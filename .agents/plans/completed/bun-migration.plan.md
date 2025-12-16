# Plan: Migrate from Node.js/tsx to Bun Runtime

## Summary

Migrate the remote-coding-agent project from Node.js with tsx to Bun as the primary runtime. This enables direct ESM module imports (eliminating the dynamic import workarounds for `@opencode-ai/sdk` and `@openai/codex-sdk`), provides native TypeScript execution without transpilation, and improves startup performance by ~6x. The migration follows a phased approach: first runtime scripts, then tests, then Docker, then simplify ESM clients.

## Intent

The current codebase uses ugly `new Function('modulePath', 'return import(modulePath)')` hacks to import ESM-only packages (`@opencode-ai/sdk`, `@openai/codex-sdk`) from CommonJS. This defeats the purpose of using typed SDKs. Bun provides seamless ESM/CJS interop, allowing direct imports with full type safety.

## Persona

Developers maintaining and extending this codebase who want:
- Clean imports without workarounds
- Full TypeScript type safety for SDK integrations
- Faster development feedback loops (Bun starts ~6x faster than ts-node)
- Smaller Docker images

## UX

**Before (Current State):**
```
┌─────────────────────────────────────────────────────────────┐
│ package.json                                                │
│   "dev": "tsx watch src/index.ts"                          │
│   "start": "node dist/index.js"                            │
│   "test": "jest"                                           │
├─────────────────────────────────────────────────────────────┤
│ opencode.ts / codex.ts                                      │
│   const importDynamic = new Function('...', 'import(...)') │
│   const sdk = await importDynamic('@opencode-ai/sdk')      │
│   // No type safety! Custom interfaces needed.              │
├─────────────────────────────────────────────────────────────┤
│ Dockerfile                                                  │
│   FROM node:20-slim                                         │
│   RUN npm ci && npm run build && npm prune --production    │
│   CMD ["node", "dist/index.js"]                            │
└─────────────────────────────────────────────────────────────┘
```

**After (With Bun):**
```
┌─────────────────────────────────────────────────────────────┐
│ package.json                                                │
│   "dev": "bun --watch src/index.ts"                        │
│   "start": "bun src/index.ts"                              │
│   "test": "bun test"                                       │
├─────────────────────────────────────────────────────────────┤
│ opencode.ts / codex.ts                                      │
│   import { createOpencodeClient } from '@opencode-ai/sdk'  │
│   // Full type safety! Direct SDK types.                    │
├─────────────────────────────────────────────────────────────┤
│ Dockerfile                                                  │
│   FROM oven/bun:1.2                                         │
│   COPY . .                                                  │
│   CMD ["bun", "src/index.ts"]                              │
│   # No build step! No node_modules pruning!                │
└─────────────────────────────────────────────────────────────┘
```

## External Research

