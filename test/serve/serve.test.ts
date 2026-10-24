import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import app from '../../src/index';
import { type ArtifactMeta, putArtifactIndex, type Visibility } from '../../src/lib/artifacts';
import { hashPassword } from '../../src/lib/password';
import { COOKIE_TTL_SECONDS, signCookie } from '../../src/serve/cookie';

const NOW = '2026-10-24T12:00:00.000Z';
const SNIPPET = '<script defer src="https://analytics.test/script.js"></script>';
// Two gates with separate documentation ranges.
const GATES = JSON.stringify({ acme: ['192.0.2.0/24', '2001:db8::/32'], example: ['198.51.100.0/24', '3fff::/20'] });
const PASSWORD = 'correct horse';

function meta(visibility: Visibility, overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return { visibility, created: NOW, updated: NOW, listed: false, ...overrides };
}

function gated(gate: string, overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return meta('gated', { gate, ...overrides });
}

function fetchPath(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}): Promise<Response> {
  const bindings = { ...env, IP_GATES: GATES, ANALYTICS_SNIPPET: '', REDIRECTS: '{}', ...overrides } as Env;
  return Promise.resolve(app.fetch(new Request(`https://share.test${path}`, init), bindings));
}

async function clearBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Cookie header value from a Set-Cookie response header. */
function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('Set-Cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0]!;
}

let loginClient = 0;

/** A fresh client IP for each call, so tests stay under the login rate limit. */
function nextClientIp(): string {
  loginClient++;
  return `203.0.113.${loginClient % 256}`;
}

