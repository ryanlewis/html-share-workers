/**
 * Password hashing for secured artifacts: PBKDF2-SHA256 through WebCrypto.
 * Stored format: pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>
 */

const SCHEME = 'pbkdf2-sha256';
/** Workers rejects PBKDF2 with more than 100000 iterations. */
export const MAX_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Compares two byte arrays in time that depends only on their length. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hashPassword(password: string, iterations = MAX_ITERATIONS): Promise<string> {
  if (password === '') throw new Error('password is empty');
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new Error(`iterations must be an integer from 1 to ${MAX_ITERATIONS}`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return [SCHEME, iterations, toBase64(salt), toBase64(hash)].join('$');
}

/** True if password matches a hashPassword() string. A malformed string gives false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [scheme, iterText, saltText, hashText] = parts as [string, string, string, string];
  if (scheme !== SCHEME || !/^[1-9]\d*$/.test(iterText)) return false;
  const iterations = Number(iterText);
  if (iterations > MAX_ITERATIONS) return false;
  const salt = fromBase64(saltText);
  const expected = fromBase64(hashText);
  if (!salt || salt.length === 0 || !expected || expected.length !== HASH_BYTES) return false;
  const actual = await derive(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}
