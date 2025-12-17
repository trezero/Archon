---
description: Comprehensive PR code review - checks diff, patterns, runs validation, comments on PR
argument-hint: <pr-number or pr-url> [--approve|--request-changes]
---

# PR Code Review

**Input**: $ARGUMENTS

---

## Philosophy

**Quality over quantity.** One actionable critical issue beats twenty low-confidence nitpicks.

**Confidence-driven reporting.** Only report issues you're confident about (≥80/100). If you're unsure, investigate before flagging.

**Multi-lens analysis.** Different issue types require different analytical perspectives. Apply specialized lenses based on what changed.

**Protect future maintainers.** Review as if you'll debug this code at 3am in 6 months without context.

---

## Phase 1: Fetch PR Context

### Ensure you are on the PR branch

### 1.1 Parse Input

Input could be:
- PR number: `123`
- PR URL: `https://github.com/owner/repo/pull/123`
- Branch name: `feature-branch` (find associated PR)

### 1.2 Get PR Metadata

```bash
# Get PR details
gh pr view [NUMBER] --json number,title,body,author,headRefName,baseRefName,state,additions,deletions,changedFiles,files,reviews,comments

# Get the diff
gh pr diff [NUMBER]

# List changed files with stats
gh pr diff [NUMBER] --name-only
```

Extract:
- PR number, title, description
- Author
- Base and head branches
- Files changed with line counts
- Existing review comments

### 1.3 Checkout PR Branch

```bash
gh pr checkout [NUMBER]
```

---

## Phase 2: Understand Context

### 2.1 Read Project Rules

Read and internalize:
- `CLAUDE.md` - Project conventions and constraints
- `.agents/reference/` - Any relevant reference docs
- Type definitions in `src/types/`

**Extract explicit rules** - These are the baseline for compliance checking.

### 2.2 Find Implementation Context

```bash
# Find implementation report by branch name
ls .agents/implementation-reports/*[branch-name]*.md 2>/dev/null

# List all implementation reports
ls .agents/implementation-reports/

# Find completed plans
ls .agents/plans/completed/
```

**If implementation report exists:**
1. Read it and the referenced plan
2. Note documented deviations - these are INTENTIONAL, not issues

**If no implementation report:** Review normally without plan context.

### 2.3 Understand PR Intent

From PR title, description, and implementation report:
- What problem does this solve?
- What approach was taken?
- What deviations were documented and why?

### 2.4 Categorize Changed Files

For each file, determine:
- File type (adapter, handler, util, test, config, types)
- Change scope (new, modification, deletion)
- Which review lenses apply (see Phase 3)

---

## Phase 3: Multi-Lens Code Review

Apply relevant lenses based on what changed. Not every lens applies to every PR.

### 3.1 Determine Applicable Lenses

| Lens | Apply When |
|------|------------|
| **Core Review** | Always |
| **Comment Quality** | Files with significant comments or docstrings |
| **Test Coverage** | New functionality or changed behavior |
| **Error Handling** | Code with try/catch, error callbacks, fallbacks |
| **Type Design** | New or modified interfaces/types |
| **Simplification** | Complex or verbose code changes |

### 3.2 Core Review Lens (Always Apply)

For EVERY changed file:

**Read the full file** (not just diff) and similar files for pattern context.

#### Correctness
- Does the code do what the PR claims?
- Are there logic errors?
- Are edge cases handled?

#### CLAUDE.md Compliance
Verify adherence to explicit project rules:
- Import patterns and structure
- Framework conventions
- Function declarations and error handling
- Naming conventions
- Testing requirements

#### Security
- User input without validation?
- Secrets that could be exposed?
- Injection vulnerabilities (SQL, command, etc.)?
- Unsafe operations?

#### Performance
- N+1 queries or loops?
- Unnecessary async/await?
- Memory leaks (unclosed resources)?
- Blocking operations in hot paths?

### 3.3 Comment Quality Lens

**Apply when:** Files have significant comments, docstrings, or inline documentation.

**Mission:** Protect against comment rot. Every comment must add genuine value.

For each comment, verify:

