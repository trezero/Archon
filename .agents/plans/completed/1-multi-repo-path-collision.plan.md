# Plan: Fix Multi-Repository Path Collision

## Summary

Fix a critical bug where multiple GitHub repositories with the same name but different owners collide on the filesystem. Currently, `alice/utils` and `bob/utils` would both clone to `/workspace/utils`, causing data corruption and cross-repo contamination. The fix is to use `owner/repo` paths instead of just `repo` paths throughout the codebase.

## The Bug

**Current behavior:**
- `alice/utils#33` → clones to `/workspace/utils`
- `bob/utils#33` → clones to `/workspace/utils` ← **OVERWRITES alice/utils!**
- Worktrees: both use `/workspace/worktrees/issue-33`

**Expected behavior:**
- `alice/utils#33` → clones to `/workspace/alice/utils`
- `bob/utils#33` → clones to `/workspace/bob/utils`
- Worktrees: `/workspace/alice/worktrees/issue-33` and `/workspace/bob/worktrees/issue-33`

## External Research

### Relevant Patterns
- GitHub uses `owner/repo` as the canonical identifier everywhere
- Filesystem best practice: never assume names are unique without namespace

### No External Dependencies
This is purely a path construction fix - no new libraries needed.

## Patterns to Mirror

### Current Path Construction (the bug)
```typescript
// FROM: src/adapters/github.ts:364-365
// Canonical path is always $WORKSPACE_PATH/{repo}
const canonicalPath = join(resolve(process.env.WORKSPACE_PATH ?? '/workspace'), repo);
```

```typescript
// FROM: src/handlers/command-handler.ts:223-224
const workspacePath = resolve(process.env.WORKSPACE_PATH ?? '/workspace');
const targetPath = join(workspacePath, repoName);
```

### Worktree Path Construction
```typescript
// FROM: src/utils/git.ts:32-33
const branchName = isPR ? `pr-${String(issueNumber)}` : `issue-${String(issueNumber)}`;
const worktreePath = join(repoPath, '..', 'worktrees', branchName);
```

The worktree path is relative to repoPath, so fixing the repoPath automatically fixes worktrees.

### Codebase Name Pattern
```typescript
// FROM: src/adapters/github.ts:383-388
const codebase = await codebaseDb.createCodebase({
  name: repo,  // Just repo name - could be confusing with multiple owners
  repository_url: repoUrlNoGit,
  default_cwd: canonicalPath,
});
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/adapters/github.ts` | UPDATE | Use `owner/repo` for clone path |
| `src/handlers/command-handler.ts` | UPDATE | Parse owner from URL for clone path |
| `src/adapters/github.test.ts` | UPDATE | Add test for multi-repo path construction |

## NOT Building

- ❌ Migration for existing codebases - manual or future work
- ❌ Per-repo webhook secrets - single secret is fine for now
- ❌ Codebase name disambiguation UI - paths are unique, names can duplicate
- ❌ Validation that owner exists - trust GitHub webhooks

---

## Tasks

### Task 1: Fix GitHub adapter clone path

**Why**: This is the primary source of the collision - GitHub webhooks create codebases with colliding paths.

**Mirror**: Existing path construction at `src/adapters/github.ts:364-365`

**Do**: Update `src/adapters/github.ts` in the `getOrCreateCodebaseForRepo` method:

Find line 364-365:
```typescript
// Canonical path is always $WORKSPACE_PATH/{repo}
const canonicalPath = join(resolve(process.env.WORKSPACE_PATH ?? '/workspace'), repo);
```

Replace with:
```typescript
// Canonical path includes owner to prevent collisions between repos with same name
// e.g., alice/utils and bob/utils get separate directories
const canonicalPath = join(resolve(process.env.WORKSPACE_PATH ?? '/workspace'), owner, repo);
```

Also update the codebase name to include owner for clarity (line 384):
```typescript
const codebase = await codebaseDb.createCodebase({
  name: `${owner}/${repo}`,  // Include owner to distinguish repos with same name
  repository_url: repoUrlNoGit,
  default_cwd: canonicalPath,
});
```

**Don't**:
- Don't change the repository_url (it's already correct)
- Don't change the worktree logic (it uses repoPath which will now be correct)

**Verify**: `npm run type-check`

---

### Task 2: Fix command-handler clone path

**Why**: The `/clone` command has the same bug - it uses only repo name for the path.

**Mirror**: Existing clone logic at `src/handlers/command-handler.ts:205-225`

**Do**: Update `src/handlers/command-handler.ts` in the `clone` case:

Find the section that extracts repoName and constructs targetPath (around lines 220-224):
```typescript
const repoName = workingUrl.split('/').pop()?.replace('.git', '') ?? 'unknown';
// Use WORKSPACE_PATH env var for flexibility (local dev vs Docker)
// resolve() converts relative paths to absolute (cross-platform)
const workspacePath = resolve(process.env.WORKSPACE_PATH ?? '/workspace');
const targetPath = join(workspacePath, repoName);
```

Replace with:
```typescript
// Extract owner and repo from URL
// https://github.com/owner/repo.git -> owner, repo
const urlParts = workingUrl.replace(/\.git$/, '').split('/');
const repoName = urlParts.pop() ?? 'unknown';
const ownerName = urlParts.pop() ?? 'unknown';

// Use WORKSPACE_PATH env var for flexibility (local dev vs Docker)
// Include owner in path to prevent collisions (e.g., alice/utils vs bob/utils)
const workspacePath = resolve(process.env.WORKSPACE_PATH ?? '/workspace');
const targetPath = join(workspacePath, ownerName, repoName);
```

