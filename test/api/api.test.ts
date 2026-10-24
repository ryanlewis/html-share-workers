import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from '../../src/api';
import type { Env } from '../../src/env';
import app from '../../src/index';
import {
  acquireSlugLock,
  gatedScope,
  LOCK_TTL_MS,
  lockKey,
  objectKey,
  PUBLIC,
  putArtifactIndex,
  readArtifactMeta,
  releaseSlugLock,
  type Scope,
  SECURED,
} from '../../src/lib/artifacts';
import { verifyPassword } from '../../src/lib/password';

const TOKEN = 'test-token';
const BASE = 'https://share.test/api';
const HTML = '<!doctype html><title>t</title><p>hello</p>';
const ACME = gatedScope('acme');

function call(path: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return exports.default.fetch(`${BASE}${path}`, { ...init, headers });
}

function putHtml(path: string, body = HTML, headers: Record<string, string> = {}) {
  return call(path, { method: 'PUT', body, headers: { 'Content-Type': 'text/html', ...headers } });
}

function putForm(path: string, files: Record<string, string>) {
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) form.append(name, new File([content], name));
  return call(path, { method: 'PUT', body: form });
}

/** Calls the app with extra or replaced bindings, e.g. a revoked token. */
function callWith(bindings: Record<string, string>, path: string, token: string): Promise<Response> {
  const request = new Request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return Promise.resolve(app.fetch(request, { ...env, ...bindings } as Env));
}