1. **Factual Accuracy**
   - Do function signatures match documented parameters/return types?
   - Does described behavior match actual code logic?
   - Do referenced types, functions, variables exist and work as stated?

2. **Completeness**
   - Critical assumptions documented?
   - Non-obvious side effects mentioned?
   - Complex algorithms explained?
   - Business logic rationale captured when not self-evident?

3. **Long-term Value**
   - Comments explaining 'why' vs just 'what'?
   - Will they become outdated with likely code changes?
   - TODOs or FIXMEs that may have already been addressed?

4. **Misleading Elements**
   - Ambiguous language?
   - Outdated references to refactored code?
   - Examples that don't match current implementation?

**Flag for removal:** Comments that merely restate obvious code.

### 3.4 Test Coverage Lens

**Apply when:** PR adds new functionality or changes existing behavior.

**Mission:** Ensure behavioral coverage, not just line coverage.

For each significant change:

1. **Critical Gap Identification**
   - Untested error handling paths that could cause silent failures
   - Missing edge case coverage for boundary conditions
   - Uncovered critical business logic branches
   - Absent negative test cases for validation logic
   - Missing tests for concurrent or async behavior

2. **Test Quality Assessment**
   - Do tests verify behavior and contracts (not implementation details)?
   - Would they catch meaningful regressions?
   - Are they resilient to reasonable refactoring?

3. **Prioritize Recommendations (Rate 1-10)**
   - 9-10: Critical - could cause data loss, security issues, system failures
   - 7-8: Important - could cause user-facing errors
   - 5-6: Edge cases - could cause confusion or minor issues
   - 3-4: Nice-to-have for completeness
   - 1-2: Optional minor improvements

Only recommend tests rated ≥7.

### 3.5 Error Handling Lens

**Apply when:** Code contains try/catch blocks, error callbacks, fallbacks, or error states.

**Mission:** Zero tolerance for silent failures.

For each error handling location, audit:

1. **Logging Quality**
   - Is the error logged with appropriate severity?
   - Does the log include sufficient context (operation, IDs, state)?
   - Would this help debug the issue 6 months from now?

2. **User Feedback**
   - Does user receive clear, actionable feedback?
   - Does the message explain what they can do to fix/work around?
   - Is it specific enough to be useful?

3. **Catch Block Specificity**
   - Does it catch only expected error types?
   - Could it accidentally suppress unrelated errors?
   - Should this be multiple catch blocks?

4. **Fallback Behavior**
   - Is fallback explicitly requested/documented?
   - Does it mask the underlying problem?
   - Would user be confused by silent fallback?

5. **Error Propagation**
   - Should this error bubble up instead of being caught here?
   - Is the error being swallowed when it should propagate?

**Critical flags:**
- Empty catch blocks (absolutely forbidden)
- Catch blocks that only log and continue without user feedback
- Returning null/undefined on error without logging
- Fallback to mock/stub implementations outside tests

### 3.6 Type Design Lens

**Apply when:** PR introduces or significantly modifies interfaces, types, or classes.

**Mission:** Ensure types have strong, clearly expressed, well-encapsulated invariants.

For each significant type:

1. **Identify Invariants**
   - Data consistency requirements
   - Valid state transitions
   - Relationship constraints between fields
   - Business logic rules encoded in the type

2. **Rate (1-10 each):**

   **Encapsulation**
   - Are internal details properly hidden?
   - Can invariants be violated from outside?
   - Is the interface minimal and complete?

   **Invariant Expression**
   - How clearly are invariants communicated through structure?
   - Are invariants enforced at compile-time where possible?
   - Is the type self-documenting?

   **Invariant Usefulness**
   - Do invariants prevent real bugs?
   - Are they aligned with business requirements?
   - Neither too restrictive nor too permissive?

   **Invariant Enforcement**
   - Are invariants checked at construction time?
   - Are all mutation points guarded?
   - Is it impossible to create invalid instances?

**Flag:**
- Anemic domain models with no behavior
- Types that expose mutable internals
- Invariants enforced only through documentation
- Missing validation at construction boundaries

### 3.7 Simplification Lens

**Apply when:** Code changes are complex, verbose, or difficult to follow.

