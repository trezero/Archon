# Investigation: Copy .archon directory to worktrees by default

**Issue**: #198 (https://github.com/Wirasm/remote-coding-agent/issues/198)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T00:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Important for workflow consistency (artifacts, plans, workflows available in worktrees), but workaround exists (manual config), not blocking |
| Complexity | LOW | Single file modification (~10 lines), existing infrastructure (copyWorktreeFiles) handles all the work, comprehensive test coverage exists |
| Confidence | HIGH | Clear requirement from issue, well-understood code path with extensive test coverage (31 tests), straightforward merge of defaults with user config |

---

## Problem Statement

When creating git worktrees for isolated development, the `.archon/` directory (containing artifacts, plans, and workflows) is not copied by default. Users must explicitly add `.archon` to their `.archon/config.yaml` worktree configuration. This creates inconsistent workflows where commands expecting artifacts fail in worktrees unless configured. The `.archon` directory should be copied automatically to ensure consistent behavior across worktree environments.

---

## Analysis

### Change Rationale

**Why this change**: Worktrees are isolated git checkouts used for parallel development (e.g., working on multiple issues simultaneously). The `.archon/` directory contains:
- **Artifacts** (`.archon/artifacts/`) - Investigation reports, RCA documents used by implement commands
- **Plans** - Feature implementation plans referenced during execution
- **Workflows** - YAML-based multi-step execution chains
- **Commands** - Custom slash command templates

These files are git-ignored (not committed) but essential for Archon workflows. Without automatic copying, commands like `/implement-issue` fail in worktrees because they can't find the investigation artifact.

**Current workaround**: Users must manually add to `.archon/config.yaml`:
```yaml
worktree:
  copyFiles:
    - .archon
```

**Better approach**: Make `.archon` a default entry, merged with user configuration.

### Evidence Chain

**Current Implementation**: `src/isolation/providers/worktree.ts:283-331`

```typescript
private async copyConfiguredFiles(
  canonicalRepoPath: string,
  worktreePath: string
): Promise<void> {
  // Load config
  let copyFiles: string[] | undefined;
  try {
    const repoConfig = await loadRepoConfig(canonicalRepoPath);
    copyFiles = repoConfig.worktree?.copyFiles;  // ← User config only
  } catch (error) {
    console.error('[WorktreeProvider] Failed to load repo config', ...);
    return;  // ← Early return on config error
  }

  if (!copyFiles || copyFiles.length === 0) {
    return;  // ← No defaults, early return if empty
  }

  // Copy files
  const copied = await copyWorktreeFiles(canonicalRepoPath, worktreePath, copyFiles);
  ...
}
```

**Problem**: No default files, only user-configured files are copied.

