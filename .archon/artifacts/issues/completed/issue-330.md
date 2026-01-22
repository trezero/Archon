# Investigation: Wire up baseBranch config option for worktree creation

**Issue**: #330 (https://github.com/dynamous-community/remote-coding-agent/issues/330)
**Type**: BUG
**Investigated**: 2026-01-22T15:32:33Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | MEDIUM | Repos with non-main defaults cannot align worktree sync with their branching strategy because `worktree.baseBranch` is silently ignored (`packages/core/src/isolation/providers/worktree.ts:462-470`), but default branch auto-detection still works as a workaround. |
| Complexity | MEDIUM | The fix touches core worktree orchestration plus git helpers and two test suites (`worktree.ts`, `git.ts`, and their tests), requiring new config plumbing and API adjustments. |
| Confidence | HIGH | The unused config path is obvious in the current code, and the change path is fully mapped with clear type boundaries in `RepoConfig` and git helpers. |

---

## Problem Statement

`worktree.baseBranch` is defined in `.archon/config.yaml` (`packages/core/src/config/config-types.ts:97-116`) but `WorktreeProvider` always syncs from whatever branch `git.getDefaultBranch()` detects (`packages/core/src/isolation/providers/worktree.ts:462-470`). As a result, repos that expect worktrees to start from a custom branch (e.g., `develop`) cannot configure Archon to do so.

---

## Analysis

### Root Cause / Change Rationale

The worktree provider never reads the repo-level config before syncing the workspace. `syncWorkspaceBeforeCreate()` unconditionally calls `getDefaultBranch()` and forwards that value to `syncWorkspace()`, so any configured base branch is ignored. We need to load repo config up front, pass the optional `worktree.baseBranch` through the sync path, and fall back to git auto-detection when the config is absent or invalid.

### Evidence Chain

WHY: Worktree sync always uses the git default branch.
↓ BECAUSE: `syncWorkspaceBeforeCreate()` always calls `getDefaultBranch(repoPath)` and never inspects repo config.  
  Evidence: `packages/core/src/isolation/providers/worktree.ts:462-470`

↓ BECAUSE: Repo config is only loaded inside `copyConfiguredFiles()` and its `worktree.copyFiles` subsection.  
  Evidence: `packages/core/src/isolation/providers/worktree.ts:505-538`

↓ ROOT CAUSE: `worktree.baseBranch` (declared in `RepoConfig`) is never read nor passed to git helpers, so user configuration cannot influence workspace sync.  
  Evidence: `packages/core/src/config/config-types.ts:97-116`

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/core/src/isolation/providers/worktree.ts` | 429-538 | UPDATE | Load repo config once, pass `worktree.baseBranch` into `syncWorkspaceBeforeCreate`, extend method signature, and reuse the loaded config for file-copy logic. |
| `packages/core/src/utils/git.ts` | 398-455 | UPDATE | Let `syncWorkspace()` accept an optional `baseBranch` and return which branch was synced so callers can log accurately while falling back to `getDefaultBranch()` when undefined. |
| `packages/core/src/isolation/providers/worktree.test.ts` | workspace sync + file copy sections | UPDATE | Spy on `loadRepoConfig`, assert the configured base branch is forwarded to sync, and adjust expectations for the new `syncWorkspace` return type. |
| `packages/core/src/utils/git.test.ts` | 719-931 | UPDATE | Cover the new optional branch behavior/resolved branch return value so regressions are caught. |

### Integration Points

- `WorktreeProvider.create()` orchestrates `syncWorkspaceBeforeCreate()` and `copyConfiguredFiles()` for every new worktree (`packages/core/src/isolation/providers/worktree.ts:381-452`).
- `git.syncWorkspace()` performs fetch/reset using the branch name it receives (`packages/core/src/utils/git.ts:398-455`).
- `loadRepoConfig()` already loads `.archon/config.yaml` for worktree copy settings and can be reused for base-branch lookups (`packages/core/src/isolation/providers/worktree.ts:505-538`).

### Git History

- `worktree.baseBranch` was added alongside other worktree config fields in `config-types.ts` but never wired to runtime logic, so this is a long-standing gap rather than a regression.

---

## Implementation Plan

### Step 1: Load repo config once during worktree creation and capture baseBranch

**File**: `packages/core/src/isolation/providers/worktree.ts:405-452`
**Action**: UPDATE

**Current code:**
```ts
    const repoPath = request.canonicalRepoPath;

    await this.syncWorkspaceBeforeCreate(repoPath);
    // ...
    await this.copyConfiguredFiles(repoPath, worktreePath);
