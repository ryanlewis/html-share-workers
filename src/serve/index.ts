import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../env';
import {
  gatedScope,
  InvalidKeyError,
  listArtifacts,
  objectKey,
  PUBLIC,
  readArtifactMeta,
  type Scope,
  SECURED,
  validateSlug,
} from '../lib/artifacts';
import { clientNetwork, ipAllowed } from '../lib/cidr';
import { type Gates, gatesFor } from '../lib/gates';
import type { LoginAttempt, LoginLimiter } from '../lib/login-limiter';
import { verifyPassword } from '../lib/password';
import { pointsAt, type Redirects, redirectLocation, redirectsFor, trimSlashes } from '../lib/redirects';
import { COOKIE_NAME, cookieValues, setCookieHeader, signCookie, verifyCookie } from './cookie';
import { forbiddenPage, indexPage, loginPage, notFoundPage } from './pages';

// Serving for everything outside /api: artifacts, index, robots.txt, redirects.
const serve = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

const CACHE_PUBLIC = 'public, max-age=300';
const CACHE_INDEX = 'public, max-age=60';
const CACHE_PRIVATE = 'private, no-store';
const CACHE_NONE = 'no-store';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wasm: 'application/wasm',
};

function contentTypeFor(key: string, stored: string | undefined): string {
  if (stored) return stored;
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream';
}

function isHtml(contentType: string | null): boolean {
  return contentType !== null && /^text\/html\b/i.test(contentType);
}

function htmlResponse(body: string, status: number, cacheControl = CACHE_NONE): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl },
  });
}

const notFound = () => htmlResponse(notFoundPage(), 404);

const methodNotAllowed = () =>
  new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': CACHE_NONE } });

function redirect(location: string, status: 303 | 308): Response {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': CACHE_NONE } });
}

/**
 * A request path split into segments, both raw (as sent, still
 * percent-encoded) and decoded. Null when a segment does not decode, or
 * decodes to something containing "/".
 */
interface RequestPath {
  raw: string[];
  decoded: string[];
  trailingSlash: boolean;
}

