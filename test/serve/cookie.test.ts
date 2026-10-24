import { describe, expect, it } from 'vitest';
import { COOKIE_TTL_SECONDS, cookieValues, setCookieHeader, signCookie, verifyCookie } from '../../src/serve/cookie';

const SECRET = 'fixture-secret';
const HASH = 'pbkdf2-sha256$1$c2FsdA==$aGFzaA==';
const NOW = 1_800_000_000;

describe('signCookie / verifyCookie', () => {
  it('accepts its own cookie', async () => {
    const value = await signCookie(SECRET, 'deck', HASH, NOW);
    expect(await verifyCookie(SECRET, 'deck', HASH, value, NOW)).toBe(true);
    expect(await verifyCookie(SECRET, 'deck', HASH, value, NOW + COOKIE_TTL_SECONDS - 1)).toBe(true);
  });

  it('rejects an expired cookie', async () => {
    const value = await signCookie(SECRET, 'deck', HASH, NOW);
    expect(await verifyCookie(SECRET, 'deck', HASH, value, NOW + COOKIE_TTL_SECONDS)).toBe(false);
  });

  it('rejects a cookie for another slug, pwhash or secret', async () => {
    const value = await signCookie(SECRET, 'deck', HASH, NOW);
    expect(await verifyCookie(SECRET, 'other', HASH, value, NOW)).toBe(false);
    expect(await verifyCookie(SECRET, 'deck', `${HASH}x`, value, NOW)).toBe(false);
    expect(await verifyCookie('other-secret', 'deck', HASH, value, NOW)).toBe(false);
  });

  it('rejects a cookie whose expiry was pushed forward', async () => {
    const value = await signCookie(SECRET, 'deck', HASH, NOW);
    const [, signature] = value.split('.');
    const later = `${NOW + COOKIE_TTL_SECONDS * 10}.${signature}`;
    expect(await verifyCookie(SECRET, 'deck', HASH, later, NOW)).toBe(false);
  });

  it.each(['', 'ok', '123', '123.', '.abc', 'abc.def', '0.abc', '123.a+b', '1800604800.@@@', '99999999999999.abc'])(
    'rejects malformed value %j',
    async (value) => {
      expect(await verifyCookie(SECRET, 'deck', HASH, value, NOW)).toBe(false);
    },
  );
});

describe('cookieValues', () => {
  it('returns every value for the name', () => {
    expect(cookieValues('a=1; share_auth=x; b=2; share_auth=y', 'share_auth')).toEqual(['x', 'y']);
    expect(cookieValues('share_authx=1; xshare_auth=2', 'share_auth')).toEqual([]);
    expect(cookieValues(null, 'share_auth')).toEqual([]);
  });
});

describe('setCookieHeader', () => {
  it('scopes the cookie to the slug and sets the security attributes', () => {
    const header = setCookieHeader('deck', 'v');
    expect(header).toContain('share_auth=v');
    expect(header).toContain('Path=/_/deck/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
  });
});