### Documentation
- [Bun Migration Guide](https://blog.logrocket.com/migrating-typescript-app-node-js-bun/) - LogRocket guide on TypeScript migration
- [Bun Test Migration](https://bun.com/guides/test/migrate-from-jest) - Jest to bun:test migration
- [Bun Docker Guide](https://bun.com/docs/guides/ecosystem/docker) - Official Docker containerization docs
- [Bun Module Resolution](https://bun.sh/docs/runtime/modules) - ESM/CJS interop details

### Key Findings from Research

1. **Jest Compatibility**: Bun's test runner is Jest-compatible. `bun test` can run most Jest test suites without changes. Bun internally rewrites imports from `@jest/globals` to `bun:test`.

2. **Performance**:
   - Startup: 0.35s (Bun) vs 2.43s (ts-node) - **6.5x faster**
   - Tests: 13x faster than Jest in benchmarks
   - No transpilation overhead

3. **ESM/CJS Interop**: Bun seamlessly handles mixed modules. When you `require()` an ES module, Bun returns the module namespace object.

4. **Docker Image Size**: Bun images are smaller because:
   - No build step needed (direct TypeScript execution)
   - No separate devDependencies/production dependencies dance

5. **Gotchas Found**:
   - Scripts with `#!/usr/bin/env node` shebangs still run in Node, use `bun --bun` flag
   - `jsdom` doesn't work in Bun (uses V8 APIs) - use `happy-dom` instead
   - Some Node.js APIs may differ slightly

## Patterns to Mirror

### Current package.json Scripts (to be replaced)
```json
// FROM: package.json:6-19
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "test": "jest",
  "test:watch": "jest --watch",
  "type-check": "tsc --noEmit",
  // ...
}
```

### Current Dynamic Import Pattern (to be eliminated)
```typescript
// FROM: src/clients/opencode.ts:64-86
// Dynamic import that bypasses TypeScript transpilation
const importDynamic = new Function('modulePath', 'return import(modulePath)');

async function getClient(): Promise<OpenCodeClientInstance> {
  if (!clientInstance) {
    const sdk = (await importDynamic('@opencode-ai/sdk')) as {
      createOpencodeClient: (config?: { baseUrl?: string }) => OpenCodeClientInstance;
    };
    // ...
  }
}
```

### Current Dockerfile Pattern
```dockerfile
# FROM: Dockerfile:1-66
FROM node:20-slim
# Install deps, build TypeScript, prune production
RUN npm ci
RUN npm run build
RUN npm prune --production
CMD ["node", "dist/index.js"]
```

### Test Setup Pattern
```typescript
// FROM: src/test/setup.ts:1-14
jest.setTimeout(10000);
afterEach(() => { jest.clearAllMocks(); });
afterAll(() => { jest.restoreAllMocks(); });
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `package.json` | UPDATE | Change scripts to use Bun, add bun-types |
| `tsconfig.json` | UPDATE | Add Bun types, change moduleResolution to bundler |
| `Dockerfile` | UPDATE | Use oven/bun base image, simplify build |
| `docker-compose.yml` | UPDATE | Update build context if needed |
| `src/clients/opencode.ts` | UPDATE | Remove dynamic import hack, use direct import |
| `src/clients/codex.ts` | UPDATE | Remove dynamic import hack, use direct import |
| `src/clients/opencode.test.ts` | UPDATE | Remove global.Function patch for mocking |
| `src/clients/codex.test.ts` | UPDATE | Remove global.Function patch for mocking |
| `src/test/setup.ts` | UPDATE | Migrate to bun:test setup |
| `.github/workflows/*.yml` | UPDATE (if exists) | Use oven-sh/setup-bun@v2 |
| `bun.lock` | CREATE | Bun's lockfile (replaces package-lock.json) |

## NOT Building

- ❌ **Dual runtime support**: We're fully migrating to Bun, not maintaining Node.js compatibility
- ❌ **Hybrid test runner**: All tests move to bun:test, not keeping Jest alongside
- ❌ **Custom Bun plugins**: No custom plugins needed for this migration
- ❌ **tsconfig changes for Node**: We're not maintaining separate Node.js tsconfig

## Tasks

### Task 1: Install Bun and Create bun.lock

**Why**: Establish Bun as the package manager, which is faster and creates bun.lock

**Do**:
```bash
# Remove npm lockfile (will be replaced by bun.lock)
rm -f package-lock.json

# Install dependencies with Bun (creates bun.lock)
bun install

# Verify installation
bun --version
```

**Don't**:
- Don't keep both package-lock.json and bun.lock

**Verify**: `ls bun.lock && bun install --dry-run` shows no changes

---

### Task 2: Update package.json Scripts

**Why**: Replace Node.js/tsx/Jest commands with Bun equivalents

**Mirror**: Current scripts in `package.json:6-19`

**Do**: Edit `package.json` scripts section:
```json
{
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts --outdir=dist --target=bun",
    "start": "bun src/index.ts",
    "setup-auth": "bun src/scripts/setup-auth.ts",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "test:coverage": "bun test --coverage",
    "test:ci": "bun test --coverage",
    "type-check": "bun x tsc --noEmit",
    "lint": "bun x eslint . --cache",
    "lint:fix": "bun x eslint . --cache --fix",
    "format": "bun x prettier --write .",
    "format:check": "bun x prettier --check ."
  }
}
```

Also add `@types/bun` to devDependencies:
```json
{
  "devDependencies": {
    "@types/bun": "latest",
    // ... keep other devDeps
  }
}
```

And remove `tsx` from devDependencies (no longer needed).

**Don't**:
- Don't remove ts-jest yet (will be removed in later task)
- Don't change the `main` field yet

**Verify**: `bun run dev` starts the application

---

### Task 3: Update tsconfig.json for Bun

**Why**: Enable Bun type definitions and bundler module resolution for proper ESM import types

**Mirror**: Current `tsconfig.json`

**Do**: Edit `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

Key changes:
- `"module": "ESNext"` (was `"commonjs"`)
- `"moduleResolution": "bundler"` (was `"node"`)
- `"types": ["bun-types"]` (added)

**Don't**:
- Don't use `"module": "commonjs"` - Bun handles ESM natively

**Verify**: `bun x tsc --noEmit` passes

---

### Task 4: Create Bun Test Preload File

**Why**: Replace Jest setup with Bun test setup

**Mirror**: Current `src/test/setup.ts`

**Do**: Edit `src/test/setup.ts`:
```typescript
// Global test setup for bun:test
import { afterEach, afterAll, setSystemTime } from 'bun:test';

// Increase default timeout for async tests (Bun default is 5000ms)
// Note: Bun doesn't have a global setTimeout like Jest, timeouts are per-test

// Clean up mocks after each test
afterEach(() => {
  // Bun uses mock.restore() for individual mocks
  // For Jest compatibility, we clear any module mocks here
});

// Restore all mocks after all tests complete
afterAll(() => {
  // Reset any global state
});
```

**Don't**:
- Don't use `jest.setTimeout()` - not available in Bun

**Verify**: `bun test src/utils/variable-substitution.test.ts` runs

---

### Task 5: Migrate Test Files to bun:test

**Why**: Bun's test runner is mostly Jest-compatible but some imports may need adjustment

**Do**:
For most test files, Bun auto-rewrites Jest imports. However, for files using `jest.mock()` with the dynamic import workaround pattern (opencode.test.ts, codex.test.ts), update the mock pattern:

For `src/clients/opencode.test.ts`:
```typescript
import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';

// Mock the SDK module
mock.module('@opencode-ai/sdk', () => ({
  createOpencodeClient: mock(() => ({
    session: {
      create: mock(),
      prompt: mock(),
    },
  })),
}));

// Rest of tests remain the same structure
```

For `src/clients/codex.test.ts`:
```typescript
import { mock, describe, test, expect, beforeEach } from 'bun:test';

mock.module('@openai/codex-sdk', () => ({
  Codex: mock(() => ({
    startThread: mock(),
    resumeThread: mock(),
  })),
}));
```

**Note**: Most other test files using `jest.mock()` and `jest.fn()` should work as-is because Bun rewrites these internally.

**Don't**:
- Don't remove the `global.Function` patches yet - wait until clients are updated

**Verify**: `bun test` runs all tests

---

### Task 6: Simplify OpenCode Client (Remove Dynamic Import)

**Why**: With Bun + bundler moduleResolution, we can use direct ESM imports with full type safety

**Mirror**: Current dynamic import pattern in `src/clients/opencode.ts:64-86`

**Do**: Rewrite `src/clients/opencode.ts`:
```typescript
/**
 * OpenCode SDK wrapper
 * Provides async generator interface for streaming OpenCode responses
 */
import { createOpencodeClient } from '@opencode-ai/sdk';
import { IAssistantClient, MessageChunk } from '../types';

// Get SDK types directly
type OpencodeClient = ReturnType<typeof createOpencodeClient>;

// Singleton client instance
let clientInstance: OpencodeClient | null = null;

/**
 * Get or create OpenCode client instance
 * Uses singleton pattern since client is stateless connection to server
 */
function getClient(): OpencodeClient {
  if (!clientInstance) {
    const baseUrl = process.env.OPENCODE_URL || 'http://localhost:4096';
    clientInstance = createOpencodeClient({ baseUrl });
    console.log(`[OpenCode] Client initialized with server: ${baseUrl}`);
  }
  return clientInstance;
}

/**
 * OpenCode AI assistant client
 * Implements generic IAssistantClient interface
 */
export class OpenCodeClient implements IAssistantClient {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const client = getClient();

    // Get or create session
    let sessionId: string;
    if (resumeSessionId) {
      sessionId = resumeSessionId;
      console.log(`[OpenCode] Resuming session: ${sessionId}`);
    } else {
      try {
        const result = await client.session.create();
        sessionId = result.data.id;
        console.log(`[OpenCode] Created new session: ${sessionId}`);
      } catch (error) {
        console.error('[OpenCode] Failed to create session:', error);
        throw new Error(
          `Failed to create OpenCode session. Is the server running? (${process.env.OPENCODE_URL || 'http://localhost:4096'})`
        );
      }
    }

    if (cwd) {
      console.log(`[OpenCode] Note: cwd=${cwd} (managed at server level)`);
    }

    try {
      const response = await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: prompt }] },
      });

      const parts = response.data?.parts;
      if (parts && Array.isArray(parts)) {
        for (const part of parts) {
          if (part.type === 'text' && 'text' in part && part.text) {
            yield { type: 'assistant', content: part.text };
          } else if (part.type === 'tool' && 'tool' in part) {
            yield {
              type: 'tool',
              toolName: part.tool,
              toolInput: ('metadata' in part ? part.metadata : {}) ?? {},
            };
          } else if (part.type === 'step-start' && 'text' in part && part.text) {
            yield { type: 'thinking', content: part.text };
          }
        }
      }

      yield { type: 'result', sessionId };
    } catch (error) {
      const err = error as Error & { status?: number };
      if (err.status === 404) {
        console.error(`[OpenCode] Session not found: ${sessionId}`);
        throw new Error(`OpenCode session ${sessionId} not found. It may have expired.`);
      }
      console.error('[OpenCode] Query error:', error);
      throw error;
    }
  }

  getType(): string {
    return 'opencode';
  }
}
```

**Key changes**:
- Direct `import { createOpencodeClient } from '@opencode-ai/sdk'`
- Removed `new Function()` hack
- Removed manual interface definitions (use SDK types)
- `getClient()` is now synchronous (no async needed)

**Don't**:
- Don't keep the old dynamic import pattern
- Don't define custom interfaces that duplicate SDK types

**Verify**: `bun run dev` starts, `bun test src/clients/opencode.test.ts` passes

---

### Task 7: Simplify Codex Client (Remove Dynamic Import)

**Why**: Same as OpenCode - use direct ESM imports

**Mirror**: Current `src/clients/codex.ts`

**Do**: Rewrite `src/clients/codex.ts`:
```typescript
/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 */
import { Codex } from '@openai/codex-sdk';
import { IAssistantClient, MessageChunk } from '../types';

