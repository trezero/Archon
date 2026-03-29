/**
 * Zod schemas for codebase API endpoints.
 */
import { z } from '@hono/zod-openapi';

/** A single command entry within a codebase. */
const codebaseCommandSchema = z
  .object({ path: z.string(), description: z.string() })
  .openapi('CodebaseCommand');

/** A codebase record. */
export const codebaseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    repository_url: z.string().nullable(),
    default_cwd: z.string(),
    ai_assistant_type: z.string(),
    commands: z.record(codebaseCommandSchema),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Codebase');

/** GET /api/codebases response. */
export const codebaseListResponseSchema = z.array(codebaseSchema).openapi('CodebaseListResponse');

/** Path params for routes with :id (codebase ID). */
export const codebaseIdParamsSchema = z.object({ id: z.string() });

/** POST /api/codebases request body. Exactly one of url or path must be provided. */
export const addCodebaseBodySchema = z
  .object({
    url: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .refine(b => (b.url !== undefined) !== (b.path !== undefined), {
    message: 'Provide either "url" or "path", not both and not neither',
  })
  .openapi('AddCodebaseBody');

/** DELETE /api/codebases/:id response. */
export const deleteCodebaseResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteCodebaseResponse');