/** Logs in to a secured artifact through the serving routes; returns the Cookie header value. */
async function loginCookie(slug: string, password: string): Promise<string> {
  const res = await exports.default.fetch(`https://share.test/_/${slug}/`, {
    method: 'POST',
    body: new URLSearchParams({ password }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  expect(res.status).toBe(303);
  return res.headers.get('Set-Cookie')!.split(';')[0]!;
}

async function securedStatus(slug: string, cookie: string): Promise<number> {
  const res = await exports.default.fetch(`https://share.test/_/${slug}/`, { headers: { Cookie: cookie } });
  await res.body?.cancel();
  return res.status;
}

async function keys(prefix = ''): Promise<string[]> {
  const page = await env.BUCKET.list({ prefix });
  return page.objects.map((o) => o.key).sort();
}

beforeEach(async () => {
  const all = await keys();
  if (all.length > 0) await env.BUCKET.delete(all);
});

describe('auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await call('/artifacts', {}, null);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'missing or invalid bearer token' });
  });

  it.each(['wrong-token', 'test-token-and-more', 'test-toke', ''])('rejects token %j', async (token) => {
    expect((await call('/artifacts', {}, token)).status).toBe(401);
  });

  it('rejects a non-bearer scheme carrying the right token', async () => {
    const res = await exports.default.fetch(`${BASE}/artifacts`, { headers: { Authorization: `Basic ${TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it('accepts the right token', async () => {
    expect((await call('/artifacts')).status).toBe(200);
  });

  it('rejects a revoked machine while others still work', async () => {
    const bindings = { TOKEN_TESTMACHINE: '', TOKEN_OTHER: 'other-token' };
    expect((await callWith(bindings, '/artifacts', TOKEN)).status).toBe(401);
    expect((await callWith(bindings, '/artifacts', 'other-token')).status).toBe(200);
  });

  it('rejects everything when no tokens are configured', async () => {
    expect((await callWith({ TOKEN_TESTMACHINE: '' }, '/artifacts', TOKEN)).status).toBe(401);
    expect((await callWith({ TOKEN_TESTMACHINE: '' }, '/artifacts', '')).status).toBe(401);
  });

  it('records the machine that uploaded', async () => {
    const res = await putHtml('/artifacts/public/by-machine');
    expect((await res.json<{ uploadedBy: string }>()).uploadedBy).toBe('testmachine');
    expect((await readArtifactMeta(env.BUCKET, PUBLIC, 'by-machine'))?.uploadedBy).toBe('testmachine');
  });

  it('rejects PUT and DELETE without a token and writes nothing', async () => {
    const put = await exports.default.fetch(`${BASE}/artifacts/public/x`, {
      method: 'PUT',
      body: HTML,
      headers: { 'Content-Type': 'text/html' },
    });
    expect(put.status).toBe(401);
    expect(await keys()).toEqual([]);
    await putHtml('/artifacts/public/x');
    const del = await exports.default.fetch(`${BASE}/artifacts/public/x`, { method: 'DELETE' });
    expect(del.status).toBe(401);
    expect(await keys()).toEqual(['x/index.html']);
  });
});

describe('routing', () => {
  it.each(['/', '/nope', '/artifacts/public', '/artifactsx'])('returns JSON 404 for unknown path %s', async (path) => {
    const res = await call(path);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('returns 404 for an unsupported method', async () => {
    expect((await call('/artifacts', { method: 'POST' })).status).toBe(404);
  });
});

describe('PUT', () => {
  it.each<[string, Scope, string, string, Record<string, string>]>([
    ['public', PUBLIC, 'q1-deck', 'https://share.rlew.io/q1-deck/', { visibility: 'public' }],
    ['secured', SECURED, 'q1-deck', 'https://share.rlew.io/_/q1-deck/', { visibility: 'secured' }],
    ['acme', ACME, 'q1-deck', 'https://share.rlew.io/acme/q1-deck/', { visibility: 'gated', gate: 'acme' }],
    ['acme', ACME, 'pr/some-repo/123', 'https://share.rlew.io/acme/pr/some-repo/123/', { visibility: 'gated', gate: 'acme' }],
    [
      'example',
      gatedScope('example'),
      'q1-deck',
      'https://share.rlew.io/example/q1-deck/',
      { visibility: 'gated', gate: 'example' },
    ],
  ])('uploads to scope %s the artifact %s', async (name, scope, slug, url, fields) => {
    const res = await putHtml(`/artifacts/${name}/${slug}`);
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ url, ...fields, slug, listed: false });
    if (scope.visibility !== 'gated') expect(body).not.toHaveProperty('gate');
    expect(body.created).toBe(body.updated);
    const object = await env.BUCKET.get(objectKey(scope, slug));
    expect(await object?.text()).toBe(HTML);
    expect(object?.httpMetadata?.contentType).toBe('text/html; charset=utf-8');
    expect(await readArtifactMeta(env.BUCKET, scope, slug)).toMatchObject(fields);
  });

  it.each([
    ['/artifacts/private/x', 'scope must be public, secured or a configured gate name'],
    ['/artifacts/gated/x', 'scope must be public, secured or a configured gate name'],
    ['/artifacts/other/x', 'scope must be public, secured or a configured gate name'],
    ['/artifacts/public/Upper', 'slug segment "Upper" must be lowercase letters, digits and single hyphens'],
    ['/artifacts/public/a_b', 'slug segment "a_b" must be lowercase letters, digits and single hyphens'],
    ['/artifacts/public/api', 'public slug "api" is reserved'],
    ['/artifacts/public/gated', 'public slug "gated" is reserved'],
    ['/artifacts/public/acme', 'public slug "acme" is reserved'],
    ['/artifacts/public/example', 'public slug "example" is reserved'],
    ['/artifacts/public/a/b', 'only gated slugs may contain "/"'],
    ['/artifacts/secured/a/b', 'only gated slugs may contain "/"'],
    ['/artifacts/acme/a//b', 'slug segment "" must be lowercase letters, digits and single hyphens'],
    ['/artifacts/acme/a/', 'slug segment "" must be lowercase letters, digits and single hyphens'],
    [`/artifacts/public/${'a'.repeat(201)}`, 'slug is longer than 200 characters'],
  ])('rejects %s', async (path, error) => {
    const res = await putHtml(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(await keys()).toEqual([]);
  });

  it('decodes the slug before validating it', async () => {
    expect((await putHtml('/artifacts/public/a%2Fb')).status).toBe(400);
    expect((await putHtml('/artifacts/acme/a%2F..%2Fb')).status).toBe(400);
    expect((await putHtml('/artifacts/public/a%00')).status).toBe(400);
    expect(await keys()).toEqual([]);
  });

  it('rejects other content types and empty bodies', async () => {
    const plain = await call('/artifacts/public/x', { method: 'PUT', body: HTML, headers: { 'Content-Type': 'text/plain' } });
    expect(plain.status).toBe(415);
    const empty = await putHtml('/artifacts/public/x', '');
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'body is empty' });
  });

  it('rejects a body over the size limit', async () => {
    const res = await putHtml('/artifacts/public/big', 'a'.repeat(MAX_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await keys()).toEqual([]);
  });

  it('takes listed and title from the query or from headers', async () => {
    const byQuery = await putHtml('/artifacts/public/q?listed=true&title=Q1%20deck');
    expect(await byQuery.json()).toMatchObject({ listed: true, title: 'Q1 deck' });
    const byHeader = await putHtml('/artifacts/public/h', HTML, { 'X-Share-Listed': '1', 'X-Share-Title': 'Head' });
    expect(await byHeader.json()).toMatchObject({ listed: true, title: 'Head' });
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'h')).toMatchObject({ listed: true, title: 'Head' });
  });

  it('rejects a bad listed value and an over-long title without touching the old artifact', async () => {
    await putHtml('/artifacts/public/keep');
    expect((await putHtml('/artifacts/public/keep?overwrite=true&listed=maybe')).status).toBe(400);
    const long = await putHtml(`/artifacts/public/keep?overwrite=true&title=${'t'.repeat(201)}`);
    expect(long.status).toBe(400);
    expect(await keys()).toEqual(['keep/index.html']);
  });
});

describe('multipart', () => {
  it('uploads index.html with siblings and sub-folders', async () => {
    const res = await putForm('/artifacts/acme/site', {
      'index.html': HTML,
      'assets/app.js': 'console.log(1)',
      'assets/style.css': 'p{}',
      'sub/index.html': '<p>sub</p>',
      'data.bin': 'xx',
    });
    expect(res.status).toBe(201);
    expect(await keys()).toEqual([
      'gated/acme/site/assets/app.js',
      'gated/acme/site/assets/style.css',
      'gated/acme/site/data.bin',
      'gated/acme/site/index.html',
      'gated/acme/site/sub/index.html',
    ]);
    const js = await env.BUCKET.head('gated/acme/site/assets/app.js');
    expect(js?.httpMetadata?.contentType).toBe('text/javascript; charset=utf-8');
    expect(js?.customMetadata).toEqual({});
    const sub = await env.BUCKET.head('gated/acme/site/sub/index.html');
    expect(sub?.httpMetadata?.contentType).toBe('text/html; charset=utf-8');
    expect(sub?.customMetadata).toEqual({});
    // Only the root page carries the artifact's metadata.
    const root = await env.BUCKET.head('gated/acme/site/index.html');
    expect(root?.customMetadata).toMatchObject({ visibility: 'gated', gate: 'acme' });
  });

  it.each([
    [{ 'assets/app.js': 'x' }, 'multipart upload must include index.html'],
    [{ 'index.html': HTML, '../escape.html': 'x' }, '"../escape.html": path has an empty, "." or ".." segment'],
    [{ 'index.html': HTML, 'a/../b.html': 'x' }, '"a/../b.html": path has an empty, "." or ".." segment'],
    [{ 'index.html': HTML, '/etc/passwd': 'x' }, '"/etc/passwd": path must not start with "/"'],
    [{ 'index.html': HTML, 'a\\b': 'x' }, '"a\\b": path contains a backslash or control character'],
    [{ 'index.html': '' }, 'index.html is empty'],
  ])('rejects %j', async (files, error) => {
    const res = await putForm('/artifacts/public/bad', files);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(await keys()).toEqual([]);
  });

  it('rejects text fields and duplicate paths', async () => {
    const form = new FormData();
    form.append('index.html', 'not a file');
    expect((await call('/artifacts/public/t', { method: 'PUT', body: form })).status).toBe(400);
    const dup = new FormData();
    dup.append('index.html', new File([HTML], 'index.html'));
    dup.append('sub/', new File(['a'], 'a'));
    dup.append('sub/index.html', new File(['b'], 'b'));
    const res = await call('/artifacts/public/t', { method: 'PUT', body: dup });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"sub/index.html" appears more than once' });
  });
});

describe('replace', () => {
  it('removes stale objects and keeps the created time', async () => {
    const first = await putForm('/artifacts/public/site', { 'index.html': HTML, 'old.js': 'x', 'sub/a.css': 'y' });
    const { created } = await first.json<{ created: string }>();
    const second = await putForm('/artifacts/public/site?overwrite=true', { 'index.html': '<p>v2</p>', 'new.js': 'z' });
    expect(second.status).toBe(200);
    const body = await second.json<{ created: string; updated: string }>();
    expect(body.created).toBe(created);
    expect(await keys()).toEqual(['site/index.html', 'site/new.js']);
    expect(await (await env.BUCKET.get('site/index.html'))?.text()).toBe('<p>v2</p>');
  });

  it('does not touch an artifact whose slug shares a text prefix', async () => {
    await putHtml('/artifacts/public/site-two');
    await putHtml('/artifacts/public/site');
    await putHtml('/artifacts/public/site?overwrite=true');
    expect(await keys()).toEqual(['site-two/index.html', 'site/index.html']);
  });

  it('refuses a gated slug nested inside an existing artifact, and the reverse', async () => {
    expect((await putHtml('/artifacts/acme/pr')).status).toBe(201);
    const inner = await putHtml('/artifacts/acme/pr/x');
    expect(inner.status).toBe(409);
    expect(await inner.json()).toEqual({ error: '"pr/x" would sit inside the existing artifact "pr"' });

    expect((await putHtml('/artifacts/acme/team/a/b')).status).toBe(201);
    const outer = await putHtml('/artifacts/acme/team');
    expect(outer.status).toBe(409);
    expect(await outer.json()).toEqual({ error: '"team" would contain the existing artifact "team/a/b"' });
    expect((await putHtml('/artifacts/acme/team/a')).status).toBe(409);
    // Replacing the same slug is fine, and other scopes, including other
    // gates, do not nest.
    expect((await putHtml('/artifacts/acme/pr?overwrite=true')).status).toBe(200);
    expect((await putHtml('/artifacts/public/team')).status).toBe(201);
    expect((await putHtml('/artifacts/example/pr/x')).status).toBe(201);
    expect((await putHtml('/artifacts/example/team')).status).toBe(201);
    expect(await keys('gated/acme/')).toEqual(['gated/acme/pr/index.html', 'gated/acme/team/a/b/index.html']);
  });
});

describe('overwrite', () => {
  it('refuses to replace an existing artifact without overwrite, and changes nothing', async () => {
    await putForm('/artifacts/public/site?title=Old', { 'index.html': '<p>v1</p>', 'old.js': 'x' });
    const before = await readArtifactMeta(env.BUCKET, PUBLIC, 'site');
    for (const query of ['', '?overwrite=false', '?overwrite=0']) {
      const res = await putForm(`/artifacts/public/site${query}`, { 'index.html': '<p>v2</p>', 'new.js': 'z' });
      expect(res.status, query).toBe(409);
      expect(await res.json()).toEqual({ error: '"site" already exists (set overwrite=true to replace it)' });
    }
    const header = await putHtml('/artifacts/public/site', '<p>v2</p>', { 'X-Share-Overwrite': 'false' });
    expect(header.status).toBe(409);
    expect(await keys()).toEqual(['site/index.html', 'site/old.js']);
    expect(await (await env.BUCKET.get('site/index.html'))?.text()).toBe('<p>v1</p>');
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'site')).toEqual(before);
  });

  it('replaces with overwrite from the query or the header', async () => {
    await putHtml('/artifacts/public/p', '<p>v1</p>');
    expect((await putHtml('/artifacts/public/p?overwrite=true', '<p>v2</p>')).status).toBe(200);
    expect(await (await env.BUCKET.get('p/index.html'))?.text()).toBe('<p>v2</p>');
    expect((await putHtml('/artifacts/public/p', '<p>v3</p>', { 'X-Share-Overwrite': '1' })).status).toBe(200);
    expect(await (await env.BUCKET.get('p/index.html'))?.text()).toBe('<p>v3</p>');
  });

  it('creates a new artifact whether or not overwrite is set, and rejects a bad value', async () => {
    expect((await putHtml('/artifacts/public/a?overwrite=true')).status).toBe(201);
    expect((await putHtml('/artifacts/public/b?overwrite=false')).status).toBe(201);
    expect((await putHtml('/artifacts/public/c?overwrite=maybe')).status).toBe(400);
    expect(await keys()).toEqual(['a/index.html', 'b/index.html']);
  });

  it('refuses an empty overwrite rather than reading it as true', async () => {
    await putHtml('/artifacts/public/p', '<p>v1</p>');
    expect((await putHtml('/artifacts/public/p?overwrite=', '<p>v2</p>')).status).toBe(400);
    expect((await putHtml('/artifacts/public/p', '<p>v2</p>', { 'X-Share-Overwrite': '' })).status).toBe(400);
    expect(await (await env.BUCKET.get('p/index.html'))?.text()).toBe('<p>v1</p>');
  });
});

describe('slug lock', () => {
  it('refuses a PUT or DELETE while another request holds the lock, and writes nothing', async () => {
    await putForm('/artifacts/public/site', { 'index.html': '<p>v1</p>', 'old.js': 'x' });
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site')).not.toBeNull();
    const put = await putForm('/artifacts/public/site?overwrite=true', { 'index.html': '<p>v2</p>', 'new.js': 'z' });
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({ error: 'another upload or delete of "site" is in progress (a stale lock expires within 5 minutes)' });
    expect((await putHtml('/artifacts/public/site?overwrite=true')).status).toBe(409);
    expect((await call('/artifacts/public/site', { method: 'DELETE' })).status).toBe(409);
    expect(await keys('site/')).toEqual(['site/index.html', 'site/old.js']);
    expect(await (await env.BUCKET.get('site/index.html'))?.text()).toBe('<p>v1</p>');
    // A new slug is refused too, and leaves nothing behind.
    expect(await acquireSlugLock(env.BUCKET, ACME, 'pr/new')).not.toBeNull();
    expect((await putHtml('/artifacts/acme/pr/new')).status).toBe(409);
    expect(await keys('gated/')).toEqual([]);
  });

  it('locks each slug in each scope on its own', async () => {
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site')).not.toBeNull();
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site')).toBeNull();
    expect((await putHtml('/artifacts/public/site-two')).status).toBe(201);
    expect((await putHtml('/artifacts/secured/site')).status).toBe(201);
    expect((await putHtml('/artifacts/acme/site')).status).toBe(201);
  });

  it('takes over a lock that has expired', async () => {
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site', Date.now() - LOCK_TTL_MS - 1)).not.toBeNull();
    expect((await putHtml('/artifacts/public/site')).status).toBe(201);
  });

  it('lets only one of two requests take over an expired lock', async () => {
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site', Date.now() - LOCK_TTL_MS - 1)).not.toBeNull();
    const taken = await Promise.all([acquireSlugLock(env.BUCKET, PUBLIC, 'site'), acquireSlugLock(env.BUCKET, PUBLIC, 'site')]);
    expect(taken.filter((lock) => lock !== null)).toHaveLength(1);
  });

  it('does not release a lock that another request has taken over', async () => {
    const stale = await acquireSlugLock(env.BUCKET, PUBLIC, 'site', Date.now() - LOCK_TTL_MS - 1);
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site')).not.toBeNull();
    await releaseSlugLock(env.BUCKET, stale!);
    expect(await keys('.locks/')).toEqual(['.locks/site']);
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site')).toBeNull();
  });

  it('releases the lock after a success and after a refusal', async () => {
    await putHtml('/artifacts/public/site');
    expect((await putHtml('/artifacts/public/site')).status).toBe(409);
    expect((await call('/artifacts/public/site', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/artifacts/public/site', { method: 'DELETE' })).status).toBe(404);
    expect(await keys('.locks/')).toEqual([]);
    expect(await acquireSlugLock(env.BUCKET, PUBLIC, 'site')).not.toBeNull();
  });

  it('still returns the upload, and its password, when releasing the lock fails', async () => {
    const failing = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === 'head') {
          return (key: string) => (key.startsWith('.locks/') ? Promise.reject(new Error('R2 is down')) : target.head(key));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const request = new Request(`${BASE}/artifacts/secured/s`, {
      method: 'PUT',
      body: HTML,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/html' },
    });
    const res = await app.fetch(request, { ...env, BUCKET: failing } as Env);
    expect(res.status).toBe(201);
    expect((await res.json<{ password: string }>()).password).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it('does not show the lock as an artifact or a page', async () => {
    expect(await acquireSlugLock(env.BUCKET, ACME, 'pr/x')).not.toBeNull();
    expect(lockKey(ACME, 'pr/x')).toBe('.locks/gated/acme/pr/x');
    expect(await (await call('/artifacts')).json()).toEqual({ artifacts: [] });
    const page = await exports.default.fetch('https://share.test/.locks/gated/acme/pr/x');
    await page.body?.cancel();
    expect(page.status).toBe(404);
  });

  it('lets only one of two overlapping uploads write, so files never mix', async () => {
    await putForm('/artifacts/public/site', { 'index.html': '<p>v0</p>', 'old.js': 'x' });
    // Upload A stops at its first asset write until B has finished.
    let resume!: () => void;
    const held = new Promise<void>((r) => (resume = r));
    let reached!: () => void;
    const atFirstWrite = new Promise<void>((r) => (reached = r));
    const real = env.BUCKET;
    const pausing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'put') {
          return async (key: string, ...rest: unknown[]) => {
            if (key === 'site/a.js') {
              reached();
              await held;
            }
            return (target.put as (...args: unknown[]) => unknown).call(target, key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    function form(files: Record<string, string>) {
      const body = new FormData();
      for (const [name, content] of Object.entries(files)) body.append(name, new File([content], name));
      return new Request(`${BASE}/artifacts/public/site?overwrite=true`, {
        method: 'PUT',
        body,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
    }
    const a = Promise.resolve(app.fetch(form({ 'index.html': '<p>A</p>', 'a.js': 'a' }), { ...env, BUCKET: pausing } as Env));
    await atFirstWrite;
    const b = await app.fetch(form({ 'index.html': '<p>B</p>', 'b.js': 'b' }), env as Env);
    expect(b.status).toBe(409);
    resume();
    expect((await a).status).toBe(200);
    expect(await keys('site/')).toEqual(['site/a.js', 'site/index.html']);
    expect(await (await env.BUCKET.get('site/index.html'))?.text()).toBe('<p>A</p>');
  });

  it('ends with exactly one upload\'s files when PUTs run at once', async () => {
    await putHtml('/artifacts/public/site');
    const uploads = ['a', 'b', 'c'].map((n) => ({ 'index.html': `<p>${n}</p>`, [`${n}.js`]: n, [`${n}/x.css`]: n }));
    const results = await Promise.all(uploads.map((files) => putForm('/artifacts/public/site?overwrite=true', files)));
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    expect(statuses).toContain(200);
    const page = await (await env.BUCKET.get('site/index.html'))!.text();
    const winner = uploads.find((files) => files['index.html'] === page)!;
    expect(await keys('site/')).toEqual(Object.keys(winner).map((k) => `site/${k}`).sort());
  });
});

describe('secured', () => {
  it('generates a password, returns it once and stores only its hash', async () => {
    const res = await putHtml('/artifacts/secured/s');
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json<Record<string, string>>();
    expect(body.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(body).not.toHaveProperty('pwhash');
    const meta = await readArtifactMeta(env.BUCKET, SECURED, 's');
    expect(meta?.pwhash).not.toContain(body.password);
    expect(await verifyPassword(body.password!, meta!.pwhash!)).toBe(true);

    for (const path of ['/artifacts/secured/s', '/artifacts', '/artifacts?visibility=secured']) {
      const text = await (await call(path)).text();
      expect(text).not.toContain('pwhash');
      expect(text).not.toContain(meta!.pwhash!);
      expect(text).not.toContain(body.password);
    }
  });

  it('uses the X-Share-Password header and does not echo it', async () => {
    const res = await putHtml('/artifacts/secured/s', HTML, { 'X-Share-Password': 'hunter2' });
    const body = await res.json<Record<string, string>>();
    expect(body).not.toHaveProperty('password');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    const meta = await readArtifactMeta(env.BUCKET, SECURED, 's');
    expect(await verifyPassword('hunter2', meta!.pwhash!)).toBe(true);
  });

  it('rejects a password for other visibilities, and an empty one', async () => {
    const pub = await putHtml('/artifacts/public/p', HTML, { 'X-Share-Password': 'x' });
    expect(pub.status).toBe(400);
    const empty = await putHtml('/artifacts/secured/p', HTML, { 'X-Share-Password': '' });
    expect(empty.status).toBe(400);
    expect(await keys()).toEqual([]);
  });

  it('keeps the password when replaced without one, and old cookies stay valid', async () => {
    const first = await (await putHtml('/artifacts/secured/s', '<p>v1</p>')).json<{ password: string }>();
    const before = await readArtifactMeta(env.BUCKET, SECURED, 's');
    const cookie = await loginCookie('s', first.password);
    expect(await securedStatus('s', cookie)).toBe(200);

    const res = await putHtml('/artifacts/secured/s?overwrite=true', '<p>v2</p>');
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('password');
    expect(body.passwordUnchanged).toBe(true);
    const after = await readArtifactMeta(env.BUCKET, SECURED, 's');
    expect(after?.pwhash).toBe(before?.pwhash);
    expect(await verifyPassword(first.password, after!.pwhash!)).toBe(true);
    expect(await securedStatus('s', cookie)).toBe(200);
    expect(await (await exports.default.fetch('https://share.test/_/s/', { headers: { Cookie: cookie } })).text()).toBe('<p>v2</p>');
  });

  it('replaces the password when one is given, and old cookies stop working', async () => {
    const first = await (await putHtml('/artifacts/secured/s')).json<{ password: string }>();
    const cookie = await loginCookie('s', first.password);
    const res = await putHtml('/artifacts/secured/s?overwrite=true', HTML, { 'X-Share-Password': 'new-one' });
    const body = await res.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('passwordUnchanged');
    const meta = await readArtifactMeta(env.BUCKET, SECURED, 's');
    expect(await verifyPassword('new-one', meta!.pwhash!)).toBe(true);
    expect(await verifyPassword(first.password, meta!.pwhash!)).toBe(false);
    expect(await securedStatus('s', cookie)).toBe(401);
  });

  it.each([
    ['query', '?overwrite=true&regenerate=true', {}],
    ['header', '', { 'X-Share-Overwrite': 'true', 'X-Share-Password-Regenerate': '1' }],
  ])('generates a new password on request (%s), and old cookies stop working', async (_name, query, headers) => {
    const first = await (await putHtml('/artifacts/secured/s')).json<{ password: string }>();
    const cookie = await loginCookie('s', first.password);
    const second = await (await putHtml(`/artifacts/secured/s${query}`, HTML, headers)).json<Record<string, string>>();
    expect(second.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(second.password).not.toBe(first.password);
    expect(second).not.toHaveProperty('passwordUnchanged');
    const meta = await readArtifactMeta(env.BUCKET, SECURED, 's');
    expect(await verifyPassword(first.password, meta!.pwhash!)).toBe(false);
    expect(await verifyPassword(second.password!, meta!.pwhash!)).toBe(true);
    expect(await securedStatus('s', cookie)).toBe(401);
  });

  it('generates a password for a new secured artifact even with regenerate unset or false', async () => {
    const res = await putHtml('/artifacts/secured/n?regenerate=false');
    expect(await res.json()).toHaveProperty('password');
  });

  it('rejects regenerate with a password, for other visibilities, or with a bad value', async () => {
    await putHtml('/artifacts/secured/s');
    const both = await putHtml('/artifacts/secured/s?regenerate=true', HTML, { 'X-Share-Password': 'x' });
    expect(both.status).toBe(400);
    expect((await putHtml('/artifacts/public/p?regenerate=true')).status).toBe(400);
    expect((await putHtml('/artifacts/secured/s?regenerate=maybe')).status).toBe(400);
    expect((await putHtml('/artifacts/secured/s?regenerate=')).status).toBe(400);
    expect(await keys()).toEqual(['_/s/index.html']);
  });
});

describe('replace keeps title and listed', () => {
  it('keeps both when the request sets neither', async () => {
    await putHtml('/artifacts/public/p?listed=true&title=Keep%20me');
    const res = await putHtml('/artifacts/public/p?overwrite=true');
    expect(await res.json()).toMatchObject({ listed: true, title: 'Keep me' });
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'p')).toMatchObject({ listed: true, title: 'Keep me' });
  });

  it('uses new values when set', async () => {
    await putHtml('/artifacts/public/p?listed=true&title=Old');
    await putHtml('/artifacts/public/p?overwrite=true', HTML, { 'X-Share-Title': 'New' });
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'p')).toMatchObject({ listed: true, title: 'New' });
    await putHtml('/artifacts/public/q');
    await putHtml('/artifacts/public/q?overwrite=true&listed=true');
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'q')).toMatchObject({ listed: true });
  });

  it('unlists with listed=false and clears the title with an empty one', async () => {
    await putHtml('/artifacts/public/p?listed=true&title=Old');
    await putHtml('/artifacts/public/p?overwrite=true&listed=false');
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'p')).toMatchObject({ listed: false, title: 'Old' });
    const res = await putHtml('/artifacts/public/p?overwrite=true&title=');
    expect(res.status).toBe(200);
    const meta = await readArtifactMeta(env.BUCKET, PUBLIC, 'p');
    expect(meta?.title).toBeUndefined();
    expect(await res.json()).not.toHaveProperty('title');
    const byHeader = await putHtml('/artifacts/public/p?overwrite=true&title=Again');
    expect(await byHeader.json()).toMatchObject({ title: 'Again' });
    await putHtml('/artifacts/public/p', HTML, { 'X-Share-Overwrite': '1', 'X-Share-Title': '' });
    expect((await readArtifactMeta(env.BUCKET, PUBLIC, 'p'))?.title).toBeUndefined();
  });

  it('defaults a new artifact to unlisted with no title', async () => {
    await putHtml('/artifacts/public/p');
    const meta = await readArtifactMeta(env.BUCKET, PUBLIC, 'p');
    expect(meta?.listed).toBe(false);
    expect(meta?.title).toBeUndefined();
  });

  it('keeps created and bumps updated, including for secured and gated', async () => {
    for (const path of ['/artifacts/public/c', '/artifacts/secured/c', '/artifacts/acme/c']) {
      const first = await (await putHtml(path)).json<{ created: string; updated: string }>();
      await new Promise((r) => setTimeout(r, 5));
      const second = await (await putHtml(`${path}?overwrite=true`)).json<{ created: string; updated: string }>();
      expect(second.created).toBe(first.created);
      expect(Date.parse(second.updated)).toBeGreaterThan(Date.parse(first.updated));
    }
  });
});

describe('GET, list and DELETE', () => {
  it('reports whether an artifact exists', async () => {
    expect((await call('/artifacts/public/none')).status).toBe(404);
    await putHtml('/artifacts/acme/pr/a?title=A');
    const res = await call('/artifacts/acme/pr/a');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: 'https://share.rlew.io/acme/pr/a/',
      visibility: 'gated',
      gate: 'acme',
      slug: 'pr/a',
      created: expect.any(String),
      updated: expect.any(String),
      listed: false,
      title: 'A',
      uploadedBy: 'testmachine',
    });
    expect((await call('/artifacts/public/pr')).status).toBe(404);
    expect((await call('/artifacts/example/pr/a')).status).toBe(404);
    expect((await call('/artifacts/public/Bad')).status).toBe(400);
  });

  it('lists every artifact, or one scope', async () => {
    await putForm('/artifacts/public/a', { 'index.html': HTML, 'sub/index.html': HTML });
    await putHtml('/artifacts/secured/b');
    await putHtml('/artifacts/acme/pr/c');
    await putHtml('/artifacts/example/d');
    type Listing = { artifacts: { visibility: string; gate?: string; slug: string; size: number }[] };
    const all = await (await call('/artifacts')).json<Listing>();
    expect(all.artifacts.map((a) => `${a.gate ?? a.visibility}:${a.slug}`).sort()).toEqual([
      'acme:pr/c',
      'example:d',
      'public:a',
      'secured:b',
    ]);
    const acme = await (await call('/artifacts?visibility=acme')).json<Listing>();
    expect(acme.artifacts).toEqual([
      expect.objectContaining({ visibility: 'gated', gate: 'acme', slug: 'pr/c', size: HTML.length }),
    ]);
    const pub = await (await call('/artifacts?visibility=public')).json<Listing>();
    expect(pub.artifacts.map((a) => a.slug)).toEqual(['a']);
    for (const bad of ['nope', 'gated', '']) {
      const res = await call(`/artifacts?visibility=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({ error: 'scope must be public, secured or a configured gate name' });
    }
  });

  it('deletes every object of an artifact', async () => {
    await putForm('/artifacts/public/gone', { 'index.html': HTML, 'a.js': 'x', 'sub/b.css': 'y' });
    await putHtml('/artifacts/public/gone-not');
    const res = await call('/artifacts/public/gone', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, slug: 'gone', objects: 3 });
    expect(await keys()).toEqual(['gone-not/index.html']);
    expect((await call('/artifacts/public/gone', { method: 'DELETE' })).status).toBe(404);
    expect((await call('/artifacts/public/gone')).status).toBe(404);
  });

  it('does not delete an artifact nested inside the one being deleted', async () => {
    // Nesting is refused on upload, but migrated content could already have it.
    const meta = {
      visibility: 'gated' as const,
      gate: 'acme',
      created: '2026-10-24T00:00:00Z',
      updated: '2026-10-24T00:00:00Z',
      listed: false,
    };
    await putArtifactIndex(env.BUCKET, 'pr', HTML, meta);
    await env.BUCKET.put('gated/acme/pr/asset.js', 'x');
    await putArtifactIndex(env.BUCKET, 'pr/inner', HTML, meta);
    await env.BUCKET.put('gated/acme/pr/inner/asset.js', 'x');
    const res = await call('/artifacts/acme/pr', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: 'https://share.rlew.io/acme/pr/', visibility: 'gated', gate: 'acme' });
    expect(await keys()).toEqual(['gated/acme/pr/inner/asset.js', 'gated/acme/pr/inner/index.html']);
  });

  it('deletes within one gate only', async () => {
    await putHtml('/artifacts/acme/same');
    await putHtml('/artifacts/example/same');
    expect((await call('/artifacts/acme/same', { method: 'DELETE' })).status).toBe(200);
    expect(await keys()).toEqual(['gated/example/same/index.html']);
  });
});

