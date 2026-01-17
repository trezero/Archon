# Investigation: Feature: Worktree-aware automatic port allocation

**Issue**: #147 (https://github.com/dynamous-community/remote-coding-agent/issues/147)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T07:45:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | LOW | Issue author labeled it "priority: low" and "dx" - this is a developer experience improvement with an existing workaround (manual PORT env var documented in CLAUDE.md), not blocking any critical functionality |
| Complexity | LOW | Single file change (~20 lines) using existing utilities (isWorktreePath, createHash), one new test file, no database changes or external integrations - isolated and straightforward |
| Confidence | HIGH | Clear requirement with specific solution proposed, existing utilities proven in production, hash-based allocation is deterministic and testable, no unknowns or ambiguity |

---

## Problem Statement

Agents working in worktrees need to run multiple instances of the app (`bun dev`) for self-testing loops (make changes → run app → test via curl → fix). Currently, all instances try to bind to the same port (3000 or PORT env var), causing conflicts. The workaround requires agents to manually set unique PORTs and track which ports are in use.

---

## Analysis

### Enhancement Change Rationale

**Current Behavior:**
```typescript
// src/index.ts:261
const port = process.env.PORT ?? 3000;
```

All instances use the same port, causing `EADDRINUSE` errors when running multiple worktree instances.

**Desired Behavior:**
- Main repo (not in worktree): Use PORT env var or default 3000
- Worktree: Auto-allocate unique port based on path hash (deterministic)
- Explicit PORT env var: Always override (backwards compatible)

**Benefits:**
1. Zero-config for agents - just run `bun dev`, port is automatic
2. Deterministic - same worktree always gets same port
3. No port conflicts between worktrees
4. Backwards compatible - explicit PORT still works
5. Enables agentic self-testing loops without manual coordination

### Evidence Chain

**Problem Root:**
- Single port configuration at `src/index.ts:261`
- No worktree context awareness
- Manual workaround documented in CLAUDE.md and issue #154

**Integration Points:**
- Port used only for Express server: `src/index.ts:379-381`
- Existing worktree detection: `src/utils/git.ts:111-120` (`isWorktreePath()`)
- Existing logging patterns: `src/index.ts:380` (`[Express]` prefix)
- Existing path utilities: `src/utils/archon-paths.ts:66-68` (`getArchonWorktreesPath()`)

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/index.ts` | 1-10, 261 | UPDATE | Add `getPort()` function and import crypto |
| `src/index.ts` | 261 | UPDATE | Replace `process.env.PORT ?? 3000` with `await getPort()` |
| `src/index.ts` | 259-262 | UPDATE | Make server setup async to call `await getPort()` |
| `src/index.test.ts` | NEW | CREATE | Unit tests for `getPort()` function |

### Git History

- **Last modified**: 69ba686 (2025-01-10) - "Fix: Add ConversationLock to GitHub webhook handler"
- **Port configuration unchanged**: Simple `process.env.PORT ?? 3000` pattern since initial implementation
- **Implication**: No recent changes to port logic, safe to modify

---

## Implementation Plan

### Step 1: Add `getPort()` function to `src/index.ts`

**File**: `src/index.ts`
**Lines**: 1-10 (imports), 261 (port assignment)
**Action**: UPDATE

**Current code (lines 1-10):**
```typescript
import express from 'express';
import 'dotenv/config';
import { pool } from './db/connection.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { GitHubAdapter } from './adapters/github.js';
import { TestAdapter } from './adapters/test.js';
import { handleMessage } from './orchestrator/orchestrator.js';
import { SlackAdapter } from './adapters/slack.js';
import { logArchonPaths } from './utils/archon-paths.js';
import { ConversationLock } from './db/conversation-lock.js';
```

**Required change - Add crypto import:**
```typescript
import { createHash } from 'crypto';
import express from 'express';
import 'dotenv/config';
// ... rest of imports unchanged
```

**Add new function after imports (before main code):**
```typescript
/**
 * Get the port for the Express server
 * - If PORT env var is set: use it (explicit override)
 * - If running in worktree: auto-allocate unique port based on path hash
 * - Otherwise: use default 3000
 */
async function getPort(): Promise<number> {
  const envPort = process.env.PORT;
  const basePort = envPort ? Number(envPort) : 3000;

  // If PORT is explicitly set, use it (user override)
  if (envPort) {
    return basePort;
  }

  // Detect if running in a worktree
  const cwd = process.cwd();
  if (await isWorktreePath(cwd)) {
    // Hash the path to get consistent offset per worktree
    const hash = createHash('md5').update(cwd).digest();
    const offset = (hash.readUInt16BE(0) % 900) + 100; // 100-999 range
    const port = basePort + offset;
    console.log(`[Express] Worktree detected (${cwd})`);
    console.log(`[Express] Auto-allocated port: ${port} (base: ${basePort}, offset: +${offset})`);
    return port;
  }

  return basePort;
}
```

**Why:**
- Hash-based calculation ensures deterministic port per worktree
- Explicit PORT env var takes precedence (backwards compatible)
- Logging makes it clear to agents which port was allocated
- Uses existing `isWorktreePath()` utility from `src/utils/git.ts`

---

### Step 2: Update port assignment to use `getPort()`

**File**: `src/index.ts`
**Lines**: 259-262
**Action**: UPDATE

**Current code:**
```typescript
  // Setup Express server
  const app = express();
  const port = process.env.PORT ?? 3000;

  // GitHub webhook endpoint (must use raw body for signature verification)