**Solution**: Add default files and merge with user config.

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/isolation/providers/worktree.ts` | 283-331 | UPDATE | Add default `.archon` entry, merge with user config |
| `src/isolation/providers/worktree.test.ts` | NEW | UPDATE | Add test for default `.archon` copy behavior |

### Integration Points

**Callers of `copyConfiguredFiles()`**:
- `src/isolation/providers/worktree.ts:277` - Called after `git worktree add` succeeds

**Dependencies**:
- `src/utils/worktree-copy.ts:160-185` - `copyWorktreeFiles()` does actual copying
- `src/config/config-loader.ts:109-133` - `loadRepoConfig()` loads user config

**Data Flow**:
1. Worktree created: `git worktree add <path> <branch>`
2. `copyConfiguredFiles()` called
3. Config loaded: `loadRepoConfig(canonicalRepoPath)`
4. **NEW**: Merge defaults (`['.archon']`) with user config
5. Copy files: `copyWorktreeFiles(canonicalRepoPath, worktreePath, mergedList)`

### Git History

```
$ git log --oneline -5 -- src/isolation/providers/worktree.ts
1bf8af8 Fix: Detect and block concurrent workflow execution
5caba9e Rebuild feature-development workflow
4407d40 Update docs to reflect actual command folder detection
a30776f Fix code-simplifier agent YAML parsing error
c628740 Fix: RouterContext not populated for non-slash commands
```

**Implication**: File copying feature is established and stable. This is an enhancement to add sensible defaults.

---

## Implementation Plan

### Step 1: Add Default Copy Files to copyConfiguredFiles()

**File**: `src/isolation/providers/worktree.ts`
**Lines**: 283-331
**Action**: UPDATE

**Current code:**
```typescript
private async copyConfiguredFiles(
  canonicalRepoPath: string,
  worktreePath: string
): Promise<void> {
  // Load config - log errors but don't fail worktree creation
  let copyFiles: string[] | undefined;
  try {
    const repoConfig = await loadRepoConfig(canonicalRepoPath);
    copyFiles = repoConfig.worktree?.copyFiles;
  } catch (error) {
    const err = error as Error;
    console.error('[WorktreeProvider] Failed to load repo config', {
      canonicalRepoPath,
      error: err.message,
    });
    return;
  }

  if (!copyFiles || copyFiles.length === 0) {
    return;
  }

  // Copy files...
}
```

**Required change:**
```typescript
private async copyConfiguredFiles(
  canonicalRepoPath: string,
  worktreePath: string
): Promise<void> {
  // Default files to always copy
  const defaultCopyFiles = ['.archon'];

  // Load user config - log errors but don't fail worktree creation
  let userCopyFiles: string[] = [];
  try {
    const repoConfig = await loadRepoConfig(canonicalRepoPath);
    userCopyFiles = repoConfig.worktree?.copyFiles ?? [];
  } catch (error) {
    const err = error as Error;
    // Config errors are more serious - log as error, not warning
    console.error('[WorktreeProvider] Failed to load repo config', {
      canonicalRepoPath,
      error: err.message,
    });
    // Don't return - still copy default files even if config fails
  }

  // Merge defaults with user config (Set deduplicates)
  const copyFiles = [...new Set([...defaultCopyFiles, ...userCopyFiles])];

  if (copyFiles.length === 0) {
    return;
  }

  // Copy files - errors are handled inside copyWorktreeFiles, but wrap in
  // try/catch for defense against unexpected errors
  try {
    const copied = await copyWorktreeFiles(canonicalRepoPath, worktreePath, copyFiles);
    if (copied.length > 0) {
      console.log(`[WorktreeProvider] Copied ${copied.length} file(s) to worktree`);
    }

    // Log summary if some files were configured but not all were copied
    const attemptedCount = copyFiles.length;
    const copiedCount = copied.length;
    if (copiedCount < attemptedCount) {
      console.log(
        `[WorktreeProvider] File copy summary: ${copiedCount}/${attemptedCount} succeeded (check logs above for details)`
      );
    }
  } catch (error) {
    // Should not happen as copyWorktreeFiles handles errors internally,
    // but guard against unexpected errors
    const err = error as Error;
    console.error('[WorktreeProvider] Unexpected error in file copying', {
      worktreePath,
      error: err.message,
    });
  }
}
```

**Why**:
- Defines `defaultCopyFiles = ['.archon']`
- Changes `copyFiles` to `userCopyFiles` for clarity
- Uses `?? []` to default empty array instead of undefined
- Removes early return on config error (still copy defaults)
- Merges defaults with user config using `Set` for deduplication
- Rest of function unchanged (logging, error handling)

---

### Step 2: Add Test for Default Copy Behavior

**File**: `src/isolation/providers/worktree.test.ts`
**Action**: UPDATE

**Test case to add:**
```typescript
describe('WorktreeProvider.create', () => {
  // ... existing tests ...

  it('should copy .archon directory by default (without config)', async () => {
    // Mock: No config file exists
    vi.mocked(loadRepoConfig).mockResolvedValue({});

    // Mock: copyWorktreeFiles succeeds
    const copyWorktreeFilesSpy = vi.spyOn(worktreeCopyModule, 'copyWorktreeFiles')
      .mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

    // Create worktree
    const result = await provider.create({
      canonicalRepoPath: '/repo',
      conversationId: 'test',
      type: 'new-branch',
      branch: 'feature-test',
    });

    // Verify .archon was copied even without config
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
      '/repo',
      expect.stringContaining('feature-test'),
      ['.archon']  // Default only
    );

    expect(result.worktreePath).toContain('feature-test');
  });

  it('should merge .archon default with user copyFiles config', async () => {
    // Mock: User config with additional files
    vi.mocked(loadRepoConfig).mockResolvedValue({
      worktree: {
        copyFiles: ['.env', '.vscode']
      }
    });

    // Mock: copyWorktreeFiles succeeds
    const copyWorktreeFilesSpy = vi.spyOn(worktreeCopyModule, 'copyWorktreeFiles')
      .mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env', destination: '.env' },
        { source: '.vscode', destination: '.vscode' }
      ]);

    // Create worktree
    await provider.create({
      canonicalRepoPath: '/repo',
      conversationId: 'test',
      type: 'new-branch',
      branch: 'feature-test',
    });

    // Verify .archon + user files were copied
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
      '/repo',
      expect.stringContaining('feature-test'),
      expect.arrayContaining(['.archon', '.env', '.vscode'])
    );
  });

  it('should deduplicate .archon if user explicitly includes it', async () => {
    // Mock: User config explicitly includes .archon
    vi.mocked(loadRepoConfig).mockResolvedValue({
      worktree: {
        copyFiles: ['.archon', '.env']
      }
    });

    const copyWorktreeFilesSpy = vi.spyOn(worktreeCopyModule, 'copyWorktreeFiles')
      .mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env', destination: '.env' }
      ]);

    await provider.create({
      canonicalRepoPath: '/repo',
      conversationId: 'test',
      type: 'new-branch',
      branch: 'feature-test',
    });

    // Verify .archon appears only once (deduplicated by Set)
    const copyFilesArg = copyWorktreeFilesSpy.mock.calls[0][2];
    const archonCount = copyFilesArg.filter(f => f === '.archon').length;
    expect(archonCount).toBe(1);
  });

  it('should copy default .archon even if config loading fails', async () => {
    // Mock: Config loading throws error
    vi.mocked(loadRepoConfig).mockRejectedValue(new Error('Config parse error'));

    const copyWorktreeFilesSpy = vi.spyOn(worktreeCopyModule, 'copyWorktreeFiles')
      .mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

    await provider.create({
      canonicalRepoPath: '/repo',
      conversationId: 'test',
      type: 'new-branch',
      branch: 'feature-test',
    });

    // Verify .archon was still copied (graceful degradation)
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
      '/repo',
      expect.stringContaining('feature-test'),
      ['.archon']
    );
  });
});
```

---

### Step 3: Update Documentation (if exists)

**File**: Search for worktree documentation
**Action**: UPDATE (if found)

**Documentation to add:**
- `.archon` directory is copied to worktrees by default
- Users can add additional files via `worktree.copyFiles` config
- Example config showing additional files (not .archon since it's automatic)

**Search for docs:**
```bash
find . -name "*.md" | grep -i worktree
find . -name "*.md" | grep -i config
```

If documentation exists, update it to reflect:
- `.archon` is now copied automatically
- `worktree.copyFiles` still works for additional files
- Example config should show OTHER files (not `.archon`)

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### Pattern 1: Array Merging with Set Deduplication
**SOURCE**: Common TypeScript pattern, similar to how defaults are merged
```typescript
// Pattern for merging arrays with deduplication
const defaults = ['default1', 'default2'];
const userValues = ['user1', 'default1']; // Includes one duplicate
const merged = [...new Set([...defaults, ...userValues])];
// Result: ['default1', 'default2', 'user1'] - deduplicated
```

### Pattern 2: Graceful Config Loading
**SOURCE**: `src/isolation/providers/worktree.ts:289-299`
```typescript
// Pattern for config loading with fallback
let userCopyFiles: string[] = [];
try {
  const repoConfig = await loadRepoConfig(canonicalRepoPath);
  userCopyFiles = repoConfig.worktree?.copyFiles ?? [];
} catch (error) {
  const err = error as Error;
  console.error('[WorktreeProvider] Failed to load repo config', {
    canonicalRepoPath,
    error: err.message,
  });
  // Don't return - continue with defaults
}
```

### Pattern 3: Logging File Copy Results
**SOURCE**: `src/isolation/providers/worktree.ts:310-321`
```typescript
// Pattern for logging copy operations
const copied = await copyWorktreeFiles(canonicalRepoPath, worktreePath, copyFiles);
if (copied.length > 0) {
  console.log(`[WorktreeProvider] Copied ${copied.length} file(s) to worktree`);
}

