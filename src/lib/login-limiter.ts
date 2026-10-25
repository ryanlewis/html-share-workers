import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/** Password attempts allowed per client key in one window. */
export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 60_000;

interface Window {
  /** Epoch ms of the first attempt in the window. */
  start: number;
  count: number;
}

/** A refused attempt says how many seconds remain in the window. */
export type LoginAttempt = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * Counts secured-page password attempts for one client key (an IPv4
 * address or an IPv6 /64), named by that key. A window opens on the first
 * attempt and lasts LOGIN_WINDOW_MS; refused attempts do not extend it.
 * An alarm at the end of the window deletes the count, so an idle object
 * holds no data.
 */
export class LoginLimiter extends DurableObject<Env> {
  async attempt(): Promise<LoginAttempt> {
    const now = Date.now();
    const kv = this.ctx.storage.kv;
    const window = kv.get<Window>('window');
    if (!window || now >= window.start + LOGIN_WINDOW_MS) {
      kv.put('window', { start: now, count: 1 });
      await this.ctx.storage.setAlarm(now + LOGIN_WINDOW_MS);
      return { allowed: true };
    }
    if (window.count >= LOGIN_LIMIT) {
      return { allowed: false, retryAfter: Math.ceil((window.start + LOGIN_WINDOW_MS - now) / 1000) };
    }
    kv.put('window', { start: window.start, count: window.count + 1 });
    return { allowed: true };
  }

  async alarm(): Promise<void> {
    const window = this.ctx.storage.kv.get<Window>('window');
    // A window opened after this alarm was set keeps its count and its own alarm.
    if (window && Date.now() < window.start + LOGIN_WINDOW_MS) {
      await this.ctx.storage.setAlarm(window.start + LOGIN_WINDOW_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