```

**Required change:**
```typescript
  // Setup Express server
  const app = express();
  const port = await getPort();

  // GitHub webhook endpoint (must use raw body for signature verification)
```

**Why:**
- Replace hardcoded logic with new `getPort()` function
- Async/await for `isWorktreePath()` check inside `getPort()`

---

### Step 3: Add import for `isWorktreePath` utility

**File**: `src/index.ts`
**Lines**: 1-10 (imports)
**Action**: UPDATE

**Current code:**
```typescript
import { logArchonPaths } from './utils/archon-paths.js';
```

**Required change:**
```typescript
import { logArchonPaths } from './utils/archon-paths.js';
import { isWorktreePath } from './utils/git.js';
```

**Why:**
- `getPort()` function needs `isWorktreePath()` to detect worktree context

---

### Step 4: Make main execution context async

**File**: `src/index.ts`
**Lines**: Wrap main code in async IIFE
**Action**: UPDATE

**Current pattern:**
```typescript
// ... main code at top level ...
// Setup Express server
const app = express();
const port = process.env.PORT ?? 3000;
// ... rest of code ...
```

**Required change:**
```typescript
// Wrap main execution in async IIFE to enable await getPort()
(async () => {
  // ... existing main code ...
  // Setup Express server
  const app = express();
  const port = await getPort();
  // ... rest of code unchanged ...
})().catch(error => {
  console.error('[App] Fatal error:', error);
  process.exit(1);
});
```

**Why:**
- `getPort()` is async (calls `isWorktreePath()`)
- Need async context to use `await`
- Add error handling for fatal startup errors

---

### Step 5: Add Unit Tests

**File**: `src/index.test.ts`
**Action**: CREATE

**Test cases to add:**
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';

// Mock process.cwd() and isWorktreePath for testing
let mockCwd = '/normal/path';
let mockIsWorktree = false;

// We'll test the logic inline since getPort() is not exported
// This tests the hash calculation algorithm
describe('Port allocation algorithm', () => {
  it('should calculate consistent hash-based offset for worktree paths', () => {
    const testPath = '/Users/test/.archon/worktrees/owner/repo/issue-123';
    const hash = createHash('md5').update(testPath).digest();
    const offset = (hash.readUInt16BE(0) % 900) + 100;

    expect(offset).toBeGreaterThanOrEqual(100);
    expect(offset).toBeLessThanOrEqual(999);

    // Same path should produce same offset (deterministic)
    const hash2 = createHash('md5').update(testPath).digest();
    const offset2 = (hash2.readUInt16BE(0) % 900) + 100;
    expect(offset2).toBe(offset);
  });

  it('should produce different offsets for different worktree paths', () => {
    const path1 = '/Users/test/.archon/worktrees/owner/repo/issue-123';
    const path2 = '/Users/test/.archon/worktrees/owner/repo/issue-456';

    const hash1 = createHash('md5').update(path1).digest();
    const offset1 = (hash1.readUInt16BE(0) % 900) + 100;

    const hash2 = createHash('md5').update(path2).digest();
    const offset2 = (hash2.readUInt16BE(0) % 900) + 100;

    // Different paths SHOULD produce different offsets (high probability)
    // Note: Not guaranteed due to hash collisions, but extremely unlikely
    expect(offset1).not.toBe(offset2);
  });

  it('should keep offset in 100-999 range for various paths', () => {
    const testPaths = [
      '/.archon/worktrees/repo/branch',
      '/home/user/.archon/worktrees/owner/repo/issue-1',
      '/very/long/path/to/archon/worktrees/organization/repository/feature-branch-with-long-name',
    ];

    for (const path of testPaths) {
      const hash = createHash('md5').update(path).digest();
      const offset = (hash.readUInt16BE(0) % 900) + 100;

      expect(offset).toBeGreaterThanOrEqual(100);
      expect(offset).toBeLessThanOrEqual(999);
    }
  });
});

// Integration test notes (manual verification):
// 1. Run in main repo: `bun dev` → should use port 3000
// 2. Run in worktree: `bun dev` → should auto-allocate port 3XXX
// 3. Override: `PORT=4000 bun dev` → should use 4000 (both contexts)
// 4. Multiple worktrees: Start in 2+ worktrees → different ports
```

