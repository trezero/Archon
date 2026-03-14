/**
 * Async generator idle timeout utility.
 *
 * Wraps an async generator with an idle timeout — if no value is yielded
 * within `timeoutMs`, the wrapper returns normally, converting a hang
 * into a clean exit.
 *
 * This is the primary defense against subprocess hangs where the AI process
 * completes its work but fails to exit (stuck MCP connection, dangling child
 * process, etc.). Without this, the `for await` loop blocks indefinitely and
 * `step_completed` / `node_completed` is never recorded.
 */

/**
 * Default idle timeout: 5 minutes.
 *
 * Conservative — typical inter-message gaps are < 30 seconds even during
 * long tool calls (the SDK yields tool_use events before tool execution starts).
 */
export const STEP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Sentinel value to distinguish idle timeout from normal generator completion */
const IDLE_TIMEOUT_SENTINEL = Symbol('IDLE_TIMEOUT');

/**
 * Wraps an async generator with an idle timeout. If no value is yielded within
 * `timeoutMs`, the wrapper returns normally — converting a hang into a clean exit.
 *
 * When timeout fires:
 * 1. `onTimeout` callback is invoked (use this to abort the subprocess and log)
 * 2. The pending `generator.next()` promise gets a `.catch()` to prevent unhandled rejection
 * 3. We do NOT call `generator.return()` — it would block on the pending `.next()`
 * 4. The subprocess is cleaned up asynchronously via the abort signal from `onTimeout`
 *
 * @param generator - The async generator to wrap
 * @param timeoutMs - Maximum idle time in milliseconds before terminating
 * @param onTimeout - Optional callback invoked when idle timeout fires (before return)
 */
export async function* withIdleTimeout<T>(
  generator: AsyncGenerator<T>,
  timeoutMs: number,
  onTimeout?: () => void
): AsyncGenerator<T> {
  let timedOut = false;

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof IDLE_TIMEOUT_SENTINEL>(resolve => {
        timer = setTimeout(() => {
          resolve(IDLE_TIMEOUT_SENTINEL);
        }, timeoutMs);
      });

      // Start waiting for the next value from the generator
      const nextPromise = generator.next();

      const result = await Promise.race([nextPromise, timeoutPromise]);
      clearTimeout(timer);

      if (result === IDLE_TIMEOUT_SENTINEL) {
        timedOut = true;
        // Prevent unhandled rejection when the subprocess is aborted via onTimeout
        nextPromise.catch((_err: unknown) => {
          // Intentional: swallow rejection from aborted subprocess
        });
        onTimeout?.();
        return;
      }

      // result is IteratorResult<T> since it's not the sentinel
      const iterResult = result;
      if (iterResult.done) return;
      yield iterResult.value;
    }
  } finally {
    if (!timedOut) {
      // Normal exit (generator exhausted or consumer broke out) — safe to clean up
      try {
        await generator.return(undefined as never);
      } catch {
        // Generator cleanup errors are non-fatal
      }
    }
    // If timed out, don't call generator.return() — it would hang on the pending .next()
    // The onTimeout callback aborts the subprocess, which causes the pending .next()
    // to reject (caught by nextPromise.catch above) and the generator to finalize
  }
}
