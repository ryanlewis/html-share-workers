/**
 * IP gates from the IP_GATES config: a JSON object of gate name -> CIDR
 * list, e.g. {"acme":["192.0.2.0/24","2001:db8::/32"]}. A gated artifact
 * is served only to requests whose CF-Connecting-IP is in its own gate's
 * ranges.
 */
import { type Cidr, parseCidr } from './cidr';
import { validateGateName } from './artifacts';
import { memoByText } from './memo';

export interface Gates {
  /** Gate names with a valid name. The API and routing use these. */
  names: ReadonlySet<string>;
  /**
   * Ranges per gate, or null when IP_GATES has a bad entry. Null means
   * every gate refuses every request, so a typo fails closed.
   */
  ranges: ReadonlyMap<string, readonly Cidr[]> | null;
}

const NONE: Gates = { names: new Set(), ranges: new Map() };

/**
 * Parses IP_GATES. Empty or unset means no gates. JSON that does not parse,
 * or is not an object, gives no gates: the names are unknown, so those URLs
 * are public misses. A bad entry (invalid gate name, a value that is not an
 * array of strings, or a CIDR that does not parse) keeps the valid names but
 * sets ranges to null. Problems are logged.
 */
export function parseGates(text: string | undefined): Gates {
  if (!text || text.trim() === '') return NONE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('IP_GATES is not valid JSON; no gates are configured');
    return NONE;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('IP_GATES is not a JSON object; no gates are configured');
    return NONE;
  }
  const names = new Set<string>();
  const ranges = new Map<string, Cidr[]>();
  const errors: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    const check = validateGateName(name);
    if (!check.ok) {
      errors.push(check.error);
      continue;
    }
    names.add(name);
    if (!Array.isArray(value)) {
      errors.push(`gate "${name}" is not an array of CIDRs`);
      continue;
    }
    const cidrs: Cidr[] = [];
    for (const entry of value) {
      const cidr = typeof entry === 'string' ? parseCidr(entry) : null;
      if (cidr) cidrs.push(cidr);
      else errors.push(`gate "${name}" has a bad entry: ${JSON.stringify(entry)}`);
    }
    ranges.set(name, cidrs);
  }
  if (errors.length > 0) {
    console.error(`IP_GATES has bad entries, so every gate refuses access: ${errors.join('; ')}`);
    return { names, ranges: null };
  }
  return { names, ranges };
}

/** parseGates, run once per distinct IP_GATES value per isolate. */
export const gatesFor = memoByText(parseGates);
