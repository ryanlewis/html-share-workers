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
 * Parses REDIRECTS. Unset, invalid JSON or a non-object gives no redirects.
 * Entries are dropped when the target is not a non-empty string, the key is
 * "/" or ends in more than one slash, or the target is the key's own path
 * (so it would loop). Problems are logged.
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
  for (const [key, target] of Object.entries(parsed)) {
    const isExact = key.startsWith('/');
    const path = isExact ? trimSlashes(key) : `/${key}`;
    if (typeof target !== 'string' || target === '') errors.push(`"${key}" has no target`);
    else if (isExact && path === '') errors.push(`"${key}" cannot be redirected`);
    else if (/\/\/$/.test(key)) errors.push(`"${key}" ends in more than one slash`);
    else if (pointsAt(target, `${NO_HOST}${path}/`, path)) errors.push(`"${key}" redirects to itself`);
    else (isExact ? exact : slugs).set(isExact ? path : key, target);
  }
  if (errors.length > 0) console.error(`REDIRECTS has bad entries, which are ignored: ${errors.join('; ')}`);
  return { exact, slugs };
}

/** parseRedirects, run once per distinct REDIRECTS value per isolate. */
export const redirectsFor = memoByText(parseRedirects);
