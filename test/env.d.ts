// Types for `env` and `exports` from "cloudflare:workers" in tests.
import type { Env as WorkerEnv } from '../src/env';
import type * as MainModule from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof MainModule;
    }
  }
}
