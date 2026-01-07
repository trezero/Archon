# Investigation: /repo <name> fails due to owner/repo folder structure mismatch

**Issue**: #95 (https://github.com/dynamous-community/remote-coding-agent/issues/95)
**Type**: BUG
**Complexity**: MEDIUM
**Confidence**: HIGH
**Investigated**: 2026-01-06T00:00:00Z

---

## Problem Statement

The `/repo <name>` command fails to find repositories by name because `/repos` only lists top-level owner directories, not the nested repository folders. When a user clones `octocat/Hello-World`, they see "octocat" in the repo list but cannot switch using the actual repository name "Hello-World".

---

## Analysis

### Root Cause

The `/repos` and `/repo` commands read only the top-level workspace directory, but `/clone` creates a nested `owner/repo` structure.

### Evidence Chain

WHY: `/repo Hello-World` returns "Repository not found: Hello-World"
|
v BECAUSE: The identifier is matched against top-level folder names only
  Evidence: `src/handlers/command-handler.ts:699-700`
  ```typescript
  targetFolder =
    folders.find(f => f === identifier) ?? folders.find(f => f.startsWith(identifier));
  ```
|
v BECAUSE: `folders` only contains top-level directories like `octocat`, not `Hello-World`
  Evidence: `src/handlers/command-handler.ts:679-683`
  ```typescript
  const entries = await readdir(workspacePath, { withFileTypes: true });
  const folders = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  ```
|
v BECAUSE: `/clone` creates nested structure but `/repos` doesn't recurse
  Evidence: `src/handlers/command-handler.ts:296`
  ```typescript
  const targetPath = join(workspacePath, ownerName, repoName);
  ```
|
v ROOT CAUSE: Directory structure is nested but listing logic is flat
  - Clone creates: `~/.archon/workspaces/octocat/Hello-World/`
  - Repos lists: `~/.archon/workspaces/*` (only top level)

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/handlers/command-handler.ts` | 587-633 | UPDATE | `/repos` command - recurse into owner folders |
| `src/handlers/command-handler.ts` | 668-801 | UPDATE | `/repo` command - match repo names, not just owner names |
| `src/handlers/command-handler.ts` | 803-879 | UPDATE | `/repo-remove` command - same fix for consistency |
| `src/handlers/command-handler.test.ts` | NEW | UPDATE | Add tests for nested structure behavior |

### Integration Points

- `/clone` at line 296 creates the nested structure
- Database stores codebase name as `owner/repo` format (line 407)
- Database stores `default_cwd` as the full nested path
- `findCodebaseByDefaultCwd` does exact path matching

### Git History

- **Path collision fix**: `5c6ad1c` - "Fix multi-repository path collision bug (#78)" added owner nesting
- **Initial /repo command**: `ae6bb06` - "Add /repo command for quick repository switching"
- **Implication**: The nesting was added after `/repo` was created, breaking the match

---

## Implementation Plan

### Step 1: Create helper function to list repositories with nested structure

**File**: `src/handlers/command-handler.ts`
**Lines**: Before line 587 (before `/repos` case)
**Action**: ADD

**Add this helper function:**
```typescript
interface RepoEntry {
  displayName: string;  // "owner/repo" format for display
  repoName: string;     // Just the repo name for matching
  fullPath: string;     // Full filesystem path
}

async function listRepositories(workspacePath: string): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];

  try {
    const ownerEntries = await readdir(workspacePath, { withFileTypes: true });
    const ownerFolders = ownerEntries.filter(entry => entry.isDirectory());

    for (const owner of ownerFolders) {
      const ownerPath = join(workspacePath, owner.name);
      const repoEntries = await readdir(ownerPath, { withFileTypes: true });
      const repoFolders = repoEntries.filter(entry => entry.isDirectory());

      for (const repo of repoFolders) {
        repos.push({
          displayName: `${owner.name}/${repo.name}`,
          repoName: repo.name,
          fullPath: join(ownerPath, repo.name),
        });
      }
    }
  } catch {
    // Workspace doesn't exist yet
  }

  return repos.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
