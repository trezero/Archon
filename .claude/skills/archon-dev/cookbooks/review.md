# Review Cookbook

Structured code review for PRs or local changes. Deploys parallel review agents for thorough coverage.

**Input**: `$ARGUMENTS` — PR number, PR URL, or omit for local uncommitted changes.

---

## Phase 1: SCOPE — Determine What to Review

1. **If PR number/URL**: Fetch diff with `gh pr diff {number}`
2. **If no arguments**: Use local changes (`git diff` for unstaged, `git diff --staged` for staged)
3. **If nothing to review**: Tell the user

Also gather:
- PR description (if PR): `gh pr view {number}`
- Commit messages: `git log --oneline main..HEAD` (or equivalent)
- Related artifacts: Check `.claude/archon/plans/` and `.claude/archon/reports/` for context

**CHECKPOINT**: Diff obtained. Scope understood.

---

## Phase 2: CONTEXT — Read Project Standards

1. **Read CLAUDE.md** for project conventions, patterns, and constraints
2. **Read affected files** — not just the diff, but the full files being changed (context matters)
3. **Check for related tests** — are there existing tests for the changed code?

---

## Phase 3: REVIEW — Deploy Parallel Agents

Launch 2-4 review agents in parallel using the Agent tool:

### Agent 1: Correctness & Logic (`code-reviewer`)
**Always launch.** Write a detailed prompt describing the specific changes being reviewed, the files affected, and what to look for. Ask it to check correctness, logic bugs, edge cases, error handling, and adherence to CLAUDE.md conventions.

### Agent 2: Silent Failures & Error Handling (`silent-failure-hunter`)
**Always launch.** Write a detailed prompt describing the changed files and what error handling patterns to scrutinize. Ask it to hunt for swallowed errors, inappropriate fallbacks, and missing error propagation.

### Agent 3: Test Coverage (`pr-test-analyzer`)
**Launch if code changes (not just docs/config).** Write a detailed prompt describing what functionality changed and what test coverage to evaluate. Focus on behavioral coverage gaps, not line metrics.

### Agent 4: Simplification (`code-simplifier`)
**Launch if changes are substantial (>100 lines).** Write a detailed prompt describing the changed code and ask for simplification opportunities that preserve exact functionality.
```

---

## Phase 4: SYNTHESIZE — Merge and Prioritize

After all agents return:

1. **Deduplicate** findings across agents
2. **Categorize** by severity:
   - **Critical** (must fix): Bugs, security issues, data loss risks
   - **High** (should fix): Logic errors, missing error handling, test gaps
   - **Medium** (consider): Style inconsistencies, minor improvements
   - **Low** (nit): Formatting, naming preferences
3. **Verify** top findings yourself — read the actual code to confirm

---

## Phase 5: WRITE — Save Review Artifact

Save to `.claude/archon/reviews/{date}-{slug}.md`.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Code Review

**Target**: PR #{number} / local changes on {branch}
**Date**: {YYYY-MM-DD}
**Files Reviewed**: {count}
**Verdict**: APPROVE / REQUEST_CHANGES / CONCERNS

---

## Summary

{2-3 sentence overall assessment}

## Critical Issues

### {issue title}
**File**: `{path}:{line}`
**Problem**: {description}
**Fix**: {suggested fix}

## High Priority

### {issue title}
**File**: `{path}:{line}`
**Problem**: {description}
**Suggestion**: {suggested improvement}

## Medium Priority

...

## Low Priority / Nits

...

## What's Good

{Positive observations — what was done well}

## Test Coverage Assessment

{Summary of test coverage analysis — gaps, suggestions}
```

---

## Phase 6: REPORT — Present to User

Summarize the review:
- Verdict (approve/request changes)
- Count of issues by severity
- Top 3 most important findings

Link to the artifact. If reviewing a PR, ask whether to post findings as a PR comment.
