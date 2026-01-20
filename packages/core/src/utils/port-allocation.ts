/**
 * Port allocation utilities for Express server
 * Separated from index.ts to allow testing without triggering app startup
 */
import { createHash } from 'crypto';
import { isWorktreePath } from './git';

/**
 * Calculate hash-based port offset for worktree paths.
 * Exported for testing.
 *
 * @param path - The worktree path to hash
 * @returns Offset in range 100-999 (ports 3100-3999 when added to base 3000)
 */
export function calculatePortOffset(path: string): number {
  const hash = createHash('md5').update(path).digest();
  // 100-999 range: Offset starts at 100 to avoid default port 3000, results in ports 3100-3999
  return (hash.readUInt16BE(0) % 900) + 100;
}

/**
 * Get the port for the Express server
 * - If PORT env var is set: use it (explicit override, validated)
 * - If running in worktree: auto-allocate deterministic port based on path hash
 * - Otherwise: use default 3000
 *
 * Note: Exits process with code 1 if PORT env var is set but invalid (not 1-65535)
 */
export async function getPort(): Promise<number> {
  const envPort = process.env.PORT;

  if (envPort) {
    const parsedPort = Number(envPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      console.error(
        `[Express] Invalid PORT environment variable: "${envPort}". Must be an integer between 1-65535.`
      );
      process.exit(1);
    }
    return parsedPort;
  }

  const basePort = 3000;
  const cwd = process.cwd();

  if (await isWorktreePath(cwd)) {
    const offset = calculatePortOffset(cwd);
    const port = basePort + offset;
    console.log(`[Express] Worktree detected (${cwd})`);
    console.log(`[Express] Auto-allocated port: ${port} (base: ${basePort}, offset: +${offset})`);
    return port;
  }

  console.log(`[Express] Using default port: ${basePort} (not in worktree)`);
  return basePort;
}
