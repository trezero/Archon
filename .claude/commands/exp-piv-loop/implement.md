---
description: Execute an implementation plan - autonomous, adaptive, end-to-end
argument-hint: <path/to/plan.md>
---

# Implement from Plan

**Plan file**: $1

---

## Step 0: Branch Setup

Before making any changes, ensure you're on the correct branch:

```bash
# Check current branch
git branch --show-current

# Check if a feature branch already exists
git branch -a | grep -i feature
```

**If on main/master:**
1. Check if a branch for this feature already exists
2. If yes → `git checkout [branch-name]`
3. If no → Create one: `git checkout -b feature/[name]`

**Branch naming**: `feature/[short-description]` (e.g., `feature/discord-adapter`, `feature/add-caching`)

---

## Your Mission

Execute the plan end-to-end. You are autonomous and adaptive.

**Golden Rule**: Finish the job. Adapt when needed. Human decides merge/rollback after.

---

## Step 1: Read the Plan

Read `$1` and locate these sections:
- **Summary** - What we're building
- **External Research** - Docs and gotchas to be aware of
- **Patterns to Mirror** - Code to follow
- **Files to Change** - What gets created/modified
- **Tasks** - Step-by-step implementation
- **Validation Strategy** - How to verify it works

---

## Step 2: Validate Current State

Before implementing, quick check:
- Are the pattern files still there and unchanged?
- Any git conflicts with files we need to modify?
- Dependencies available?

**If outdated**: Adapt. Research if needed. Continue.

---

## Step 3: Execute Tasks

Follow the plan's **Tasks** section top-to-bottom.

For each task:
1. Read the **Mirror** reference
2. Make the change
3. Run the task's **Verify** command
4. If verify fails → fix it → re-verify → continue

**If stuck**: Research (web search), adapt, continue. Don't stop.

---

## Step 4: Run Validation

Execute the plan's **Validation Strategy** section:
- Run all automated checks listed
- Write the tests specified in "New Tests to Write"
- Execute manual validation steps
- Test edge cases listed
- Run regression checks

**All validation is defined in the plan.** Follow it.

---

## Step 5: Write Implementation Report

Create a detailed implementation report at `.agents/implementation-reports/[branch-name]-implementation-report.md`:

```bash
mkdir -p .agents/implementation-reports
```

**Report structure:**

```markdown
---
plan: [relative path to plan file]
branch: [feature branch name]
implemented: [YYYY-MM-DD]
status: complete | partial
---

# Implementation Report: [Feature Name from Plan Summary]

## Overview

**Plan**: `[plan path]` → moved to `.agents/plans/completed/`
**Branch**: `[branch-name]`
**Date**: [YYYY-MM-DD]

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | [task from plan] | ✅/❌ | [brief note if needed] |
| 2 | [task from plan] | ✅/❌ | |

## Validation Results

| Check | Result | Details |
|-------|--------|---------|
| Type check | ✅/❌ | [errors if any] |
| Lint | ✅/❌ | [X warnings, 0 errors] |
| Tests | ✅/❌ | [X pass, Y fail] |
| [other from plan] | ✅/❌ | |

## Deviations from Plan

### [Deviation 1 Title]
- **Plan specified**: [what the plan said to do]
- **Actual implementation**: [what was actually done]
- **Reason**: [why the deviation was made - user request, technical constraint, better approach discovered, etc.]
- **Impact**: [how this affects the feature/system]

### [Deviation 2 Title]
...

*If no deviations: "None - implementation followed plan exactly."*

## Issues Encountered

### [Issue 1 Title]
- **Problem**: [what went wrong]
- **Solution**: [how it was resolved]
- **Time impact**: [minor/moderate/significant]

*If no issues: "None - implementation proceeded smoothly."*

## Files Changed

| File | Change Type | Lines |
|------|-------------|-------|
| `src/path/to/file.ts` | Modified | +25/-0 |
| `src/path/to/test.ts` | Modified | +73/-0 |

## Implementation Notes

[Any additional context, decisions made, or things the reviewer should know that don't fit above. This is free-form.]

## For Reviewers

When reviewing the PR for this implementation:
1. The plan is at: `[plan path in completed/]`
2. Deviations documented above were intentional
3. Key areas to focus on: [list 2-3 areas if relevant]
```

Then move plan to completed:
```bash
mkdir -p .agents/plans/completed
mv $1 .agents/plans/completed/
```

**Naming convention**: `[branch-name]-implementation-report.md`
- Example: `feature-github-adapter-ux-improvements-implementation-report.md`

---

## Key Principles

1. **The plan is your guide** - Tasks, validation, everything is there
2. **You are autonomous** - Adapt and continue, don't stop and ask
3. **Research when stuck** - Web search, read docs, figure it out
4. **Document deviations** - If you change the approach, explain why
5. **Complete the job** - Human decides merge/rollback after
