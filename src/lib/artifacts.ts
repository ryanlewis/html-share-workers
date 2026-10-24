/**
 * Storage contract shared by the upload API and serving.
 *
 * Where each scope lives:
 *   scope    URL                     R2 key
 *   public   /<slug>/<path>          <slug>/<path>
 *   secured  /_/<slug>/<path>        _/<slug>/<path>
 *   gated    /<gate>/<slug>/<path>   gated/<gate>/<slug>/<path>
 * Gated keys sit under their own fixed prefix, so a public lookup can never
 * reach a gated object, whatever the gate config says. Gates are named in
 * the IP_GATES config (src/lib/gates.ts).
 *
 * The default page is index.html. Per-artifact metadata lives in R2
 * customMetadata on the artifact's own index.html object, and only there:
 * other objects (including index.html pages in sub-folders) carry none.
 */

export type Visibility = 'public' | 'secured' | 'gated';

export const VISIBILITIES: readonly Visibility[] = ['public', 'secured', 'gated'];

export function isVisibility(value: string): value is Visibility {
  return (VISIBILITIES as readonly string[]).includes(value);
}

/** Where an artifact lives: its visibility, plus the gate name for gated ones. */
export type Scope = { visibility: 'public' } | { visibility: 'secured' } | { visibility: 'gated'; gate: string };

export const PUBLIC: Scope = { visibility: 'public' };
export const SECURED: Scope = { visibility: 'secured' };

export function gatedScope(gate: string): Scope {
  return { visibility: 'gated', gate };
}

export function sameScope(a: Scope, b: Scope): boolean {
  if (a.visibility !== b.visibility) return false;
  return a.visibility !== 'gated' || a.gate === (b as { gate: string }).gate;
}

export const DEFAULT_PAGE = 'index.html';

const SECURED_PREFIX = '_/';
const GATED_PREFIX = 'gated/';

/** R2 key prefix of a scope. Public artifacts sit at the bucket root. */
export function scopeKeyPrefix(scope: Scope): string {
  if (scope.visibility === 'secured') return SECURED_PREFIX;
  if (scope.visibility === 'gated') return `${GATED_PREFIX}${scope.gate}/`;
  return '';
}

/** URL path prefix of a scope, starting and ending in "/". */
export function scopeUrlPrefix(scope: Scope): string {
  if (scope.visibility === 'secured') return '/_/';
  if (scope.visibility === 'gated') return `/${scope.gate}/`;
  return '/';
}

/**
 * Public slugs that collide with top-level routes and files. Configured
 * gate names are reserved as well, but that check needs the config, so
 * callers make it themselves.
 */
export const RESERVED_PUBLIC_SLUGS: ReadonlySet<string> = new Set([
  '_',
  'gated',
  'assets',
  'index.html',
  'robots.txt',
  'favicon.ico',
  'api',
]);

/** Names a gate may not have: the reserved public slugs and the API's scope words. */
export const RESERVED_GATE_NAMES: ReadonlySet<string> = new Set([...RESERVED_PUBLIC_SLUGS, 'public', 'secured']);

export const MAX_SLUG_LENGTH = 200;
/** R2 rejects keys longer than 1024 bytes. */
export const MAX_KEY_BYTES = 1024;
/** Keeps customMetadata well under R2's 2 KB limit. */
export const MAX_TITLE_LENGTH = 200;

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Validation = { ok: true } | { ok: false; error: string };

/** Gate names are one lowercase kebab-case segment and not a reserved name. */
export function validateGateName(name: string): Validation {
  if (!SEGMENT.test(name)) {
    return { ok: false, error: `gate name "${name}" must be lowercase letters, digits and single hyphens` };
  }
  if (RESERVED_GATE_NAMES.has(name)) return { ok: false, error: `gate name "${name}" is reserved` };
  return { ok: true };
}

/**
 * Slugs are lowercase kebab-case segments. Only gated slugs may have several
 * segments separated by "/" (e.g. pr/some-repo/123). For a gated scope the
 * gate name is checked too.
 */
