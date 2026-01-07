# Investigation: Load workflows from conversation.cwd instead of codebase.default_cwd

**Issue**: #138 (https://github.com/dynamous-community/remote-coding-agent/issues/138)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-07T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | HIGH | Blocking users in worktrees/local clones from using conversation-specific workflows; creates inconsistency with command loading which already uses `conversation.cwd`. |
| Complexity | LOW | Single file change (1 line fix), minimal integration impact, well-defined pattern already exists for commands. |
| Confidence | HIGH | Clear root cause at line 526, exact fix pattern demonstrated in command loading at line 462, no unknowns. |

---

## Problem Statement

Workflows are discovered from `codebase.default_cwd` (the base repository clone) instead of `conversation.cwd` (the user's actual working directory). This means users working in worktrees, local clones, or isolated environments cannot use conversation-specific workflows located in their working directory.

---

## Analysis

### Root Cause / Change Rationale

The workflow discovery happens BEFORE isolation resolution, using the codebase's default directory instead of the conversation's resolved working directory. This is inconsistent with command loading, which correctly uses `conversation.cwd`.

### Evidence Chain

WHY: Workflows from local clone/worktree are not discovered
↓ BECAUSE: `discoverWorkflows()` receives wrong path
  Evidence: `src/orchestrator/orchestrator.ts:526` - `availableWorkflows = await discoverWorkflows(codebaseForWorkflows.default_cwd);`

↓ BECAUSE: Code uses `codebaseForWorkflows.default_cwd` instead of `conversation.cwd`
  Evidence: `src/orchestrator/orchestrator.ts:523-526`:
  ```typescript
  const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
  if (codebaseForWorkflows) {
    try {
      availableWorkflows = await discoverWorkflows(codebaseForWorkflows.default_cwd);
  ```

↓ ROOT CAUSE: Workflow discovery does not follow the established pattern for path resolution
  Evidence: Compare with command loading at `src/orchestrator/orchestrator.ts:462`:
  ```typescript
  const commandCwd = conversation.cwd ?? codebase.default_cwd;
  ```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/orchestrator/orchestrator.ts` | 522-526 | UPDATE | Use `conversation.cwd ?? codebase.default_cwd` pattern |

### Integration Points

- `discoverWorkflows()` in `src/workflows/loader.ts:100` - Already accepts `cwd` parameter, no changes needed
- `conversation.cwd` - Already set from isolation environment at line 110-112
- `validateAndResolveIsolation()` - Resolves correct cwd but happens AFTER workflow discovery (line 578)

### Git History

- **Introduced**: 759cb303 - 2025-12-18 - "Add workflow engine for multi-step AI orchestration"
- **Last modified**: 37cf6152 - 2026-01-02 - "Fix workflow engine type safety and routing"
- **Implication**: Original implementation oversight - pattern was established for commands but not replicated for workflows

---

## Implementation Plan

### Step 1: Update workflow discovery to use conversation.cwd

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 522-526
**Action**: UPDATE

**Current code:**
```typescript
// Line 522-526
// Discover workflows (returns array, no global state)
const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
if (codebaseForWorkflows) {
  try {
    availableWorkflows = await discoverWorkflows(codebaseForWorkflows.default_cwd);
```

**Required change:**
```typescript
// Discover workflows (returns array, no global state)
// Use conversation.cwd if set (worktree/local clone), otherwise codebase default
const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
if (codebaseForWorkflows) {
  try {
    const workflowCwd = conversation.cwd ?? codebaseForWorkflows.default_cwd;
    availableWorkflows = await discoverWorkflows(workflowCwd);
```

**Why**: Follows the established pattern from command loading (line 462) and ensures workflows are discovered from the user's actual working directory.

---

### Step 2: Add test for workflow discovery with conversation.cwd

**File**: `src/orchestrator/orchestrator.test.ts`
**Action**: CREATE or UPDATE (if exists)

**Test cases to add:**
```typescript
describe('workflow discovery', () => {
  it('should discover workflows from conversation.cwd when set', async () => {
    // Mock conversation with cwd set to a worktree
    const conversation = {
      id: 'test-conv',
      cwd: '/tmp/worktree',
      codebase_id: 'test-codebase',
      // ... other fields
    };

    // Mock codebase with different default_cwd
    const codebase = {
      id: 'test-codebase',
      default_cwd: '/workspace/repo',
      // ... other fields
    };

    // Create workflow in worktree location
    // Verify discoverWorkflows is called with conversation.cwd
  });

  it('should fall back to codebase.default_cwd when conversation.cwd is null', async () => {
    // Mock conversation without cwd
    const conversation = {
      id: 'test-conv',
      cwd: null,
      codebase_id: 'test-codebase',
    };

    // Verify discoverWorkflows is called with codebase.default_cwd
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/orchestrator/orchestrator.ts:461-463
// Pattern for resolving cwd with fallback
const commandCwd = conversation.cwd ?? codebase.default_cwd;
const commandFilePath = join(commandCwd, commandDef.path);
```

```typescript
// SOURCE: src/orchestrator/orchestrator.ts:104
// Pattern from validateAndResolveIsolation fallback
return { cwd: conversation.cwd ?? '/workspace', env: null, isNew: false };
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| conversation.cwd is null and codebase is null | Already handled - early return at line 514-519 |
| Workflow folder doesn't exist in conversation.cwd | Already handled - discoverWorkflows gracefully handles ENOENT |
| User expects workspace workflows but gets worktree workflows | Documented behavior - worktree takes priority (matches command behavior) |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/workflows/loader.test.ts
bun test src/orchestrator
bun run lint
```

### Manual Verification

1. Create a worktree with custom workflow:
   ```bash
   git worktree add /tmp/test-worktree -b test-branch
   mkdir -p /tmp/test-worktree/.archon/workflows
   echo "name: test-workflow\ndescription: Test\nprovider: claude\nsteps:\n  - command: plan" > /tmp/test-worktree/.archon/workflows/test.yaml
   ```

2. Set conversation cwd to worktree and verify workflow is discovered:
   ```bash
   # Via test adapter or Telegram
   /setcwd /tmp/test-worktree
   # Send message - should see "Discovered 1 workflows" in logs
   ```

3. Verify base workspace workflows still work when conversation.cwd is null

---

## Scope Boundaries

**IN SCOPE:**
- Update workflow discovery path resolution (line 526)
- Add tests for the new behavior

**OUT OF SCOPE (do not touch):**
- Docker workflow limitations (documented in issue as future consideration)
- Moving workflow discovery after isolation resolution (would require larger refactor)
- Changes to `discoverWorkflows()` function itself
- Changes to command loading logic (already correct)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-07T12:00:00Z
- **Artifact**: `.archon/artifacts/issues/issue-138.md`
