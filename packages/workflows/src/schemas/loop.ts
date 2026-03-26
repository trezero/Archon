/**
 * Zod schema for loop node configuration.
 */
import { z } from '@hono/zod-openapi';

export const loopNodeConfigSchema = z.object({
  /** Inline prompt text executed each iteration. */
  prompt: z.string().min(1, "loop node requires 'loop.prompt' (non-empty string)"),
  /** Completion signal string detected in AI output (e.g., "COMPLETE"). */
  until: z.string().min(1, "loop node requires 'loop.until' (completion signal string)"),
  /** Maximum iterations allowed; exceeding this fails the node. */
  max_iterations: z.number().int().positive("'loop.max_iterations' must be a positive integer"),
  /** Whether to start fresh session each iteration (default: false). */
  fresh_context: z.boolean().default(false),
  /** Optional bash script run after each iteration; exit 0 = complete. */
  until_bash: z.string().optional(),
});

export type LoopNodeConfig = z.infer<typeof loopNodeConfigSchema>;
