# Investigation: Workflows should only load from .archon/workflows

**Issue**: #194 (https://github.com/dynamous-community/remote-coding-agent/issues/194)
**Type**: REFACTOR
**Investigated**: 2026-01-13T08:52:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Consistency improvement that prevents confusion but doesn't block functionality - commands already follow single-directory pattern |
| Complexity | LOW | Changes isolated to 4 implementation files (1 function, 3 test cases) plus documentation - no integration risk |
| Confidence | HIGH | Clear root cause identified, straightforward refactor with comprehensive test coverage and explicit acceptance criteria from issue author |

---

## Problem Statement

The workflow loader currently searches three directories (`.archon/workflows/`, `.claude/workflows/`, `.agents/workflows/`) for workflow files, but this behavior is inconsistent with the command system which only searches `.archon/commands/` plus an optional configured folder. This inconsistency creates confusion about where workflows should be placed and violates the principle of explicit configuration over convention.

---

## Analysis

### Root Cause / Change Rationale

The fallback directories were added in commit `3026a644` (2025-12-17) as part of the initial Archon distribution config implementation. At that time, the project supported multiple configuration folder conventions (`.archon/`, `.claude/`, `.agents/`).

However, the command system was later refined to only search `.archon/commands/` by default (with optional additional folder via config), establishing a clearer pattern. The workflow loader was not updated to match this pattern, creating an inconsistency.

**Rationale for removal:**
1. **Consistency**: Match command folder behavior (single primary directory)
2. **Simplicity**: Reduce search paths, clearer mental model
3. **Explicit over implicit**: Users should know exactly where workflows live
4. **Future-proof**: If additional folders are needed, they can be added via config (like commands)

### Evidence Chain

**ROOT CAUSE**: Multiple fallback directories in workflow loader create inconsistency with command system

Evidence: `src/utils/archon-paths.ts:102-104`
```typescript
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows', '.claude/workflows', '.agents/workflows'];
}
```

**CONTRAST**: Command folder function only returns `.archon/commands` plus optional config folder

Evidence: `src/utils/archon-paths.ts:87-96`
```typescript
export function getCommandFolderSearchPaths(configuredFolder?: string): string[] {
  const paths = ['.archon/commands'];

  // Add configured folder if specified (and not already .archon/commands)
  if (configuredFolder && configuredFolder !== '.archon/commands') {
    paths.push(configuredFolder);
  }

  return paths;
}
```

**DOCUMENTATION**: CLAUDE.md documents the fallback behavior that should be removed

Evidence: `CLAUDE.md:364-367`
```markdown
**Workflow folder search paths (in priority order):**
1. `.archon/workflows/`
2. `.claude/workflows/`
3. `.agents/workflows/`
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/utils/archon-paths.ts` | 102-104 | UPDATE | Remove fallback paths, return only `['.archon/workflows']` |
| `src/utils/archon-paths.test.ts` | N/A | UPDATE | Remove test for `getWorkflowFolderSearchPaths` (not currently tested) |
| `src/workflows/loader.ts` | 178 | UPDATE | Update comment to reflect single-directory behavior |
| `src/workflows/loader.test.ts` | 199-246 | UPDATE | Remove/update fallback directory tests |
| `CLAUDE.md` | 364-367 | UPDATE | Remove fallback directory documentation |

### Integration Points

- `src/workflows/loader.ts:183` - `discoverWorkflows()` calls `getWorkflowFolderSearchPaths()` to get search paths
- `src/workflows/loader.ts:185-203` - Loop iterates through search paths and stops at first directory with workflows
- Tests in `src/workflows/loader.test.ts` verify the fallback behavior that will be removed

### Git History

- **Introduced**: `3026a644` - 2025-12-17 - "Add Archon distribution config and directory structure (#101)"
- **Last modified**: `3026a644` - 2025-12-17
- **Implication**: Feature existed since initial Archon directory structure implementation; removing fallback was always intended to align with command system pattern

---

## Implementation Plan

### Step 1: Update getWorkflowFolderSearchPaths() function

**File**: `src/utils/archon-paths.ts`
**Lines**: 102-104
**Action**: UPDATE

**Current code:**
```typescript
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows', '.claude/workflows', '.agents/workflows'];
}
```

**Required change:**
```typescript
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows'];
}
```

**Why**: Remove fallback directories to match command system behavior

---

### Step 2: Update loader.ts comment

**File**: `src/workflows/loader.ts`
**Lines**: 176-179
**Action**: UPDATE

**Current code:**
```typescript
/**
 * Discover and load workflows from codebase
 * Searches .archon/workflows/, .claude/workflows/, .agents/workflows/
 * Stops at the first folder that contains workflows (priority order).
 */
```

**Required change:**
```typescript
/**
 * Discover and load workflows from codebase
 * Searches .archon/workflows/ only.
 */
```

**Why**: Update documentation to reflect single-directory behavior

---

### Step 3: Remove fallback directory tests

**File**: `src/workflows/loader.test.ts`
**Lines**: 199-246
**Action**: UPDATE

**Tests to remove:**
1. Line 199-215: "should search fallback directories (.claude/workflows, .agents/workflows)"
2. Line 217-246: "should prefer .archon/workflows over .claude/workflows"

**Why**: These tests verify the fallback behavior that no longer exists

**Note**: Keep the test "should discover workflows from .archon/workflows/" (line 155-170) as it verifies the primary behavior

---

### Step 4: Update CLAUDE.md documentation

**File**: `CLAUDE.md`
**Lines**: 364-367
**Action**: UPDATE

**Current code:**
```markdown
**Workflow folder search paths (in priority order):**
1. `.archon/workflows/`
2. `.claude/workflows/`
3. `.agents/workflows/`
```

**Required change:**
```markdown
**Workflow folder location:**
- `.archon/workflows/` - Workflow definitions (YAML files)
```

**Why**: Remove references to fallback directories

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/utils/archon-paths.ts:87-96
// Pattern for single-directory with optional config folder
export function getCommandFolderSearchPaths(configuredFolder?: string): string[] {
  const paths = ['.archon/commands'];

  // Add configured folder if specified (and not already .archon/commands)
  if (configuredFolder && configuredFolder !== '.archon/commands') {
    paths.push(configuredFolder);
  }

  return paths;
}
```

**For workflow paths function - use simpler version (no config parameter yet):**
```typescript
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows'];
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Existing workflows in `.claude/workflows/` or `.agents/workflows/` won't be found | Acceptable - users should migrate to `.archon/workflows/` (documented in issue) |
| Tests may fail if they verify fallback behavior | Remove/update fallback tests (Step 3) |
| Documentation in other files may reference fallback paths | Search completed - no other docs reference these paths |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/utils/archon-paths.test.ts
bun test src/workflows/loader.test.ts
bun run lint
```

### Manual Verification

1. Create test workflow in `.archon/workflows/test.yaml` - verify it loads
2. Create workflow in `.claude/workflows/test2.yaml` - verify it does NOT load
3. Run existing integration tests to ensure no regressions

---

## Scope Boundaries

**IN SCOPE:**
- Update `getWorkflowFolderSearchPaths()` to return single directory
- Remove tests for fallback behavior
- Update documentation in CLAUDE.md
- Update comment in loader.ts

**OUT OF SCOPE (do not touch):**
- Adding configurable workflow folder (future enhancement)
- Migration script for existing workflows (users can move files manually)
- Changes to command folder search logic (already correct)
- Changes to workflow loading logic beyond search paths

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T08:52:00Z
- **Artifact**: `.archon/artifacts/issues/issue-194.md`