// Singleton Codex instance
let codexInstance: Codex | null = null;

/**
 * Get or create Codex SDK instance
 */
function getCodex(): Codex {
  if (!codexInstance) {
    codexInstance = new Codex();
  }
  return codexInstance;
}

/**
 * Codex AI assistant client
 * Implements generic IAssistantClient interface
 */
export class CodexClient implements IAssistantClient {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const codex = getCodex();

    let thread;
    if (resumeSessionId) {
      console.log(`[Codex] Resuming thread: ${resumeSessionId}`);
      try {
        thread = codex.resumeThread(resumeSessionId, {
          workingDirectory: cwd,
          skipGitRepoCheck: true,
        });
      } catch (error) {
        console.error(
          `[Codex] Failed to resume thread ${resumeSessionId}, creating new one:`,
          error
        );
        thread = codex.startThread({
          workingDirectory: cwd,
          skipGitRepoCheck: true,
        });
      }
    } else {
      console.log(`[Codex] Starting new thread in ${cwd}`);
      thread = codex.startThread({
        workingDirectory: cwd,
        skipGitRepoCheck: true,
      });
    }

    try {
      const result = await thread.runStreamed(prompt);

      for await (const event of result.events) {
        if (event.type === 'error') {
          console.error('[Codex] Stream error:', event.message);
          if (!event.message.includes('MCP client')) {
            yield { type: 'system', content: `⚠️ ${event.message}` };
          }
          continue;
        }

        if (event.type === 'turn.failed') {
          const errorObj = event.error as { message?: string } | undefined;
          const errorMessage = errorObj?.message ?? 'Unknown error';
          console.error('[Codex] Turn failed:', errorMessage);
          yield { type: 'system', content: `❌ Turn failed: ${errorMessage}` };
          break;
        }

        if (event.type === 'item.completed') {
          const item = event.item;
          switch (item.type) {
            case 'agent_message':
              if (item.text) yield { type: 'assistant', content: item.text };
              break;
            case 'command_execution':
              if (item.command) yield { type: 'tool', toolName: item.command };
              break;
            case 'reasoning':
              if (item.text) yield { type: 'thinking', content: item.text };
              break;
          }
        }

        if (event.type === 'turn.completed') {
          console.log('[Codex] Turn completed');
          yield { type: 'result', sessionId: thread.id ?? undefined };
          break;
        }
      }
    } catch (error) {
      console.error('[Codex] Query error:', error);
      throw new Error(`Codex query failed: ${(error as Error).message}`);
    }
  }

  getType(): string {
    return 'codex';
  }
}
```

**Key changes**:
- Direct `import { Codex } from '@openai/codex-sdk'`
- Removed `new Function()` hack
- Removed `CodexSDK` type alias (use SDK types directly)
- `getCodex()` is now synchronous

**Verify**: `bun test src/clients/codex.test.ts` passes

---

### Task 8: Update Test Files to Remove global.Function Patches

**Why**: With direct imports, we no longer need to patch global.Function

**Do**: Update `src/clients/opencode.test.ts`:
```typescript
import { mock, describe, test, expect, beforeEach, spyOn } from 'bun:test';