**Mission:** Enhance clarity without changing functionality.

Analyze for:

1. **Unnecessary Complexity**
   - Excessive nesting that could be flattened
   - Redundant abstractions or indirection
   - Over-engineered solutions for simple problems

2. **Clarity Issues**
   - Nested ternaries (prefer switch/if-else)
   - Dense one-liners that sacrifice readability
   - Magic numbers/strings that should be constants
   - Unclear variable/function names

3. **Pattern Violations**
   - Inconsistent with established project patterns
   - Arrow functions where `function` keyword expected
   - Missing explicit return type annotations

**Important:** Prefer clarity over brevity. Explicit code > clever compact code.

---

## Phase 4: Confidence Scoring

### Issue Confidence Scale (0-100)

| Score | Meaning |
|-------|---------|
| 0-25 | Likely false positive or pre-existing issue |
| 26-50 | Minor nitpick not explicitly in CLAUDE.md |
| 51-75 | Valid but low-impact issue |
| 76-90 | Important issue requiring attention |
| 91-100 | Critical bug or explicit CLAUDE.md violation |

### Reporting Threshold

**Only report issues with confidence ≥80**

For each potential issue, ask:
1. Am I certain this is actually wrong? (not just different)
2. Is this explicitly against project rules?
3. Would this cause real problems in production?
4. Is this in code the PR changed (not pre-existing)?

If uncertain, investigate before flagging. Read more context. Check if it's intentional.

---

## Phase 5: Run Validation

### 5.1 Automated Checks

```bash
# Type checking
npm run type-check
# OR bun run type-check

# Linting
npm run lint
# OR bun run lint

# Tests
npm test
# OR bun test

# Build
npm run build
# OR bun run build
```

### 5.2 Specific Validation

Based on what changed:
- New API endpoint → test with curl
- New adapter → check interface compliance
- Database changes → check migration exists
- Config changes → verify .env.example updated

### 5.3 Regression Check

```bash
npm test
# Run specific tests for changed functionality
npm test -- [relevant-test-file]
```

---

## Phase 6: Generate Report

### 6.1 Issue Categorization

**🔴 Critical (Blocking)** - Confidence 91-100
- Security vulnerabilities
- Data loss/corruption potential
- Breaking changes without migration
- Crashes or undefined behavior

**🟠 High (Should Fix)** - Confidence 80-90
- Type safety violations
- Missing error handling for likely failures
- Missing tests for new functionality
- Logic errors affecting functionality

**🟡 Medium (Acknowledged)** - Confidence 76-79
Include only if pattern is egregious. Otherwise omit.

**Note:** Issues below 76 confidence are NOT reported.

### 6.2 Report Structure

```markdown
# PR Review: #[NUMBER] - [TITLE]

**Author**: @[author]
**Branch**: [head] → [base]
**Files Changed**: [count] (+[additions]/-[deletions])

---

## Summary

[2-3 sentences: What this PR does and overall assessment]

## Lenses Applied

- [x] Core Review
- [ ] Comment Quality (if applied)
- [ ] Test Coverage (if applied)
- [ ] Error Handling (if applied)
- [ ] Type Design (if applied)
- [ ] Simplification (if applied)

## Implementation Context

**Implementation Report**: `[path]` or "Not found"
**Documented Deviations**: [count] or "N/A"

---

## Issues Found

### 🔴 Critical (Confidence 91-100)

[If none: "None."]

- **[file.ts:123]** [Confidence: 95]
  - **Issue**: [Clear description]
  - **Why**: [Impact explanation]
  - **Fix**: [Specific recommendation]

### 🟠 High Priority (Confidence 80-90)

[If none: "None."]

- **[file.ts:456]** [Confidence: 85]
  - **Issue**: [Clear description]
  - **Rule**: [CLAUDE.md rule or bug explanation]
  - **Fix**: [Specific recommendation]

---

## Lens-Specific Findings

### Comment Quality
[Only if lens was applied and findings exist]

### Test Coverage Gaps
[Only if lens was applied]
- [List tests rated ≥7 with criticality rating]

### Error Handling Concerns
[Only if lens was applied and findings exist]

### Type Design Assessment
[Only if lens was applied]
| Type | Encapsulation | Expression | Usefulness | Enforcement |
|------|---------------|------------|------------|-------------|
| [TypeName] | X/10 | X/10 | X/10 | X/10 |

---

## Validation Results

| Check | Status | Details |
|-------|--------|---------|
| Type Check | ✅ Pass / ❌ Fail | [notes] |
| Lint | ✅ Pass / ⚠️ Warnings | [count] |
| Tests | ✅ Pass ([count]) | [coverage] |
| Build | ✅ Pass / ❌ Fail | [notes] |

---

## What's Good

[Acknowledge positive aspects - good patterns, clean code, thoughtful design]

---

## Recommendation

**✅ APPROVE** / **🔄 REQUEST CHANGES** / **❌ BLOCK**

[Clear explanation and what needs to happen next]

---

*Report: `.agents/pr-reviews/pr-[NUMBER]-review.md`*
```

