import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  artifactPrefix,
  type ArtifactMeta,
  gatedScope,
  InvalidKeyError,
  listArtifacts,
  objectKey,
  parseCustomMetadata,
  PUBLIC,
  putArtifactIndex,
  readArtifactMeta,
  RESERVED_GATE_NAMES,
  RESERVED_PUBLIC_SLUGS,
  type Scope,
  SECURED,
  toCustomMetadata,
  validateGateName,
  validateMeta,
  validatePath,
  validateSlug,
} from '../src/lib/artifacts';

const NOW = '2026-10-24T12:00:00.000Z';
const ACME = gatedScope('acme');
const EXAMPLE = gatedScope('example');
const gated = (gate: string): Partial<ArtifactMeta> => ({ visibility: 'gated', gate });

function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return { visibility: 'public', created: NOW, updated: NOW, listed: false, ...overrides };
}

describe('validateSlug', () => {
  it.each(['a', 'q1-deck', 'abc123', '9f3e2a1b', 'a-b-c'])('accepts %s for every visibility', (slug) => {
    expect(validateSlug(PUBLIC, slug).ok).toBe(true);
    expect(validateSlug(SECURED, slug).ok).toBe(true);
    expect(validateSlug(ACME, slug).ok).toBe(true);
  });

  it.each([
    '',
    'Q1-deck',
    'q1_deck',
    'q1 deck',
    '-lead',
    'trail-',
    'double--hyphen',
    '..',
    '.',
    'a.b',
    'café',
    'a%2fb',
  ])('rejects %j', (slug) => {
    expect(validateSlug(PUBLIC, slug).ok).toBe(false);
    expect(validateSlug(ACME, slug).ok).toBe(false);
  });

  it('rejects slugs over the length limit', () => {
    expect(validateSlug(PUBLIC, 'a'.repeat(200)).ok).toBe(true);
    expect(validateSlug(PUBLIC, 'a'.repeat(201)).ok).toBe(false);
  });

  it('allows "/" in gated slugs only', () => {
    expect(validateSlug(ACME, 'pr/some-repo/123').ok).toBe(true);
    expect(validateSlug(PUBLIC, 'pr/some-repo').ok).toBe(false);
    expect(validateSlug(SECURED, 'pr/some-repo').ok).toBe(false);
  });

  it.each(['pr//123', '/pr', 'pr/', 'pr/../x', 'pr/./x', 'pr/Upper'])('rejects gated slug %j', (slug) => {
    expect(validateSlug(ACME, slug).ok).toBe(false);
  });

  it('reserves top-level names for public slugs only', () => {
    for (const slug of ['_', 'gated', 'assets', 'api', 'index.html', 'robots.txt', 'favicon.ico']) {
      expect(RESERVED_PUBLIC_SLUGS.has(slug)).toBe(true);
      expect(validateSlug(PUBLIC, slug).ok).toBe(false);
    }
    for (const slug of ['gated', 'assets', 'api']) {
      expect(validateSlug(SECURED, slug).ok).toBe(true);
      expect(validateSlug(ACME, slug).ok).toBe(true);
    }
  });

  it('rejects a gated scope with a bad gate name', () => {
    expect(validateSlug(gatedScope('Acme'), 'x').ok).toBe(false);
    expect(validateSlug(gatedScope('api'), 'x').ok).toBe(false);
    expect(validateSlug(gatedScope(''), 'x').ok).toBe(false);
  });
});

describe('validateGateName', () => {
  it.each(['acme', 'example', 'team-2'])('accepts %s', (name) => {
    expect(validateGateName(name).ok).toBe(true);
  });

  it.each(['', 'Acme', 'a/b', 'a_b', '-a', '_', 'api', 'assets', 'gated', 'public', 'secured', 'robots.txt'])(
    'rejects %j',
    (name) => {
      expect(validateGateName(name).ok).toBe(false);
    },
  );

  it('reserves every reserved public slug plus the API scope words', () => {
    for (const slug of RESERVED_PUBLIC_SLUGS) expect(RESERVED_GATE_NAMES.has(slug)).toBe(true);
    expect(RESERVED_GATE_NAMES.has('public')).toBe(true);
    expect(RESERVED_GATE_NAMES.has('secured')).toBe(true);
  });
});