// Mock the SDK
const mockSessionCreate = mock();
const mockSessionPrompt = mock();

mock.module('@opencode-ai/sdk', () => ({
  createOpencodeClient: () => ({
    session: {
      create: mockSessionCreate,
      prompt: mockSessionPrompt,
    },
  }),
}));

import { OpenCodeClient } from './opencode';

describe('OpenCodeClient', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient();
    mockSessionCreate.mockClear();
    mockSessionPrompt.mockClear();
  });

  // ... rest of tests (same test cases, updated mock references)
});
```

Update `src/clients/codex.test.ts` similarly.

**Don't**:
- Don't keep the `global.Function` patches
- Don't keep the `{ virtual: true }` option (not needed in Bun)

**Verify**: `bun test src/clients/` passes

---

### Task 9: Update Dockerfile for Bun

**Why**: Use official Bun Docker image, eliminate build step

**Mirror**: Current `Dockerfile`

**Do**: Create new `Dockerfile`:
```dockerfile
FROM oven/bun:1.2-slim

# Install system dependencies (git, gh CLI needed for AI agents)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    bash \
    ca-certificates \
    gnupg \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && mkdir -p /workspace \
    && chown -R appuser:appuser /workspace

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy application source (Bun runs TypeScript directly!)
COPY . .
RUN chown -R appuser:appuser /app

