import { createMiddleware } from 'hono/factory';
import { machineTokens, type AppEnv } from '../env';

/** Bindings plus the machine whose token authenticated the request. */
export type ApiEnv = AppEnv & { Variables: { machine: string } };

const encoder = new TextEncoder();

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(text));
}

/**
 * Returns the machine whose TOKEN_<MACHINE> secret equals the token, or null.
 * Both sides are hashed first so the comparison is over equal-length values,
 * and every configured token is compared, so timing does not reveal which
 * machine matched or how much of a token was right.
 */
export async function matchMachine(
  tokens: Map<string, string>,
  token: string,
): Promise<string | null> {
  const given = await sha256(token);
  let matched: string | null = null;
  for (const [machine, secret] of tokens) {
    const expected = await sha256(secret);
    if (crypto.subtle.timingSafeEqual(given, expected) && matched === null) matched = machine;
  }
  return matched;
}

const BEARER = /^Bearer[ ]+(\S+)[ ]*$/i;

/**
 * Requires `Authorization: Bearer <token>` matching one of the TOKEN_<MACHINE>
 * secrets. With no tokens configured every request is rejected.
 */
export const bearerAuth = createMiddleware<ApiEnv>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = BEARER.exec(header)?.[1];
  const tokens = machineTokens(c.env);
  const machine = token && tokens.size > 0 ? await matchMachine(tokens, token) : null;
  if (!machine) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'missing or invalid bearer token' }, 401);
  }
  c.set('machine', machine);
  await next();
});
