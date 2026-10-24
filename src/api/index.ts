import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  acquireSlugLock,
  artifactPrefix,
  type ArtifactMeta,
  DEFAULT_PAGE,
  gatedScope,
  InvalidKeyError,
  listArtifacts,
  LOCK_TTL_MS,
  metaScope,
  parseCustomMetadata,
  PUBLIC,
  putArtifactIndex,
  readArtifactMeta,
  releaseSlugLock,
  sameScope,
  type Scope,
  scopeUrlPrefix,
  SECURED,
  validateMeta,
  validateSlug,
} from '../lib/artifacts';
import { gatesFor } from '../lib/gates';
import { hashPassword } from '../lib/password';
import { bearerAuth, type ApiEnv } from './auth';
import { parseMultipart, type ParsedUpload } from './files';

// Upload API, mounted at /api. Routes here are relative to /api.
const api = new Hono<ApiEnv>();

export const PUBLIC_BASE = 'https://share.rlew.io';
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
/** R2 deletes at most 1000 keys per call. */
const DELETE_BATCH = 1000;

class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

export function artifactUrl(scope: Scope, slug: string): string {
  return `${PUBLIC_BASE}${scopeUrlPrefix(scope)}${slug}/`;
}

/** The visibility and, for gated artifacts, the gate name, as the API shows them. */
function scopeFields(scope: Scope) {
  return scope.visibility === 'gated' ? { visibility: scope.visibility, gate: scope.gate } : { visibility: scope.visibility };
}

/** What the API shows of an artifact. Never includes the pwhash. */
function describe(scope: Scope, slug: string, meta: ArtifactMeta) {
  return {
    url: artifactUrl(scope, slug),
    ...scopeFields(scope),
    slug,
    created: meta.created,
    updated: meta.updated,
    listed: meta.listed,
    ...(meta.title !== undefined && { title: meta.title }),
    ...(meta.uploadedBy !== undefined && { uploadedBy: meta.uploadedBy }),
  };
}

/** 18 random bytes as base64url: 24 characters, 144 bits. */
export function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

const SCOPE_ERROR = 'scope must be public, secured or a configured gate name';

/** Resolves "public", "secured" or a configured gate name. 400 otherwise. */
function resolveScope(name: string, gates: ReadonlySet<string>): Scope {
  if (name === 'public') return PUBLIC;
  if (name === 'secured') return SECURED;
  if (gates.has(name)) return gatedScope(name);
  throw new ApiError(400, SCOPE_ERROR);
}

/**
 * The scope and slug of the request. For uploads, a public slug equal to a
 * configured gate name is refused: serving gives /<gate>/ priority, so it
 * could never be reached. GET and DELETE still work on one, so an artifact
 * shadowed by a gate added later can be removed.
 */
function target(c: Context<ApiEnv>, upload = false): { scope: Scope; slug: string } {
  const gates = gatesFor(c.env.IP_GATES).names;
  const scope = resolveScope(c.req.param('scope') ?? '', gates);
  const slug = c.req.param('slug') ?? '';
  const check = validateSlug(scope, slug);
  if (!check.ok) throw new ApiError(400, check.error);
  if (upload && scope.visibility === 'public' && gates.has(slug)) {
    throw new ApiError(400, `public slug "${slug}" is reserved`);
  }
  return { scope, slug };
}

/** A setting from the query string, else from its X-Share-* header. */
function setting(c: Context<ApiEnv>, query: string, header: string): string | undefined {
  return c.req.query(query) ?? c.req.header(header);
}

/** undefined means the request did not set it. */
function parseFlag(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === '' || v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ApiError(400, `${name} must be true or false`);
}

/**
 * Keys belonging to an artifact, and the slugs of other artifacts nested
 * inside its prefix (only possible for gated scopes). Keys of nested
 * artifacts are left out so removing one artifact never touches another.
 */