```

**Why**: Centralizes the logic for listing repositories with proper nesting. Both `/repos` and `/repo` will use this.

---

### Step 2: Update /repos command to use helper

**File**: `src/handlers/command-handler.ts`
**Lines**: 587-633
**Action**: UPDATE

**Current code:**
```typescript
case 'repos': {
  const workspacePath = getArchonWorkspacesPath();

  try {
    const entries = await readdir(workspacePath, { withFileTypes: true });
    const folders = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();

    if (!folders.length) {
      return {
        success: true,
        message: 'No repositories found in /workspace\n\nUse /clone <repo-url> to add one.',
      };
    }

    // Get current codebase to check for active repo (consistent with /status)
    let currentCodebase = conversation.codebase_id
      ? await codebaseDb.getCodebase(conversation.codebase_id)
      : null;

    // Auto-detect codebase from cwd if not explicitly linked (same as /status)
    if (!currentCodebase && conversation.cwd) {
      currentCodebase = await codebaseDb.findCodebaseByDefaultCwd(conversation.cwd);
    }

    let msg = 'Repositories:\n\n';

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      const folderPath = join(workspacePath, folder);
      // Mark as active only if current codebase's default_cwd matches this folder
      const isActive = currentCodebase?.default_cwd === folderPath;
      const marker = isActive ? ' ← active' : '';
      msg += `${String(i + 1)}. ${folder}${marker}\n`;
    }

    msg += '\nUse /repo <number|name> to switch';

    return { success: true, message: msg };
  } catch (error) {
    const err = error as Error;
    console.error('[Command] repos failed:', err);
    return { success: false, message: `Failed to list repositories: ${err.message}` };
  }
}
```

**Required change:**
```typescript
case 'repos': {
  const workspacePath = getArchonWorkspacesPath();

  try {
    const repos = await listRepositories(workspacePath);

    if (!repos.length) {
      return {
        success: true,
        message: 'No repositories found in /workspace\n\nUse /clone <repo-url> to add one.',
      };
    }

    // Get current codebase to check for active repo (consistent with /status)
    let currentCodebase = conversation.codebase_id
      ? await codebaseDb.getCodebase(conversation.codebase_id)
      : null;

    // Auto-detect codebase from cwd if not explicitly linked (same as /status)
    if (!currentCodebase && conversation.cwd) {
      currentCodebase = await codebaseDb.findCodebaseByDefaultCwd(conversation.cwd);
    }

    let msg = 'Repositories:\n\n';

    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      // Mark as active if current codebase's default_cwd matches this repo's path
      const isActive = currentCodebase?.default_cwd === repo.fullPath;
      const marker = isActive ? ' ← active' : '';
      msg += `${String(i + 1)}. ${repo.displayName}${marker}\n`;
    }

    msg += '\nUse /repo <number|name> to switch';

    return { success: true, message: msg };
  } catch (error) {
    const err = error as Error;
    console.error('[Command] repos failed:', err);
    return { success: false, message: `Failed to list repositories: ${err.message}` };
  }
}
```

**Why**: Shows full `owner/repo` format and compares against correct nested path for active marker.

---

### Step 3: Update /repo command to use helper and match repo names

**File**: `src/handlers/command-handler.ts`
**Lines**: 668-801
**Action**: UPDATE

**Current code (lines 677-710):**
```typescript
try {
  // Get sorted list of repos (same as /repos)
  const entries = await readdir(workspacePath, { withFileTypes: true });
  const folders = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  if (!folders.length) {
    return {
      success: false,
      message: 'No repositories found. Use /clone <repo-url> first.',
    };
  }

  // Find the target folder by number or name
  let targetFolder: string | undefined;
  const num = parseInt(identifier, 10);
  if (!isNaN(num) && num >= 1 && num <= folders.length) {
    targetFolder = folders[num - 1];
  } else {
    // Try exact match first, then prefix match
    targetFolder =
      folders.find(f => f === identifier) ?? folders.find(f => f.startsWith(identifier));
  }

  if (!targetFolder) {
    return {
      success: false,
      message: `Repository not found: ${identifier}\n\nUse /repos to see available repositories.`,
    };
  }

  const targetPath = join(workspacePath, targetFolder);
```

**Required change:**
```typescript
try {
  // Get sorted list of repos with nested structure
  const repos = await listRepositories(workspacePath);

  if (!repos.length) {
    return {
      success: false,
      message: 'No repositories found. Use /clone <repo-url> first.',
    };
  }

  // Find the target repo by number or name
  let targetRepo: RepoEntry | undefined;
  const num = parseInt(identifier, 10);
  if (!isNaN(num) && num >= 1 && num <= repos.length) {
    targetRepo = repos[num - 1];
  } else {
    // Match priority:
    // 1. Exact full path match (e.g., "octocat/Hello-World")
    // 2. Exact repo name match (e.g., "Hello-World")
    // 3. Prefix match on full path
    // 4. Prefix match on repo name
    targetRepo =
      repos.find(r => r.displayName === identifier) ??
      repos.find(r => r.repoName === identifier) ??
      repos.find(r => r.displayName.startsWith(identifier)) ??
      repos.find(r => r.repoName.startsWith(identifier));
  }

  if (!targetRepo) {
    return {
      success: false,
      message: `Repository not found: ${identifier}\n\nUse /repos to see available repositories.`,
    };
  }

  const targetPath = targetRepo.fullPath;
  const targetFolder = targetRepo.displayName;
```

**Also update remaining references from `targetFolder` to use the new structure where needed:**
- Line 716: `console.log(\`[Command] Pulled latest for ${targetFolder}\`);`
- Line 742: `name: targetFolder,` - keep as is, this creates codebase name
- Line 746: `console.log(\`[Command] Created codebase for ${targetFolder}\`);`
- Line 786: `let msg = \`Switched to: ${targetFolder}\`;`

**Why**: Enables matching by repo name (what users expect) while also supporting full path and numeric index.

---

### Step 4: Update /repo-remove command for consistency

**File**: `src/handlers/command-handler.ts`
**Lines**: 803-879
**Action**: UPDATE

Apply the same pattern as Step 3:

**Current code (lines 811-844):**
```typescript
try {
  // Get sorted list of repos (same as /repos)
  const entries = await readdir(workspacePath, { withFileTypes: true });
  const folders = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  // ... rest of matching logic
```

**Required change:**
```typescript
try {
  // Get sorted list of repos with nested structure
  const repos = await listRepositories(workspacePath);
  // ... same matching logic as /repo
```

**Full changes needed:**
- Replace folder listing with `listRepositories(workspacePath)`
- Replace matching logic with same priority as `/repo`
- Update `targetPath` assignment from `join(workspacePath, targetFolder)` to `targetRepo.fullPath`
- Update display name usage to `targetRepo.displayName`

**Why**: Consistency between /repo and /repo-remove commands.

---

### Step 5: Add tests for nested structure behavior

**File**: `src/handlers/command-handler.test.ts`
**Action**: UPDATE

**Test cases to add:**
```typescript
describe('/repos with nested owner/repo structure', () => {
  // Mock setup for nested directories
  const mockReaddirNested = (path: string) => {
    if (path.endsWith('/workspaces')) {
      // Top level: owner folders
      return Promise.resolve([
        { name: 'octocat', isDirectory: () => true },
        { name: 'github', isDirectory: () => true },
      ]);
    } else if (path.endsWith('/octocat')) {
      return Promise.resolve([
        { name: 'Hello-World', isDirectory: () => true },
        { name: 'Spoon-Knife', isDirectory: () => true },
      ]);
    } else if (path.endsWith('/github')) {
      return Promise.resolve([
        { name: 'docs', isDirectory: () => true },
      ]);
    }
    return Promise.resolve([]);
  };

  it('should list repos in owner/repo format', async () => {
    // Test /repos shows "octocat/Hello-World" not just "octocat"
  });

  it('should match by repo name in /repo command', async () => {
    // Test /repo Hello-World finds octocat/Hello-World
  });

  it('should match by full path in /repo command', async () => {
    // Test /repo octocat/Hello-World works
  });

  it('should match by number in /repo command', async () => {
    // Test /repo 1 still works
  });

  it('should mark correct repo as active', async () => {
    // Test active marker uses full path comparison
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/handlers/command-handler.ts:287-296
// Pattern for extracting owner/repo and creating nested path
const urlParts = workingUrl.replace(/\.git$/, '').split('/');
const repoName = urlParts.pop() ?? 'unknown';
const ownerName = urlParts.pop() ?? 'unknown';
const targetPath = join(workspacePath, ownerName, repoName);
```

```typescript
// SOURCE: src/handlers/command-handler.ts:406-411
// Pattern for codebase naming (uses owner/repo format)
const codebase = await codebaseDb.createCodebase({
  name: `${ownerName}/${repoName}`,
  repository_url: workingUrl,
  default_cwd: targetPath,
  ai_assistant_type: suggestedAssistant,
});
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Empty owner folder (no repos inside) | Filter out owners with no repo subdirectories |
| Multiple repos with same name (different owners) | Display as `owner/repo` to disambiguate |
| Existing codebases with old flat structure | Backward compatible - flat repos still work |
| User types partial name matching multiple repos | Priority matching: exact > prefix on full path > prefix on repo name |
| Performance with many repos | Acceptable for typical usage (<100 repos) |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/handlers/command-handler.test.ts
bun run lint
```

### Manual Verification

1. Clone a repository: `/clone https://github.com/octocat/Hello-World`
2. Verify `/repos` shows `octocat/Hello-World` format
3. Test `/repo Hello-World` works
4. Test `/repo octocat/Hello-World` works
5. Test `/repo 1` works
6. Verify active marker appears correctly
7. Test `/repo-remove` with same matching patterns

---

## Scope Boundaries

**IN SCOPE:**
- `/repos` command: list with nested structure, show `owner/repo` format
- `/repo` command: match by number, full path, or repo name
- `/repo-remove` command: same matching logic for consistency
- Tests for new behavior

**OUT OF SCOPE (do not touch):**
- `/clone` command - already creates correct structure
- Database schema - no changes needed
- Other commands that don't list repos

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-06
- **Artifact**: `.archon/artifacts/issues/issue-95.md`