export function validateSlug(scope: Scope, slug: string): Validation {
  if (scope.visibility === 'gated') {
    const gate = validateGateName(scope.gate);
    if (!gate.ok) return gate;
  }
  if (slug === '') return { ok: false, error: 'slug is empty' };
  if (slug.length > MAX_SLUG_LENGTH) {
    return { ok: false, error: `slug is longer than ${MAX_SLUG_LENGTH} characters` };
  }
  const segments = slug.split('/');
  if (segments.length > 1 && scope.visibility !== 'gated') {
    return { ok: false, error: 'only gated slugs may contain "/"' };
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      return {
        ok: false,
        error: `slug segment "${segment}" must be lowercase letters, digits and single hyphens`,
      };
    }
  }
  if (scope.visibility === 'public' && RESERVED_PUBLIC_SLUGS.has(slug)) {
    return { ok: false, error: `public slug "${slug}" is reserved` };
  }
  return { ok: true };
}

/**
 * Validates a file path inside an artifact, e.g. "index.html" or
 * "assets/app.js". No leading "/", no empty, "." or ".." segments, no
 * backslashes or control characters. A trailing "/" is allowed and means
 * that folder's index.html.
 */
export function validatePath(path: string): Validation {
  if (path === '') return { ok: true };
  if (path.startsWith('/')) return { ok: false, error: 'path must not start with "/"' };
  if (/[\\\u0000-\u001f\u007f]/.test(path)) {
    return { ok: false, error: 'path contains a backslash or control character' };
  }
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, error: 'path has an empty, "." or ".." segment' };
    }
  }
  return { ok: true };
}

export class InvalidKeyError extends Error {
  override name = 'InvalidKeyError';
}

/** Key prefix of an artifact, ending in "/". Throws InvalidKeyError on a bad slug. */
export function artifactPrefix(scope: Scope, slug: string): string {
  const check = validateSlug(scope, slug);
  if (!check.ok) throw new InvalidKeyError(check.error);
  return `${scopeKeyPrefix(scope)}${slug}/`;
}

/**
 * R2 key for a file in an artifact. An empty path, or one ending in "/",
 * maps to index.html. Throws InvalidKeyError on a bad slug or path, or a
 * key over R2's length limit.
 */
export function objectKey(scope: Scope, slug: string, path = ''): string {
  const check = validatePath(path);
  if (!check.ok) throw new InvalidKeyError(check.error);
  const file = path === '' || path.endsWith('/') ? `${path}${DEFAULT_PAGE}` : path;
  const key = `${artifactPrefix(scope, slug)}${file}`;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) {
    throw new InvalidKeyError(`key is longer than ${MAX_KEY_BYTES} bytes`);
  }
  return key;
}

/** Metadata stored on an artifact's index.html. */
export interface ArtifactMeta {
  visibility: Visibility;
  /** Gated artifacts only: the gate name, matching the key's gate. */
  gate?: string;
  /** ISO 8601 timestamp. */
  created: string;
  /** ISO 8601 timestamp. */
  updated: string;
  /** Whether the generated index lists it. */
  listed: boolean;
  title?: string;
  /** Secured artifacts only: hashPassword() output from src/lib/password.ts. */
  pwhash?: string;
  /** Machine name of the upload token that last wrote it (TOKEN_M5P -> "m5p"). */
  uploadedBy?: string;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

/** Scope of an artifact from its metadata. Only call on validated metadata. */
export function metaScope(meta: ArtifactMeta): Scope {
  return meta.visibility === 'gated' ? gatedScope(meta.gate ?? '') : { visibility: meta.visibility };
}

/**
 * Checks metadata before it is written. Secured artifacts need a pwhash,
 * and the others must not have one. Gated artifacts need a valid gate
 * name, and the others must not have one.
 */
export function validateMeta(meta: ArtifactMeta): Validation {
  if (!isVisibility(meta.visibility)) return { ok: false, error: 'unknown visibility' };
  if (meta.visibility === 'gated') {
    if (meta.gate === undefined) return { ok: false, error: 'gated artifacts need a gate' };
    const gate = validateGateName(meta.gate);
    if (!gate.ok) return gate;
  } else if (meta.gate !== undefined) {
    return { ok: false, error: 'only gated artifacts have a gate' };
  }
  if (!isIsoTimestamp(meta.created)) return { ok: false, error: 'created is not an ISO timestamp' };
  if (!isIsoTimestamp(meta.updated)) return { ok: false, error: 'updated is not an ISO timestamp' };
  if (meta.title !== undefined && meta.title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `title is longer than ${MAX_TITLE_LENGTH} characters` };
  }
  if (meta.visibility === 'secured' && !meta.pwhash) {
    return { ok: false, error: 'secured artifacts need a pwhash' };
  }
  if (meta.visibility !== 'secured' && meta.pwhash !== undefined) {
    return { ok: false, error: 'only secured artifacts have a pwhash' };
  }
  return { ok: true };
}

