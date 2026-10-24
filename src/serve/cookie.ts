/**
 * Signed cookies for secured artifacts.
 *
 * Value: <expiry>.<signature>, where expiry is Unix seconds and signature is
 * base64url HMAC-SHA256 (COOKIE_SECRET) over the slug, the expiry and a
 * SHA-256 fingerprint of the artifact's current pwhash. A new password (or a
 * re-upload, which salts afresh) changes the fingerprint and so invalidates
 * every cookie issued before it.
 */

export const COOKIE_NAME = 'share_auth';
export const COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function fingerprint(pwhash: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(pwhash));
  return toBase64Url(new Uint8Array(digest));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function message(slug: string, expiry: number, pwhash: string): Promise<Uint8Array> {
  // Slugs cannot contain "\n", so the fields cannot run into each other.
  return encoder.encode(`${slug}\n${expiry}\n${await fingerprint(pwhash)}`);
}

/** Cookie value for a slug, valid until now + COOKIE_TTL_SECONDS. */
export async function signCookie(
  secret: string,
  slug: string,
  pwhash: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const expiry = nowSeconds + COOKIE_TTL_SECONDS;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), await message(slug, expiry, pwhash));
  return `${expiry}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * True if value was issued by signCookie for this slug and pwhash and has
 * not expired. The signature check is constant time (crypto.subtle.verify).
 */
export async function verifyCookie(
  secret: string,
  slug: string,
  pwhash: string,
  value: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const match = /^([1-9]\d{0,11})\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) return false;
  const expiry = Number(match[1]);
  if (expiry <= nowSeconds) return false;
  const signature = fromBase64Url(match[2]!);
  if (!signature) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), signature, await message(slug, expiry, pwhash));
}

/** Every value sent for a cookie name. A browser can send several with the same name. */
export function cookieValues(header: string | null | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    values.push(pair.slice(eq + 1).trim());
  }
  return values;
}

/** Set-Cookie header value scoped to one secured artifact. */
export function setCookieHeader(slug: string, value: string): string {
  return [
    `${COOKIE_NAME}=${value}`,
    `Path=/_/${slug}/`,
    `Max-Age=${COOKIE_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}