**Why:**
- Test the hash-based offset calculation (deterministic, in range)
- Test that different paths produce different offsets
- Document integration test scenarios for manual verification

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/utils/git.ts:111-120
// Pattern for worktree detection via .git file check
export async function isWorktreePath(path: string): Promise<boolean> {
  try {
    const gitPath = join(path, '.git');
    const content = await readFile(gitPath, 'utf-8');
    // Worktree .git file contains "gitdir: /path/to/main/.git/worktrees/..."
    return content.startsWith('gitdir:');
  } catch {
    return false;
  }
}
```

```typescript
// SOURCE: src/index.ts:380
// Pattern for Express startup logging
console.log(`[Express] Health check server listening on port ${String(port)}`);

// New logging for worktree port allocation
console.log(`[Express] Worktree detected (${cwd})`);
console.log(`[Express] Auto-allocated port: ${port} (base: ${basePort}, offset: +${offset})`);
```

```typescript
// SOURCE: src/index.ts:1-10
// Pattern for imports (add crypto at top)
import { createHash } from 'crypto';
```

```typescript
// SOURCE: src/utils/archon-paths.ts:43-54
// Pattern for environment variable with fallback
const envHome = process.env.ARCHON_HOME;
if (envHome) {
  return expandTilde(envHome);
}
return join(homedir(), '.archon');

// Apply to PORT
const envPort = process.env.PORT;
if (envPort) {
  return Number(envPort);
}
// ... auto-allocation logic ...
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Hash collision between worktrees (1/900 probability) | Document limitation; explicit PORT env var overrides; collision unlikely with typical usage |
| Path contains "worktrees" but not actually a worktree | Use `isWorktreePath()` which checks `.git` file content (not path string) - robust detection |
| Agent doesn't discover allocated port | Log clearly with `[Express]` prefix showing exact port; agent reads stdout |
| Breaks existing deployments | Backwards compatible: explicit PORT env var takes precedence; main repo behavior unchanged |
| Port out of system range | Hash offset limited to 100-999, base port 3000 → range 3100-3999 (safe) |

---

## Validation

### Automated Checks

```bash
# Type checking
bun run type-check

# Run new tests
bun test src/index.test.ts

# Run all tests
bun test

# Linting
bun run lint
```

### Manual Verification

**Test Case 1: Main repo (not in worktree)**
```bash
cd /path/to/main/repo
bun dev
# Expected: [Express] Health check server listening on port 3000
```

**Test Case 2: Worktree without PORT env var**
```bash
cd ~/.archon/worktrees/owner/repo/issue-147
bun dev
# Expected:
# [Express] Worktree detected (/Users/.../issue-147)
# [Express] Auto-allocated port: 3547 (base: 3000, offset: +547)
# [Express] Health check server listening on port 3547
```

**Test Case 3: Worktree with explicit PORT**
```bash
cd ~/.archon/worktrees/owner/repo/issue-147
PORT=4000 bun dev
# Expected: [Express] Health check server listening on port 4000
# (No worktree detection log - explicit override)
```

**Test Case 4: Multiple worktrees**
```bash
# Terminal 1
cd ~/.archon/worktrees/owner/repo/issue-147
bun dev  # Gets port 3547

# Terminal 2
cd ~/.archon/worktrees/owner/repo/issue-200
bun dev  # Gets different port (e.g., 3782)

# Both should start successfully (no EADDRINUSE error)
```

**Test Case 5: Agent self-testing workflow**
```bash
cd ~/.archon/worktrees/owner/repo/issue-147
bun dev &  # Auto-allocates port, logs it
PORT_FROM_LOG=3547  # Agent reads from stdout

# Agent uses discovered port
curl http://localhost:${PORT_FROM_LOG}/health
curl -X POST http://localhost:${PORT_FROM_LOG}/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test","message":"/status"}'
```

---

## Scope Boundaries

**IN SCOPE:**
- Add `getPort()` function to detect worktree and calculate port
- Update port assignment in `src/index.ts` to use `getPort()`
- Add imports for `crypto` and `isWorktreePath`
- Add enhanced logging for worktree port allocation
- Add unit tests for hash calculation algorithm
- Make main execution context async to support `await getPort()`

**OUT OF SCOPE (do not touch):**
- Port discovery file (`.port`) - defer as alternative approach
- Integration with worktree-manager skill's port registry - future enhancement
- Port availability scanning - accept hash collision risk (1/900)
- Environment variable validation - keep existing behavior
- Express server logic, health checks, webhooks - no changes
- Platform adapters, orchestrator, database - no changes
- Documentation updates to CLAUDE.md - can be done post-implementation

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T07:45:00Z
- **Artifact**: `.archon/artifacts/issues/issue-147.md`