```

**Required change:**
```ts
    const repoPath = request.canonicalRepoPath;
    let repoConfig: RepoConfig | null = null;
    try {
      repoConfig = await loadRepoConfig(repoPath);
    } catch (error) {
      console.error('[WorktreeProvider] Failed to load repo config', { repoPath, error: (error as Error).message });
    }

    await this.syncWorkspaceBeforeCreate(repoPath, repoConfig?.worktree?.baseBranch);
    // ...
    await this.copyConfiguredFiles(repoPath, worktreePath, repoConfig);
```

**Why**: This captures the configured base branch once, avoids redundant disk reads, and gives both sync and copy stages consistent config data.

---

### Step 2: Teach syncWorkspaceBeforeCreate to honor the configured branch and updated git API

**File**: `packages/core/src/isolation/providers/worktree.ts:454-500`
**Action**: UPDATE

**Current code:**
```ts
  private async syncWorkspaceBeforeCreate(repoPath: string): Promise<void> {
    try {
      const defaultBranch = await getDefaultBranch(repoPath);
      console.log('[WorktreeProvider] Syncing workspace before worktree creation', { repoPath, defaultBranch });
      const synced = await syncWorkspace(repoPath, defaultBranch);
      if (synced) {
        console.log(`[WorktreeProvider] Workspace synced to latest ${defaultBranch}`);
      } else {
        console.log('[WorktreeProvider] Workspace sync skipped ...');
      }
    } catch (error) {
      // error handling ...
    }
  }
```

**Required change:**
```ts
  private async syncWorkspaceBeforeCreate(repoPath: string, configuredBaseBranch?: string): Promise<void> {
    try {
      console.log('[WorktreeProvider] Syncing workspace before worktree creation', {
        repoPath,
        branch: configuredBaseBranch ?? 'auto-detect',
      });
      const { branch, synced } = await syncWorkspace(repoPath, configuredBaseBranch);
      if (synced) {
        console.log(`[WorktreeProvider] Workspace synced to latest ${branch}`);
      } else {
        console.log('[WorktreeProvider] Workspace sync skipped (uncommitted changes), proceeding with existing code');
      }
    } catch (error) {
      // keep existing fatal/non-fatal handling
    }
  }
```

**Why**: This method now accepts the optional user-configured value, passes it down, and logs what happened using the branch actually synced (reported by the git helper). The error-handling logic remains unchanged.

---

### Step 3: Enhance git.syncWorkspace to resolve the branch itself and report it back

**File**: `packages/core/src/utils/git.ts:382-455`
**Action**: UPDATE

**Current code:**
```ts
export async function syncWorkspace(
  workspacePath: string,
  defaultBranch: string
): Promise<boolean> {
  const hasChanges = await hasUncommittedChanges(workspacePath);
  if (hasChanges) {
    console.warn('[Git] Workspace has uncommitted changes...', { workspacePath, defaultBranch });
    return false;
  }
  // checkout/fetch/reset using defaultBranch
  return true;
}
```

**Required change:**
```ts
export interface WorkspaceSyncResult {
  branch: string;
  synced: boolean;
}

