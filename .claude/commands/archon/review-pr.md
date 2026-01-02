---
description: Review a pull request and post findings as a comment
argument-hint: <pr-number|url>
---

# Review Pull Request

**Input**: $ARGUMENTS

---

## Your Mission

Perform a thorough code review of a pull request and post your findings as a PR comment:

1. Fetch the PR details and diff
2. Analyze the changes for quality, bugs, and patterns
3. Check test coverage and security
4. Post a structured review comment to the PR

**Golden Rule**: Be helpful, not pedantic. Focus on issues that matter - bugs, security, maintainability. Skip style nitpicks that linters should catch.

---

## Phase 1: FETCH - Get PR Details

### 1.1 Parse Input

**If input is a number** (`123`, `#123`):
- Use directly as PR number

**If input is a URL**:
- Extract PR number from URL

### 1.2 Fetch PR Information

```bash
# Get PR metadata
gh pr view {number} --json title,body,state,baseRefName,headRefName,files,additions,deletions,author,url

# Get the diff
gh pr diff {number}
```

**Extract:**
- Title and description
- Files changed (list with additions/deletions)
- Base branch (what it's merging into)
- Related issue (from "Fixes #X" in description)

### 1.3 Validate PR

**Proceed if:**
- PR is open
- Has actual code changes (not just docs/config unless that's the focus)

**If PR is merged/closed:**
- Report status and exit

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] PR details fetched
- [ ] Diff retrieved
- [ ] PR is reviewable (open)

---

## Phase 2: CONTEXT - Understand the Change

### 2.1 Read PR Description

Extract:
- What problem does this solve?
- What's the approach?
- Any testing notes?
- Related issue number

### 2.2 Understand Scope

From the files changed:
- What areas of the codebase are affected?
- Is this a focused change or wide-reaching?
- Are there tests included?

### 2.3 Get Codebase Context

If needed, read related files to understand:
- How the changed code fits into the larger system
- What patterns should be followed
- What the code looked like before

**PHASE_2_CHECKPOINT:**
- [ ] Understand what the PR is trying to do
- [ ] Understand which files/areas are affected
- [ ] Have context for reviewing the changes

---

## Phase 3: ANALYZE - Review the Code

### 3.1 Review Criteria

**For each changed file, check:**

| Category | Questions |
|----------|-----------|
| **Correctness** | Does the code do what it claims? Any logical errors? |
| **Bugs** | Edge cases missed? Null/undefined issues? Race conditions? |
| **Security** | Injection risks? Auth issues? Data exposure? |
| **Patterns** | Follows codebase conventions? Consistent style? |
| **Tests** | Are changes tested? Are tests meaningful? |
| **Performance** | Any obvious performance issues? N+1 queries? |
| **Maintainability** | Is code readable? Good names? Appropriate complexity? |

### 3.2 Categorize Findings

**Critical (must fix):**
- Bugs that would break functionality
- Security vulnerabilities
- Data loss risks

**Important (should fix):**
- Logic that could fail in edge cases
- Missing error handling
- Incomplete tests

**Suggestions (nice to have):**
- Code clarity improvements
- Performance optimizations
- Pattern consistency

**Positive (good things):**
- Well-written code
- Good test coverage
- Thoughtful design

### 3.3 Check Test Coverage

- Are new code paths tested?
- Do tests actually verify the fix/feature?
- Are edge cases covered?

### 3.4 Security Scan

Look for:
- Command injection (string concatenation in shell commands)
- SQL injection (string concatenation in queries)
- XSS (unsanitized user input in output)
- Secrets in code
- Unsafe deserialization
- Path traversal

**PHASE_3_CHECKPOINT:**
- [ ] All changed files reviewed
- [ ] Findings categorized by severity
- [ ] Security considerations checked
- [ ] Test coverage assessed

---

## Phase 4: SYNTHESIZE - Form Overall Assessment

### 4.1 Overall Verdict

Based on findings, determine:

| Verdict | Criteria |
|---------|----------|
| **Approve** | No critical/important issues, ready to merge |
| **Approve with suggestions** | Minor suggestions, but good to merge |
| **Request changes** | Has issues that should be fixed first |
| **Needs discussion** | Architectural concerns, needs team input |

### 4.2 Summary

Write a 2-3 sentence summary:
- What does this PR do?
- What's the overall quality?
- What's the verdict?

**PHASE_4_CHECKPOINT:**
- [ ] Overall verdict determined
- [ ] Summary written
- [ ] Findings prioritized

---

## Phase 5: POST - Comment on PR

### 5.1 Format Review Comment

```bash
gh pr comment {number} --body "$(cat <<'EOF'
## 🔍 Code Review

### Summary

{2-3 sentence summary of what the PR does and overall assessment}

**Verdict**: {Approve | Approve with suggestions | Request changes | Needs discussion}

---

### Findings

{Only include sections that have findings}

#### 🔴 Critical Issues
{Must be fixed before merge}

- `{file}:{line}` - {description of issue}
  ```typescript
  // Problematic code
  {snippet}
  ```
  **Suggestion**: {how to fix}

#### 🟡 Important Issues
{Should be addressed}

- `{file}:{line}` - {description}

#### 💡 Suggestions
{Nice to have improvements}

- `{file}:{line}` - {suggestion}

#### ✅ Strengths
{Good things in the PR}

- {positive observation}
- {another positive}

---

### Security

{🔒 No security concerns identified | ⚠️ Security considerations below}

{If concerns, list them}

---

### Test Coverage

{Assessment of test coverage}

- [ ] New code paths are tested
- [ ] Edge cases are covered
- [ ] Tests are meaningful (not just for coverage)

---

### Checklist

- [{x or space}] Code follows project patterns
- [{x or space}] No obvious bugs
- [{x or space}] Appropriate test coverage
- [{x or space}] No security concerns
- [{x or space}] Ready for merge

---
*Reviewed by Claude*
EOF
)"
```

**PHASE_5_CHECKPOINT:**
- [ ] Review comment posted to PR

---

## Phase 6: REPORT - Output to User

```markdown
## Review Complete

**PR**: #{number} - {title}
**Verdict**: {verdict}

### Summary

{2-3 sentence summary}

### Findings

| Severity | Count |
|----------|-------|
| Critical | {n} |
| Important | {n} |
| Suggestions | {n} |

### Posted

✅ Review comment added to PR #{number}
```

---

## Review Guidelines

### Be Helpful, Not Pedantic

**Good feedback:**
- "This could throw if `user` is null - consider adding a null check"
- "This SQL query is vulnerable to injection - use parameterized queries"
- "This duplicates logic from `src/utils.ts:45` - consider reusing"

**Avoid:**
- "Use single quotes instead of double quotes" (linter should catch)
- "Add a blank line here" (formatting nitpick)
- "I would name this differently" (subjective, not important)

### Focus on What Matters

**High priority:**
- Bugs and logic errors
- Security vulnerabilities
- Missing error handling
- Broken functionality

**Medium priority:**
- Edge cases
- Test coverage gaps
- Performance issues
- Pattern violations

**Low priority:**
- Style preferences
- Minor refactoring opportunities
- Documentation gaps (unless critical)

### Be Specific

**Good:**
```
`src/auth.ts:45` - The password comparison uses `==` which is
vulnerable to timing attacks. Use `crypto.timingSafeEqual()` instead.
```

**Bad:**
```
The auth code could be improved.
```

### Acknowledge Good Work

If the code is well-written, say so! Positive feedback is valuable.

---

## Handling Edge Cases

### PR is too large
- Focus on the most critical files
- Note that a full review wasn't possible
- Suggest breaking into smaller PRs

### PR is just refactoring
- Focus on: Does it preserve behavior? Are tests updated?
- Less focus on: New functionality (there shouldn't be any)

### PR is a dependency update
- Check for breaking changes in changelog
- Verify tests pass
- Look for deprecated API usage

### Can't understand the change
- Ask clarifying questions in the review
- Don't approve what you don't understand

---

## Success Criteria

- **THOROUGH**: All changed files reviewed
- **ACTIONABLE**: Findings have specific file:line references
- **PRIORITIZED**: Issues categorized by severity
- **CONSTRUCTIVE**: Feedback is helpful, not nitpicky
- **POSTED**: Review comment visible on PR
