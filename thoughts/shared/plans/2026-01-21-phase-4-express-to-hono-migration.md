# Phase 4: Express → Hono Migration

## Overview

Phase 4 replaces Express with Hono in the server package. This is a focused migration that modernizes the HTTP layer while preserving all existing functionality.

**Why Hono:**

- 4x faster performance than Express (benchmarks)
- Built on Web Standards (fetch, Request, Response)
- Better TypeScript support with type-safe routes
- Smaller bundle size
- Native Bun integration (no adapter needed)
- Modern async/await patterns (no callback-style `next()`)

## Prerequisites

- [x] Phase 1 complete: Monorepo structure with `@archon/core` extracted
- [x] Phase 2 complete: CLI entry point and basic commands working
- [x] Phase 3 complete: Database abstraction (SQLite + PostgreSQL)

## Current State

The Express implementation in `packages/server/src/index.ts` is already thin (~140 lines of HTTP code):

```
Express Endpoints:
├── POST /webhooks/github     # GitHub webhook (raw body for signature)
├── GET  /health              # Basic health check
├── GET  /health/db           # Database connectivity
├── GET  /health/concurrency  # Lock manager stats
├── POST /test/message        # Test adapter: send message
├── GET  /test/messages/:id   # Test adapter: get responses
├── DELETE /test/messages{/:id}  # Test adapter: clear messages (optional param)
└── PUT  /test/mode           # Test adapter: set streaming mode
```

**Key patterns:**

- GitHub webhook uses `express.raw()` for raw body (signature verification)
- All other endpoints use `express.json()` for JSON parsing
- Middleware order matters: raw body route registered BEFORE json middleware
- Express 5 optional parameter syntax: `{/:conversationId}`

## Desired End State

Replace Express with Hono while maintaining exact API compatibility:

```typescript
// Before (Express)
import express from 'express';
const app = express();
app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const payload = (req.body as Buffer).toString('utf-8');
  return res.status(200).send('OK');
});

// After (Hono)
import { Hono } from 'hono';
const app = new Hono();
app.post('/webhooks/github', async c => {
  const signature = c.req.header('x-hub-signature-256');
  const payload = await c.req.text(); // Raw body, no middleware needed
  return c.text('OK', 200);
});
```

**Verification:**