async function scanArtifact(bucket: R2Bucket, scope: Scope, slug: string): Promise<{ keys: string[]; nested: string[] }> {
  const prefix = artifactPrefix(scope, slug);
  const all: string[] = [];
  const nestedPrefixes: string[] = [];
  const nested: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
    for (const object of page.objects) {
      all.push(object.key);
      const rest = object.key.slice(prefix.length);
      if (scope.visibility !== 'gated' || !rest.endsWith(`/${DEFAULT_PAGE}`)) continue;
      const inner = `${slug}/${rest.slice(0, -DEFAULT_PAGE.length - 1)}`;
      const meta = parseCustomMetadata(object.customMetadata);
      if (meta && sameScope(metaScope(meta), scope) && validateSlug(scope, inner).ok) {
        nested.push(inner);
        nestedPrefixes.push(artifactPrefix(scope, inner));
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const keys = all.filter((key) => !nestedPrefixes.some((p) => key.startsWith(p)));
  return { keys, nested };
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    await bucket.delete(keys.slice(i, i + DELETE_BATCH));
  }
}

/** Refuses a gated slug that would sit inside, or contain, another artifact of the same gate. */
async function checkNesting(bucket: R2Bucket, scope: Scope, slug: string, nested: string[]) {
  if (scope.visibility !== 'gated') return;
  if (nested.length > 0) {
    throw new ApiError(409, `"${slug}" would contain the existing artifact "${nested[0]}"`);
  }
  const segments = slug.split('/');
  for (let i = 1; i < segments.length; i++) {
    const outer = segments.slice(0, i).join('/');
    if (await readArtifactMeta(bucket, scope, outer)) {
      throw new ApiError(409, `"${slug}" would sit inside the existing artifact "${outer}"`);
    }
  }
}

/**
 * Runs fn holding the slug's lock, or its gate's (src/lib/artifacts.ts).
 * 409 if another request holds it; nothing has been read or written by then.
 */
async function withSlugLock<T>(bucket: R2Bucket, scope: Scope, slug: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireSlugLock(bucket, scope, slug);
  if (!lock) {
    const what = scope.visibility === 'gated' ? `in gate "${scope.gate}"` : `of "${slug}"`;
    throw new ApiError(409, `another upload or delete ${what} is in progress (a stale lock expires within ${LOCK_TTL_MS / 60_000} minutes)`);
  }
  try {
    return await fn();
  } finally {
    // A failed release must not replace fn's result (a new password, say);
    // the lock expires on its own.
    await releaseSlugLock(bucket, lock).catch((err) => console.error('releasing slug lock failed', err));
  }
}

async function readUpload(c: Context<ApiEnv>, scope: Scope, slug: string): Promise<ParsedUpload> {
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'text/html') {
    const index = await c.req.arrayBuffer();
    if (index.byteLength === 0) throw new ApiError(400, 'body is empty');
    return { index, assets: [] };
  }
  if (type === 'multipart/form-data') {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new ApiError(400, 'body is not valid multipart/form-data');
    }
    const parsed = await parseMultipart(form, scope, slug);
    if (!parsed.ok) throw new ApiError(400, parsed.error);
    return parsed.upload;
  }
  throw new ApiError(415, 'Content-Type must be text/html or multipart/form-data');
}

api.use('*', bearerAuth);

api.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
  if (err instanceof InvalidKeyError) return c.json({ error: err.message }, 400);
  console.error('api error', err);
  return c.json({ error: 'internal error' }, 500);
});

api.get('/artifacts', async (c) => {
  const filter = c.req.query('visibility');
  const scope = filter === undefined ? undefined : resolveScope(filter, gatesFor(c.env.IP_GATES).names);
  const found = await listArtifacts(c.env.BUCKET, scope);
  return c.json({
    artifacts: found.map((a) => ({ ...describe(a.scope, a.slug, a.meta), size: a.size })),
  });
});

const ARTIFACT = '/artifacts/:scope/:slug{.+}';

api.get(ARTIFACT, async (c) => {
  const { scope, slug } = target(c);
  const meta = await readArtifactMeta(c.env.BUCKET, scope, slug);
  if (!meta) throw new ApiError(404, 'artifact not found');
  return c.json(describe(scope, slug, meta));
});