USER appuser

# Configure git safe directory
RUN git config --global --add safe.directory /workspace && \
    git config --global --add safe.directory '/workspace/*'

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1

# Run directly with Bun - no build needed!
CMD ["bun", "src/index.ts"]
```

**Key changes**:
- `FROM oven/bun:1.2-slim` instead of `node:20-slim`
- No `npm run build` step - Bun runs TypeScript directly
- `bun install --frozen-lockfile --production` instead of `npm ci`
- `CMD ["bun", "src/index.ts"]` instead of `["node", "dist/index.js"]`
- Added HEALTHCHECK

**Verify**: `docker build -t remote-agent-bun .` succeeds

---

### Task 10: Update .dockerignore

**Why**: Ensure bun.lock is included, dist/ excluded

**Do**: Update `.dockerignore`:
```
node_modules
dist
coverage
.git
.env
.env.*
*.log
*.md
!README.md
Dockerfile*
docker-compose*.yml
.agents/
```

**Verify**: Docker build doesn't include node_modules

---

### Task 11: Remove Obsolete Dependencies

**Why**: tsx, ts-jest no longer needed with Bun

**Do**: Remove from devDependencies in `package.json`:
- `tsx`
- `ts-jest`
- `jest` (Bun has built-in test runner)
- `@types/jest` (use bun-types)

Update devDependencies:
```json
{
  "devDependencies": {
    "@eslint/js": "^9.39.1",
    "@types/bun": "latest",
    "@types/express": "^5.0.5",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "eslint": "^9.39.1",
    "eslint-config-prettier": "10.1.8",
    "prettier": "^3.7.4",
    "typescript": "^5.3.0",
    "typescript-eslint": "^8.48.0"
  }
}
```

Then run: `bun install`

**Verify**: `bun install` succeeds, no tsx/jest in node_modules

---

### Task 12: Update jest.config.js → bunfig.toml (Optional)

**Why**: Bun test configuration uses bunfig.toml instead of jest.config.js

**Do**: Create `bunfig.toml`:
```toml
[test]
preload = ["./src/test/setup.ts"]
coverage = true
coverageDir = "coverage"
timeout = 10000

