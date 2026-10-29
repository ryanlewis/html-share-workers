/**
 * Rewrites from the REWRITES config: a JSON object of exact path -> folder
 * path on this host. A request for the key is served as if it were for the
 * target, with the URL left as it is. The target then goes through the usual
 * routing, so a gated or missing target is refused or 404s as it would be
 * when requested directly.
 */
import { memoByText } from './memo';
import { trimSlashes } from './redirects';

/** Exact-path keys, decoded and without trailing slashes ("/lhv"), to targets. */
export type Rewrites = ReadonlyMap<string, string>;

const NONE: Rewrites = new Map();

/** The decoded path without trailing slashes, or null if a segment does not decode or decodes to contain "/". */
function decodedPath(path: string): string | null {
  try {
    const segments = path.split('/').map(decodeURIComponent);
    return segments.slice(1).some((segment) => segment.includes('/')) ? null : trimSlashes(segments.join('/'));
  } catch {
    return null;
  }
}

/**
 * Parses REWRITES. Unset, invalid JSON or a non-object gives no rewrites.
 * Entries are dropped when the key does not start with "/", is "/", ends in
 * more than one slash or does not percent-decode, or the target is not a
 * folder path on this host: "/..." ending in "/", without "//", a query or a
 * fragment, not under the secured "/_/" prefix (its login form posts back to
 * the URL as requested), and not the key's own path. Rewrites do not chain:
 * a target is served as it is, even if it is another key. Problems are
 * logged.
 */
export function parseRewrites(text: string | undefined): Rewrites {
  if (!text || text.trim() === '') return NONE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('REWRITES is not valid JSON; ignoring it');
    return NONE;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('REWRITES is not a JSON object; ignoring it');
    return NONE;
  }
  const rewrites = new Map<string, string>();
  const errors: string[] = [];
  for (const [key, target] of Object.entries(parsed)) {
    const path = key.startsWith('/') ? decodedPath(key) : null;
    const to = typeof target === 'string' && target.startsWith('/') ? decodedPath(target) : null;
    if (!key.startsWith('/')) errors.push(`"${key}" is not a path starting with "/"`);
    else if (path === null) errors.push(`"${key}" does not percent-decode`);
    else if (path === '') errors.push(`"${key}" cannot be rewritten`);
    else if (/\/\/$/.test(key)) errors.push(`"${key}" ends in more than one slash`);
    else if (typeof target !== 'string' || !/^\/[^?#]*\/$/.test(target) || target.includes('//') || to === null) {
      errors.push(`"${key}" has a target that is not a folder path like "/gate/slug/"`);
    } else if (to === '/_' || to.startsWith('/_/')) errors.push(`"${key}" has a secured target`);
    else if (to === path) errors.push(`"${key}" rewrites to itself`);
    else rewrites.set(path, target);
  }
  if (errors.length > 0) console.error(`REWRITES has bad entries, which are ignored: ${errors.join('; ')}`);
  return rewrites;
}

/** parseRewrites, run once per distinct REWRITES value per isolate. */
export const rewritesFor = memoByText(parseRewrites);
