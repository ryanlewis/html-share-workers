import { describe, expect, it } from 'vitest';
import { ipAllowed } from '../src/lib/cidr';
import { parseGates } from '../src/lib/gates';

describe('parseGates', () => {
  it('parses several gates with IPv4 and IPv6 ranges', () => {
    const gates = parseGates('{"acme":["192.0.2.0/24","2001:db8::/32"],"example":["198.51.100.7"]}');
    expect([...gates.names]).toEqual(['acme', 'example']);
    const acme = gates.ranges!.get('acme')!;
    expect(ipAllowed('192.0.2.9', acme)).toBe(true);
    expect(ipAllowed('2001:db8::1', acme)).toBe(true);
    expect(ipAllowed('198.51.100.7', acme)).toBe(false);
    expect(ipAllowed('198.51.100.7', gates.ranges!.get('example')!)).toBe(true);
  });

  it.each([undefined, '', '  ', '{}'])('gives no gates for %j', (text) => {
    const gates = parseGates(text);
    expect(gates.names.size).toBe(0);
    expect(gates.ranges).not.toBeNull();
  });

  it('allows a gate with no ranges, which admits nobody', () => {
    const gates = parseGates('{"acme":[]}');
    expect(gates.names.has('acme')).toBe(true);
    expect(gates.ranges!.get('acme')).toEqual([]);
  });

  it.each(['not json', '["acme"]', '"acme"', 'null', '5'])('gives no gates for unusable JSON %j', (text) => {
    expect(parseGates(text).names.size).toBe(0);
  });

  it.each([
    '{"acme":["192.0.2.0/99"]}',
    '{"acme":["garbage"]}',
    '{"acme":[5]}',
    '{"acme":"192.0.2.0/24"}',
    '{"acme":["192.0.2.0/24"],"API":["198.51.100.0/24"]}',
    '{"acme":["192.0.2.0/24"],"api":["198.51.100.0/24"]}',
    '{"acme":["192.0.2.0/24"],"__proto__":["198.51.100.0/24"]}',
  ])('keeps the valid names but drops every range for a bad entry in %s', (text) => {
    const gates = parseGates(text);
    expect(gates.names.has('acme')).toBe(true);
    expect(gates.ranges).toBeNull();
  });
});