function login(slug: string, password: string, path = `/_/${slug}/`, ip = nextClientIp(), overrides: Partial<Env> = {}): Promise<Response> {
  return fetchPath(
    path,
    {
      method: 'POST',
      body: new URLSearchParams({ password }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
      redirect: 'manual',
    },
    overrides,
  );
}

beforeEach(clearBucket);

describe('public artifacts', () => {
  beforeEach(async () => {
    await putArtifactIndex(env.BUCKET, 'deck', '<html><head><title>Deck</title></head><body>deck</body></html>', meta('public'));
    await env.BUCKET.put('deck/app.js', 'console.log(1)');
    await env.BUCKET.put('deck/logo.png', new Uint8Array([1, 2, 3]));
    await env.BUCKET.put('deck/data.bin', 'x', { httpMetadata: { contentType: 'application/x-custom' } });
    await env.BUCKET.put('deck/sub/index.html', '<p>sub</p>');
  });

  it('serves index.html for the artifact root', async () => {
    const res = await fetchPath('/deck/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('deck');
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/);
  });

  it('308s the bare slug to the trailing-slash form, keeping the query', async () => {
    const res = await fetchPath('/deck?x=1', { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/deck/?x=1');
  });

  it('serves a sub-folder index.html and redirects the folder without a slash', async () => {
    expect(await (await fetchPath('/deck/sub/')).text()).toBe('<p>sub</p>');
    const res = await fetchPath('/deck/sub', { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/deck/sub/');
  });

  it('takes the content type from httpMetadata, then the extension', async () => {
    expect((await fetchPath('/deck/app.js')).headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect((await fetchPath('/deck/logo.png')).headers.get('Content-Type')).toBe('image/png');
    expect((await fetchPath('/deck/data.bin')).headers.get('Content-Type')).toBe('application/x-custom');
  });

  it('answers If-None-Match with 304', async () => {
    const first = await fetchPath('/deck/app.js');
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    await first.body?.cancel();
    const res = await fetchPath('/deck/app.js', { headers: { 'If-None-Match': etag! } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    const weak = await fetchPath('/deck/app.js', { headers: { 'If-None-Match': `"nope", W/${etag}` } });
    expect(weak.status).toBe(304);
    const other = await fetchPath('/deck/app.js', { headers: { 'If-None-Match': '"nope"' } });
    expect(other.status).toBe(200);
    await other.body?.cancel();
  });

  it('supports HEAD', async () => {
    const res = await fetchPath('/deck/app.js', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('14');
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(await res.text()).toBe('');
  });

  it('serves a 404 page for misses', async () => {
    for (const path of ['/nope/', '/deck/missing.js', '/Deck/', '/deck/a%2Fb', '/deck/%ZZ', '/assets/style.css']) {
      const res = await fetchPath(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Content-Type'), path).toContain('text/html');
      expect(await res.text(), path).toContain('Not found');
    }
  });

  it('decodes percent-encoded file names', async () => {
    await env.BUCKET.put('deck/my file.txt', 'spaced');
    expect(await (await fetchPath('/deck/my%20file.txt')).text()).toBe('spaced');
  });

  it('refuses other methods', async () => {
    expect((await fetchPath('/deck/', { method: 'PUT', body: 'x' })).status).toBe(405);
    expect((await fetchPath('/deck/', { method: 'POST', body: 'x' })).status).toBe(405);
  });
});

describe('robots.txt', () => {
  it('disallows everything', async () => {
    const res = await fetchPath('/robots.txt');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('generated index', () => {
  it('lists only listed artifacts, linking secured and gated without content', async () => {
    await putArtifactIndex(env.BUCKET, 'shown', '<p>PUBLIC-BODY</p>', meta('public', { listed: true, title: 'Shown <b>deck</b>' }));
    await putArtifactIndex(env.BUCKET, 'hidden', '<p>x</p>', meta('public', { listed: false, title: 'Hidden deck' }));
    const pwhash = await hashPassword(PASSWORD, 1);
    await putArtifactIndex(env.BUCKET, 'locked', '<p>SECRET-BODY</p>', meta('secured', { listed: true, pwhash, title: 'Locked' }));
    await putArtifactIndex(env.BUCKET, 'pr/thing/1', '<p>GATED-BODY</p>', gated('acme', { listed: true }));
    await putArtifactIndex(env.BUCKET, 'ex', '<p>GATED-BODY</p>', gated('example', { listed: true }));
    // Its gate is not configured, so a link would not reach it.
    await putArtifactIndex(env.BUCKET, 'gone', '<p>x</p>', gated('removed', { listed: true, title: 'Removed gate' }));
    // Shadowed by the acme gate.
    await env.BUCKET.put('acme/index.html', 'x', { customMetadata: { visibility: 'public', created: NOW, updated: NOW, listed: 'true' } });

    const res = await fetchPath('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('href="/shown/"');
    expect(html).toContain('Shown &lt;b&gt;deck&lt;/b&gt;');
    expect(html).toContain('href="/_/locked/"');
    expect(html).toContain('href="/acme/pr/thing/1/"');
    expect(html).toContain('href="/example/ex/"');
    expect(html).not.toContain('Removed gate');
    expect(html).not.toContain('href="/acme/"');
    expect(html).not.toContain('acme only');
    expect(html).not.toContain('hidden');
    expect(html).not.toContain('Hidden deck');
    expect(html).not.toContain('BODY');
    expect(html).not.toContain(pwhash);
    expect(html).not.toContain('pbkdf2');
  });
});

describe('redirects', () => {
  const REDIRECTS = JSON.stringify({ 'old-overview': '/acme/old-overview/' });

  it.each([
    ['/old-overview', '/acme/old-overview/'],
    ['/old-overview/', '/acme/old-overview/'],
    ['/old-overview/x.png', '/acme/old-overview/x.png'],
    ['/old-overview/a/b.css?v=2', '/acme/old-overview/a/b.css?v=2'],
  ])('308s %s to %s', async (from, to) => {
    const res = await fetchPath(from, { redirect: 'manual' }, { REDIRECTS });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe(to);
  });

  it('puts the sub-path before the target query', async () => {
    const res = await fetchPath('/old/page?a=1', { redirect: 'manual' }, { REDIRECTS: '{"old":"/acme/old/?ref=x"}' });
    expect(res.headers.get('Location')).toBe('/acme/old/page?ref=x&a=1');
  });

  it('never produces a scheme-relative Location', async () => {
    const res = await fetchPath('/old//evil.example/x', { redirect: 'manual' }, { REDIRECTS: '{"old":"/"}' });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/evil.example/x');
  });

  it('wins over a public artifact with the same slug', async () => {
    await putArtifactIndex(env.BUCKET, 'old-overview', '<p>old</p>', meta('public'));
    const res = await fetchPath('/old-overview/', { redirect: 'manual' }, { REDIRECTS });
    expect(res.status).toBe(308);
  });

  it('loses to a gate with the same name', async () => {
    const res = await fetchPath('/acme/', { redirect: 'manual' }, { REDIRECTS: '{"acme":"/elsewhere/"}' });
    expect(res.status).toBe(403);
  });

  it('serves normally when REDIRECTS is unset', async () => {
    await putArtifactIndex(env.BUCKET, 'deck', '<p>deck</p>', meta('public'));
    expect((await fetchPath('/deck/', {}, { REDIRECTS: undefined })).status).toBe(200);
  });

  it('ignores invalid JSON and non-string targets', async () => {
    await putArtifactIndex(env.BUCKET, 'deck', '<p>deck</p>', meta('public'));
    expect((await fetchPath('/deck/', {}, { REDIRECTS: 'not json' })).status).toBe(200);
    expect((await fetchPath('/deck/', {}, { REDIRECTS: '{"deck":5}' })).status).toBe(200);
    expect((await fetchPath('/constructor/', {}, { REDIRECTS: '{}' })).status).toBe(404);
  });
});

describe('exact-path redirects', () => {
  const REDIRECTS = JSON.stringify({ '/acme/': '/acme/index/' });
  const headers = { 'CF-Connecting-IP': '192.0.2.10' };

  it.each([
    ['/acme/', '/acme/index/'],
    ['/acme', '/acme/index/'],
    ['/acme/?a=1', '/acme/index/?a=1'],
  ])('308s %s to %s before the gate check', async (from, to) => {
    const res = await fetchPath(from, { redirect: 'manual' }, { REDIRECTS });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe(to);
  });

  it('leaves the target to the gate', async () => {
    await putArtifactIndex(env.BUCKET, 'index', '<p>listing</p>', gated('acme'));
    const allowed = await fetchPath('/acme/index/', { headers }, { REDIRECTS });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('<p>listing</p>');
    expect((await fetchPath('/acme/index/', { headers: { 'CF-Connecting-IP': '203.0.113.5' } }, { REDIRECTS })).status).toBe(403);
  });

  it('matches only the exact path', async () => {
    await putArtifactIndex(env.BUCKET, 'report', '<p>report</p>', gated('acme'));
    expect((await fetchPath('/acme/report/', { headers }, { REDIRECTS })).status).toBe(200);
  });

  it('works for nested paths and keeps single-segment keys apart', async () => {
    const res = await fetchPath(
      '/a/b/',
      { redirect: 'manual' },
      { REDIRECTS: JSON.stringify({ '/a/b': '/c/', a: '/d/' }) },
    );
    expect(res.headers.get('Location')).toBe('/c/');
    const sub = await fetchPath('/a/x', { redirect: 'manual' }, { REDIRECTS: JSON.stringify({ '/a/b': '/c/', a: '/d/' }) });
    expect(sub.headers.get('Location')).toBe('/d/x');
  });

  it('merges the request query into a target query', async () => {
    const res = await fetchPath('/acme/?a=1', { redirect: 'manual' }, { REDIRECTS: '{"/acme/":"/acme/index/?view=list"}' });
    expect(res.headers.get('Location')).toBe('/acme/index/?view=list&a=1');
  });

  it('matches keys against the decoded path', async () => {
    const res = await fetchPath('/caf%C3%A9/', { redirect: 'manual' }, { REDIRECTS: '{"/café/":"/x/"}' });
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/x/');
  });

  it('puts the request query before the target fragment', async () => {
    const res = await fetchPath('/acme/?utm=x', { redirect: 'manual' }, { REDIRECTS: '{"/acme/":"/acme/index/#latest"}' });
    expect(res.headers.get('Location')).toBe('/acme/index/?utm=x#latest');
  });

  it('skips an entry that points at itself', async () => {
    const res = await fetchPath('/acme/', { headers }, { REDIRECTS: '{"/acme/":"/acme"}' });
    expect(res.status).toBe(404);
  });
});

describe('config parsing', () => {
  it('parses each config value once per isolate and logs a bad one once', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Values no other test uses, so nothing has cached them yet.
      const overrides = { IP_GATES: '{"acme":["once"]}', REDIRECTS: '{"/once//":"/x/"}' };
      for (let i = 0; i < 3; i++) await fetchPath('/deck/', {}, overrides);
      const messages = log.mock.calls.map((call) => String(call[0]));
      expect(messages.filter((m) => m.startsWith('IP_GATES'))).toHaveLength(1);
      expect(messages.filter((m) => m.startsWith('REDIRECTS'))).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('serves a cross-host self-target as the page, not a redirect loop', async () => {
    await putArtifactIndex(env.BUCKET, 'deck', '<p>deck</p>', meta('public'));
    const redirects = { REDIRECTS: '{"/deck/":"https://share.test/deck/","deck":"https://share.test/deck/"}' };
    expect((await fetchPath('/deck/', { redirect: 'manual' }, redirects)).status).toBe(200);
  });
});

describe('gated artifacts', () => {
  beforeEach(async () => {
    await putArtifactIndex(env.BUCKET, 'report', '<p>acme report</p>', gated('acme'));
    await env.BUCKET.put('gated/acme/report/x.png', new Uint8Array([9]));
    await putArtifactIndex(env.BUCKET, 'pr/some-repo/123', '<p>pr page</p>', gated('acme'));
    await putArtifactIndex(env.BUCKET, 'report', '<p>example report</p>', gated('example'));
  });

  it.each([
    ['acme', '192.0.2.10', '<p>acme report</p>'],
    ['acme', '2001:db8:1::5', '<p>acme report</p>'],
    ['example', '198.51.100.20', '<p>example report</p>'],
    ['example', '3fff:0:1::5', '<p>example report</p>'],
  ])('allows %s from %s', async (gate, ip, body) => {
    const res = await fetchPath(`/${gate}/report/`, { headers: { 'CF-Connecting-IP': ip } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('serves assets and multi-segment slugs', async () => {
    const headers = { 'CF-Connecting-IP': '192.0.2.10' };
    expect((await fetchPath('/acme/report/x.png', { headers })).headers.get('Content-Type')).toBe('image/png');
    expect(await (await fetchPath('/acme/pr/some-repo/123/', { headers })).text()).toBe('<p>pr page</p>');
    const bare = await fetchPath('/acme/pr/some-repo/123', { headers, redirect: 'manual' });
    expect(bare.status).toBe(308);
    expect(bare.headers.get('Location')).toBe('/acme/pr/some-repo/123/');
  });

  it.each([
    ['acme', '203.0.113.5'],
    ['acme', '2001:db9::1'],
    ['acme', 'garbage'],
    ['example', '203.0.113.5'],
    ['example', '3fff:1000::1'],
  ])('denies %s to %s with a generic 403 page', async (gate, ip) => {
    const res = await fetchPath(`/${gate}/report/`, { headers: { 'CF-Connecting-IP': ip } });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('This page is restricted to an allowlisted network.');
    expect(html).not.toContain('report');
    expect(html).not.toContain(gate);
  });

  it('keeps gates apart: an address allowed for one gate is refused by the other', async () => {
    const acmeIp = { 'CF-Connecting-IP': '192.0.2.10' };
    const exampleIp = { 'CF-Connecting-IP': '3fff::1' };
    expect((await fetchPath('/example/report/', { headers: acmeIp })).status).toBe(403);
    expect((await fetchPath('/acme/report/', { headers: exampleIp })).status).toBe(403);
    expect((await fetchPath('/acme/report/x.png', { headers: exampleIp })).status).toBe(403);
  });

  it('denies a request with no CF-Connecting-IP', async () => {
    expect((await fetchPath('/acme/report/')).status).toBe(403);
    expect((await fetchPath('/acme/report/x.png')).status).toBe(403);
    expect((await fetchPath('/example/report/')).status).toBe(403);
  });

  it('ignores X-Forwarded-For', async () => {
    const spoofed = await fetchPath('/acme/report/', {
      headers: { 'CF-Connecting-IP': '203.0.113.5', 'X-Forwarded-For': '192.0.2.10' },
    });
    expect(spoofed.status).toBe(403);
    const onlyXff = await fetchPath('/acme/report/', { headers: { 'X-Forwarded-For': '192.0.2.10' } });
    expect(onlyXff.status).toBe(403);
    const otherGate = await fetchPath('/example/report/', {
      headers: { 'CF-Connecting-IP': '192.0.2.10', 'X-Forwarded-For': '198.51.100.20' },
    });
    expect(otherGate.status).toBe(403);
  });

  it('denies everyone when a gate has no ranges', async () => {
    const IP_GATES = JSON.stringify({ acme: [], example: ['198.51.100.0/24'] });
    const res = await fetchPath('/acme/report/', { headers: { 'CF-Connecting-IP': '192.0.2.10' } }, { IP_GATES });
    expect(res.status).toBe(403);
  });

  it('fails closed for every gate, and only for gates, when IP_GATES has a bad entry', async () => {
    await putArtifactIndex(env.BUCKET, 'deck', '<p>public deck</p>', meta('public'));
    const pwhash = await hashPassword(PASSWORD, 1);
    await putArtifactIndex(env.BUCKET, 'locked', '<p>x</p>', meta('secured', { pwhash }));
    const IP_GATES = JSON.stringify({ acme: ['192.0.2.0/24'], example: ['198.51.100.0/99'] });
    const acme = await fetchPath('/acme/report/', { headers: { 'CF-Connecting-IP': '192.0.2.10' } }, { IP_GATES });
    expect(acme.status).toBe(403);
    expect(await acme.text()).not.toContain('acme report');
    const example = await fetchPath('/example/report/', { headers: { 'CF-Connecting-IP': '198.51.100.20' } }, { IP_GATES });
    expect(example.status).toBe(403);
    expect((await fetchPath('/deck/', {}, { IP_GATES })).status).toBe(200);
    expect((await fetchPath('/_/locked/', {}, { IP_GATES })).status).toBe(401);
  });

  it.each([
    ['unparseable IP_GATES', 'not json'],
    ['IP_GATES that is not an object', '["acme"]'],
    ['the gate removed from IP_GATES', '{"example":["198.51.100.0/24"]}'],
    ['no IP_GATES', ''],
  ])('404s a gated URL whose object exists, with %s', async (_name, IP_GATES) => {
    for (const path of ['/acme/report/', '/acme/report/x.png', '/acme/pr/some-repo/123/']) {
      const res = await fetchPath(path, { headers: { 'CF-Connecting-IP': '192.0.2.10' } }, { IP_GATES });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('report');
    }
  });

  it('never serves gated objects through public or secured URLs', async () => {
    const headers = { 'CF-Connecting-IP': '192.0.2.10' };
    for (const path of ['/gated/acme/report/', '/gated/acme/report/x.png', '/_/gated/acme/report/']) {
      expect((await fetchPath(path, { headers })).status, path).toBe(404);
    }
  });

  it('404s an unknown slug under a gate for an allowed address', async () => {
    expect((await fetchPath('/acme/nope/', { headers: { 'CF-Connecting-IP': '192.0.2.10' } })).status).toBe(404);
  });

  it('serves the gate rather than a public artifact of the same name', async () => {
    // Uploaded as public before the gate existed.
    await env.BUCKET.put('acme/index.html', '<p>old public</p>', {
      customMetadata: { visibility: 'public', created: NOW, updated: NOW, listed: 'false' },
    });
    const res = await fetchPath('/acme/', { headers: { 'CF-Connecting-IP': '203.0.113.5' } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('old public');
  });
});

describe('secured artifacts', () => {
  let pwhash: string;

  beforeEach(async () => {
    pwhash = await hashPassword(PASSWORD, 1);
    await putArtifactIndex(env.BUCKET, 'deck', '<p>secret deck</p>', meta('secured', { pwhash }));
    await env.BUCKET.put('_/deck/app.js', 'secret js');
    await putArtifactIndex(env.BUCKET, 'other', '<p>other deck</p>', meta('secured', { pwhash: await hashPassword('other', 1) }));
  });

  async function expectLoginForm(res: Response): Promise<string> {
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).not.toContain('secret');
    expect(html).not.toContain(pwhash);
    expect(html).not.toContain('pbkdf2');
    return html;
  }

  it('shows the login form without a cookie', async () => {
    await expectLoginForm(await fetchPath('/_/deck/'));
    await expectLoginForm(await fetchPath('/_/deck/app.js'));
  });

  it('shows the login form for a bad cookie', async () => {
    await expectLoginForm(await fetchPath('/_/deck/', { headers: { Cookie: 'share_auth=ok' } }));
    await expectLoginForm(await fetchPath('/_/deck/', { headers: { Cookie: 'share_auth=1999999999.AAAA' } }));
  });

  it('shows the login form for an expired cookie', async () => {
    const past = Math.floor(Date.now() / 1000) - COOKIE_TTL_SECONDS - 60;
    const value = await signCookie(env.COOKIE_SECRET, 'deck', pwhash, past);
    await expectLoginForm(await fetchPath('/_/deck/', { headers: { Cookie: `share_auth=${value}` } }));
  });

  it('shows the login form for a cookie issued for another slug', async () => {
    const res = await login('other', 'other');
    expect(res.status).toBe(303);
    await expectLoginForm(await fetchPath('/_/deck/', { headers: { Cookie: cookieFrom(res) } }));
  });

  it('logs in, sets a scoped signed cookie, and serves with it', async () => {
    const res = await login('deck', PASSWORD, '/_/deck/app.js?v=1');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/_/deck/app.js?v=1');
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toMatch(/^share_auth=\d+\.[A-Za-z0-9_-]+;/);
    expect(setCookie).toContain('Path=/_/deck/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=604800');

    const cookie = cookieFrom(res);
    const page = await fetchPath('/_/deck/', { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<p>secret deck</p>');
    expect(page.headers.get('Cache-Control')).toBe('private, no-store');
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex');
    const asset = await fetchPath('/_/deck/app.js', { headers: { Cookie: cookie } });
    expect(await asset.text()).toBe('secret js');
  });

  it('accepts a valid cookie alongside a junk one of the same name', async () => {
    const cookie = cookieFrom(await login('deck', PASSWORD));
    const res = await fetchPath('/_/deck/', { headers: { Cookie: `share_auth=junk; ${cookie}` } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('re-shows the form with an error for a wrong or missing password', async () => {
    for (const body of [new URLSearchParams({ password: 'wrong' }), new URLSearchParams(), new URLSearchParams({ password: '' })]) {
      const res = await fetchPath('/_/deck/', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      expect(res.headers.get('Set-Cookie')).toBeNull();
      const html = await expectLoginForm(res);
      expect(html).toContain('Wrong password.');
    }
  });

  it('rejects old cookies after the password changes', async () => {
    const cookie = cookieFrom(await login('deck', PASSWORD));
    const newHash = await hashPassword('new password', 1);
    await putArtifactIndex(env.BUCKET, 'deck', '<p>secret deck v2</p>', meta('secured', { pwhash: newHash }));
    await expectLoginForm(await fetchPath('/_/deck/', { headers: { Cookie: cookie } }));
    const fresh = cookieFrom(await login('deck', 'new password'));
    expect(await (await fetchPath('/_/deck/', { headers: { Cookie: fresh } })).text()).toBe('<p>secret deck v2</p>');
  });

  it('rejects old cookies after a re-upload with the same password', async () => {
    const cookie = cookieFrom(await login('deck', PASSWORD));
    await putArtifactIndex(env.BUCKET, 'deck', '<p>again</p>', meta('secured', { pwhash: await hashPassword(PASSWORD, 1) }));
    await expectLoginForm(await fetchPath('/_/deck/', { headers: { Cookie: cookie } }));
  });

  it('308s the bare slug and 404s unknown slugs', async () => {
    const bare = await fetchPath('/_/deck', { redirect: 'manual' });
    expect(bare.status).toBe(308);
    expect(bare.headers.get('Location')).toBe('/_/deck/');
    expect((await fetchPath('/_/nope/')).status).toBe(404);
    expect((await login('nope', PASSWORD)).status).toBe(404);
  });

  it('fails closed when the artifact has no valid metadata', async () => {
    await env.BUCKET.put('_/bare/index.html', '<p>no meta</p>');
    const res = await fetchPath('/_/bare/');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('no meta');
  });

  it('refuses to serve when COOKIE_SECRET is unset', async () => {
    const res = await fetchPath('/_/deck/', {}, { COOKIE_SECRET: '' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret deck');
  });
});

describe('login rate limit', () => {
  beforeEach(async () => {
    await putArtifactIndex(env.BUCKET, 'deck', '<p>secret deck</p>', meta('secured', { pwhash: await hashPassword(PASSWORD, 1) }));
    await putArtifactIndex(env.BUCKET, 'other', '<p>other deck</p>', meta('secured', { pwhash: await hashPassword('other', 1) }));
  });

  /** A limiter that records its keys and allows the first `allow` calls. */
  function fakeLimiter(allow: number): RateLimit & { keys: string[] } {
    const keys: string[] = [];
    return {
      keys,
      async limit({ key }) {
        keys.push(key);
        return { success: keys.length <= allow };
      },
    };
  }

  async function expectLimited(res: Response): Promise<void> {
    expect(res.status).toBe(429);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain('Too many attempts');
    expect(html).not.toContain('secret deck');
  }

  it('is bound in the test Worker from wrangler.toml', () => {
    expect(env.LOGIN_LIMIT).toBeDefined();
  });

  it('allows 10 attempts a minute from one IP, then answers 429 without checking the password', async () => {
    // Miniflare's windows follow the wall clock, so a run that crossed a
    // minute boundary would reset the count partway. Start well clear of one.
    while (Date.now() % 60_000 > 58_000) await new Promise((resolve) => setTimeout(resolve, 100));
    const ip = '198.18.0.1';
    for (let i = 0; i < 9; i++) expect((await login('deck', 'wrong', undefined, ip)).status).toBe(401);
    expect((await login('deck', PASSWORD, undefined, ip)).status).toBe(303);
    await expectLimited(await login('deck', PASSWORD, undefined, ip));
    // The count is per IP, not per slug.
    await expectLimited(await login('other', 'other', undefined, ip));
    expect((await login('deck', PASSWORD, undefined, '198.18.0.2')).status).toBe(303);
  });

  it('keys on CF-Connecting-IP and stops before the password check', async () => {
    const limiter = fakeLimiter(1);
    expect((await login('deck', PASSWORD, undefined, '192.0.2.7', { LOGIN_LIMIT: limiter })).status).toBe(303);
    await expectLimited(await login('deck', PASSWORD, undefined, '192.0.2.7', { LOGIN_LIMIT: limiter }));
    expect(limiter.keys).toEqual(['192.0.2.7', '192.0.2.7']);
  });

  it('counts an IPv6 client by its /64, so it cannot rotate addresses', async () => {
    const limiter = fakeLimiter(Infinity);
    for (const ip of ['2001:db8:1:2::1', '2001:DB8:1:2:ffff:ffff:ffff:fffe', '2001:db8:1:3::1', '::ffff:192.0.2.9']) {
      expect((await login('deck', 'wrong', undefined, ip, { LOGIN_LIMIT: limiter })).status).toBe(401);
    }
    expect(limiter.keys).toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:3::/64', '192.0.2.9']);
  });

  it('answers 429 for unknown slugs too, so the limit also covers probing', async () => {
    await expectLimited(await login('nope', PASSWORD, undefined, '192.0.2.8', { LOGIN_LIMIT: fakeLimiter(0) }));
  });

  it('does not limit page views', async () => {
    const res = await fetchPath('/_/deck/', {}, { LOGIN_LIMIT: fakeLimiter(0) });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('has no limit without the binding', async () => {
    const ip = '198.18.0.3';
    for (let i = 0; i < 12; i++) expect((await login('deck', 'wrong', undefined, ip, { LOGIN_LIMIT: undefined })).status).toBe(401);
    expect((await login('deck', PASSWORD, undefined, ip, { LOGIN_LIMIT: undefined })).status).toBe(303);
  });
});

describe('analytics snippet', () => {
  beforeEach(async () => {
    await putArtifactIndex(env.BUCKET, 'deck', '<html><head><title>Deck</title></head><body>deck</body></html>', meta('public'));
    await env.BUCKET.put('deck/app.js', 'console.log("</head>")');
  });

  it.each([
    ['artifact', '/deck/', 200, {}],
    ['index', '/', 200, {}],
    ['404 page', '/nope/', 404, {}],
    ['403 page', '/acme/x/', 403, {}],
    ['login page', '/_/locked/', 401, {}],
  ])('is injected before </head> on the %s', async (_name, path, status, headers) => {
    await putArtifactIndex(env.BUCKET, 'locked', '<p>x</p>', meta('secured', { pwhash: await hashPassword('pw', 1) }));
    const res = await fetchPath(path, { headers }, { ANALYTICS_SNIPPET: SNIPPET });
    expect(res.status).toBe(status);
    const html = await res.text();
    expect(html).toContain(`${SNIPPET}</head>`);
    expect(html.split(SNIPPET)).toHaveLength(2);
  });

  it('is not injected into non-HTML responses', async () => {
    const res = await fetchPath('/deck/app.js', {}, { ANALYTICS_SNIPPET: SNIPPET });
    expect(await res.text()).toBe('console.log("</head>")');
  });

  it('leaves HTML unchanged when unset or empty', async () => {
    const original = '<html><head><title>Deck</title></head><body>deck</body></html>';
    expect(await (await fetchPath('/deck/', {}, { ANALYTICS_SNIPPET: '' })).text()).toBe(original);
    expect(await (await fetchPath('/deck/', {}, { ANALYTICS_SNIPPET: undefined })).text()).toBe(original);
  });

  it('weakens the ETag of rewritten pages and still answers If-None-Match', async () => {
    const first = await fetchPath('/deck/', {}, { ANALYTICS_SNIPPET: SNIPPET });
    const etag = first.headers.get('ETag')!;
    expect(etag).toMatch(/^W\//);
    expect(first.headers.get('Content-Length')).toBeNull();
    await first.body?.cancel();
    const res = await fetchPath('/deck/', { headers: { 'If-None-Match': etag } }, { ANALYTICS_SNIPPET: SNIPPET });
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    // A new snippet must not be hidden behind a 304 for the old one.
    const changed = await fetchPath('/deck/', { headers: { 'If-None-Match': etag } }, { ANALYTICS_SNIPPET: '<script>2</script>' });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain('<script>2</script></head>');
    const removed = await fetchPath('/deck/', { headers: { 'If-None-Match': etag } }, { ANALYTICS_SNIPPET: '' });
    expect(removed.status).toBe(200);
    await removed.body?.cancel();
  });
});

describe('api routes', () => {
  it('are not handled by serving', async () => {
    const res = await fetchPath('/api/artifacts');
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});
