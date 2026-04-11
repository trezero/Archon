/**
 * Strips Bun-auto-loaded CWD .env keys from process.env.
 *
 * Bun's runtime unconditionally loads .env / .env.local / .env.development /
 * .env.production from the process CWD before any user code runs. When `archon`
 * is invoked from inside a target repo, that repo's env vars leak into the
 * Archon process.
 *
 * `override: true` in dotenv only fixes keys that exist in both files — keys
 * that only appear in the target repo's .env survive unaffected.
 *
 * This function must be called (via the boot wrapper) BEFORE any module that
 * reads env at init time — notably `@archon/paths/logger` which reads `LOG_LEVEL`
 * during module load.
 */
import { config } from 'dotenv';
import { resolve } from 'path';

/** The four filenames Bun auto-loads from CWD (in loading order). */
const BUN_AUTO_LOADED_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production'];

/**
 * Parse CWD .env files and delete any matching keys from process.env.
 * Keys in ~/.archon/.env (loaded later with override: true) are unaffected.
 * Safe to call even when no CWD .env files exist.
 */
export function stripCwdEnv(cwd: string = process.cwd()): void {
  const cwdKeys = new Set<string>();

  for (const filename of BUN_AUTO_LOADED_ENV_FILES) {
    const filepath = resolve(cwd, filename);
    // dotenv.config with processEnv:{} parses without writing to process.env
    const result = config({ path: filepath, processEnv: {} });
    if (!result.error && result.parsed) {
      for (const key of Object.keys(result.parsed)) {
        cwdKeys.add(key);
      }
    }
  }

  for (const key of cwdKeys) {
    Reflect.deleteProperty(process.env, key);
  }
}
