# Investigation: Worktree creation does not copy .env files

**Issue**: #100 (https://github.com/dynamous-community/remote-coding-agent/issues/100)
**Type**: ENHANCEMENT
**Complexity**: MEDIUM
**Confidence**: HIGH
**Investigated**: 2026-01-06
**Implemented**: 2026-01-06
**PR**: #145

---

## Problem Statement

When worktrees are created via the orchestrator, git-ignored files like `.env` are not copied from the main repository. This causes applications to fail when running in the worktree because environment configuration is missing. The fix allows configuring which git-ignored files to copy via `.archon/config.yaml`.

---

## Solution

Added support for copying git-ignored files during worktree creation via repo configuration.

### Configuration Syntax

```yaml
# .archon/config.yaml
worktree:
  copyFiles:
    - .env.example -> .env    # Copy and rename
    - .env                     # Copy as-is if exists
    - data/fixtures/           # Copy entire directory
```

### Implementation

1. **Type Definition** (`src/config/config-types.ts`)
   - Added `copyFiles?: string[]` to `RepoConfig.worktree`

2. **Copy Utility** (`src/utils/worktree-copy.ts`)
   - `parseCopyFileEntry()` - Parse "source -> dest" or "source" syntax
   - `copyWorktreeFile()` - Copy single file/directory with error handling
   - `copyWorktreeFiles()` - Main entry point for config-based copying

3. **Provider Integration** (`src/isolation/providers/worktree.ts`)
   - Added `copyConfiguredFiles()` method called after `git worktree add`
   - Loads repo config, extracts `copyFiles`, invokes utility
   - Graceful degradation: errors logged but don't fail worktree creation

4. **Tests**
   - 15 tests in `worktree-copy.test.ts` (100% coverage)
   - 6 integration tests in `worktree.test.ts`

---

## Validation Results

| Check | Result |
|-------|--------|
| Type check | Pass |
| Unit tests | 250 pass |
| Lint | Pass (warnings pre-existing) |

---

## Metadata

- **Investigated by**: Claude
- **Implemented by**: Claude
- **PR**: https://github.com/dynamous-community/remote-coding-agent/pull/145
