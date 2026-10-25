import type { LoginLimiter } from './lib/login-limiter';

/**
 * Worker bindings. Everything except BUCKET and LOGIN_LIMIT is a secret, set with
 * `wrangler secret put` (or in .dev.vars locally). wrangler.toml has no
 * [vars], because a deploy would replace them.
 */
export interface Env {
  /** Artifact storage. Key layout is in src/lib/artifacts.ts. */
  BUCKET: R2Bucket;
  /**
   * Durable Objects counting secured-page password attempts, one per client
   * IP. Set in wrangler.toml. Unset refuses logins.
   */
  LOGIN_LIMIT?: DurableObjectNamespace<LoginLimiter>;
  /** HMAC key for signing secured-artifact cookies. Secret. */
  COOKIE_SECRET: string;
  /**
   * Secret. JSON object of gate name -> IPv4/IPv6 CIDRs allowed to read /<gate>/,
   * e.g. {"acme":["192.0.2.0/24","2001:db8::/32"]}. Read it with gatesFor().
   */
  IP_GATES?: string;
  /** Secret. HTML injected before </head> on HTML responses. Empty or unset means none. */
  ANALYTICS_SNIPPET?: string;
  /**
   * Secret. JSON object of slug or exact path -> target, e.g. {"some-slug":"/acme/some-slug/"}.
   * Unset means none. Read it with redirectsFor().
   */
  REDIRECTS?: string;
  /**
   * Upload bearer tokens, one secret per machine: TOKEN_M5P, TOKEN_WORKLAPTOP, ...
   * Read them with machineTokens() rather than directly.
   */
  [token: `TOKEN_${string}`]: string | undefined;
}

/** Hono generic for apps and sub-apps that use these bindings. */
export type AppEnv = { Bindings: Env };

const TOKEN_PREFIX = 'TOKEN_';

/**
 * Upload tokens keyed by machine name, lowercased (TOKEN_M5P -> "m5p").
 * Bindings with an empty value are skipped, so blanking a secret revokes it.
 */
export function machineTokens(env: Env): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(TOKEN_PREFIX) || name.length === TOKEN_PREFIX.length) continue;
    if (typeof value !== 'string' || value === '') continue;
    tokens.set(name.slice(TOKEN_PREFIX.length).toLowerCase(), value);
  }
  return tokens;
}