export async function syncWorkspace(
  workspacePath: string,
  baseBranch?: string
): Promise<WorkspaceSyncResult> {
  const branchToSync = baseBranch ?? (await getDefaultBranch(workspacePath));
  const hasChanges = await hasUncommittedChanges(workspacePath);
  if (hasChanges) {
    console.warn('[Git] Workspace has uncommitted changes, skipping sync to prevent data loss', {
      workspacePath,
      branch: branchToSync,
    });
    return { branch: branchToSync, synced: false };
  }
  // checkout/fetch/reset using branchToSync (rename log contexts)
  return { branch: branchToSync, synced: true };
}
```

**Why**: Centralizing the branch resolution keeps callers simple, ensures the helper understands user overrides, and gives callers the exact branch used for logging.

---

### Step 4: Update copyConfiguredFiles to use the cached config when available

**File**: `packages/core/src/isolation/providers/worktree.ts:505-538`
**Action**: UPDATE

**Change**: Add an optional `repoConfig?: RepoConfig | null` parameter. If provided, use its `worktree.copyFiles` array; otherwise, fall back to loading via `loadRepoConfig` (retaining the existing error logging). This prevents double-reading `.archon/config.yaml` and keeps error reporting centralized in the new loader from Step 1.

---

### Step 5: Adapt unit tests for the new behavior

- **`packages/core/src/isolation/providers/worktree.test.ts`**
  - Create a shared `loadRepoConfig` spy in the suite `beforeEach`, defaulting to `{}` so every test avoids real disk access.
  - Add tests under "workspace sync" to cover: (a) config-specified branch results in `syncWorkspace` being called with that branch and `getDefaultBranch` not being called; (b) when config omits the value, `syncWorkspace` is invoked without override and `getDefaultBranch` is still queried (now inside git helper) via the spy result.
  - Update existing expectations to handle the new `{ branch, synced }` return value from `syncWorkspace` (`mockResolvedValue({ branch: 'main', synced: true })`, etc.).
  - Adjust file-copy tests to reuse the shared `loadRepoConfig` spy instead of redefining it locally.

- **`packages/core/src/utils/git.test.ts`**
  - Update all tests to expect the new return type (`result.synced`) and that `syncWorkspace` can be called without a branch (mock `getDefaultBranch` to a known value in such tests).
  - Add a dedicated test verifying the fallback path when `baseBranch` is undefined, ensuring `getDefaultBranch` is invoked before checkout/fetch/reset.

---

## Patterns to Follow

```ts
// SOURCE: packages/core/src/isolation/providers/worktree.ts:505-538
try {
  const repoConfig = await loadRepoConfig(canonicalRepoPath);
  userCopyFiles = repoConfig.worktree?.copyFiles ?? [];
} catch (error) {
  console.error('[WorktreeProvider] Failed to load repo config', {
    canonicalRepoPath,
    error: (error as Error).message,
  });
}
```

Use the same defensive logging style (log and continue) when loading the config for base-branch selection so that worktree creation remains resilient to config parse errors.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Configured branch does not exist locally or remotely | `syncWorkspace` already surfaces checkout/fetch/reset failures with context; the provider catch block will propagate meaningful errors. |
| `.archon/config.yaml` is malformed or missing | Wrap the initial `loadRepoConfig` call in try/catch, log the error once, and proceed with auto-detection just like today. |
| Workspaces with uncommitted changes | `syncWorkspace` still returns "skipped" without throwing; provider logs and continues, so behavior is unchanged. |

---

## Validation

### Automated Checks

```bash
bun test packages/core/src/isolation/providers/worktree.test.ts packages/core/src/utils/git.test.ts
bun run lint
```

### Manual Verification

1. Create a `.archon/config.yaml` with `worktree.baseBranch: develop`, trigger worktree creation, and confirm logs mention syncing `develop`.
2. Remove the config entry, rerun, and confirm logs show auto-detection (`branch: auto-detect`) and that worktree creation still succeeds.

---

## Scope Boundaries

**IN SCOPE:**
- Reading `worktree.baseBranch` from repo config and plumbing it into the workspace sync path.
- Updating git/worktree tests and logging to reflect the new behavior.

**OUT OF SCOPE:**
- Changes to how PR worktrees fetch or checkout branches.
- Broader refactors of config loading or other isolation providers.

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-22T15:32:33Z
- **Artifact**: `.archon/artifacts/issues/issue-330.md`
