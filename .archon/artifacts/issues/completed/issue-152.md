# Investigation: GitHub UX - Show repo identifier instead of server filesystem path

**Issue**: #152 (https://github.com/dynamous-community/remote-coding-agent/issues/152)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T07:33:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | HIGH | Security concern exposing server filesystem structure, unprofessional UX, affects multiple user-facing commands |
| Complexity | MEDIUM | Requires changes to 3 commands (status, getcwd, setcwd, clone), helper function modification, and database query addition - isolated to command-handler.ts |
| Confidence | HIGH | Clear scope, all affected code locations identified through comprehensive exploration, implementation approach well-defined with existing patterns |

---

## Problem Statement

The `/status`, `/getcwd`, `/setcwd`, and `/clone` commands expose the server's internal filesystem paths (e.g., `/Users/rasmus/.archon/workspaces/dynamous-community/remote-coding-agent`) to users. This is a security concern, provides no value to users, and looks unprofessional. Users need to know **what repo and branch** they're working in, not the server's internal directory structure.

---

## Analysis

### Root Cause / Change Rationale

The application was designed to show `conversation.cwd` directly to users for debugging purposes during development. As the system matured, this debug output remained in user-facing commands. The database already contains all the information needed to show meaningful repo/branch identifiers (`codebase.name`, `isolation_env.branch_name`), but commands directly display filesystem paths instead.

### Evidence Chain

**WHY:** Commands show filesystem paths like `/Users/rasmus/.archon/workspaces/owner/repo`
↓ **BECAUSE:** Code directly outputs `conversation.cwd` without transformation
  Evidence: `src/handlers/command-handler.ts:247` - `msg += \`\n\nCurrent Working Directory: ${conversation.cwd ?? 'Not set'}\`;`
  Evidence: `src/handlers/command-handler.ts:287` - `message: \`Current working directory: ${conversation.cwd ?? 'Not set'}\``
  Evidence: `src/handlers/command-handler.ts:327` - `message: \`Working directory set to: ${resolvedCwd}\``
  Evidence: `src/handlers/command-handler.ts:510` - `\`Path: ${targetPath}\``

↓ **BECAUSE:** No function exists to format repo context for user display
  Evidence: Only `shortenPath()` exists (lines 30-49), which still falls back to full paths

↓ **ROOT CAUSE:** Commands need a new formatting function that shows "repo @ branch" instead of filesystem paths
  Evidence: Database already has `codebase.name` (e.g., "owner/repo") and `isolation_env.branch_name` (e.g., "issue-152")

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/handlers/command-handler.ts` | 30-49 | UPDATE | Modify `shortenPath()` or add new `formatRepoContext()` function |
| `src/handlers/command-handler.ts` | 221-282 | UPDATE | Replace CWD display in `/status` command with repo context |
| `src/handlers/command-handler.ts` | 284-288 | UPDATE | Replace CWD display in `/getcwd` command with repo context |
| `src/handlers/command-handler.ts` | 325-328 | UPDATE | Replace CWD display in `/setcwd` response with repo context |
| `src/handlers/command-handler.ts` | 510 | UPDATE | Replace path display in `/clone` response with repo context |

### Integration Points

- **Codebase Database** (`src/db/codebases.ts`): Provides `codebase.name` (owner/repo identifier)
- **Isolation Environment Database** (`src/db/isolation-environments.ts`): Provides `branch_name` for worktrees
- **Git Utils** (`src/utils/git.ts`): Can be used to get current branch if not in worktree
- All commands that show working directory rely on this formatting

### Git History

- **Introduced**: commit `924ce833` - 2025-12-01 - "Fix ESLint warnings: use nullish coalescing and SDK types"
- **Last modified**: Multiple recent commits have touched this area
- **Implication**: The CWD display has been in the codebase since early development, carried forward through refactorings

---

## Implementation Plan

### Step 1: Add helper function to format repository context

**File**: `src/handlers/command-handler.ts`
**Lines**: Insert after line 49 (after `shortenPath()` function)
**Action**: CREATE new function

**Add this new function:**
```typescript
/**
 * Format repository context for user-facing display.
 * Shows "owner/repo @ branch" instead of filesystem paths.
 *
 * @param codebase - The codebase record (contains name like "owner/repo")
 * @param isolationEnvId - Optional isolation environment ID (for worktree branch)
 * @param isolationDb - Database module for querying isolation environments
 * @returns Formatted string like "owner/repo @ main" or "owner/repo @ issue-42 (worktree)"
 */
