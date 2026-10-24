/**
 * IPv4 and IPv6 CIDR matching for IP gates. Addresses are held as
 * BigInt so both families share one code path.
 */

export interface Cidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

interface Address {
  family: 4 | 6;
  value: bigint;
}

function parseIPv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // No leading zeros: "010" is octal in some parsers and decimal in others.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseHextets(text: string): bigint[] | null {
  if (text === '') return [];
  const groups = text.split(':');
  const out: bigint[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    // A dotted IPv4 tail (::ffff:192.0.2.1) counts as two hextets.
    if (i === groups.length - 1 && group.includes('.')) {
      const v4 = parseIPv4(group);
      if (v4 === null) return null;
      out.push(v4 >> 16n, v4 & 0xffffn);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(BigInt(parseInt(group, 16)));
  }
  return out;
}

function parseIPv6(text: string): bigint | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  let hextets: bigint[];
  if (halves.length === 2) {
    const head = parseHextets(halves[0]!);
    const tail = parseHextets(halves[1]!);
    if (!head || !tail) return null;
    // "::" stands for at least one zero group.
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    hextets = [...head, ...Array<bigint>(missing).fill(0n), ...tail];
  } else {
    const all = parseHextets(text);
    if (!all) return null;
    hextets = all;
  }
  if (hextets.length !== 8) return null;
  return hextets.reduce((acc, h) => (acc << 16n) | h, 0n);
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;

/**
 * Parses an IPv4 or IPv6 address. IPv4-mapped IPv6 (::ffff:a.b.c.d) is
 * returned as IPv4 so it matches IPv4 ranges.
 */
export function parseAddress(text: string): Address | null {
  const trimmed = text.trim();
  if (trimmed.includes(':')) {
    const value = parseIPv6(trimmed);
    if (value === null) return null;
    if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
    return { family: 6, value };
  }
  const value = parseIPv4(trimmed);
  return value === null ? null : { family: 4, value };
}

function bits(family: 4 | 6): number {
  return family === 4 ? 32 : 128;
}

function mask(family: 4 | 6, prefix: number): bigint {
  const width = BigInt(bits(family));
  const all = (1n << width) - 1n;
  return all ^ ((1n << (width - BigInt(prefix))) - 1n);
}

/**
 * Parses "a.b.c.d/n" or "x::y/n". A bare address is a single host. Host bits
 * set below the prefix are ignored. Returns null when malformed.
 */
export function parseCidr(text: string): Cidr | null {
  const [addressText, prefixText, extra] = text.trim().split('/');
  if (addressText === undefined || extra !== undefined) return null;
  // Parse the address without the v4-mapped folding so that a mapped
  // range like ::ffff:0:0/96 keeps its IPv6 prefix length.
  const family: 4 | 6 = addressText.includes(':') ? 6 : 4;
  const value = family === 6 ? parseIPv6(addressText.trim()) : parseIPv4(addressText.trim());
  if (value === null) return null;
  let prefix = bits(family);
  if (prefixText !== undefined) {
    if (!/^(0|[1-9]\d{0,2})$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > bits(family)) return null;
  }
  // An IPv4-mapped range is matched as the IPv4 range it covers.
  if (family === 6 && value >> 32n === 0xffffn && prefix >= 96) {
    const v4prefix = prefix - 96;
    return { family: 4, network: (value - V4_MAPPED_PREFIX) & mask(4, v4prefix), prefix: v4prefix };
  }
  return { family, network: value & mask(family, prefix), prefix };
}

/**
 * Parses an allowlist of CIDRs separated by commas, newlines or other
 * whitespace. Malformed entries are dropped, so they allow nothing.
 */
export function parseAllowlist(text: string | undefined): Cidr[] {
  if (!text) return [];
  return text
    .split(/[\s,]+/)
    .filter((entry) => entry !== '')
    .map(parseCidr)
    .filter((cidr): cidr is Cidr => cidr !== null);
}

/** True if the address is inside any of the ranges. A malformed address gives false. */
export function ipAllowed(ip: string, allowlist: readonly Cidr[]): boolean {
  const address = parseAddress(ip);
  if (!address) return false;
  return allowlist.some(
    (cidr) =>
      cidr.family === address.family && (address.value & mask(cidr.family, cidr.prefix)) === cidr.network,
  );
}
