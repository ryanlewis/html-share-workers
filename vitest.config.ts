import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Fixture secrets for tests only.
        bindings: {
          COOKIE_SECRET: 'test-cookie-secret',
          TOKEN_TESTMACHINE: 'test-token',
          // Two gates with separate documentation ranges (RFC 5737, RFC 3849, RFC 9637).
          IP_GATES: JSON.stringify({ acme: ['192.0.2.0/24', '2001:db8::/32'], example: ['198.51.100.0/24', '3fff::/20'] }),
        },
      },
    }),
  ],
});
