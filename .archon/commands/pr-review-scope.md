---
description: Gather PR context, verify reviewability, and prepare artifacts directory for comprehensive review
argument-hint: <pr-number|url>
---

# PR Review Scope

**Input**: $ARGUMENTS

---

## Your Mission

Verify the PR is in a reviewable state, gather all context needed for the parallel review agents, and prepare the artifacts directory structure.

---

## Phase 1: IDENTIFY - Determine PR

### 1.1 Parse Input

**Check input format:**
- Number (`123`, `#123`) → GitHub PR number
- URL (`https://github.com/...`) → Extract PR number
- Empty → Check current branch for open PR

```bash
# If no input, check current branch
gh pr view --json number,title,url,headRefName,baseRefName,state 2>/dev/null || echo "NO_PR"
```

### 1.2 Fetch PR Details

```bash
gh pr view {number} --json number,title,body,url,headRefName,baseRefName,files,additions,deletions,changedFiles,state,author,isDraft,mergeable,mergeStateStatus
```

**Extract:**
- PR number and title
- Branch names (head → base)
- Changed files list
- Addition/deletion counts
- Draft status
- Mergeable status

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] PR is open (not merged/closed)
- [ ] Basic metadata extracted

---

## Phase 2: VERIFY - Pre-Review Checks

**Before launching review agents, verify the PR is in a reviewable state.**

### 2.1 Check for Merge Conflicts

```bash
gh pr view {number} --json mergeable,mergeStateStatus --jq '.mergeable, .mergeStateStatus'
```

| Status | Action |
|--------|--------|
| `MERGEABLE` | Continue |
| `CONFLICTING` | **STOP** - Tell user to resolve conflicts first |
| `UNKNOWN` | Warn, continue (GitHub still calculating) |

**If conflicts exist:**
```markdown
❌ **Cannot review: PR has merge conflicts**

Please resolve conflicts before requesting a review:
```bash
git fetch origin main
git rebase origin/main
# Resolve conflicts
git push --force-with-lease
```

Then re-request the review.
```
**Exit workflow if conflicts detected.**

### 2.2 Check CI Status

```bash
gh pr checks {number} --json name,state,conclusion --jq '.[] | "\(.name): \(.state) (\(.conclusion // "pending"))"'
```

| Status | Action |
|--------|--------|
| All passing | Continue |
| Some failing | Warn, continue (note in scope) |
| All failing | Warn strongly, continue (note in scope) |
| Pending | Note, continue |

**Flag CI status for review report.**

### 2.3 Check Behind Main

```bash
# Get branch names
BASE_BRANCH=$(gh pr view {number} --json baseRefName --jq '.baseRefName')
HEAD_BRANCH=$(gh pr view {number} --json headRefName --jq '.headRefName')

# Fetch and count
git fetch origin $BASE_BRANCH --quiet
git fetch origin $HEAD_BRANCH --quiet

# Commits behind main
BEHIND=$(git rev-list --count origin/$HEAD_BRANCH..origin/$BASE_BRANCH 2>/dev/null || echo "0")
```

| Commits Behind | Action |
|----------------|--------|
| 0-5 | Continue |
| 6-15 | Warn, suggest rebase, continue |
| 16+ | Warn strongly, recommend rebase before review |

**If significantly behind:**
```markdown
⚠️ **Branch is {N} commits behind {base}**

Consider rebasing before review to ensure you're reviewing against current code:
```bash
git fetch origin {base}
git rebase origin/{base}
git push --force-with-lease
```
```

### 2.4 Check Draft Status

```bash
gh pr view {number} --json isDraft --jq '.isDraft'
```

| Status | Action |
|--------|--------|
| `false` | Continue normally |
| `true` | Note in scope, continue (user wants early feedback) |

### 2.5 Check PR Size

| Metric | Warning Threshold | Action |
|--------|-------------------|--------|
| Changed files | 20+ | Warn about review thoroughness |
| Lines changed | 1000+ | Warn about review thoroughness |

**If very large:**
```markdown
⚠️ **Large PR: {files} files, +{additions} -{deletions} lines**

Large PRs are harder to review thoroughly. Consider splitting into smaller PRs for better review quality.
```

### 2.6 Compile Reviewability Summary

```markdown
## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | ✅ None / ❌ Has conflicts | {details} |
| CI Status | ✅ Passing / ⚠️ Failing / ⏳ Pending | {details} |
| Behind Main | ✅ Up to date / ⚠️ {N} commits behind | {details} |
| Draft | ✅ Ready / 📝 Draft | {details} |
| Size | ✅ Normal / ⚠️ Large ({N} files) | {details} |
```

