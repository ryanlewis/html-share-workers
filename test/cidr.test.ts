import { describe, expect, it } from 'vitest';
import { ipAllowed, parseAddress, parseAllowlist, parseCidr } from '../src/lib/cidr';

describe('parseAddress', () => {
  it.each(['192.0.2.1', '0.0.0.0', '255.255.255.255'])('parses IPv4 %s', (ip) => {
    expect(parseAddress(ip)?.family).toBe(4);
  });

  it.each(['2001:db8::1', '::', '::1', '2001:db8:0:0:0:0:0:1', 'fe80::1:2:3:4', '2001:DB8::A'])(
    'parses IPv6 %s',
    (ip) => {
      expect(parseAddress(ip)?.family).toBe(6);
    },
  );

  it('treats compressed and full IPv6 forms as equal', () => {
    expect(parseAddress('2001:db8::1')).toEqual(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001'));
  });

  it('folds IPv4-mapped IPv6 to IPv4', () => {
    expect(parseAddress('::ffff:192.0.2.7')).toEqual(parseAddress('192.0.2.7'));
    expect(parseAddress('::ffff:c000:207')).toEqual(parseAddress('192.0.2.7'));
  });

  it.each([
    '',
    '192.0.2',
    '192.0.2.1.5',
    '192.0.2.256',
    '192.0.2.01',
    '192.0.2.-1',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7',
    '1::2::3',
    '1:2:3:4:5:6:7::8',
    '2001:db8::g',
    '2001:db8::12345',
    'fe80::1%eth0',
    'not-an-ip',
    ':::',
  ])('rejects %j', (ip) => {
    expect(parseAddress(ip)).toBeNull();
  });
});

describe('parseCidr', () => {
  it('treats a bare address as a single host', () => {
    expect(parseCidr('192.0.2.1')).toEqual({ family: 4, network: 0xc0000201n, prefix: 32 });
    expect(parseCidr('2001:db8::1')?.prefix).toBe(128);
  });

  it('clears host bits below the prefix', () => {
    expect(parseCidr('192.0.2.77/24')).toEqual(parseCidr('192.0.2.0/24'));
  });

  it.each(['192.0.2.0/33', '2001:db8::/129', '192.0.2.0/', '192.0.2.0/x', '192.0.2.0/24/1', '/24', '192.0.2.0/024'])(
    'rejects %j',
    (cidr) => {
      expect(parseCidr(cidr)).toBeNull();
    },
  );
});

describe('ipAllowed', () => {
  const list = parseAllowlist('192.0.2.0/24, 198.51.100.7/32\n2001:db8::/32\n2001:db8:ffff::/64');

  it.each(['192.0.2.0', '192.0.2.1', '192.0.2.255', '198.51.100.7', '::ffff:192.0.2.9'])('allows IPv4 %s', (ip) => {
    expect(ipAllowed(ip, list)).toBe(true);
  });

  it.each(['192.0.3.0', '192.0.1.255', '198.51.100.8', '203.0.113.1'])('denies IPv4 %s', (ip) => {
    expect(ipAllowed(ip, list)).toBe(false);
  });

  it.each(['2001:db8::1', '2001:db8:1234:5678::9', '2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff'])(
    'allows IPv6 %s',
    (ip) => {
      expect(ipAllowed(ip, list)).toBe(true);
    },
  );

  it.each(['2001:db9::1', '2001:db7:ffff::1', '::1', '::'])('denies IPv6 %s', (ip) => {
    expect(ipAllowed(ip, list)).toBe(false);
  });

  it('does not match an IPv4 address against an IPv6 range of the same bits', () => {
    // 192.0.2.1 as a 32-bit value would sit inside ::/96 if families mixed.
    expect(ipAllowed('192.0.2.1', parseAllowlist('::/96'))).toBe(false);
  });

  it('matches IPv4 against an IPv4-mapped IPv6 range', () => {
    expect(ipAllowed('192.0.2.1', parseAllowlist('::ffff:192.0.2.0/120'))).toBe(true);
    expect(ipAllowed('192.0.3.1', parseAllowlist('::ffff:192.0.2.0/120'))).toBe(false);
  });

  it('allows everything only with an explicit /0', () => {
    expect(ipAllowed('203.0.113.1', parseAllowlist('0.0.0.0/0'))).toBe(true);
    expect(ipAllowed('2001:db8::1', parseAllowlist('0.0.0.0/0'))).toBe(false);
    expect(ipAllowed('2001:db8::1', parseAllowlist('::/0'))).toBe(true);
  });

  it('denies malformed addresses and empty lists', () => {
    expect(ipAllowed('not-an-ip', list)).toBe(false);
    expect(ipAllowed('192.0.2.1', [])).toBe(false);
    expect(ipAllowed('192.0.2.1', parseAllowlist(''))).toBe(false);
    expect(ipAllowed('192.0.2.1', parseAllowlist(undefined))).toBe(false);
  });

  it('drops malformed entries without dropping the rest', () => {
    const mixed = parseAllowlist('garbage, 192.0.2.0/99, 198.51.100.0/24');
    expect(mixed).toHaveLength(1);
    expect(ipAllowed('198.51.100.1', mixed)).toBe(true);
  });
});
