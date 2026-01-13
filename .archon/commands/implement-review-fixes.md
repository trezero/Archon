---
description: Implement CRITICAL and HIGH fixes from review, add tests, report remaining issues
argument-hint: (none - reads from consolidated review artifact)
---

# Implement Review Fixes

---

## Your Mission

Read the consolidated review artifact and implement all CRITICAL and HIGH priority fixes. Add tests for fixed code if missing. Commit changes. Report what was fixed, what wasn't (and why), and suggest follow-up issues for remaining items.

**Output artifact**: `.archon/artifacts/reviews/pr-{number}/fix-report.md`
**Git action**: Commit fixes (don't push)
**GitHub action**: Post fix report comment

---

## Phase 1: LOAD - Get Fix List

### 1.1 Find PR Number

```bash
ls -d .archon/artifacts/reviews/pr-* 2>/dev/null | tail -1
```

### 1.2 Read Consolidated Review

```bash
cat .archon/artifacts/reviews/pr-{number}/consolidated-review.md
```

Extract:
- All CRITICAL issues with fixes
- All HIGH issues with fixes
- MEDIUM issues (for reporting)
- LOW issues (for reporting)

### 1.3 Read Individual Artifacts for Details

If consolidated doesn't have full fix code, read original artifacts:

```bash
cat .archon/artifacts/reviews/pr-{number}/code-review-findings.md
cat .archon/artifacts/reviews/pr-{number}/error-handling-findings.md
cat .archon/artifacts/reviews/pr-{number}/test-coverage-findings.md
```

### 1.4 Check Current Git State

```bash
git status --porcelain
git branch --show-current
```

**PHASE_1_CHECKPOINT:**
- [ ] Consolidated review loaded
- [ ] CRITICAL/HIGH issues extracted
- [ ] Fix code available for each
- [ ] Git state clean

---

## Phase 2: IMPLEMENT - Apply Fixes

### 2.1 For Each CRITICAL Issue

1. **Read the file**
2. **Apply the recommended fix**
3. **Verify fix compiles**: `bun run type-check`
4. **Track**: Note what was changed

### 2.2 For Each HIGH Issue

Same process as CRITICAL.

### 2.3 For Test Coverage Gaps

If test-coverage-agent identified missing tests for fixed code:

1. **Create/update test file**
2. **Add tests for the fix**
3. **Verify tests pass**: `bun test {file}`

### 2.4 Handle Unfixable Issues

If a fix cannot be applied:
- **Conflict**: Code has changed since review
- **Complex**: Requires architectural changes
- **Unclear**: Recommendation is ambiguous
- **Risk**: Fix might break other things

Document the reason clearly.

**PHASE_2_CHECKPOINT:**
- [ ] All CRITICAL fixes attempted
- [ ] All HIGH fixes attempted
- [ ] Tests added for fixes
- [ ] Unfixable issues documented

---

## Phase 3: VALIDATE - Verify Fixes

### 3.1 Type Check

```bash
bun run type-check
```

Must pass. If not, fix type errors.

### 3.2 Lint

```bash
bun run lint
```

Fix any lint errors introduced.

### 3.3 Run Tests

```bash
bun test
```

All tests must pass. If new tests fail, fix them.

### 3.4 Build Check

```bash
bun run build
```

Must succeed.

**PHASE_3_CHECKPOINT:**
- [ ] Type check passes
- [ ] Lint passes
- [ ] All tests pass
- [ ] Build succeeds

---

## Phase 4: COMMIT - Save Changes

### 4.1 Stage Changes

```bash
git add -A
git status
```

### 4.2 Commit

```bash
git commit -m "fix: Address CRITICAL and HIGH issues from comprehensive review

Fixes applied:
- {brief list of fixes}

Tests added:
- {list of new tests}

Skipped (see review artifacts):
- {brief list of unfixable}

Review artifacts: .archon/artifacts/reviews/pr-{number}/"
```

### 4.3 Do NOT Push

Leave for user to review and push.

**PHASE_4_CHECKPOINT:**
- [ ] Changes committed
- [ ] Commit message descriptive
- [ ] Not pushed (user will review)

---

## Phase 5: GENERATE - Create Fix Report

Write to `.archon/artifacts/reviews/pr-{number}/fix-report.md`:

```markdown
# Fix Report: PR #{number}

**Date**: {ISO timestamp}
**Status**: {COMPLETE | PARTIAL}

---

## Summary

{2-3 sentence overview of fixes applied}

---

## Fixes Applied

### CRITICAL Fixes ({n}/{total})

| Issue | Location | Status | Details |
|-------|----------|--------|---------|
| {title} | `file:line` | ✅ FIXED | {what was done} |
| {title} | `file:line` | ❌ SKIPPED | {why} |

#### Fix Details

**{Issue Title}**
- **Location**: `{file}:{line}`
- **Original Issue**: {brief description}
- **Fix Applied**:
```typescript
{the fix that was applied}
```
- **Test Added**: {yes/no - test file if yes}

---

### HIGH Fixes ({n}/{total})

{Same structure as CRITICAL}

---

## Tests Added

| Test File | Test Cases | For Issue |
|-----------|------------|-----------|
| `src/x.test.ts` | `it('should...')` | {issue title} |
| ... | ... | ... |

---

## Not Fixed (Requires Manual Action)

### {Issue Title}

**Severity**: {CRITICAL/HIGH}
**Location**: `{file}:{line}`
**Reason Not Fixed**: {reason}

**Suggested Action**:
{What the user should do:
- Manual fix required because...
- Needs architectural decision...
- Conflicts with...}

---

## MEDIUM Issues (User Decision Required)

These were not auto-fixed. User should decide:

| Issue | Location | Options |
|-------|----------|---------|
| {title} | `file:line` | Fix now / Create issue / Skip |
| ... | ... | ... |

<details>
<summary>Details for each MEDIUM issue</summary>

### {Issue Title}
{Full details from consolidated review}

</details>

---

## LOW Issues (For Consideration)

| Issue | Location | Suggestion |
|-------|----------|------------|
| {title} | `file:line` | {brief suggestion} |
| ... | ... | ... |

---

## Suggested Follow-up Issues

If not addressing in this PR, create these issues:

### Issue 1: {Suggested Title}

**Priority**: P1 / P2 / P3
**Related Finding**: {which review finding}
**Description**:
{What the issue should contain}

**Suggested Labels**: `bug`, `enhancement`, `tech-debt`

---

### Issue 2: {Suggested Title}

{Same structure...}

---

## Validation Results

| Check | Status |
|-------|--------|
| Type check | ✅ |
| Lint | ✅ |
| Tests | ✅ ({n} passed) |
| Build | ✅ |

---

## Git Status

- **Branch**: {branch-name}
- **Commit**: {commit-hash}
- **Status**: Committed, not pushed

**To review changes**:
```bash
git diff HEAD~1
```

**To push when ready**:
```bash
git push
```

---

## Next Steps

1. Review the fixes: `git diff HEAD~1`
2. Address MEDIUM issues (fix, create issue, or skip)
3. Push when satisfied: `git push`
4. Create follow-up issues for deferred items

---

## Metadata

- **Fixes Applied**: {n}
- **Tests Added**: {n}
- **Issues Skipped**: {n}
- **Artifact**: `.archon/artifacts/reviews/pr-{number}/fix-report.md`
```

**PHASE_5_CHECKPOINT:**
- [ ] Fix report created
- [ ] All fixes documented
- [ ] Unfixed items explained
- [ ] Follow-up issues suggested

---

## Phase 6: POST - GitHub Comment

### 6.1 Post Fix Report

```bash
gh pr comment {number} --body "$(cat <<'EOF'
# ⚡ Auto-Fix Report

**Status**: {COMPLETE | PARTIAL}

---

## Fixes Applied

| Severity | Fixed | Skipped |
|----------|-------|---------|
| 🔴 CRITICAL | {n} | {n} |
| 🟠 HIGH | {n} | {n} |

### What Was Fixed

{For each fix:}
- ✅ **{title}** (`{file}:{line}`) - {brief description}

### Tests Added

- `{test-file}`: {n} new test cases

---

## ❌ Not Fixed (Manual Action Required)

{If any:}
- **{title}** (`{file}`) - {reason}

---

## 🟡 MEDIUM Issues (Your Decision)

These require your decision:

| Issue | Options |
|-------|---------|
| {title} | Fix now / Create issue / Skip |

---

## 📋 Suggested Follow-up Issues

{If any items should become issues:}

1. **{Issue Title}** (P{1/2/3})
   - {brief description}

---

## Validation

✅ Type check | ✅ Lint | ✅ Tests | ✅ Build

---

## Next Steps

1. Review changes: `git diff HEAD~1`
2. Address MEDIUM issues
3. Push when ready: `git push`
4. Create follow-up issues if needed

---

*Auto-fixed by Archon comprehensive-pr-review workflow*
EOF
)"
```

**PHASE_6_CHECKPOINT:**
- [ ] GitHub comment posted
- [ ] Fix summary clear
- [ ] Next steps provided

---

## Phase 7: OUTPUT - Final Report

```markdown
## Fix Implementation Complete

**PR**: #{number}
**Status**: {COMPLETE | PARTIAL}

### Fixes Applied
- CRITICAL: {n}/{total}
- HIGH: {n}/{total}
- Tests added: {n}

### Validation
| Check | Status |
|-------|--------|
| Type check | ✅ |
| Lint | ✅ |
| Tests | ✅ |
| Build | ✅ |

### Git
- Commit: {hash}
- Status: Committed (not pushed)

### Artifacts
- Fix report: `.archon/artifacts/reviews/pr-{number}/fix-report.md`

### User Actions Required
1. Review changes: `git diff HEAD~1`
2. Address {n} MEDIUM issues
3. Push when ready
4. Consider {n} suggested follow-up issues

### GitHub
✅ Fix report posted to PR #{number}
```

---

## Error Handling

### Type Check Fails After Fix

1. Review the error
2. Adjust the fix
3. Re-run type check
4. If still failing, mark as "Not Fixed" with reason

### Tests Fail

1. Check if fix caused the failure
2. Either: fix the implementation, or fix the test
3. If unclear, mark as "Not Fixed" for manual review

### Conflicting Fixes

If two fixes conflict:
1. Apply the higher-severity fix
2. Note the conflict in report
3. Mark lower-severity as "Skipped - conflicts with fix for {X}"

---

## Success Criteria

- **CRITICAL_ADDRESSED**: All CRITICAL issues attempted
- **HIGH_ADDRESSED**: All HIGH issues attempted
- **TESTS_ADDED**: Tests for fixed code where needed
- **VALIDATION_PASSED**: Type check, lint, tests, build all pass
- **COMMITTED**: Changes committed (not pushed)
- **REPORTED**: Fix report artifact and GitHub comment created