const attemptedCount = copyFiles.length;
const copiedCount = copied.length;
if (copiedCount < attemptedCount) {
  console.log(
    `[WorktreeProvider] File copy summary: ${copiedCount}/${attemptedCount} succeeded`
  );
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Source `.archon` doesn't exist | Handled by existing `copyWorktreeFile()` - returns false, logs info, continues |
| User explicitly includes `.archon` in config | Deduplicated by `Set` - no double copy |
| Config loading fails | Graceful degradation - still copy `.archon` default, log error |
| User config is empty `copyFiles: []` | Merge with defaults results in `['.archon']` only |
| Path traversal attempt in user config | Existing validation in `copyWorktreeFile()` blocks it |
| Permission errors copying `.archon` | Logged by `copyWorktreeFile()`, doesn't fail worktree creation |

---

## Validation

### Automated Checks

```bash
# Type checking
bun run type-check

# Run all tests
bun test

# Run specific worktree tests
bun test src/isolation/providers/worktree.test.ts

# Run worktree-copy tests
bun test src/utils/worktree-copy.test.ts

# Linting
bun run lint
```

### Manual Verification

**Test 1: Default behavior (no config)**
1. Create test repo without `.archon/config.yaml`
2. Add `.archon/artifacts/test.txt` file
3. Create worktree via platform (e.g., GitHub issue comment)
4. Verify `.archon/artifacts/test.txt` exists in worktree

**Test 2: Merge with user config**
1. Add `.archon/config.yaml` with `worktree.copyFiles: ['.env']`
2. Create worktree
3. Verify both `.archon` and `.env` are copied

**Test 3: Deduplication**
1. Add `.archon/config.yaml` with `worktree.copyFiles: ['.archon', '.env']`
2. Create worktree
3. Check logs - should show `.archon` copied once (not twice)

**Test 4: Graceful degradation**
1. Add invalid `.archon/config.yaml` (malformed YAML)
2. Create worktree
3. Verify `.archon` still copied (config error logged but not fatal)

---

## Scope Boundaries

**IN SCOPE:**
- Add `.archon` as default copy file in `copyConfiguredFiles()`
- Merge defaults with user config using Set deduplication
- Remove early return on config error (copy defaults anyway)
- Add tests for default behavior, merging, deduplication, error cases
- Update documentation (if exists) to reflect default behavior

**OUT OF SCOPE (do not touch):**
- Change `copyWorktreeFiles()` utility function (works correctly)
- Modify config loading logic in `config-loader.ts` (not needed)
- Change worktree creation logic (only file copying behavior)
- Add configuration for disabling default (YAGNI - users can override)
- Copy other directories by default (only `.archon` requested in issue)

**FUTURE IMPROVEMENTS (defer):**
- Global defaults in `~/.archon/config.yaml` (not requested)
- Per-platform worktree defaults (not needed yet)
- Worktree templates (too complex for this issue)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T00:00:00Z
- **Artifact**: `.archon/artifacts/issues/issue-198.md`
