/**
 * Redirects from the REDIRECTS config: a JSON object of key -> target. A key
 * starting with "/" is an exact path; any other key is a top-level slug,
 * which keeps its sub-path when redirected.
 */
import { memoByText } from './memo';

export interface Redirects {
  /** Exact-path keys, decoded and without trailing slashes ("/lhv"). */
  exact: ReadonlyMap<string, string>;
  /** Slug keys. */
  slugs: ReadonlyMap<string, string>;
}

const NONE: Redirects = { exact: new Map(), slugs: new Map() };

/** Base for resolving targets when the serving host is not known. */
const NO_HOST = 'https://no-host.invalid';

export function trimSlashes(path: string): string {
  return path.replace(/\/+$/, '');
}

/**
 * True when target, resolved against base, has base's origin and the given
 * decoded path, ignoring trailing slashes, the query and the fragment. Such
 * a target would redirect back to where it came from.
 */
export function pointsAt(target: string, base: string | URL, path: string): boolean {
  try {
    const resolved = new URL(target, base);
    return resolved.origin === new URL(base).origin && trimSlashes(decodeURIComponent(resolved.pathname)) === trimSlashes(path);
  } catch {
    return false;
  }
}

/**
 * The Location for a redirect to target. For a slug key, subPath is the rest
 * of the request path after the slug and replaces the target's trailing
 * slash; for an exact key it is null. The request query is merged after the
 * target's own query with "&", and the target's fragment stays last:
 * "/acme/old/?ref=x#top" with sub-path "/page" and "?a=1" gives
 * "/acme/old/page?ref=x&a=1#top".
 */
export function redirectLocation(target: string, subPath: string | null, search: string): string {
  const hash = target.indexOf('#');
  const fragment = hash === -1 ? '' : target.slice(hash);
  const beforeHash = hash === -1 ? target : target.slice(0, hash);
  const mark = beforeHash.indexOf('?');
  let path = mark === -1 ? beforeHash : beforeHash.slice(0, mark);
  const query = [mark === -1 ? '' : beforeHash.slice(mark + 1), search.slice(1)].filter((q) => q !== '').join('&');
  if (subPath !== null) {
    // A target of "/" plus a sub-path starting "//" would make a
    // scheme-relative URL to another host.
    path = `${trimSlashes(path)}${subPath === '' ? '/' : subPath}`.replace(/^\/{2,}/, '/');
  }
  return `${path}${query === '' ? '' : `?${query}`}${fragment}`;
}

/** True for "/path" (not "//host") or a URL with a scheme, such as "https://host/path". */
function isAbsoluteTarget(target: string): boolean {
  if (target.startsWith('/')) return !target.startsWith('//');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return URL.canParse(target);
}

/** The decoded path of a target without trailing slashes, or null for a URL with a host. */
function targetPath(target: string): string | null {
  if (!target.startsWith('/')) return null;
  try {
    return trimSlashes(decodeURIComponent(new URL(target, NO_HOST).pathname));
  } catch {
    return null;
  }
}

/** Exact keys whose redirects form a loop through other exact keys (A -> B -> A). */
function exactKeysInLoops(exact: ReadonlyMap<string, string>): Set<string> {
  const inLoop = new Set<string>();
  for (const start of exact.keys()) {
    let at: string | null | undefined = start;
    for (let steps = 0; steps < exact.size; steps++) {
      const target = exact.get(at!);
      at = target === undefined ? undefined : targetPath(target);
      if (at === start) inLoop.add(start);
      if (!at || at === start || !exact.has(at)) break;
    }
  }
  return inLoop;
}

/**
 * Parses REDIRECTS. Unset, invalid JSON or a non-object gives no redirects.
 * Entries are dropped when the target is not a non-empty string or is
 * neither an absolute path nor a URL with a scheme, a slug key contains "/",
 * an exact key is "/", ends in more than one slash or does not percent-decode,
 * the target is the key's own path, or exact keys redirect in a loop
 * (A -> B -> A). Problems are logged.
 */
export function parseRedirects(text: string | undefined): Redirects {
  if (!text || text.trim() === '') return NONE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('REDIRECTS is not valid JSON; ignoring it');
    return NONE;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('REDIRECTS is not a JSON object; ignoring it');
    return NONE;
  }
  const exact = new Map<string, string>();
  const slugs = new Map<string, string>();
  const errors: string[] = [];
  // The original key of each exact path, for log messages.
  const exactKeys = new Map<string, string>();
  for (const [key, target] of Object.entries(parsed)) {
    const isExact = key.startsWith('/');
    let path: string | null = `/${key}`;
    if (isExact) {
      try {
        path = trimSlashes(decodeURIComponent(key));
      } catch {
        path = null;
      }
    }
    if (typeof target !== 'string' || target === '') errors.push(`"${key}" has no target`);
    else if (!isExact && key.includes('/')) errors.push(`"${key}" is a slug key with a "/"`);
    else if (path === null) errors.push(`"${key}" does not percent-decode`);
    else if (isExact && path === '') errors.push(`"${key}" cannot be redirected`);
    else if (/\/\/$/.test(key)) errors.push(`"${key}" ends in more than one slash`);
    else if (pointsAt(target, `${NO_HOST}${path}/`, path)) errors.push(`"${key}" redirects to itself`);
    else if (!isAbsoluteTarget(target)) errors.push(`"${key}" has a target that is not "/..." or a full URL`);
    else if (isExact) {
      exact.set(path, target);
      exactKeys.set(path, key);
    } else slugs.set(key, target);
  }
  for (const path of exactKeysInLoops(exact)) {
    exact.delete(path);
    errors.push(`"${exactKeys.get(path)}" is in a redirect loop`);
  }
  if (errors.length > 0) console.error(`REDIRECTS has bad entries, which are ignored: ${errors.join('; ')}`);
  return { exact, slugs };
}

/** parseRedirects, run once per distinct REDIRECTS value per isolate. */
export const redirectsFor = memoByText(parseRedirects);
