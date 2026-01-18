# Error Handling Findings: PR #219

**Reviewer**: error-handling-agent
**Date**: 2026-01-14T00:00:00Z
**Error Handlers Reviewed**: 5

---

## Summary

The error handling in this PR follows established codebase patterns well. The new `syncArchonToWorktree` function uses graceful degradation with proper logging, which aligns with the project's philosophy. However, there are a few minor areas where error specificity could be improved.

**Verdict**: APPROVE

---

## Findings

### Finding 1: Inner catch blocks swallow all errors without type discrimination

**Severity**: LOW
**Category**: broad-catch
**Location**: `src/utils/worktree-sync.ts:30-35, 37-42, 52-58`

**Issue**:
The inner try-catch blocks catch all errors without discriminating between expected filesystem errors (ENOENT) and unexpected errors (permission denied, disk full). While the graceful degradation is intentional, truly unexpected errors are treated the same as "file not found."

**Evidence**:
```typescript
// Current error handling at src/utils/worktree-sync.ts:30-35
try {
  canonicalStat = await stat(canonicalArchonPath);
} catch (error) {
  // No .archon in canonical repo, nothing to sync
  return false;
}
```

**Hidden Errors**:
This catch block could silently hide:
- `EACCES`: Permission denied when accessing .archon folder
- `EIO`: I/O error indicating disk problems
- `ENOMEM`: Out of memory during stat operation

**User Impact**:
If the canonical .archon exists but is inaccessible due to permission issues, the user won't be notified. The sync will silently skip, and the worktree may use stale workflows. This is a minor impact since the outer catch block logs the error anyway for other failure modes.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Check for ENOENT specifically, log others | Clear distinction between expected/unexpected | More code, may be overkill for this use case |
| B | Keep current behavior | Simple, follows graceful degradation pattern | Unexpected errors hidden at inner level |
| C | Add debug-level logging for all inner catches | Visibility for debugging, no behavior change | Log noise in normal operation |

**Recommended**: Option B (Keep current behavior)

**Reasoning**:
The outer try-catch at lines 75-83 already catches and logs any errors that propagate up. The inner catches are specifically for expected "not found" scenarios where no logging is needed. The function's contract is to return `false` on any failure, which is well-documented. This matches the codebase pattern seen in `src/utils/worktree-copy.ts:92-98` and follows the CLAUDE.md guidance on graceful degradation.

**Codebase Pattern Reference**:
```typescript
// SOURCE: src/utils/worktree-copy.ts:92-98
try {
  const stat = await statAsync(sourcePath);
  if (stat.isDirectory()) {
    await cp(sourcePath, destPath, { recursive: true });
  } else {
    await copyFile(sourcePath, destPath);
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    // Expected - file doesn't exist
    return false;
  }
  throw error;
}
```

Note: If we wanted to align more closely with this pattern, we could check for ENOENT explicitly, but the current approach is acceptable given the function's design.

---

### Finding 2: Config load failure defaults without logging

**Severity**: LOW
**Category**: missing-logging
**Location**: `src/utils/worktree-sync.ts:52-58`

**Issue**:
When config loading fails, the code silently defaults to `['.archon']` without any indication that the config wasn't respected.

**Evidence**:
```typescript
// Current error handling at src/utils/worktree-sync.ts:52-58
try {
  const repoConfig = await loadRepoConfig(canonicalRepoPath);
  copyFiles = repoConfig.worktree?.copyFiles;
} catch (error) {
  // If config fails to load, default to copying .archon
  copyFiles = ['.archon'];
}
```

**Hidden Errors**:
This catch block could silently hide:
- Malformed YAML in config file
- Permission errors reading config
- Syntax errors in config

**User Impact**:
If a user has a custom `copyFiles` configuration but it fails to load, the sync will proceed with just `.archon` instead of their full file list. The user might expect other files to sync but they won't.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Add console.warn for config load failures | User gets visibility, follows codebase pattern | More log output |
| B | Keep silent, document in JSDoc | Minimal code change | User unaware of config issues |
| C | Add debug-level log (if debug logging exists) | Visibility when needed, quiet normally | No debug logging system exists |

**Recommended**: Option A

**Reasoning**:
Adding a warning aligns with the codebase pattern for graceful degradation with logging. The outer function already logs success, so logging the config fallback provides symmetry. This matches how `src/utils/github-graphql.ts:63` handles similar fallback scenarios:

```typescript
// SOURCE: src/utils/github-graphql.ts:60-64
} catch (error) {
  // GraphQL query failed (no token, network issue, etc.)
  // Gracefully return empty - we'll create a new worktree
  console.warn('[GitHub GraphQL] Failed to fetch linked issues:', (error as Error).message);
  return [];
}
```

**Recommended Fix**:
```typescript
try {
  const repoConfig = await loadRepoConfig(canonicalRepoPath);
  copyFiles = repoConfig.worktree?.copyFiles;
} catch (error) {
  // If config fails to load, default to copying .archon
  console.warn('[WorktreeSync] Config load failed, defaulting to .archon only:', (error as Error).message);
  copyFiles = ['.archon'];
}
```

---

## Error Handler Audit

| Location | Type | Logging | User Feedback | Specificity | Verdict |
|----------|------|---------|---------------|-------------|---------|
| `worktree-sync.ts:30-35` | try-catch | None (expected) | N/A | Broad | PASS |
| `worktree-sync.ts:37-42` | try-catch | None (expected) | N/A | Broad | PASS |
| `worktree-sync.ts:52-58` | try-catch | None | N/A | Broad | MINOR |
| `worktree-sync.ts:75-83` | try-catch | GOOD | N/A (internal util) | Proper | PASS |
| `orchestrator.ts:549-558` | try-catch (outer) | GOOD | GOOD | Proper | PASS |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | 0 | 0 |
| HIGH | 0 | 0 |
| MEDIUM | 0 | 0 |
| LOW | 2 | 1 |

---

## Silent Failure Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Stale worktree workflows due to permission error | LOW | MEDIUM | Outer catch logs error, user can diagnose |
| Custom copyFiles config not applied | LOW | LOW | Add warning log (Finding 2) |
| Sync operation fails silently | LOW | LOW | Outer catch already handles this well |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `src/utils/worktree-copy.ts` | 92-98 | ENOENT-specific catch |
| `src/utils/github-graphql.ts` | 60-64 | console.warn for graceful fallback |
| `src/orchestrator/orchestrator.ts` | 549-558 | Outer catch with user message |
| `src/services/cleanup-service.ts` | 136-139 | Minimal catch block for expected errors |

---

## Positive Observations

1. **Outer catch pattern is excellent**: The main function catch at lines 75-83 properly logs with structured context (`worktreePath`, `error: err.message`), follows codebase conventions, and implements graceful degradation without throwing.

2. **Integration is safe**: The sync call in `orchestrator.ts:538` is placed inside an existing try-catch that already handles workflow discovery failures, so any unexpected errors that escape `syncArchonToWorktree` are still caught and reported to the user.

3. **Test coverage is thorough**: The test file (`worktree-sync.test.ts`) covers graceful error handling scenarios including config load failures and sync errors.

4. **Documentation is clear**: The JSDoc and inline comments explain the expected behavior on errors.

---

## Metadata

- **Agent**: error-handling-agent
- **Timestamp**: 2026-01-14T00:00:00Z
- **Artifact**: `.archon/artifacts/reviews/pr-219/error-handling-findings.md`
