# Investigation: Check for existing PR before creating new one in fix-github-issue workflow

**Issue**: #193 (https://github.com/dynamous-community/remote-coding-agent/issues/193)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T08:40:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | HIGH | Causes duplicate PRs in production use (issue #124 created PR #186 and #190), wastes resources, confuses users about which PR to review |
| Complexity | LOW | Single command file modification, add bash check using existing `gh pr list` pattern before PR creation (10-15 lines) |
| Confidence | HIGH | Root cause is clear from code review (missing PR check in implement-issue.md:309-388), solution pattern exists in worktree-cleanup.md:91 |

---

## Problem Statement

The `fix-github-issue` workflow's `implement-issue` command unconditionally creates a new PR via `gh pr create` without checking if a PR already exists for the current branch. This results in duplicate PRs when the workflow runs multiple times (user retry, worktree fallback, partial completion) for the same issue, as evidenced by issue #124 creating both PR #186 and PR #190.

---

## Analysis

### Change Rationale

**Why This Change:**
The `implement-issue` command (Phase 7: PR Creation, lines 309-388) immediately pushes and creates a PR after implementation without checking if a PR already exists. While `gh pr create` will fail if a PR exists for the exact same branch name, the workflow can create duplicate PRs when:
1. Workflow runs on different branches for same issue (e.g., `fix/issue-124-*` vs `test/issue-124-*`)
2. User manually retries after modifying branch
3. Worktree fallback creates new branch with different naming pattern

**User Impact:**
- Confusion about which PR to review/merge
- Wasted CI/CD resources (tests run on duplicate PRs)
- Issue gets incorrectly linked to multiple PRs
- Manual cleanup required

**Evidence from Production:**
Issue #124 resulted in two open PRs:
- PR #186: `fix/issue-124-add-workflow-tests`
- PR #190: `test/issue-124-workflow-command-tests`

Both have title "test: Add unit tests for /workflow command handler(s) (#124)" and both reference fixing issue #124.

### Evidence Chain

**SYMPTOM:** Duplicate PRs created for same issue
↓ BECAUSE: `implement-issue` command creates PR without checking existing PRs
  Evidence: `.archon/commands/implement-issue.md:309-388` - Phase 7 has no PR existence check

↓ BECAUSE: No validation step before `gh pr create` command
  Evidence: `.archon/commands/implement-issue.md:322-375` - Direct `gh pr create` with no conditional logic

↓ BECAUSE: Edge case handling (line 534-538) acknowledges issue but doesn't implement proactive check
  Evidence: `.archon/commands/implement-issue.md:534-537` - "PR creation fails - Check if PR already exists" is reactive, not proactive

↓ ROOT CAUSE: Missing Phase 6.5 "Check for Existing PR" before Phase 7 "Create Pull Request"
  Evidence: `.archon/commands/implement-issue.md:309` - Phase 7 should be preceded by existence check phase

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `.archon/commands/implement-issue.md` | 309 (insert before) | UPDATE | Add Phase 6.5 to check for existing PR before Phase 7 |
| `.archon/commands/implement-issue.md` | 384-388 | UPDATE | Update Phase 7 checkpoint to include PR check result |

### Integration Points

**Downstream Effects:**
- Phase 7.2 (line 322-375): `gh pr create` - Should only execute if no PR exists
- Phase 7.3 (line 377-382): `gh pr view` - Should work with existing or new PR
- Phase 8 (line 391+): Self code review - Should reference correct PR

**Upstream Dependencies:**
- Phase 6 (line 258-306): Commits changes - Must complete successfully before PR check
- Git branch state: Must be on correct branch with commits pushed

**Similar Patterns in Codebase:**
1. `.claude/commands/exp-piv-loop/worktree-cleanup.md:91` - Uses `gh pr list --head "$BRANCH" --state all`
2. `.claude/commands/validation/validate-2.md:716` - Uses `gh pr list --state open --json number,title,headRefName`
3. `.archon/commands/implement-issue.md:534-537` - Acknowledges PR check needed in error handling

### Git History

- **Introduced**: commit `b0edafc` - 2026-01-10 - "Add investigate-issue and implement-issue commands for fix-github-issue workflow"
- **Last modified**: Same commit (new feature)
- **Implication**: This is a new workflow (created 3 days ago), issue discovered during early production use

---

## Implementation Plan

### Step 1: Add Phase 6.5 - Check for Existing PR

**File**: `.archon/commands/implement-issue.md`
**Lines**: Insert new section before line 309 (before Phase 7)
**Action**: INSERT

**Insert this content before line 309:**

