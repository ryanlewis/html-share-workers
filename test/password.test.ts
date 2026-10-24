import { describe, expect, it } from 'vitest';
import { hashPassword, MAX_ITERATIONS, verifyPassword } from '../src/lib/password';

describe('hashPassword', () => {
  it('produces the self-describing format', async () => {
    const stored = await hashPassword('correct horse');
    const [scheme, iterations, salt, hash] = stored.split('$');
    expect(scheme).toBe('pbkdf2-sha256');
    expect(Number(iterations)).toBe(MAX_ITERATIONS);
    expect(atob(salt!)).toHaveLength(16);
    expect(atob(hash!)).toHaveLength(32);
  });

  it('uses a fresh salt each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects an empty password and out-of-range iterations', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword('pw', 0)).rejects.toThrow();
    await expect(hashPassword('pw', MAX_ITERATIONS + 1)).rejects.toThrow();
    await expect(hashPassword('pw', 1.5)).rejects.toThrow();
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects others', async () => {
    const stored = await hashPassword('hunter2');
    expect(await verifyPassword('hunter2', stored)).toBe(true);
    expect(await verifyPassword('hunter3', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('honours the stored iteration count', async () => {
    const stored = await hashPassword('pw', 1000);
    expect(stored.split('$')[1]).toBe('1000');
    expect(await verifyPassword('pw', stored)).toBe(true);
  });

  it('handles unicode passwords', async () => {
    const stored = await hashPassword('pässwörd-🔑');
    expect(await verifyPassword('pässwörd-🔑', stored)).toBe(true);
    expect(await verifyPassword('passwort-🔑', stored)).toBe(false);
  });

  it('returns false for malformed stored strings', async () => {
    const good = await hashPassword('pw', 1000);
    const [, , salt, hash] = good.split('$');
    const bad = [
      '',
      'garbage',
      `sha256$1000$${salt}$${hash}`,
      `pbkdf2-sha256$0$${salt}$${hash}`,
      `pbkdf2-sha256$01000$${salt}$${hash}`,
      `pbkdf2-sha256$-1$${salt}$${hash}`,
      `pbkdf2-sha256$${MAX_ITERATIONS + 1}$${salt}$${hash}`,
      `pbkdf2-sha256$1000$!!notbase64$${hash}`,
      `pbkdf2-sha256$1000$$${hash}`,
      `pbkdf2-sha256$1000$${salt}$${btoa('short')}`,
      `${good}$extra`,
    ];
    for (const stored of bad) {
      expect(await verifyPassword('pw', stored), stored).toBe(false);
    }
  });
});
