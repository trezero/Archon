# Investigation: Critical: Fix silent error swallowing in git.ts utilities

**Issue**: #275 (https://github.com/dynamous-community/remote-coding-agent/issues/275)
**Type**: BUG
**Investigated**: 2026-01-19T13:00:36Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | CRITICAL | `worktreeExists`, `listWorktrees`, and `isWorktreePath` in `src/utils/git.ts:40-130` suppress permission/git failures, causing cleanup and adoption flows to misreport healthy worktrees as missing and masking repository corruption, which risks data loss during automated cleanup. |
| Complexity | MEDIUM | Fix touches `src/utils/git.ts` plus `src/utils/git.test.ts` to add nuanced error handling and new logging/tests across three exported functions used by orchestrator, command handler, and worktree provider modules. |
| Confidence | HIGH | The silent catch blocks are explicitly visible in `src/utils/git.ts:40-130`, and downstream callers (`src/isolation/providers/worktree.ts:183-235`) directly depend on their return values, so the root cause is well understood. |

---

## Problem Statement

Core git utilities currently treat *all* execution and filesystem failures as benign "not found" results. As a result, worktree listings drop to an empty array, health checks report false negatives, and canonical path detection proceeds with incorrect assumptions when the real problem is a permission, corruption, or missing git binary error. Callers get no logging or context, making it impossible to distinguish "no worktrees" from "git broke".

---

## Analysis

### Root Cause / Change Rationale

1. `WorktreeProvider.list()` and command handlers rely on `listWorktrees` to mirror git's source-of-truth data (`src/isolation/providers/worktree.ts:206-214`, `src/handlers/command-handler.ts:1394-1420`). When `git worktree list` fails, `listWorktrees` catches the error and returns `[]` (`src/utils/git.ts:55-80`), so callers silently lose visibility into existing worktrees.
2. `worktreeExists` is the gatekeeper for adopting environments, performing health checks, and deciding cleanup actions (`src/isolation/providers/worktree.ts:183-258`). The function currently returns `false` for *every* exception thrown by `fs.access` (`src/utils/git.ts:40-48`), so permission errors or disk failures look identical to "path missing," triggering duplicate creation or destructive cleanup.
3. `isWorktreePath` powers `getCanonicalRepoPath` and worktree-sync flows (`src/utils/git.ts:280-303`, `src/utils/worktree-sync.ts:68-120`). Its unexpected-error branch logs a warning but still returns `false` (`src/utils/git.ts:111-130`), so upstream code assumes the path is the canonical repo, bypassing safety checks and hiding the underlying failure.

These three functions need to follow the same defensive pattern already used in `cleanup-service` (selectively swallowing ENOENT/not-a-repo cases and rethrowing everything else) to surface actionable errors and prevent data loss.

### Evidence Chain

WHY: Worktree listings and health checks misreport "no worktrees" even when git fails.
↓ BECAUSE: `WorktreeProvider.list` and `.healthCheck` trust `listWorktrees` / `worktreeExists` return values (`src/isolation/providers/worktree.ts:183-235`).
  Evidence: `listWorktrees(repoPath)` feeds the entire environment list (`src/isolation/providers/worktree.ts:206-214`).
↓ BECAUSE: `listWorktrees` returns `[]` for any thrown error and never logs context (`src/utils/git.ts:55-80`).
  Evidence: `} catch { return []; }` at lines 78-80 hides permission, timeout, or binary errors.
