import { parse } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Strip Bun-auto-loaded CWD `.env` keys from `process.env`.
 *
 * Bun's runtime (and compiled binaries) auto-load `.env` files from the current
 * working directory before any user code runs. When `archon` is invoked from
 * inside a target repo, that repo's `.env` leaks into the Archon process env,
 * contaminating logging, config, and any `process.env.X` reads.
 *
 * The design rule is: **the CLI must never load target repo env**. Call this
 * function at the very top of the CLI/server entry point — before loading
 * `~/.archon/.env` — to undo Bun's auto-load.
 *
 * Files checked (matches Bun's auto-load set): `.env.local`, `.env.development`,
 * `.env.production`, `.env`. For each existing file, parsed keys are deleted
 * from `process.env`. Parse errors are ignored — a broken target repo `.env`
 * is not our concern; we only need to strip keys, not validate them.
 *
 * Returns the list of keys that were stripped (useful for tests and debug logs).
 */
export function stripCwdEnv(): string[] {
  const cwdEnvFiles = ['.env.local', '.env.development', '.env.production', '.env'];
  const stripped: string[] = [];

  for (const filename of cwdEnvFiles) {
    const path = resolve(process.cwd(), filename);
    if (!existsSync(path)) continue;
    try {
      const parsed = parse(readFileSync(path));
      for (const key of Object.keys(parsed)) {
        if (key in process.env) {
          // Dynamic delete is required: keys come from the target repo's .env
          // at runtime, so they cannot be known statically.
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete process.env[key];
          stripped.push(key);
        }
      }
    } catch {
      // Ignore parse errors — we're only trying to undo Bun's auto-load,
      // not validate the target repo's .env file.
    }
  }

  return stripped;
}
