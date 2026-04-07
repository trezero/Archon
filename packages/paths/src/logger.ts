/**
 * Structured logging utility built on Pino
 *
 * Usage:
 *   import { createLogger } from '@archon/paths';
 *   const log = createLogger('orchestrator');
 *   log.info({ conversationId }, 'session_started');
 *   log.error({ err, conversationId }, 'session_failed');
 *
 * Log levels (standard Pino levels):
 *   fatal (60) - Process cannot continue
 *   error (50) - Failures needing immediate attention
 *   warn  (40) - Degraded behavior, fallbacks
 *   info  (30) - Key user-visible events (DEFAULT)
 *   debug (20) - Internal details, tool calls, state transitions
 *   trace (10) - Fine-grained diagnostic output
 *
 * Configuration:
 *   LOG_LEVEL env var or setLogLevel() at startup
 *   Pretty-printed when stdout is a TTY and NODE_ENV !== 'production'
 *   Newline-delimited JSON otherwise (piped, redirected, or production)
 */

import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger } from 'pino';

const VALID_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

function getInitialLevel(): string {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel) {
    if (VALID_LEVELS.has(envLevel)) {
      return envLevel;
    }
    // Warn via console since the logger itself isn't configured yet
    console.warn(
      `[logger] Invalid LOG_LEVEL '${process.env.LOG_LEVEL}'. ` +
        `Valid levels: ${[...VALID_LEVELS].join(', ')}. Falling back to 'info'.`
    );
  }
  return 'info';
}

/**
 * Detect whether the current process is running as a `bun build --compile`
 * binary. Inlined here because `@archon/paths` has zero `@archon/*` deps.
 *
 * pino-pretty cannot be loaded inside a compiled binary: pino transports spawn
 * a worker that does a dynamic `require.resolve('pino-pretty')`, which fails
 * inside Bun's virtual `/$bunfs/` filesystem and crashes the binary on startup.
 */
function isCompiledBinary(): boolean {
  const dir = import.meta.dir ?? '';
  if (dir.startsWith('/$bunfs/') || dir.startsWith('B:\\~BUN\\') || dir.startsWith('B:/~BUN/')) {
    return true;
  }
  const exec = process.execPath ?? '';
  const base = exec.split(/[/\\]/).pop() ?? '';
  const withoutExt = base.replace(/\.exe$/i, '').toLowerCase();
  return exec !== '' && withoutExt !== 'bun' && withoutExt !== 'node';
}

/**
 * Uses pino-pretty when stdout is a TTY and NODE_ENV !== 'production';
 * outputs newline-delimited JSON otherwise.
 *
 * Compiled binaries always use NDJSON (pino-pretty transport cannot resolve
 * inside `/$bunfs/`).
 */
function buildLoggerOptions(): pino.LoggerOptions {
  const level = getInitialLevel();
  const usePretty =
    process.stdout.isTTY && process.env.NODE_ENV !== 'production' && !isCompiledBinary();

  if (usePretty) {
    return {
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          levelFirst: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    };
  }

  return { level };
}

/**
 * Root Pino logger instance.
 * Children inherit the root's level at creation time (not dynamically updated).
 */
export const rootLogger: Logger = pino(buildLoggerOptions());

/**
 * Create a child logger with a module binding.
 *
 * @param module - Dotted namespace for the module (e.g. 'orchestrator', 'workflow.executor')
 * @returns Pino child logger with `{ module }` binding
 */
export function createLogger(module: string): Logger {
  return rootLogger.child({ module });
}

/**
 * Set the log level on the root logger at runtime.
 * Only affects child loggers created after this call.
 * Call early in startup before modules call createLogger().
 *
 * @param level - One of: 'fatal', 'error', 'warn', 'info', 'debug', 'trace'
 * @throws Error if level is not a valid Pino log level
 */
export function setLogLevel(level: string): void {
  const normalized = level.toLowerCase();
  if (!VALID_LEVELS.has(normalized)) {
    throw new Error(`Invalid log level: '${level}'. Valid levels: ${[...VALID_LEVELS].join(', ')}`);
  }
  rootLogger.level = normalized;
}

export function getLogLevel(): string {
  return rootLogger.level;
}