describe('validatePath', () => {
  it.each(['', 'index.html', 'assets/app.js', 'sub/', 'sub/page.html', 'Image_01.PNG'])('accepts %j', (path) => {
    expect(validatePath(path).ok).toBe(true);
  });

  it.each(['/index.html', '../x', 'a/../b', './a', 'a//b', 'a\\b', 'a\nb', '//', '/'])('rejects %j', (path) => {
    expect(validatePath(path).ok).toBe(false);
  });
});

describe('objectKey', () => {
  it('maps each scope to its prefix with index.html as the default page', () => {
    expect(objectKey(PUBLIC, 'q1-deck')).toBe('q1-deck/index.html');
    expect(objectKey(SECURED, 'q1-deck')).toBe('_/q1-deck/index.html');
    expect(objectKey(ACME, 'q1-deck')).toBe('gated/acme/q1-deck/index.html');
    expect(objectKey(EXAMPLE, 'q1-deck')).toBe('gated/example/q1-deck/index.html');
    expect(objectKey(ACME, 'pr/some-repo/123')).toBe('gated/acme/pr/some-repo/123/index.html');
  });

  it('maps file paths and folder paths', () => {
    expect(objectKey(PUBLIC, 'q1-deck', 'assets/app.js')).toBe('q1-deck/assets/app.js');
    expect(objectKey(SECURED, 'q1-deck', 'sub/')).toBe('_/q1-deck/sub/index.html');
  });

  it('throws InvalidKeyError on a bad slug, path or gate name', () => {
    expect(() => objectKey(PUBLIC, 'api')).toThrow(InvalidKeyError);
    expect(() => objectKey(PUBLIC, 'ok', '../escape')).toThrow(InvalidKeyError);
    expect(() => artifactPrefix(SECURED, 'a/b')).toThrow(InvalidKeyError);
    expect(() => objectKey(gatedScope('../x'), 'ok')).toThrow(InvalidKeyError);
  });

  it('throws InvalidKeyError when the key would exceed R2\'s 1024-byte limit', () => {
    const slug = 'a'.repeat(200);
    // gated/acme/ + slug + / = 212 bytes, so 812 bytes of path is exactly 1024.
    expect(objectKey(ACME, slug, 'p'.repeat(812))).toHaveLength(1024);
    expect(() => objectKey(ACME, slug, 'p'.repeat(813))).toThrow(InvalidKeyError);
    expect(() => objectKey(ACME, slug, 'é'.repeat(407))).toThrow(InvalidKeyError);
  });
});