- All endpoints respond identically
- GitHub webhook signature verification works
- Test adapter continues to function
- Health checks pass
- Adapters (Telegram, Slack, Discord) unaffected (they don't use HTTP)

## What We're NOT Doing

- NOT changing any adapter code (Telegram, Slack, Discord, GitHub adapters)
- NOT changing the test adapter class (`test.ts`) - only HTTP routes that use it
- NOT adding new endpoints
- NOT adding Hono middleware (logger, cors) - keep it minimal like Express was
- NOT changing graceful shutdown logic
- NOT changing adapter initialization order
- NOT refactoring the `main()` function structure

---

## Implementation Plan

### Phase 4.1: Add Hono, Remove Express

**Files Modified:**

- `packages/server/package.json`

**Changes:**

```bash
# In packages/server directory
bun add hono
bun remove express @types/express
```

Update `package.json`:

```json
{
  "dependencies": {
    "@archon/core": "workspace:*",
    "@octokit/rest": "^22.0.0",
    "@slack/bolt": "^4.6.0",
    "discord.js": "^14.16.0",
    "dotenv": "^17.2.3",
    "hono": "^4.7.0",
    "telegraf": "^4.16.0",
    "telegramify-markdown": "^1.3.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0"
  }
}
```

**Note:** Remove `@types/express` from devDependencies (Hono has built-in TypeScript types).

### Success Criteria (4.1):

#### Automated Verification:

- [x] `bun install` in packages/server completes without errors
- [x] `bun run type-check` passes (no Express type references remain)

---

### Phase 4.2: Migrate index.ts to Hono

**File Modified:**

- `packages/server/src/index.ts`

**Step-by-step changes:**

#### 4.2.1: Update imports

```typescript
// Before
import express from 'express';

// After
import { Hono } from 'hono';
```

#### 4.2.2: Create Hono app

```typescript
// Before
const app = express();
const port = await getPort();

// After
const app = new Hono();
const port = await getPort();
```

#### 4.2.3: Migrate GitHub Webhook Endpoint

This is the most critical endpoint - it requires raw body access for HMAC signature verification.

```typescript
// Before (Express)
if (github) {
  app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
    const eventType = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    try {
      const signature = req.headers['x-hub-signature-256'] as string;
      if (!signature) {
        return res.status(400).json({ error: 'Missing signature header' });
      }

      const payload = (req.body as Buffer).toString('utf-8');

      github.handleWebhook(payload, signature).catch((error: unknown) => {
        console.error('[GitHub] Webhook processing error:', { error, eventType, deliveryId });
      });

      return res.status(200).send('OK');
    } catch (error) {
      console.error('[GitHub] Webhook endpoint error:', { error, eventType, deliveryId });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  console.log('[Express] GitHub webhook endpoint registered');
}

// After (Hono)
if (github) {
  app.post('/webhooks/github', async c => {
    const eventType = c.req.header('x-github-event');
    const deliveryId = c.req.header('x-github-delivery');

    try {
      const signature = c.req.header('x-hub-signature-256');
      if (!signature) {
        return c.json({ error: 'Missing signature header' }, 400);
      }

      // CRITICAL: Use c.req.text() for raw body (signature verification)
      const payload = await c.req.text();

      github.handleWebhook(payload, signature).catch((error: unknown) => {
        console.error('[GitHub] Webhook processing error:', { error, eventType, deliveryId });
      });

      return c.text('OK', 200);
    } catch (error) {
      console.error('[GitHub] Webhook endpoint error:', { error, eventType, deliveryId });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
  console.log('[Hono] GitHub webhook endpoint registered');
}
```

**Key differences:**

- No middleware needed - `c.req.text()` returns raw body directly
- Headers: `c.req.header('name')` instead of `req.headers['name']`
- Response: `c.json(data, status)` and `c.text(text, status)` instead of `res.status(n).json()`

#### 4.2.4: Remove JSON Middleware

```typescript
// Before
app.use(express.json());

// After
// No global middleware needed - Hono parses body per-route with c.req.json()
```

#### 4.2.5: Migrate Health Check Endpoints

```typescript
// Before (Express)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/db', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('[Health] Database health check failed:', error);
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

app.get('/health/concurrency', (_req, res) => {
  try {
    const stats = lockManager.getStats();
    res.json({ status: 'ok', ...stats });
  } catch (error) {
    console.error('[Health] Failed to get concurrency stats:', error);
    res.status(500).json({ status: 'error', reason: 'Failed to get stats' });
  }
});

// After (Hono)
app.get('/health', c => {
  return c.json({ status: 'ok' });
});

app.get('/health/db', async c => {
  try {
    await pool.query('SELECT 1');
    return c.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('[Health] Database health check failed:', error);
    return c.json({ status: 'error', database: 'disconnected' }, 500);
  }
});

app.get('/health/concurrency', c => {
  try {
    const stats = lockManager.getStats();
    return c.json({ status: 'ok', ...stats });
  } catch (error) {
    console.error('[Health] Failed to get concurrency stats:', error);
    return c.json({ status: 'error', reason: 'Failed to get stats' }, 500);
  }
});
```

#### 4.2.6: Migrate Test Adapter Endpoints

```typescript
// Before (Express)
app.post('/test/message', async (req, res) => {
  try {
    const { conversationId, message } = req.body as {
      conversationId?: unknown;
      message?: unknown;
    };
    if (typeof conversationId !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'conversationId and message must be strings' });
    }
    if (!conversationId || !message) {
      return res.status(400).json({ error: 'conversationId and message required' });
    }

    await testAdapter.receiveMessage(conversationId, message);

    lockManager
      .acquireLock(conversationId, async () => {
        await handleMessage(testAdapter, conversationId, message);
      })
      .catch(createMessageErrorHandler('Test', testAdapter, conversationId));

    return res.json({ success: true, conversationId, message });
  } catch (error) {
    console.error('[Test] Endpoint error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/test/messages/:conversationId', (req, res) => {
  const messages = testAdapter.getSentMessages(req.params.conversationId);
  res.json({ conversationId: req.params.conversationId, messages });
});

// Express 5 optional parameter syntax
app.delete('/test/messages{/:conversationId}', (req, res) => {
  testAdapter.clearMessages(req.params.conversationId);
  res.json({ success: true });
});

app.put('/test/mode', (req, res) => {
  const { mode } = req.body as { mode?: unknown };
  if (mode !== 'stream' && mode !== 'batch') {
    return res.status(400).json({ error: 'mode must be "stream" or "batch"' });
  }
  testAdapter.setStreamingMode(mode);
  return res.json({ success: true, mode });
});

// After (Hono)
app.post('/test/message', async c => {
  try {
    const body = await c.req.json<{ conversationId?: unknown; message?: unknown }>();
    const { conversationId, message } = body;

    if (typeof conversationId !== 'string' || typeof message !== 'string') {
      return c.json({ error: 'conversationId and message must be strings' }, 400);
    }
    if (!conversationId || !message) {
      return c.json({ error: 'conversationId and message required' }, 400);
    }

    await testAdapter.receiveMessage(conversationId, message);

    lockManager
      .acquireLock(conversationId, async () => {
        await handleMessage(testAdapter, conversationId, message);
      })
      .catch(createMessageErrorHandler('Test', testAdapter, conversationId));

    return c.json({ success: true, conversationId, message });
  } catch (error) {
    console.error('[Test] Endpoint error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/test/messages/:conversationId', c => {
  const conversationId = c.req.param('conversationId');
  const messages = testAdapter.getSentMessages(conversationId);
  return c.json({ conversationId, messages });
});

// Hono optional parameter syntax: :param? (different from Express 5)
app.delete('/test/messages/:conversationId?', c => {
  const conversationId = c.req.param('conversationId');
  testAdapter.clearMessages(conversationId);
  return c.json({ success: true });
});

app.put('/test/mode', async c => {
  const body = await c.req.json<{ mode?: unknown }>();
  const { mode } = body;
  if (mode !== 'stream' && mode !== 'batch') {
    return c.json({ error: 'mode must be "stream" or "batch"' }, 400);
  }
  testAdapter.setStreamingMode(mode);
  return c.json({ success: true, mode });
});
```

**Key differences:**

- Body parsing: `await c.req.json<T>()` instead of `req.body as T`
- Route params: `c.req.param('name')` instead of `req.params.name`
- Optional params: `/:param?` instead of Express 5's `{/:param}`
- All handlers must `return` the response (not just call `res.json()`)

#### 4.2.7: Migrate Server Startup

```typescript
// Before (Express)
app.listen(port, () => {
  console.log(`[Express] Server listening on port ${String(port)}`);
});

// After (Hono with Bun)
// Bun uses export default pattern for Hono apps
// But since we're inside main(), we need to use Bun.serve() directly
const server = Bun.serve({
  port,
  fetch: app.fetch,
});
console.log(`[Hono] Server listening on port ${String(server.port)}`);
```

**Alternative approach (simpler, recommended):**

Since we're already using `bun run dev` which starts the process, we can use Hono's built-in method:

```typescript
// After (Hono - using serve helper)
import { serve } from 'hono/bun';

// At the end of main()
serve(
  {
    fetch: app.fetch,
    port,
  },
  info => {
    console.log(`[Hono] Server listening on port ${String(info.port)}`);
  }
);
```

#### 4.2.8: Update Log Messages

Change `[Express]` to `[Hono]` in all log messages for consistency.

### Success Criteria (4.2):

#### Automated Verification:

- [x] `bun run type-check` passes with no errors
- [x] `bun run lint` passes with no warnings
- [x] `bun test` passes all existing tests
- [x] `bun run dev` starts server successfully

#### Manual Verification:

- [x] `curl http://localhost:3090/health` returns `{"status":"ok"}`
- [x] `curl http://localhost:3090/health/db` returns `{"status":"ok","database":"connected"}`
- [x] `curl http://localhost:3090/health/concurrency` returns stats JSON
- [x] Test adapter works:

  ```bash
  curl -X POST http://localhost:3090/test/message \
    -H "Content-Type: application/json" \
    -d '{"conversationId":"test-1","message":"/status"}'

  curl http://localhost:3090/test/messages/test-1

  curl -X DELETE http://localhost:3090/test/messages/test-1
  ```

- [x] GitHub webhook works (if configured):
  - Push to a repo with webhook configured
  - Verify webhook is received and processed
  - Check signature verification works (invalid signature should be rejected)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding.

---

### Phase 4.3: Update Documentation and Scripts

**Files Modified:**

- `packages/server/package.json` - Update scripts if needed
- `CLAUDE.md` - Update any Express references to Hono
- `README.md` - Update framework references if present

**Changes:**

1. **package.json scripts** - Should continue to work as-is:

   ```json
   {
     "scripts": {
       "dev": "bun --watch src/index.ts",
       "start": "bun src/index.ts"
     }
   }
   ```

2. **CLAUDE.md** - Search and replace:
   - `Express` → `Hono` in architecture descriptions
   - Update any code examples that show Express patterns
   - Update the "Architecture Layers" section if it mentions Express

3. **README.md** - Update framework mention if present

### Success Criteria (4.3):

#### Automated Verification:

- [x] `bun run validate` passes from workspace root
- [x] No references to "Express" remain in documentation (except historical context)

---

## Complete Migration Diff

Here's the complete diff for `packages/server/src/index.ts`:

```diff
 import 'dotenv/config';

-import express from 'express';
+import { Hono } from 'hono';
+import { serve } from 'hono/bun';
 import { TelegramAdapter } from './adapters/telegram';
 // ... other imports unchanged

 async function main(): Promise<void> {
   // ... initialization code unchanged until Express setup

-  // Setup Express server
-  const app = express();
+  // Setup Hono server
+  const app = new Hono();
   const port = await getPort();

-  // GitHub webhook endpoint (must use raw body for signature verification)
-  // IMPORTANT: Register BEFORE express.json() to prevent body parsing
   if (github) {
-    app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
-      const eventType = req.headers['x-github-event'] as string | undefined;
-      const deliveryId = req.headers['x-github-delivery'] as string | undefined;
+    app.post('/webhooks/github', async (c) => {
+      const eventType = c.req.header('x-github-event');
+      const deliveryId = c.req.header('x-github-delivery');

       try {
-        const signature = req.headers['x-hub-signature-256'] as string;
+        const signature = c.req.header('x-hub-signature-256');
         if (!signature) {
-          return res.status(400).json({ error: 'Missing signature header' });
+          return c.json({ error: 'Missing signature header' }, 400);
         }

-        const payload = (req.body as Buffer).toString('utf-8');
+        const payload = await c.req.text();

         github.handleWebhook(payload, signature).catch((error: unknown) => {
           console.error('[GitHub] Webhook processing error:', { error, eventType, deliveryId });
         });

-        return res.status(200).send('OK');
+        return c.text('OK', 200);
       } catch (error) {
         console.error('[GitHub] Webhook endpoint error:', { error, eventType, deliveryId });
-        return res.status(500).json({ error: 'Internal server error' });
+        return c.json({ error: 'Internal server error' }, 500);
       }
     });
-    console.log('[Express] GitHub webhook endpoint registered');
+    console.log('[Hono] GitHub webhook endpoint registered');
   }

-  // JSON parsing for all other endpoints
-  app.use(express.json());

   // Health check endpoints
-  app.get('/health', (_req, res) => {
-    res.json({ status: 'ok' });
+  app.get('/health', (c) => {
+    return c.json({ status: 'ok' });
   });

-  app.get('/health/db', async (_req, res) => {
+  app.get('/health/db', async (c) => {
     try {
       await pool.query('SELECT 1');
-      res.json({ status: 'ok', database: 'connected' });
+      return c.json({ status: 'ok', database: 'connected' });
     } catch (error) {
       console.error('[Health] Database health check failed:', error);
-      res.status(500).json({ status: 'error', database: 'disconnected' });
+      return c.json({ status: 'error', database: 'disconnected' }, 500);
     }
   });

-  app.get('/health/concurrency', (_req, res) => {
+  app.get('/health/concurrency', (c) => {
     try {
       const stats = lockManager.getStats();
-      res.json({ status: 'ok', ...stats });
+      return c.json({ status: 'ok', ...stats });
     } catch (error) {
       console.error('[Health] Failed to get concurrency stats:', error);
-      res.status(500).json({ status: 'error', reason: 'Failed to get stats' });
+      return c.json({ status: 'error', reason: 'Failed to get stats' }, 500);
     }
   });

   // Test adapter endpoints
-  app.post('/test/message', async (req, res) => {
+  app.post('/test/message', async (c) => {
     try {
-      const { conversationId, message } = req.body as {
-        conversationId?: unknown;
-        message?: unknown;
-      };
+      const body = await c.req.json<{ conversationId?: unknown; message?: unknown }>();
+      const { conversationId, message } = body;
+
       if (typeof conversationId !== 'string' || typeof message !== 'string') {
-        return res.status(400).json({ error: 'conversationId and message must be strings' });
+        return c.json({ error: 'conversationId and message must be strings' }, 400);
       }
       if (!conversationId || !message) {
-        return res.status(400).json({ error: 'conversationId and message required' });
+        return c.json({ error: 'conversationId and message required' }, 400);
       }

       await testAdapter.receiveMessage(conversationId, message);

       lockManager
         .acquireLock(conversationId, async () => {
           await handleMessage(testAdapter, conversationId, message);
         })
         .catch(createMessageErrorHandler('Test', testAdapter, conversationId));

-      return res.json({ success: true, conversationId, message });
+      return c.json({ success: true, conversationId, message });
     } catch (error) {
       console.error('[Test] Endpoint error:', error);
-      return res.status(500).json({ error: 'Internal server error' });
+      return c.json({ error: 'Internal server error' }, 500);
     }
   });

-  app.get('/test/messages/:conversationId', (req, res) => {
-    const messages = testAdapter.getSentMessages(req.params.conversationId);
-    res.json({ conversationId: req.params.conversationId, messages });
+  app.get('/test/messages/:conversationId', (c) => {
+    const conversationId = c.req.param('conversationId');
+    const messages = testAdapter.getSentMessages(conversationId);
+    return c.json({ conversationId, messages });
   });

-  // Express 5 optional parameter syntax - handles both /test/messages and /test/messages/:id
-  app.delete('/test/messages{/:conversationId}', (req, res) => {
-    testAdapter.clearMessages(req.params.conversationId);
-    res.json({ success: true });
+  // Hono optional parameter syntax
+  app.delete('/test/messages/:conversationId?', (c) => {
+    const conversationId = c.req.param('conversationId');
+    testAdapter.clearMessages(conversationId);
+    return c.json({ success: true });
   });

-  // Set test adapter streaming mode
-  app.put('/test/mode', (req, res) => {
-    const { mode } = req.body as { mode?: unknown };
+  app.put('/test/mode', async (c) => {
+    const body = await c.req.json<{ mode?: unknown }>();
+    const { mode } = body;
     if (mode !== 'stream' && mode !== 'batch') {
-      return res.status(400).json({ error: 'mode must be "stream" or "batch"' });
+      return c.json({ error: 'mode must be "stream" or "batch"' }, 400);
     }
     testAdapter.setStreamingMode(mode);
-    return res.json({ success: true, mode });
+    return c.json({ success: true, mode });
   });

-  app.listen(port, () => {
-    console.log(`[Express] Server listening on port ${String(port)}`);
+  serve({
+    fetch: app.fetch,
+    port,
+  }, (info) => {
+    console.log(`[Hono] Server listening on port ${String(info.port)}`);
   });

   // ... rest of main() unchanged (Telegram adapter, shutdown handling)
```

---

## Testing Strategy

### Unit Tests

No new unit tests needed - existing tests should continue to pass. The migration is a 1:1 replacement of HTTP patterns.

### Integration Tests

The test adapter endpoints provide integration testing capability:

```bash
# 1. Start server
bun run dev

# 2. Test basic health
curl http://localhost:3000/health

# 3. Test database health
curl http://localhost:3000/health/db

# 4. Test message flow
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-hono","message":"/status"}'

# 5. Verify response stored
curl http://localhost:3000/test/messages/test-hono

# 6. Clear messages
curl -X DELETE http://localhost:3000/test/messages/test-hono

# 7. Test streaming mode
curl -X PUT http://localhost:3000/test/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"batch"}'
```

### GitHub Webhook Testing

If GitHub webhook is configured:

1. Make a commit to trigger webhook
2. Check server logs for `[GitHub] Webhook processing`
3. Verify no signature errors

Alternatively, use a tool like `ngrok` to expose local server:

```bash
ngrok http 3000
# Configure GitHub webhook to point to ngrok URL
```

---

## Risk Mitigation

| Risk                                 | Likelihood | Impact | Mitigation                                             |
| ------------------------------------ | ---------- | ------ | ------------------------------------------------------ |
| Webhook signature verification fails | Low        | High   | Test with real GitHub webhook before merging           |
| Optional parameter syntax differs    | Low        | Low    | Hono uses `:param?` not `{/:param}` - verified in docs |
| Body parsing behavior differs        | Low        | Medium | Use `c.req.text()` for raw, `c.req.json()` for parsed  |
| Bun.serve() port allocation          | Low        | Low    | Verify port from `info.port` matches expected          |

---

## Performance Considerations

Hono is significantly faster than Express:

- 4x higher requests/second in benchmarks
- Lower memory footprint
- Native Bun integration (no Node.js compatibility layer)

However, for this application:

- HTTP layer is not the bottleneck (AI operations dominate)
- Current Express usage is minimal (~8 endpoints)
- Performance gain is a nice-to-have, not the primary motivation

Primary motivation: Modern, type-safe, Web Standards-based framework.

---

## References

- Research document: `thoughts/shared/research/2026-01-20-cli-first-refactor-feasibility.md`
- Hono documentation: https://hono.dev/docs/
- Hono Bun integration: https://hono.dev/docs/getting-started/bun
- Current Express implementation: `packages/server/src/index.ts:266-392`

---

## Estimated Effort

- Phase 4.1 (dependencies): 10 minutes
- Phase 4.2 (code migration): 1-2 hours
- Phase 4.3 (documentation): 30 minutes
- Testing and verification: 1 hour

**Total: 2-4 hours**