async function formatRepoContext(
  codebase: { name: string; default_cwd: string } | null,
  isolationEnvId: string | null,
  isolationDb: typeof import('../db/isolation-environments')
): Promise<string> {
  if (!codebase) {
    return 'No codebase configured';
  }

  let branchName = 'main'; // Default assumption
  let isWorktree = false;

  // If in a worktree, get the branch name from isolation environment
  if (isolationEnvId) {
    const env = await isolationDb.getById(isolationEnvId);
    if (env?.branch_name) {
      branchName = env.branch_name;
      isWorktree = true;
    }
  } else {
    // Try to get current branch from git if not in worktree
    try {
      const { execFileAsync } = await import('../utils/git');
      const { stdout } = await execFileAsync(
        'git',
        ['-C', codebase.default_cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { timeout: 3000 }
      );
      branchName = stdout.trim();
    } catch {
      // If git fails, keep default "main"
    }
  }

  const worktreeMarker = isWorktree ? ' (worktree)' : '';
  return `${codebase.name} @ ${branchName}${worktreeMarker}`;
}
```

**Why**: Encapsulates the logic for showing meaningful repo context instead of filesystem paths. Reusable across all commands.

---

### Step 2: Update `/status` command to use repo context

**File**: `src/handlers/command-handler.ts`
**Lines**: 247-253
**Action**: UPDATE

**Current code:**
```typescript
msg += `\n\nCurrent Working Directory: ${conversation.cwd ?? 'Not set'}`;

const activeIsolation = conversation.isolation_env_id;
if (activeIsolation) {
  const repoRoot = codebase?.default_cwd;
  const shortPath = shortenPath(activeIsolation, repoRoot);
  msg += `\nWorktree: ${shortPath}`;
}
```

**Required change:**
```typescript
// Import isolation environments DB at the top of the file if not already imported
// Add: import * as isolationDb from '../db/isolation-environments';

const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id, isolationDb);
msg += `\n\nRepository: ${repoContext}`;
```

**Why**: Replace filesystem path with repo identifier and branch. Consolidates CWD + worktree display into single line.

---

### Step 3: Update `/getcwd` command to use repo context

**File**: `src/handlers/command-handler.ts`
**Lines**: 284-288
**Action**: UPDATE

**Current code:**
```typescript
case 'getcwd':
  return {
    success: true,
    message: `Current working directory: ${conversation.cwd ?? 'Not set'}`,
  };
```

**Required change:**
```typescript
case 'getcwd': {
  const codebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;
  const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id, isolationDb);
  return {
    success: true,
    message: `Repository: ${repoContext}`,
  };
}
```

**Why**: Show repo context instead of filesystem path.

---

### Step 4: Update `/setcwd` command response to use repo context

**File**: `src/handlers/command-handler.ts`
**Lines**: 325-328
**Action**: UPDATE

**Current code:**
```typescript
return {
  success: true,
  message: `Working directory set to: ${resolvedCwd}\n\nSession reset - starting fresh on next message.`,
  modified: true,
};
```

**Required change:**
```typescript
// After the conversation update (line 303), fetch the codebase
const codebase = await codebaseDb.findCodebaseByDefaultCwd(resolvedCwd);
const repoContext = codebase
  ? await formatRepoContext(codebase, conversation.isolation_env_id, isolationDb)
  : resolvedCwd; // Fallback to path only if codebase not found

