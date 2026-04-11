/**
 * Side-effect boot module: strip Bun-auto-loaded CWD `.env` keys immediately
 * on import. Import this as the FIRST import in CLI/server entry points to
 * guarantee the strip runs before any module that reads `process.env` at
 * load time (e.g. the Pino logger in `@archon/paths/logger`).
 *
 * Usage:
 *   import '@archon/paths/strip-cwd-env-boot';  // must be the first import
 *   // ...other imports...
 *
 * The separation between `strip-cwd-env.ts` (pure function, testable) and
 * this boot file (side-effect wrapper) keeps the stripping logic unit-testable
 * while still providing the "runs before everything else" guarantee that
 * entry points need.
 */
import { stripCwdEnv } from './strip-cwd-env';

stripCwdEnv();