[test.coverage]
exclude = ["src/**/*.test.ts", "src/test/**/*.ts"]
```

Remove `jest.config.js` (or keep for reference during migration).

**Verify**: `bun test` uses configuration

---

### Task 13: Update CI/CD (if GitHub Actions exist)

**Why**: CI needs to use Bun instead of Node.js

**Do**: If `.github/workflows/` exists, update to use:
```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: latest

- run: bun install
- run: bun test
- run: bun run type-check
- run: bun run lint
```

**Verify**: CI workflow passes

---

## Validation Strategy

### Automated Checks
- [ ] `bun install` - Dependencies install correctly
- [ ] `bun run type-check` - TypeScript types valid
- [ ] `bun run lint` - No lint errors
- [ ] `bun test` - All 1574+ tests pass
- [ ] `bun run dev` - Application starts

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| N/A | Existing tests | Migration doesn't break functionality |

No new test files needed - this is a runtime migration, not new functionality.

### Manual/E2E Validation

```bash
# 1. Start OpenCode server
opencode serve -p 4096

# 2. Start application with Bun
bun run dev

# 3. Test via test adapter
curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"bun-test","message":"What is 2+2?"}'

# 4. Check response
curl http://localhost:3090/test/messages/bun-test

# 5. Test Docker build
docker build -t remote-agent-bun .
docker run --env-file .env -p 3090:3090 remote-agent-bun
```

### Edge Cases to Test
- [ ] Session resumption works with OpenCode
- [ ] Session resumption works with Codex
- [ ] Claude client still works (doesn't use dynamic import)
- [ ] Long-running AI queries don't timeout
- [ ] Docker container starts and responds to health checks

### Regression Check
- [ ] All existing platform adapters work (Telegram, Slack, Discord, GitHub)
- [ ] All existing AI clients work (Claude, Codex, OpenCode)
- [ ] Database connections work
- [ ] Test adapter E2E flow works

## Risks

1. **Bun API Differences**: Some Node.js APIs may behave differently in Bun. Mitigated by running full test suite.

2. **Third-party Library Compatibility**: Some npm packages may not work with Bun. All our dependencies (pg, express, telegraf, discord.js, etc.) are known to work.

3. **Production Stability**: Bun is newer than Node.js. Mitigated by pinning Bun version and testing thoroughly.

4. **Team Learning Curve**: Developers need to learn Bun CLI. Mitigated by keeping npm-compatible command names.

5. **CI/CD Changes**: GitHub Actions needs Bun setup. Mitigated by using official `oven-sh/setup-bun` action.

## Rollback Plan

If migration fails:
1. Revert to previous commit
2. Run `npm install` to restore node_modules
3. Use `npm run dev` / `npm test` as before

Keep `package-lock.json` in git history for easy rollback.