return {
  success: true,
  message: `Working directory set to: ${repoContext}\n\nSession reset - starting fresh on next message.`,
  modified: true,
};
```

**Why**: Show repo context after setting working directory. Fallback to path only if no codebase is found (rare case).

---

### Step 5: Update `/clone` command response to use repo context

**File**: `src/handlers/command-handler.ts`
**Lines**: 510-515
**Action**: UPDATE

**Current code:**
```typescript
let responseMessage = `Repository cloned successfully!\n\nCodebase: ${repoName}\nPath: ${targetPath}`;
if (commandsLoaded > 0) {
  responseMessage += `\n✓ Loaded ${String(commandsLoaded)} commands`;
}
```

**Required change:**
```typescript
let responseMessage = `Repository cloned successfully!\n\nRepository: ${repoName}`;
if (commandsLoaded > 0) {
  responseMessage += `\n✓ Loaded ${String(commandsLoaded)} commands`;
}
```

**Why**: Remove "Path:" line entirely. Users don't need to know the filesystem path. `repoName` (owner/repo) is sufficient.

---

### Step 6: Add necessary import at top of file

**File**: `src/handlers/command-handler.ts`
**Lines**: ~1-20 (top of file)
**Action**: UPDATE

**Check if this import exists, if not, add it:**
```typescript
import * as isolationDb from '../db/isolation-environments';
```

**Why**: Required for `formatRepoContext()` function to query isolation environments.

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/handlers/command-handler.ts:238-242
// Pattern for accessing codebase information
if (codebase?.name) {
  msg += `\n\nCodebase: ${codebase.name}`;
  if (codebase.repository_url) {
    msg += `\nRepository: ${codebase.repository_url}`;
  }
}
```

```typescript
// SOURCE: src/db/isolation-environments.ts:10-16
// Pattern for querying isolation environment by ID
export async function getById(id: string): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}
```

```typescript
// SOURCE: src/orchestrator/orchestrator.ts:245-250
// Pattern for showing branch information to users
} else {
  await platform.sendMessage(
    conversationId,
    `Working in isolated branch \`${env.branch_name}\``
  );
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Codebase not found for current CWD | Return "No codebase configured" in `formatRepoContext()` |
| Git command fails to get branch name | Default to "main" in `formatRepoContext()` with try-catch |
| Isolation environment not found | Handle null case gracefully, default to "main" branch |
| User in non-worktree directory | Use git command to get actual branch name from current directory |
| `/setcwd` to path without codebase | Fallback to showing the path (rare edge case for manual setcwd) |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/handlers/command-handler.test.ts
bun run lint
```

### Manual Verification

1. **Test `/status` command**: Should show "Repository: owner/repo @ branch (worktree)" instead of filesystem path
2. **Test `/getcwd` command**: Should show "Repository: owner/repo @ branch" instead of filesystem path
3. **Test `/setcwd` command**: Response should show repo context, not full path
4. **Test `/clone` command**: Response should not include "Path:" line
5. **Test with worktree**: Verify "(worktree)" marker appears when in isolated environment
6. **Test without worktree**: Verify no "(worktree)" marker appears in main repo

**Test scenarios:**
```bash
# Via test adapter
curl -X POST http://localhost:3000/test/message -H "Content-Type: application/json" \
  -d '{"conversationId":"test","message":"/status"}'

curl http://localhost:3000/test/messages/test | jq -r '.[-1].text'
# Expected: Shows "Repository: owner/repo @ branch" NOT "/Users/rasmus/.archon/..."

curl -X POST http://localhost:3000/test/message -H "Content-Type: application/json" \
  -d '{"conversationId":"test","message":"/getcwd"}'

curl http://localhost:3000/test/messages/test | jq -r '.[-1].text'
# Expected: Shows "Repository: owner/repo @ branch" NOT filesystem path
```

---

## Scope Boundaries

**IN SCOPE:**
- `/status` command output
- `/getcwd` command output
- `/setcwd` command response message
- `/clone` command response message
- New `formatRepoContext()` helper function

**OUT OF SCOPE (do not touch):**
- Internal logging (can still use full paths for debugging)
- `shortenPath()` function (used by `/worktree` commands, works fine there)
- Database schema (no changes needed)
- Orchestrator messages (already uses branch name only)
- `/worktree` commands (already use `shortenPath()` appropriately)
- Any environment variables or configuration

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T07:33:00Z
- **Artifact**: `.archon/artifacts/issues/issue-152.md`
