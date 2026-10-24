import { describe, expect, it } from 'vitest';
import { machineTokens, type Env } from '../src/env';

describe('machineTokens', () => {
  it('maps TOKEN_<MACHINE> bindings to lowercased machine names', () => {
    const env = {
      COOKIE_SECRET: 'not-a-token',
      TOKEN_M5P: 'a',
      TOKEN_WORKLAPTOP: 'b',
      TOKEN_REVOKED: '',
      TOKEN_: 'no-machine',
    } as unknown as Env;
    expect(Object.fromEntries(machineTokens(env))).toEqual({ m5p: 'a', worklaptop: 'b' });
  });
});