/** ArtifactMeta as R2 customMetadata (all values are strings). */
export function toCustomMetadata(meta: ArtifactMeta): Record<string, string> {
  const out: Record<string, string> = {
    visibility: meta.visibility,
    created: meta.created,
    updated: meta.updated,
    listed: meta.listed ? 'true' : 'false',
  };
  if (meta.gate !== undefined) out.gate = meta.gate;
  if (meta.title !== undefined) out.title = meta.title;
  if (meta.pwhash !== undefined) out.pwhash = meta.pwhash;
  if (meta.uploadedBy !== undefined) out.uploadedBy = meta.uploadedBy;
  return out;
}

/**
 * Reads ArtifactMeta from R2 customMetadata. Returns null when the object
 * is not an artifact's index.html or the metadata is incomplete, including
 * a secured artifact with no pwhash or a gated one with no gate, so callers
 * fail closed.
 */
export function parseCustomMetadata(
  custom: Record<string, string> | undefined,
): ArtifactMeta | null {
  if (!custom) return null;
  const { visibility, gate, created, updated, listed, title, pwhash, uploadedBy } = custom;
  if (visibility === undefined || !isVisibility(visibility)) return null;
  if (created === undefined || updated === undefined) return null;
  if (listed !== 'true' && listed !== 'false') return null;
  const meta: ArtifactMeta = { visibility, created, updated, listed: listed === 'true' };
  if (visibility === 'gated') {
    if (!gate) return null;
    meta.gate = gate;
  }
  if (title !== undefined) meta.title = title;
  if (uploadedBy !== undefined) meta.uploadedBy = uploadedBy;
  if (visibility === 'secured') {
    if (!pwhash) return null;
    meta.pwhash = pwhash;
  }
  return validateMeta(meta).ok ? meta : null;
}

/**
 * Metadata for an artifact, or null if it does not exist or its index.html
 * has no valid metadata, or the stored scope (visibility and gate) does not
 * match the key.
 */
export async function readArtifactMeta(bucket: R2Bucket, scope: Scope, slug: string): Promise<ArtifactMeta | null> {
  const head = await bucket.head(objectKey(scope, slug));
  const meta = parseCustomMetadata(head?.customMetadata);
  return meta && sameScope(metaScope(meta), scope) ? meta : null;
}

/** Writes an artifact's index.html together with its metadata. The key is built from the scope in meta. */
export async function putArtifactIndex(
  bucket: R2Bucket,
  slug: string,
  body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  meta: ArtifactMeta,
): Promise<R2Object> {
  const check = validateMeta(meta);
  if (!check.ok) throw new InvalidKeyError(check.error);
  const key = objectKey(metaScope(meta), slug);
  return bucket.put(key, body, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: toCustomMetadata(meta),
  });
}

export interface ArtifactSummary {
  scope: Scope;
  slug: string;
  /** Key of the artifact's index.html. */
  key: string;
  /** Size of index.html in bytes. */
  size: number;
  meta: ArtifactMeta;
}

function classifyKey(key: string): { scope: Scope; rest: string } {
  if (key.startsWith(SECURED_PREFIX)) return { scope: SECURED, rest: key.slice(SECURED_PREFIX.length) };
  if (key.startsWith(GATED_PREFIX)) {
    const after = key.slice(GATED_PREFIX.length);
    const slash = after.indexOf('/');
    // An invalid gate name here fails validateSlug in listArtifacts.
    return { scope: gatedScope(after.slice(0, Math.max(slash, 0))), rest: after.slice(slash + 1) };
  }
  return { scope: PUBLIC, rest: key };
}