describe('metadata', () => {
  it('round-trips through customMetadata', () => {
    const m = meta({ visibility: 'secured', listed: true, title: 'Q1 deck', pwhash: 'pbkdf2-sha256$1$a$b' });
    const custom = toCustomMetadata(m);
    expect(custom).toEqual({
      visibility: 'secured',
      created: NOW,
      updated: NOW,
      listed: 'true',
      title: 'Q1 deck',
      pwhash: 'pbkdf2-sha256$1$a$b',
    });
    expect(parseCustomMetadata(custom)).toEqual(m);
  });

  it('round-trips uploadedBy', () => {
    const m = meta({ uploadedBy: 'm5p' });
    expect(toCustomMetadata(m)).toEqual({ ...toCustomMetadata(meta()), uploadedBy: 'm5p' });
    expect(parseCustomMetadata(toCustomMetadata(m))).toEqual(m);
  });

  it('omits optional fields that are not set', () => {
    expect(toCustomMetadata(meta())).toEqual({ visibility: 'public', created: NOW, updated: NOW, listed: 'false' });
  });

  it('rejects incomplete or inconsistent metadata', () => {
    const base = toCustomMetadata(meta());
    expect(parseCustomMetadata(undefined)).toBeNull();
    expect(parseCustomMetadata({})).toBeNull();
    expect(parseCustomMetadata({ ...base, visibility: 'private' })).toBeNull();
    expect(parseCustomMetadata({ ...base, listed: 'yes' })).toBeNull();
    expect(parseCustomMetadata({ ...base, created: 'yesterday' })).toBeNull();
    const { updated: _updated, ...noUpdated } = base;
    expect(parseCustomMetadata(noUpdated)).toBeNull();
    // A secured artifact without a password hash must not be served.
    expect(parseCustomMetadata({ ...base, visibility: 'secured' })).toBeNull();
  });

  it('drops a pwhash on non-secured metadata', () => {
    expect(parseCustomMetadata({ ...toCustomMetadata(meta()), pwhash: 'x' })?.pwhash).toBeUndefined();
  });

  it('round-trips the gate of gated metadata', () => {
    const m = meta(gated('acme'));
    expect(toCustomMetadata(m)).toEqual({ ...toCustomMetadata(meta()), visibility: 'gated', gate: 'acme' });
    expect(parseCustomMetadata(toCustomMetadata(m))).toEqual(m);
  });

  it('rejects gated metadata without a valid gate', () => {
    const base = toCustomMetadata(meta());
    expect(parseCustomMetadata({ ...base, visibility: 'gated' })).toBeNull();
    expect(parseCustomMetadata({ ...base, visibility: 'gated', gate: '' })).toBeNull();
    expect(parseCustomMetadata({ ...base, visibility: 'gated', gate: 'Bad' })).toBeNull();
    expect(parseCustomMetadata({ ...base, visibility: 'gated', gate: 'api' })).toBeNull();
    expect(validateMeta(meta({ visibility: 'gated' })).ok).toBe(false);
    expect(validateMeta(meta({ gate: 'acme' })).ok).toBe(false);
  });

  it('drops a gate on non-gated metadata', () => {
    expect(parseCustomMetadata({ ...toCustomMetadata(meta()), gate: 'acme' })?.gate).toBeUndefined();
  });
});

async function clearBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