```markdown
## Phase 6.5: VERIFY - Check for Existing PR

Before creating a new PR, check if one already exists for this branch or issue.

### 6.5.1 Get Current Branch

```bash
BRANCH=$(git branch --show-current)
echo "Current branch: $BRANCH"
```

### 6.5.2 Check for PR on Current Branch

```bash
# Check if PR exists for this branch (any state)
EXISTING_PR=$(gh pr list --head "$BRANCH" --state all --json number,state,url --jq '.[0]')

if [ -n "$EXISTING_PR" ]; then
  PR_NUMBER=$(echo "$EXISTING_PR" | jq -r '.number')
  PR_STATE=$(echo "$EXISTING_PR" | jq -r '.state')
  PR_URL=$(echo "$EXISTING_PR" | jq -r '.url')

  echo "⚠️  PR already exists for branch $BRANCH:"
  echo "  PR #$PR_NUMBER - State: $PR_STATE"
  echo "  URL: $PR_URL"

  # Report to user and skip PR creation
  if [ "$PR_STATE" = "OPEN" ]; then
    echo "✅ PR is already open. Skipping PR creation."
    echo "You can update this PR by pushing more commits to $BRANCH"
  elif [ "$PR_STATE" = "MERGED" ]; then
    echo "⚠️  PR was already merged. Cannot create new PR for same branch."
    exit 1
  elif [ "$PR_STATE" = "CLOSED" ]; then
    echo "⚠️  PR was closed without merging. Consider reopening or using a new branch."
    exit 1
  fi

  # Set flag to skip Phase 7 PR creation
  SKIP_PR_CREATION=true
else
  echo "✅ No existing PR found for branch $BRANCH. Proceeding with PR creation."
  SKIP_PR_CREATION=false
fi
```

**PHASE_6.5_CHECKPOINT:**
- [ ] Current branch name retrieved
- [ ] Existing PR check completed
- [ ] If PR exists: User notified, PR details displayed
- [ ] If no PR: Ready to proceed to Phase 7

---
```

**Why:** This follows the established pattern from `worktree-cleanup.md:91` which uses `gh pr list --head "$BRANCH" --state all` to check PRs for a specific branch.

---

### Step 2: Make Phase 7 Conditional

**File**: `.archon/commands/implement-issue.md`
**Lines**: 309-388 (Phase 7 section)
**Action**: UPDATE

**Current Phase 7 header (line 309):**
```markdown
## Phase 7: PR - Create Pull Request
```

**Updated Phase 7 header:**
```markdown
## Phase 7: PR - Create Pull Request (Conditional)

**Skip this phase if `SKIP_PR_CREATION=true` from Phase 6.5**

If a PR already exists, the details were displayed in Phase 6.5. Proceed to Phase 8 for code review.
```

**Why:** Makes it explicit that Phase 7 should be skipped if PR exists. The implementing agent should check the `SKIP_PR_CREATION` flag before executing.

---

### Step 3: Update Phase 7.3 to Handle Existing PR

**File**: `.archon/commands/implement-issue.md`
**Lines**: 377-382
**Action**: UPDATE

**Current code (lines 377-382):**
```markdown
### 7.3 Get PR Number

```bash
PR_URL=$(gh pr view --json url -q '.url')
PR_NUMBER=$(gh pr view --json number -q '.number')
```
```

**Updated code:**
```markdown
### 7.3 Get PR Number

```bash
# If PR was created in 7.2, get the newly created PR details
# If PR existed from Phase 6.5, these variables are already set
if [ "$SKIP_PR_CREATION" = "false" ]; then
  PR_URL=$(gh pr view --json url -q '.url')
  PR_NUMBER=$(gh pr view --json number -q '.number')
fi

echo "PR #$PR_NUMBER: $PR_URL"
```
```

**Why:** Ensures PR_NUMBER and PR_URL are set regardless of whether PR was just created or already existed.

---

### Step 4: Update Phase 7 Checkpoint

**File**: `.archon/commands/implement-issue.md`
**Lines**: 384-388
**Action**: UPDATE

**Current checkpoint (lines 384-388):**
```markdown
**PHASE_7_CHECKPOINT:**
- [ ] Changes pushed to remote
- [ ] PR created
- [ ] PR linked to issue with "Fixes #{number}"
```

**Updated checkpoint:**
```markdown
**PHASE_7_CHECKPOINT:**
- [ ] Changes pushed to remote (if not already)
- [ ] PR exists (either created in 7.2 or found in Phase 6.5)
- [ ] PR linked to issue with "Fixes #{number}"
- [ ] PR number and URL captured in $PR_NUMBER and $PR_URL
```

**Why:** Reflects that PR might have existed before Phase 7, not necessarily created in this phase.

---

### Step 5: Update Edge Case Handling