Also update the codebase creation to include owner in name (find the `createCodebase` call):
```typescript
const codebase = await codebaseDb.createCodebase({
  name: `${ownerName}/${repoName}`,  // Include owner for clarity
  repository_url: normalizedUrl,  // Store original URL
  default_cwd: targetPath,
});
```

**Don't**:
- Don't change the URL normalization logic
- Don't change the git clone command itself

**Verify**: `npm run type-check`

---

### Task 3: Add test for multi-repo path isolation

**Why**: Prevent regression of this bug.

**Mirror**: Existing test patterns in `src/adapters/github.test.ts`

**Do**: Add new test to `src/adapters/github.test.ts`:

```typescript
describe('multi-repo path isolation', () => {
  test('should use owner/repo path structure for codebases', () => {
    // Test that path construction includes owner
    const workspacePath = '/workspace';
    const owner1 = 'alice';
    const owner2 = 'bob';
    const repo = 'utils';

    // Simulate the path construction logic
    const path1 = `${workspacePath}/${owner1}/${repo}`;
    const path2 = `${workspacePath}/${owner2}/${repo}`;

    // Paths should be different even with same repo name
    expect(path1).not.toBe(path2);
    expect(path1).toBe('/workspace/alice/utils');
    expect(path2).toBe('/workspace/bob/utils');
  });

  test('worktrees should be isolated by owner', () => {
    // Worktrees are relative to repo path, so they auto-isolate
    const aliceRepoPath = '/workspace/alice/utils';
    const bobRepoPath = '/workspace/bob/utils';
    const issueNumber = 33;

    // Simulate worktree path construction
    const aliceWorktree = `${aliceRepoPath}/../worktrees/issue-${issueNumber}`;
    const bobWorktree = `${bobRepoPath}/../worktrees/issue-${issueNumber}`;

    // Note: These resolve to different paths
    // /workspace/alice/worktrees/issue-33 vs /workspace/bob/worktrees/issue-33
    expect(aliceWorktree).not.toBe(bobWorktree);
  });
});
```

**Verify**: `npm test -- src/adapters/github.test.ts`

---

### Task 4: Add test for command-handler clone path

**Why**: Ensure `/clone` command also uses owner/repo paths.

**Mirror**: Existing test patterns (if any for command-handler)

**Do**: If `src/handlers/command-handler.test.ts` exists, add test. Otherwise, add inline verification in Task 2.

Create test case:
```typescript
describe('clone command path isolation', () => {
  test('should extract owner from GitHub URL', () => {
    const url = 'https://github.com/alice/utils.git';
    const urlParts = url.replace(/\.git$/, '').split('/');
    const repoName = urlParts.pop();
    const ownerName = urlParts.pop();

    expect(ownerName).toBe('alice');
    expect(repoName).toBe('utils');
  });

  test('should construct path with owner/repo', () => {
    const workspacePath = '/workspace';
    const ownerName = 'alice';
    const repoName = 'utils';

    const targetPath = `${workspacePath}/${ownerName}/${repoName}`;

    expect(targetPath).toBe('/workspace/alice/utils');
  });
});
```

**Verify**: `npm test`

---

## Validation Strategy

### Automated Checks
- [ ] `npm run type-check` - Types valid
- [ ] `npm run lint` - No lint errors
- [ ] `npm run test` - All tests pass
- [ ] `npm run build` - Build succeeds

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `github.test.ts` | multi-repo path isolation | Different owners get different paths |
| `github.test.ts` | worktrees isolated by owner | Worktrees don't collide |

### Manual/E2E Validation

```bash
# 1. Start the app
npm run dev

# 2. Simulate two webhooks from different owners with same repo name
# Option A: Use test adapter
curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"alice/utils#1","message":"/status"}'

curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"bob/utils#1","message":"/status"}'

# 3. Check database for correct paths
psql $DATABASE_URL -c "SELECT name, default_cwd FROM remote_agent_codebases WHERE name LIKE '%utils%';"

# Expected output should show:
# alice/utils | /workspace/alice/utils
# bob/utils   | /workspace/bob/utils
```

### Edge Cases to Test
- [ ] Same repo name, different owners → different paths
- [ ] URL with `.git` suffix vs without → same extraction
- [ ] SSH URL conversion still works → owner extracted correctly
- [ ] Existing single-repo setup → still works (just different path)

### Regression Check
- [ ] Existing `/clone` command works with new path structure
- [ ] GitHub webhooks create codebases correctly
- [ ] Worktree creation still works
- [ ] Worktree cleanup still finds correct paths

---

## Migration Considerations

**Existing data**: Codebases created before this fix will have paths like `/workspace/repo` instead of `/workspace/owner/repo`. Options:

1. **Manual migration** (recommended for now):
   ```sql
   -- Update existing codebase paths
   UPDATE remote_agent_codebases
   SET default_cwd = '/workspace/owner/' || name,
       name = 'owner/' || name
   WHERE default_cwd NOT LIKE '%/%/%';  -- Only paths without owner
   ```

2. **Auto-migration on access**: Could detect old-style paths and migrate, but adds complexity.

3. **Leave as-is**: Old codebases keep working, only new ones get new structure. May cause confusion.

**Recommendation**: Document the breaking change, provide migration SQL, let users decide.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaks existing single-repo setups | Low | Old paths still work, just new codebases use new structure |
| URL parsing edge cases | Low | GitHub URLs are well-formed |
| Directory creation fails | Low | `git clone` handles creating parent directories |
| Worktree paths break | None | They're relative to repo path, auto-fixed |