describe('R2 helpers', () => {
  beforeEach(clearBucket);

  it('writes index.html with metadata and reads it back', async () => {
    await putArtifactIndex(env.BUCKET, 'q1-deck', '<h1>hi</h1>', meta({ title: 'Q1' }));
    const object = await env.BUCKET.get('q1-deck/index.html');
    expect(await object?.text()).toBe('<h1>hi</h1>');
    expect(object?.httpMetadata?.contentType).toBe('text/html; charset=utf-8');
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'q1-deck')).toEqual(meta({ title: 'Q1' }));
  });

  it('writes gated artifacts under gated/<gate>/', async () => {
    await putArtifactIndex(env.BUCKET, 'pr/1', 'g', meta(gated('acme')));
    expect(await env.BUCKET.head('gated/acme/pr/1/index.html')).not.toBeNull();
    expect(await readArtifactMeta(env.BUCKET, ACME, 'pr/1')).toEqual(meta(gated('acme')));
  });

  it('returns null for a missing artifact or one stored under another scope', async () => {
    expect(await readArtifactMeta(env.BUCKET, PUBLIC, 'missing')).toBeNull();
    // Metadata claims public, but the object sits under a gate.
    await env.BUCKET.put('gated/acme/mismatch/index.html', 'x', { customMetadata: toCustomMetadata(meta()) });
    expect(await readArtifactMeta(env.BUCKET, ACME, 'mismatch')).toBeNull();
    // Metadata names another gate than the key.
    await env.BUCKET.put('gated/acme/other/index.html', 'x', { customMetadata: toCustomMetadata(meta(gated('example'))) });
    expect(await readArtifactMeta(env.BUCKET, ACME, 'other')).toBeNull();
    expect(await readArtifactMeta(env.BUCKET, EXAMPLE, 'other')).toBeNull();
    // Gated metadata with no gate at all.
    await env.BUCKET.put('gated/acme/nogate/index.html', 'x', {
      customMetadata: { ...toCustomMetadata(meta()), visibility: 'gated' },
    });
    expect(await readArtifactMeta(env.BUCKET, ACME, 'nogate')).toBeNull();
  });

  it('refuses to write invalid metadata', async () => {
    await expect(putArtifactIndex(env.BUCKET, 'x', 'x', meta({ visibility: 'secured' }))).rejects.toThrow(
      InvalidKeyError,
    );
    await expect(putArtifactIndex(env.BUCKET, 'x', 'x', meta({ pwhash: 'h' }))).rejects.toThrow(InvalidKeyError);
    await expect(putArtifactIndex(env.BUCKET, 'api', 'x', meta())).rejects.toThrow(InvalidKeyError);
    // Over-long titles would exceed R2's customMetadata limit inside put().
    await expect(putArtifactIndex(env.BUCKET, 'x', 'x', meta({ title: 't'.repeat(3000) }))).rejects.toThrow(
      InvalidKeyError,
    );
  });

  async function seed(): Promise<void> {
    await putArtifactIndex(env.BUCKET, 'alpha', 'a', meta({ listed: true }));
    await env.BUCKET.put('alpha/assets/app.js', 'js');
    await env.BUCKET.put('alpha/sub/index.html', 'sub page, no metadata');
    await putArtifactIndex(env.BUCKET, 'beta', 'b', meta({ visibility: 'secured', pwhash: 'h' }));
    await putArtifactIndex(env.BUCKET, 'gamma', 'g', meta(gated('acme')));
    await putArtifactIndex(env.BUCKET, 'pr', 'p', meta(gated('acme')));
    await putArtifactIndex(env.BUCKET, 'pr/some-repo/123', 'pr', meta(gated('acme')));
    await env.BUCKET.put('gated/acme/pr/some-repo/123/style.css', 'css');
    await putArtifactIndex(env.BUCKET, 'delta', 'd', meta(gated('example')));
    // Gated metadata under the wrong gate is not an artifact.
    await env.BUCKET.put('gated/example/wrong/index.html', 'w', { customMetadata: toCustomMetadata(meta(gated('acme'))) });
    await env.BUCKET.put('robots.txt', 'User-agent: *\nDisallow: /');
    await env.BUCKET.put('orphan/index.html', 'no metadata');
  }

  it('lists one entry per artifact across all visibilities', async () => {
    await seed();
    const all = await listArtifacts(env.BUCKET);
    const label = (s: Scope) => (s.visibility === 'gated' ? `gated:${s.gate}` : s.visibility);
    expect(all.map((a) => `${label(a.scope)}:${a.slug}`)).toEqual([
      'secured:beta',
      'public:alpha',
      'gated:acme:gamma',
      'gated:acme:pr',
      'gated:acme:pr/some-repo/123',
      'gated:example:delta',
    ]);
    const alpha = all.find((a) => a.slug === 'alpha');
    expect(alpha).toMatchObject({ key: 'alpha/index.html', size: 1, meta: { listed: true } });
  });

  it('lists by visibility and slug prefix', async () => {
    await seed();
    const slugs = async (scope: Scope, prefix?: string) =>
      (await listArtifacts(env.BUCKET, scope, prefix)).map((a) => a.slug);
    expect(await slugs(PUBLIC)).toEqual(['alpha']);
    expect(await slugs(SECURED)).toEqual(['beta']);
    expect(await slugs(ACME)).toEqual(['gamma', 'pr', 'pr/some-repo/123']);
    expect(await slugs(ACME, 'pr/')).toEqual(['pr/some-repo/123']);
    expect(await slugs(EXAMPLE)).toEqual(['delta']);
    expect(await slugs(gatedScope('other'))).toEqual([]);
    expect(await slugs(PUBLIC, 'al')).toEqual(['alpha']);
  });

  it('follows pagination', async () => {
    for (let i = 0; i < 1005; i++) {
      await env.BUCKET.put(`many/f${i}.txt`, '');
    }
    await putArtifactIndex(env.BUCKET, 'zz-last', 'z', meta());
    expect((await listArtifacts(env.BUCKET, PUBLIC)).map((a) => a.slug)).toEqual(['zz-last']);
  });
});