↓ ROOT CAUSE: Git utility catch blocks swallow all exceptions instead of distinguishing expected ENOENT/not-a-repo cases from fatal failures, so catastrophic states are indistinguishable from normal "no worktrees" scenarios.
  Evidence: `worktreeExists` catch at `src/utils/git.ts:40-48` and `isWorktreePath` catch at `src/utils/git.ts:111-130` mirror the same silent-fail pattern.

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/utils/git.ts` | 40-130, 55-80, 111-130 | UPDATE | Add errno-aware error handling/logging for `worktreeExists`, `listWorktrees`, and `isWorktreePath`, only swallowing ENOENT/not-git cases and rethrowing the rest. |
| `src/utils/git.test.ts` | 153-214 | UPDATE | Expand coverage to assert the new behaviors: ENOENT returns false, "not a git repo" returns [], unexpected errors bubble up, and `isWorktreePath` rethrows non-ENOENT/EISDIR issues. |

### Integration Points

- `src/isolation/providers/worktree.ts:183-258` (`get`, `list`, `adopt`, `healthCheck`) depend on truthful `worktreeExists` and `listWorktrees` results.
- `src/handlers/command-handler.ts:1394-1420` surfaces `listWorktrees` output to users when displaying orphan worktrees; it should now surface thrown errors instead of silent empties.
- `src/utils/worktree-sync.ts:68-120` uses `isWorktreePath`/`getCanonicalRepoPath` to guard sync operations; throwing on unexpected errors lets its outer try/catch log and abort appropriately.

### Git History

- **Introduced**: Existing behavior dates back to `3ba4845`/`73ff921` and persisted through recent sync improvements (`commit 2a76165`, November 2025), so the bug is long-standing rather than a recent regression.
- **Implication**: No prior fix attempts exist; implementing the stricter error handling will change observable behavior, so downstream messaging/tests must expect thrown errors instead of silent defaults.

---

## Implementation Plan

### Step 1: Harden `worktreeExists` error handling

**File**: `src/utils/git.ts`
**Lines**: 40-48
**Action**: UPDATE

**Current code:**
```typescript
  } catch {
    return false;
  }
```

**Required change:**
```typescript
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    console.error('[Git] Failed to check worktree existence', {
      worktreePath,
      error: err.message,
      code: err.code,
    });
    throw new Error(`Failed to check worktree at ${worktreePath}: ${err.message}`);
  }
```

**Why**: ENOENT means the path/.git file genuinely doesn't exist; everything else (EACCES, corruption, gitdir unreadable) must be surfaced with context so cleanup/adoption callers can react instead of assuming "worktree missing".

---

### Step 2: Make `listWorktrees` fail loudly except for "not a git repo"

**File**: `src/utils/git.ts`
**Lines**: 55-80
**Action**: UPDATE

**Current code:**
```typescript
  } catch {
    return [];
  }
```

**Required change:**
```typescript
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`.toLowerCase();
    if (errorText.includes('not a git repository')) {
      return [];
    }
    console.error('[Git] Failed to list worktrees', {
      repoPath,
      error: err.message,
      stderr: err.stderr,
    });
    throw new Error(`Failed to list worktrees for ${repoPath}: ${err.message}`);
  }
```

**Why**: Only "not a git repository" should map to "no worktrees"; all other git failures must bubble up so orchestrators and CLI commands can warn users instead of showing empty lists.

---

### Step 3: Propagate unexpected `isWorktreePath` errors after logging

**File**: `src/utils/git.ts`
**Lines**: 111-130
**Action**: UPDATE

**Current code:**
```typescript
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return false;
    }
    console.error('[Git] Unexpected error checking worktree status:', {
      path,
      error: err.message,
      code: err.code,
    });
    return false;
```

**Required change:**
```typescript
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return false;
    }
    console.error('[Git] Unexpected error checking worktree status:', {
      path,
      error: err.message,
      code: err.code,
    });
    throw new Error(`Failed to determine worktree status for ${path}: ${err.message}`);
```

**Why**: Canonical-path resolution and worktree-sync rely on this check. Returning `false` hides the fact that `.git` couldn't be read due to permission or corruption; throwing lets upstream error handlers log and abort safely.

---

### Step 4: Update and expand unit tests for git utilities

**File**: `src/utils/git.test.ts`
**Action**: UPDATE