describe('gate config', () => {
  function callGates(IP_GATES: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${TOKEN}`);
    const request = new Request(`${BASE}${path}`, { ...init, headers });
    return Promise.resolve(app.fetch(request, { ...env, IP_GATES } as Env));
  }

  it('rejects a gate that is not configured', async () => {
    await putHtml('/artifacts/acme/kept');
    const res = await callGates('{"example":[]}', '/artifacts/acme/kept');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'scope must be public, secured or a configured gate name' });
    expect((await callGates('{}', '/artifacts/acme/kept', { method: 'DELETE' })).status).toBe(400);
    expect(await keys()).toEqual(['gated/acme/kept/index.html']);
  });

  it('can still read and delete a public artifact shadowed by a gate added later', async () => {
    await callGates('{}', '/artifacts/public/acme', { method: 'PUT', body: HTML, headers: { 'Content-Type': 'text/html' } });
    await putHtml('/artifacts/acme/kept');
    expect((await call('/artifacts/public/acme')).status).toBe(200);
    expect((await call('/artifacts/public/acme', { method: 'DELETE' })).status).toBe(200);
    expect(await keys()).toEqual(['gated/acme/kept/index.html']);
  });

  it('frees a public slug once its gate is removed', async () => {
    const put = await callGates('{}', '/artifacts/public/acme', {
      method: 'PUT',
      body: HTML,
      headers: { 'Content-Type': 'text/html' },
    });
    expect(put.status).toBe(201);
  });

  it('still knows gate names when an entry is bad, and none when the JSON is broken', async () => {
    expect((await callGates('{"acme":["garbage"]}', '/artifacts/acme/x')).status).toBe(404);
    expect((await callGates('not json', '/artifacts/acme/x')).status).toBe(400);
  });
});