api.put(
  ARTIFACT,
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: `body is larger than ${MAX_BODY_BYTES} bytes` }, 413),
  }),
  async (c) => {
    const { scope, slug } = target(c, true);
    const bucket = c.env.BUCKET;

    // undefined = not set: a replace keeps the old value. An empty title clears it.
    const givenTitle = setting(c, 'title', 'X-Share-Title');
    const givenListed = parseFlag(setting(c, 'listed', 'X-Share-Listed'), 'listed');
    const givenRegenerate = setting(c, 'regenerate', 'X-Share-Password-Regenerate');
    // An empty value is refused rather than read as true: this one invalidates links.
    if (givenRegenerate === '') throw new ApiError(400, 'regenerate must be true or false');
    const regenerate = parseFlag(givenRegenerate, 'regenerate') ?? false;
    const givenPassword = c.req.header('X-Share-Password');
    if (givenPassword !== undefined && scope.visibility !== 'secured') {
      throw new ApiError(400, 'X-Share-Password is only for secured artifacts');
    }
    if (givenPassword === '') throw new ApiError(400, 'X-Share-Password is empty');
    if (regenerate && scope.visibility !== 'secured') {
      throw new ApiError(400, 'regenerate is only for secured artifacts');
    }
    if (regenerate && givenPassword !== undefined) {
      throw new ApiError(400, 'regenerate and X-Share-Password cannot be combined');
    }

    const givenOverwrite = setting(c, 'overwrite', 'X-Share-Overwrite');
    // Refused when empty, like regenerate: this one replaces an artifact.
    if (givenOverwrite === '') throw new ApiError(400, 'overwrite must be true or false');
    const overwrite = parseFlag(givenOverwrite, 'overwrite') ?? false;
    // The body is read before taking the lock, so a slow client does not hold it.
    const upload = await readUpload(c, scope, slug);

    return withSlugLock(bucket, scope, slug, async () => {
      const before = await scanArtifact(bucket, scope, slug);
      await checkNesting(bucket, scope, slug, before.nested);
      const existing = await readArtifactMeta(bucket, scope, slug);
      if (existing && !overwrite) {
        throw new ApiError(409, `"${slug}" already exists (set overwrite=true to replace it)`);
      }
      const now = new Date().toISOString();
      // A secured replace keeps the old hash (and so the old cookies and the
      // shared password) unless a password is given or a new one is asked for.
      const keepHash = scope.visibility === 'secured' && existing?.pwhash !== undefined && givenPassword === undefined && !regenerate;
      const password = scope.visibility === 'secured' && !keepHash ? (givenPassword ?? generatePassword()) : undefined;
      const pwhash = keepHash ? existing.pwhash : password !== undefined ? await hashPassword(password) : undefined;
      const title = givenTitle === undefined ? existing?.title : givenTitle || undefined;
      const meta: ArtifactMeta = {
        ...scopeFields(scope),
        created: existing?.created ?? now,
        updated: now,
        listed: givenListed ?? existing?.listed ?? false,
        uploadedBy: c.get('machine'),
        ...(title !== undefined && { title }),
        ...(pwhash !== undefined && { pwhash }),
      };

      const check = validateMeta(meta);
      if (!check.ok) throw new ApiError(400, check.error);

      for (const asset of upload.assets) {
        await bucket.put(asset.key, asset.body, { httpMetadata: { contentType: asset.contentType } });
      }
      // index.html last: a new artifact only counts as existing once it is complete.
      const indexKey = (await putArtifactIndex(bucket, slug, upload.index, meta)).key;
      // Then remove the old files the new upload does not have, so stale
      // siblings do not linger. Doing this last means a failed upload leaves
      // the old artifact in place rather than nothing.
      const written = new Set([indexKey, ...upload.assets.map((a) => a.key)]);
      await deleteKeys(bucket, before.keys.filter((key) => !written.has(key)));

      c.header('Cache-Control', 'no-store');
      return c.json(
        {
          ...describe(scope, slug, meta),
          ...(password !== undefined && givenPassword === undefined && { password }),
          ...(keepHash && { passwordUnchanged: true }),
        },
        existing ? 200 : 201,
      );
    });
  },
);

api.delete(ARTIFACT, async (c) => {
  const { scope, slug } = target(c);
  const keys = await withSlugLock(c.env.BUCKET, scope, slug, async () => {
    const { keys } = await scanArtifact(c.env.BUCKET, scope, slug);
    if (keys.length === 0) throw new ApiError(404, 'artifact not found');
    await deleteKeys(c.env.BUCKET, keys);
    return keys;
  });
  return c.json({ deleted: true, url: artifactUrl(scope, slug), ...scopeFields(scope), slug, objects: keys.length });
});

export default api;