function splitPath(pathname: string): RequestPath | null {
  const trailingSlash = pathname.length > 1 && pathname.endsWith('/');
  const inner = pathname.slice(1, trailingSlash ? -1 : undefined);
  const raw = inner === '' ? [] : inner.split('/');
  const decoded: string[] = [];
  for (const segment of raw) {
    let text: string;
    try {
      text = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (text.includes('/')) return null;
    decoded.push(text);
  }
  return { raw, decoded, trailingSlash };
}

/** Path inside an artifact from its remaining segments: "" means the artifact root. */
function innerPath(segments: string[], trailingSlash: boolean): string {
  if (segments.length === 0) return '';
  return segments.join('/') + (trailingSlash ? '/' : '');
}

/** 32-bit FNV-1a, as 8 hex digits. Only used to tell snippet versions apart. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * ETag for a stored object as served. HTML that gets the analytics snippet
 * no longer matches the object byte for byte, so its ETag is weak and
 * includes a hash of the snippet: changing the snippet changes the ETag.
 */
function responseEtag(httpEtag: string, snippet: string | undefined): string {
  if (!snippet) return httpEtag;
  const inner = httpEtag.replace(/^W\//, '').replace(/^"|"$/g, '');
  return `W/"${inner}-${fnv1a(snippet)}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || bare(tag) === bare(etag));
}

/**
 * Serves one file of an artifact from R2. On a miss for a path without a
 * trailing slash, redirects to the folder form when that folder has an
 * index.html.
 */
async function serveObject(
  c: Ctx,
  scope: Scope,
  slug: string,
  path: string,
  cacheControl: string,
): Promise<Response> {
  let key: string;
  try {
    key = objectKey(scope, slug, path);
  } catch (err) {
    if (err instanceof InvalidKeyError) return notFound();
    throw err;
  }
  const bucket = c.env.BUCKET;
  const isHead = c.req.method === 'HEAD';
  const object = isHead ? await bucket.head(key) : await bucket.get(key);
  if (!object) {
    if (path !== '' && !path.endsWith('/')) {
      let folderKey: string | null = null;
      try {
        folderKey = objectKey(scope, slug, `${path}/`);
      } catch {
        // The folder form is not a valid key either.
      }
      if (folderKey && (await bucket.head(folderKey))) {
        const url = new URL(c.req.url);
        return redirect(`${url.pathname}/${url.search}`, 308);
      }
    }
    return notFound();
  }

  const contentType = contentTypeFor(key, object.httpMetadata?.contentType);
  const etag = responseEtag(object.httpEtag, isHtml(contentType) ? c.env.ANALYTICS_SNIPPET : undefined);
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    ETag: etag,
    'Last-Modified': object.uploaded.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  });
  const body = 'body' in object ? (object as R2ObjectBody).body : null;
  if (etagMatches(c.req.header('If-None-Match') ?? null, etag)) {
    await body?.cancel();
    headers.delete('Content-Type');
    headers.delete('Last-Modified');
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(body, { status: 200, headers });
}

async function generatedIndex(c: Ctx): Promise<Response> {
  const gates = gatesFor(c.env.IP_GATES).names;
  // Leave out links that would not reach the artifact: gated ones whose
  // gate is no longer configured, and public ones shadowed by a gate.
  const reachable = (scope: Scope, slug: string) =>
    scope.visibility === 'gated' ? gates.has(scope.gate) : scope.visibility !== 'public' || !gates.has(slug);
  const listed = (await listArtifacts(c.env.BUCKET))
    .filter((a) => a.meta.listed && reachable(a.scope, a.slug))
    .sort((a, b) => b.meta.updated.localeCompare(a.meta.updated) || a.key.localeCompare(b.key));
  return htmlResponse(indexPage(listed), 200, CACHE_INDEX);
}

/**
 * Redirect target for an exact-path key, keeping the query. Keys are matched
 * against the decoded path, ignoring a trailing slash, so "/lhv/" matches both
 * /lhv and /lhv/. A target on this host at the same path is skipped, so an
 * entry can never redirect to itself.
 */
function exactRedirectFor(redirects: Redirects, url: URL, requestPath: RequestPath): string | null {
  const path = trimSlashes(`/${requestPath.decoded.join('/')}`);
  const target = redirects.exact.get(path);
  if (target === undefined || pointsAt(target, url, path)) return null;
  return redirectLocation(target, null, url.search);
}

/** Redirect target for a top-level slug, keeping the sub-path and query. */
function redirectFor(redirects: Redirects, url: URL, path: RequestPath): string | null {
  const slug = path.decoded[0];
  if (slug === undefined) return null;
  const target = redirects.slugs.get(slug);
  if (target === undefined || pointsAt(target, url, `/${slug}`)) return null;
  return redirectLocation(target, url.pathname.slice(1 + path.raw[0]!.length), url.search);
}

/** Splits segments (after any prefix) into slug and path. */
function slugAndPath(
  scope: Scope,
  segments: string[],
  trailingSlash: boolean,
): { slug: string; path: string; bare: boolean } | null {
  const slug = segments[0];
  if (slug === undefined || !validateSlug(scope, slug).ok) return null;
  const bare = segments.length === 1 && !trailingSlash;
  return { slug, path: innerPath(segments.slice(1), trailingSlash), bare };
}

function bareRedirect(c: Ctx): Response {
  const url = new URL(c.req.url);
  return redirect(`${url.pathname}/${url.search}`, 308);
}

async function servePublic(c: Ctx, path: RequestPath): Promise<Response> {
  const parts = slugAndPath(PUBLIC, path.decoded, path.trailingSlash);
  if (!parts) return notFound();
  if (parts.bare) return bareRedirect(c);
  return serveObject(c, PUBLIC, parts.slug, parts.path, CACHE_PUBLIC);
}

async function serveGated(c: Ctx, gates: Gates, gate: string, segments: string[], trailingSlash: boolean): Promise<Response> {
  // Only this gate's ranges count, so access to one gate never opens
  // another. CF-Connecting-IP is set by Cloudflare and cannot be supplied
  // by the client. X-Forwarded-For can, so it is never read. With a bad
  // IP_GATES entry, ranges is null and every gate refuses.
  const ranges = gates.ranges?.get(gate);
  const ip = c.req.header('CF-Connecting-IP');
  if (!ranges || !ip || !ipAllowed(ip, ranges)) {
    return htmlResponse(forbiddenPage(), 403);
  }
  // Gated slugs may span several segments; the key is the same however the
  // segments are split between slug and path, so take the first as slug.
  const scope = gatedScope(gate);
  const parts = slugAndPath(scope, segments, trailingSlash);
  if (!parts) return notFound();
  if (parts.bare) return bareRedirect(c);
  return serveObject(c, scope, parts.slug, parts.path, CACHE_PRIVATE);
}

function cookieSecret(env: Env): string | null {
  return env.COOKIE_SECRET ? env.COOKIE_SECRET : null;
}

async function hasValidCookie(c: Ctx, secret: string, slug: string, pwhash: string): Promise<boolean> {
  for (const value of cookieValues(c.req.header('Cookie'), COOKIE_NAME)) {
    if (await verifyCookie(secret, slug, pwhash, value)) return true;
  }
  return false;
}

function loginFormAction(c: Ctx): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

async function serveSecured(c: Ctx, segments: string[], trailingSlash: boolean): Promise<Response> {
  const parts = slugAndPath(SECURED, segments, trailingSlash);
  if (!parts) return notFound();
  if (parts.bare) return bareRedirect(c);
  const secret = cookieSecret(c.env);
  if (!secret) {
    console.error('COOKIE_SECRET is not set; refusing secured requests');
    return htmlResponse('Secured pages are not configured.', 500);
  }
  const meta = await readArtifactMeta(c.env.BUCKET, SECURED, parts.slug);
  if (!meta?.pwhash) return notFound();
  if (!(await hasValidCookie(c, secret, parts.slug, meta.pwhash))) {
    return htmlResponse(loginPage(loginFormAction(c)), 401);
  }
  return serveObject(c, SECURED, parts.slug, parts.path, CACHE_PRIVATE);
}

/**
 * Counts a password attempt against the client IP (an IPv6 client's /64),
 * across all secured slugs, so spreading guesses over pages gains nothing.
 * Runs before the artifact lookup and the PBKDF2 check. Each key has one
 * LoginLimiter object, placed in Western Europe when first created.
 */
function loginAttempt(c: Ctx, limiter: DurableObjectNamespace<LoginLimiter>): Promise<LoginAttempt> {
  const key = clientNetwork(c.req.header('CF-Connecting-IP') ?? '') ?? 'unknown';
  return limiter.getByName(key, { locationHint: 'weur' }).attempt();
}

async function securedLogin(c: Ctx, segments: string[], trailingSlash: boolean): Promise<Response> {
  const parts = slugAndPath(SECURED, segments, trailingSlash);
  if (!parts) return notFound();
  const secret = cookieSecret(c.env);
  if (!secret) {
    console.error('COOKIE_SECRET is not set; refusing secured requests');
    return htmlResponse('Secured pages are not configured.', 500);
  }
  const limiter = c.env.LOGIN_LIMIT;
  if (!limiter) {
    console.error('LOGIN_LIMIT is not bound; refusing secured logins');
    return htmlResponse('Secured pages are not configured.', 500);
  }
  const attempt = await loginAttempt(c, limiter);
  if (!attempt.allowed) {
    const response = htmlResponse(loginPage(loginFormAction(c), 'limited'), 429);
    response.headers.set('Retry-After', String(attempt.retryAfter));
    return response;
  }
  const meta = await readArtifactMeta(c.env.BUCKET, SECURED, parts.slug);
  if (!meta?.pwhash) return notFound();

  let password: unknown;
  try {
    password = (await c.req.parseBody()).password;
  } catch {
    password = undefined;
  }
  const ok = typeof password === 'string' && password !== '' && (await verifyPassword(password, meta.pwhash));
  if (!ok) return htmlResponse(loginPage(loginFormAction(c), 'wrong'), 401);

  const url = new URL(c.req.url);
  const location = `${url.pathname}${parts.bare ? '/' : ''}${url.search}`;
  const response = redirect(location, 303);
  response.headers.set('Set-Cookie', setCookieHeader(parts.slug, await signCookie(secret, parts.slug, meta.pwhash)));
  return response;
}

/**
 * Applied to every response: no indexing, and the analytics snippet on
 * HTML. Done here rather than in middleware because Hono's c.res setter
 * copies the old response's headers (including Content-Length) onto the new
 * one.
 */
function finish(env: Env, res: Response): Response {
  const snippet = env.ANALYTICS_SNIPPET;
  let out: Response;
  if (snippet && isHtml(res.headers.get('Content-Type'))) {
    const transformed = res.body
      ? new HTMLRewriter()
          .on('head', {
            element(head) {
              head.append(snippet, { html: true });
            },
          })
          .transform(res)
      : res;
    const headers = new Headers(transformed.headers);
    // serveObject has already set a weak, snippet-specific ETag.
    headers.delete('Content-Length');
    out = new Response(transformed.body, { status: transformed.status, headers });
  } else {
    out = new Response(res.body, res);
  }
  out.headers.set('X-Robots-Tag', 'noindex');
  return out;
}

function handle(fn: (c: Ctx) => Response | Promise<Response>) {
  return async (c: Ctx) => finish(c.env, await fn(c));
}

serve.get(
  '/robots.txt',
  handle(
    () =>
      new Response(ROBOTS_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE_INDEX },
      }),
  ),
);

serve.get('/', handle(generatedIndex));

serve.get(
  '*',
  handle(async (c) => {
    const url = new URL(c.req.url);
    const path = splitPath(url.pathname);
    if (!path) return notFound();
    // Exact-path redirects come first, so they work for gate roots such as
    // /lhv/. They only reveal a path, never content.
    const redirects = redirectsFor(c.env.REDIRECTS);
    const exact = exactRedirectFor(redirects, url, path);
    if (exact) return redirect(exact, 308);
    const [first, ...rest] = path.decoded;
    if (first === '_') return serveSecured(c, rest, path.trailingSlash);
    // A gate takes priority over a redirect or public artifact of the same name.
    const gates = gatesFor(c.env.IP_GATES);
    if (first !== undefined && gates.names.has(first)) return serveGated(c, gates, first, rest, path.trailingSlash);
    const target = redirectFor(redirects, url, path);
    if (target) return redirect(target, 308);
    return servePublic(c, path);
  }),
);

serve.post(
  '*',
  handle(async (c) => {
    const url = new URL(c.req.url);
    const path = splitPath(url.pathname);
    if (path?.decoded[0] === '_') return securedLogin(c, path.decoded.slice(1), path.trailingSlash);
    return methodNotAllowed();
  }),
);

serve.all('*', handle(methodNotAllowed));

export default serve;