const INDEX_SUFFIX = `/${DEFAULT_PAGE}`;

/**
 * Lists artifacts, one entry per artifact, sorted by key. An artifact is an
 * index.html carrying valid metadata whose scope matches its key, so assets
 * and sub-folder pages are skipped. Gated artifacts are listed whether or
 * not their gate is still configured.
 *
 * With a scope, only that scope is listed, and slugPrefix narrows it to
 * slugs starting with that text (e.g. "pr/" for a gate). Without one, every
 * scope is listed and slugPrefix is ignored.
 */
export async function listArtifacts(bucket: R2Bucket, scope?: Scope, slugPrefix = ''): Promise<ArtifactSummary[]> {
  const prefix = scope ? scopeKeyPrefix(scope) + slugPrefix : '';
  const found: ArtifactSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
    for (const object of page.objects) {
      if (!object.key.endsWith(INDEX_SUFFIX)) continue;
      const { scope: keyScope, rest } = classifyKey(object.key);
      if (scope && !sameScope(keyScope, scope)) continue;
      const slug = rest.slice(0, -INDEX_SUFFIX.length);
      // "pr/" also matches gated/<gate>/pr/index.html, whose slug is "pr".
      if (scope && !slug.startsWith(slugPrefix)) continue;
      if (!validateSlug(keyScope, slug).ok) continue;
      const meta = parseCustomMetadata(object.customMetadata);
      if (!meta || !sameScope(metaScope(meta), keyScope)) continue;
      found.push({ scope: keyScope, slug, key: object.key, size: object.size, meta });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found;
}

/**
 * Per-slug upload lock. A PUT or DELETE holds it from the first read of an
 * artifact's keys to its last write, so two requests to one slug cannot mix
 * their files, and the overwrite check is made under it. It is an R2 object
 * under ".locks/", which no valid slug can reach, created with a conditional
 * put so only one request wins. It records an expiry, after which another
 * request may take it over, so a crashed upload does not wedge the slug.
 */
const LOCK_PREFIX = '.locks/';
/**
 * How long a lock is good for. The body is read before the lock is taken,
 * so this only has to cover the R2 writes of one upload (at most 25 MB)
 * and the stale-key deletes, not a slow client link.
 */
export const LOCK_TTL_MS = 5 * 60 * 1000;

export function lockKey(scope: Scope, slug: string): string {
  return `${LOCK_PREFIX}${artifactPrefix(scope, slug).slice(0, -1)}`;
}

/** A held lock: the key and the etag of the lock object this request wrote. */
export interface SlugLock {
  key: string;
  etag: string;
}

/** Takes the lock for a slug, or returns null if another request holds it. */
export async function acquireSlugLock(bucket: R2Bucket, scope: Scope, slug: string, now = Date.now()): Promise<SlugLock | null> {
  const key = lockKey(scope, slug);
  const options = { customMetadata: { expires: String(now + LOCK_TTL_MS) } };
  // R2's put returns null when the onlyIf condition fails.
  let lock = await bucket.put(key, '', { ...options, onlyIf: new Headers({ 'If-None-Match': '*' }) });
  if (!lock) {
    const held = await bucket.head(key);
    // Released between the put and the head: report it as busy rather than loop.
    if (!held) return null;
    const expires = Number(held.customMetadata?.expires);
    if (Number.isFinite(expires) && expires > now) return null;
    // Expired: take it over, but only if nobody else did first.
    lock = await bucket.put(key, '', { ...options, onlyIf: { etagMatches: held.etag } });
    if (!lock) return null;
  }
  return { key, etag: lock.etag };
}

/**
 * Releases a lock if this request still holds it. R2 deletes cannot be
 * conditional, so this is a head then a delete. If the lock expired and was
 * taken over between the two, the new holder's lock is removed. That window
 * is accepted: it needs a request to outlive LOCK_TTL_MS first.
 */
export async function releaseSlugLock(bucket: R2Bucket, lock: SlugLock): Promise<void> {
  const held = await bucket.head(lock.key);
  if (held?.etag === lock.etag) await bucket.delete(lock.key);
}