**File**: `.archon/commands/implement-issue.md`
**Lines**: 534-538
**Action**: UPDATE

**Current edge case (lines 534-537):**
```markdown
### PR creation fails
- Check if PR already exists for branch
- Check for permission issues
- Provide manual gh command
```

**Updated edge case:**
```markdown
### PR creation fails
- This should not happen if Phase 6.5 check succeeded
- Check for permission issues (`gh auth status`)
- Check for GitHub CLI errors (`gh pr create --help`)
- Provide manual gh command with exact parameters
- If "already exists" error: Phase 6.5 check may have missed it (report bug)
```

**Why:** Phase 6.5 makes this edge case much less likely. If it still happens, it indicates a bug in the check logic.

---

## Patterns to Follow

**FROM: `.claude/commands/exp-piv-loop/worktree-cleanup.md:86-98`**
```bash
# Get branch name from worktree
BRANCH=$(cd "$WORKTREE_PATH" && git branch --show-current)

# Check if PR exists and its status
gh pr list --head "$BRANCH" --state all --json number,state,mergedAt

# Interpret:
# - state: "MERGED" → Safe to delete everything
# - state: "OPEN" → Warn: PR still open
# - state: "CLOSED" (not merged) → Warn: PR closed without merge
# - No PR found → Warn: No PR exists for this branch
```

**Pattern:** Use `gh pr list --head "$BRANCH" --state all` to find PRs for specific branch, then check state to determine action.

---

**FROM: `.claude/commands/validation/validate-2.md:716-724`**
```bash
# List PRs to find the one created by the bot
BOT_PR=$(gh pr list --state open --json number,title,headRefName --jq '.[0]')
echo "Bot-created PR: ${BOT_PR}"

# Get PR number if exists
BOT_PR_NUMBER=$(echo $BOT_PR | jq -r '.number // empty')

if [ -n "$BOT_PR_NUMBER" ]; then
  echo "✅ PR #${BOT_PR_NUMBER} created by bot"
  gh pr view ${BOT_PR_NUMBER}
```

**Pattern:** Use `--json` with `--jq` to extract specific fields, check if result is non-empty before using.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Branch has commits but no PR created yet | Phase 6.5 check returns empty, proceeds to Phase 7 normally |
| PR exists but is CLOSED/MERGED | Phase 6.5 detects state, warns user, exits gracefully (no new PR) |
| PR exists on different branch for same issue | Current solution only checks current branch. Feature request: also search by issue number |
| `gh pr list` fails (auth issue, network) | Command will error, workflow stops with error message |
| Branch renamed after PR creation | `gh pr list --head` won't find it (GitHub tracks by branch name) |
| Multiple PRs exist for same branch | `jq '.[0]'` returns first PR (by date), which is correct behavior |

---

## Validation

### Automated Checks

```bash
# Type check (not applicable - this is markdown)
# Test changes (not applicable - no test files for markdown commands)

# Validate markdown syntax
markdownlint .archon/commands/implement-issue.md

# Verify bash syntax in code blocks (extract and validate)
grep -A 20 '```bash' .archon/commands/implement-issue.md | bash -n
```

### Manual Verification

1. **Test with issue that has existing PR:**
   - Run workflow on issue #124 (has PR #186 and #190)
   - Verify Phase 6.5 detects existing PR
   - Verify Phase 7 is skipped with appropriate message
   - Verify PR_NUMBER and PR_URL are set correctly

2. **Test with issue that has no PR:**
   - Run workflow on new issue
   - Verify Phase 6.5 check passes
   - Verify Phase 7 creates PR normally
   - Verify PR is linked to issue

3. **Test with merged PR:**
   - Create test issue, create and merge PR
   - Run workflow again on same branch
   - Verify Phase 6.5 detects MERGED state
   - Verify workflow exits gracefully with error

4. **Test with closed (not merged) PR:**
   - Create test issue, create PR, close without merging
   - Run workflow again on same branch
   - Verify Phase 6.5 detects CLOSED state
   - Verify workflow suggests reopening or new branch

---

## Scope Boundaries

**IN SCOPE:**
- Add PR existence check before creation
- Handle OPEN, CLOSED, MERGED states appropriately
- Reuse existing PR if found (display details, skip creation)
- Update checkpoints and edge case documentation

**OUT OF SCOPE (future enhancements):**
- Search for existing PRs by issue number (not just branch name)
- Automatically update existing PR with new commits
- Handle multiple PRs for same issue (user must resolve manually)
- Check for PRs across all branches (only checks current branch)
- Interactive prompt asking user which PR to use

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T08:40:00Z
- **Artifact**: `.archon/artifacts/issues/issue-193.md`
- **Codebase version**: commit a30776f