**PHASE_2_CHECKPOINT:**
- [ ] No merge conflicts (or workflow stopped)
- [ ] CI status noted
- [ ] Behind-main status checked
- [ ] Draft status noted
- [ ] Size warnings issued if needed

---

## Phase 3: CONTEXT - Gather Review Context

### 3.1 Get Full Diff

```bash
gh pr diff {number}
```

Store this for reference - parallel agents will re-fetch as needed.

### 3.2 List Changed Files by Type

```bash
gh pr view {number} --json files --jq '.files[].path'
```

**Categorize files:**
- Source code (`.ts`, `.js`, `.py`, etc.)
- Test files (`*.test.ts`, `*.spec.ts`, `test_*.py`)
- Documentation (`*.md`, `docs/`)
- Configuration (`.json`, `.yaml`, `.toml`)
- Types/interfaces

### 3.3 Check for CLAUDE.md

```bash
cat CLAUDE.md 2>/dev/null | head -100
```

Note key rules that reviewers should check against.

**PHASE_3_CHECKPOINT:**
- [ ] Diff available
- [ ] Files categorized by type
- [ ] CLAUDE.md rules noted

---

## Phase 4: PREPARE - Create Artifacts Directory

### 4.1 Create Directory Structure

```bash
mkdir -p .archon/artifacts/reviews/pr-{number}
```

### 4.2 Create Scope Manifest

Write `.archon/artifacts/reviews/pr-{number}/scope.md`:

```markdown
# PR Review Scope: #{number}

**Title**: {PR title}
**URL**: {PR URL}
**Branch**: {head} → {base}
**Author**: {author}
**Date**: {ISO timestamp}

---

## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | {status} | {details} |
| CI Status | {status} | {passing}/{total} checks |
| Behind Main | {status} | {N} commits behind |
| Draft | {status} | {Ready/Draft} |
| Size | {status} | {files} files, +{add}/-{del} |

---

## Changed Files

| File | Type | Additions | Deletions |
|------|------|-----------|-----------|
| `src/file.ts` | source | +10 | -5 |
| `src/file.test.ts` | test | +20 | -0 |
| ... | ... | ... | ... |

**Total**: {changedFiles} files, +{additions} -{deletions}

---

## File Categories

### Source Files ({count})
- `src/...`

### Test Files ({count})
- `src/...test.ts`

### Documentation ({count})
- `docs/...`
- `README.md`

### Configuration ({count})
- `package.json`

---

## Review Focus Areas

Based on changes, reviewers should focus on:

1. **Code Quality**: {list key source files}
2. **Error Handling**: {files with try/catch, error handling}
3. **Test Coverage**: {new functionality needing tests}
4. **Comments/Docs**: {files with documentation changes}
5. **Docs Impact**: {check if CLAUDE.md or docs/ need updates}

---

## CLAUDE.md Rules to Check

{Extract key rules from CLAUDE.md that apply to this PR}

---

## CI Details

{If CI failing, list which checks failed}

---

## Metadata

- **Scope created**: {ISO timestamp}
- **Artifact path**: `.archon/artifacts/reviews/pr-{number}/`
```

**PHASE_4_CHECKPOINT:**
- [ ] Directory created
- [ ] Scope manifest written with pre-review status

---

## Phase 5: OUTPUT - Report to User

### If Blocked (Conflicts)

```markdown
## ❌ Review Blocked: Merge Conflicts

**PR**: #{number} - {title}

This PR has merge conflicts that must be resolved before review.

### To Resolve

```bash
git fetch origin {base}
git checkout {head}
git rebase origin/{base}
# Resolve conflicts in your editor
git add .
git rebase --continue
git push --force-with-lease
```

Then re-request the review: `@archon review this PR`
```

### If Proceeding

```markdown
## PR Review Scope Complete

**PR**: #{number} - {title}
**Files**: {count} changed (+{additions} -{deletions})

### Pre-Review Status
| Check | Status |
|-------|--------|
| Conflicts | ✅ None |
| CI | {✅ Passing / ⚠️ {N} failing} |
| Behind Main | {✅ Up to date / ⚠️ {N} behind} |
| Draft | {✅ Ready / 📝 Draft} |
| Size | {✅ Normal / ⚠️ Large} |

### File Categories
- Source: {count} files
- Tests: {count} files
- Docs: {count} files
- Config: {count} files

### Artifacts Directory
`.archon/artifacts/reviews/pr-{number}/`

### Next Step
Launching 5 parallel review agents...
```

---

## Success Criteria

- **PR_IDENTIFIED**: Valid open PR found
- **NO_CONFLICTS**: Merge conflicts block workflow
- **CONTEXT_GATHERED**: Diff and file list available
- **ARTIFACTS_DIR_CREATED**: Directory structure exists
- **SCOPE_MANIFEST_WRITTEN**: `scope.md` file created with pre-review status