**Test cases to add/update:**
```typescript
describe('worktreeExists', () => {
  test('returns false for ENOENT but rethrows for EACCES', async () => {
    const accessSpy = spyOn(fsPromises, 'access');
    accessSpy
      .mockRejectedValueOnce(Object.assign(new Error('no dir'), { code: 'ENOENT' }))
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    await expect(git.worktreeExists('/missing')).resolves.toBe(false);
    await expect(git.worktreeExists('/protected')).rejects.toThrow('Failed to check worktree');
  });
});

describe('listWorktrees', () => {
  test('returns [] for not-a-git-repo errors', async () => {
    execSpy.mockRejectedValue(Object.assign(new Error('fatal: not a git repository'), { stderr: 'fatal: Not a git repository' }));
    await expect(git.listWorktrees('/tmp/repo')).resolves.toEqual([]);
  });

  test('rethrows other errors and logs', async () => {
    const consoleSpy = spyOn(console, 'error');
    execSpy.mockRejectedValue(new Error('permission denied'));
    await expect(git.listWorktrees('/tmp/repo')).rejects.toThrow('Failed to list worktrees');
    expect(consoleSpy).toHaveBeenCalledWith('[Git] Failed to list worktrees', expect.any(Object));
  });
});

describe('isWorktreePath', () => {
  test('throws on unexpected errors after logging', async () => {
    const readFileSpy = spyOn(fsPromises, 'readFile').mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );
    await expect(git.isWorktreePath('/protected')).rejects.toThrow('Failed to determine worktree status');
    expect(consoleErrorSpy).toHaveBeenCalled();
    readFileSpy.mockRestore();
  });
});
```

**Why**: Tests must now assert that ENOENT/"not git" cases map to safe defaults while other errors propagate and emit logs, preventing regressions.

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/services/cleanup-service.ts:366-393
// Pattern for selective error handling with logging + rethrow
  } catch (error) {
    const err = error as Error & { code?: string };
    const errorText = err.message.toLowerCase();
    if (
      err.code === 'ENOENT' ||
      errorText.includes('no such file or directory') ||
      errorText.includes('not a git repo')
    ) {
      return false;
    }
    console.error('[Cleanup] Unexpected error checking worktree existence:', {
      path,
      error: err.message,
      code: err.code,
    });
    throw err;
  }
```

Use the same structure (inspect error, allow expected cases, log + throw others) to keep behavior consistent across modules.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Downstream callers that assumed `listWorktrees` never throws may now surface errors in user flows | Verify `WorktreeProvider` and `/worktree orphans` already wrap in try/catch upstream (command handler uses overarching command error handling); document behavior change in release notes if needed. |
| Noise from "not a git repo" errors in logs | Filter those specific messages before logging/throwing (only log unexpected failures). |
| Tests relying on previous silent defaults may fail | Update `src/utils/git.test.ts` and any mocks expecting default returns to align with new behavior. |

---

## Validation

### Automated Checks

```bash
bun test src/utils/git.test.ts
bun test src/utils/worktree-sync.test.ts   # ensures thrown errors integrate with sync logic
bun run lint                                # lint the updated files
```

### Manual Verification

1. Trigger `/worktree orphans` (or equivalent) against a repo with a purposely broken git binary and confirm the command surfaces the thrown error instead of an empty list.
2. Simulate permission issues on a worktree path and ensure cleanup/adoption flows now report the error rather than silently duplicating worktrees.

---

## Scope Boundaries

**IN SCOPE:**
- `src/utils/git.ts` logic and its direct unit tests.
- Ensuring logs contain repo/worktree path and error codes for unexpected failures.

**OUT OF SCOPE (do not touch):**
- Cleanup service's internal `worktreeExists` (already hardened).
- Broader refactors of orchestrator/worktree provider behavior; they will simply consume the improved error reporting.

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-19T13:00:36Z
- **Artifact**: `.archon/artifacts/issues/issue-275.md`