### 6.3 Decision Logic

**APPROVE** if:
- No critical (91-100) or high (80-90) issues
- All validation passes
- Code follows patterns

**REQUEST CHANGES** if:
- High priority issues exist (80-90 confidence)
- Validation fails but is fixable
- Pattern violations needing attention

**BLOCK** if:
- Critical issues (91-100 confidence)
- Security or data integrity concerns
- Fundamental approach is wrong

---

## Phase 7: Publish Report

### 7.1 Save Local Report

```bash
mkdir -p .agents/pr-reviews
```

Save to: `.agents/pr-reviews/pr-[NUMBER]-review.md`

Include metadata header:
```markdown
---
pr: [NUMBER]
title: [TITLE]
author: [AUTHOR]
reviewed: [TIMESTAMP]
recommendation: [approve/request-changes/block]
lenses_applied: [core, comments, tests, errors, types, simplification]
issues_critical: [count]
issues_high: [count]
---
```

### 7.2 Comment on PR

```bash
# If approve flag passed and no critical/high issues:
gh pr review [NUMBER] --approve --body "$(cat .agents/pr-reviews/pr-[NUMBER]-review.md)"

# If request-changes flag passed or high issues found:
gh pr review [NUMBER] --request-changes --body "$(cat .agents/pr-reviews/pr-[NUMBER]-review.md)"

# Otherwise just comment:
gh pr comment [NUMBER] --body "$(cat .agents/pr-reviews/pr-[NUMBER]-review.md)"
```

### 7.3 Output Summary

```
## PR Review Complete

**PR**: #[NUMBER] - [TITLE]
**Recommendation**: ✅ APPROVE / 🔄 REQUEST CHANGES / ❌ BLOCK

**Issues (≥80 confidence only)**:
- 🔴 Critical: [count]
- 🟠 High: [count]

**Lenses Applied**: [list]
**Validation**: [pass/fail summary]

**Report saved**: .agents/pr-reviews/pr-[NUMBER]-review.md
**PR comment**: [link]
```

---

## Special Cases

### Draft PRs
- Still review but note it's a draft
- Focus on direction over polish
- Don't approve/request-changes, just comment

### Large PRs (>500 lines)
- Note thorough review may miss things
- Suggest breaking into smaller PRs
- Focus on architecture over details

### Sensitive Areas
- Security code: Extra scrutiny on all lenses
- Database migrations: Check reversibility
- Configuration: Check all environments

### Missing Tests
- Apply Test Coverage lens
- Only flag as high priority if criticality ≥7
- Suggest specific test cases

---

## Critical Reminders

1. **Confidence threshold is mandatory.** Don't report anything below 80.

2. **Investigate before flagging.** If unsure, read more context.

3. **Apply relevant lenses only.** Don't force-fit analysis.

4. **Be specific.** File, line, what's wrong, how to fix.

5. **Acknowledge good work.** Positive feedback matters.

6. **Check implementation report.** Documented deviations are intentional.

7. **Run validation.** Don't skip automated checks.

8. **One critical issue > twenty nitpicks.** Quality over quantity.

Now fetch the PR, review through appropriate lenses, and generate the report.
