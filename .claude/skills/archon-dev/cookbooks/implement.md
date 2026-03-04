# Implement Cookbook

Execute a plan file step by step with validation gates. No auto-retry — failures are surfaced to the user.

**Input**: `$ARGUMENTS` — path to a `.plan.md` file, or omit to auto-detect the latest plan.

---

## Phase 1: LOAD — Read the Plan

1. **If path provided**: Read the plan file at `$ARGUMENTS`
2. **If no path**: Look for the most recent `.plan.md` in `.claude/archon/plans/` (excluding `completed/`)
3. **If no plans found**: Tell the user and suggest `/archon-dev plan`

Parse the plan and extract:
- **Mandatory Reading** list
- **Step-by-Step Tasks** list
- **Validation Commands**
- **Acceptance Criteria**

**CHECKPOINT**: Plan loaded and understood before continuing.

---

## Phase 2: PREFLIGHT — Verify Readiness

1. **Read all Mandatory Reading files** — every P0 and P1 file listed in the plan
2. **Verify patterns still match** — spot-check that "Patterns to Mirror" code snippets are still accurate
3. **Check git state** — ensure working directory is clean (`git status`)
4. **Detect project runner** — check for bun.lockb/pnpm-lock.yaml/yarn.lock

If patterns have drifted from what the plan describes, note the discrepancy and adapt. Do NOT blindly follow stale patterns.

**CHECKPOINT**: All mandatory reading complete. Patterns verified. Branch is clean.

---

## Phase 3: EXECUTE — Work Through Tasks

For each task in the plan, sequentially:

1. **Read the target file(s)** before making changes
2. **Make the changes** described in the task
3. **Run incremental validation** — at minimum, type-check after each task
4. **If validation fails**: Fix immediately before moving to the next task
5. **If stuck on a failure**: Stop and present the issue to the user — do NOT guess

**Rules:**
- Follow the plan's task order (dependencies matter)
- If a task says "Mirror pattern from X", read X and actually mirror it
- If a task is unclear, re-read the plan context rather than improvising
- Track which tasks are complete as you go

---

## Phase 4: VALIDATE — Full Validation Gate

After ALL tasks are complete, run the full validation suite from the plan:

1. **Level 1**: Type check
2. **Level 2**: Lint
3. **Level 3**: Unit tests
4. **Level 4**: Full validation (if available)
5. **Level 5**: Manual verification (if specified in plan)

**Present results to the user:**
- Which checks passed
- Which checks failed (with error output)
- Suggested fixes for failures

**If failures exist**: Fix them and re-run the failing validation level. Repeat until all pass or you need user guidance.

**Do NOT auto-loop indefinitely.** If the same failure persists after 2 fix attempts, stop and ask the user.

---

## Phase 5: REPORT — Write Implementation Report

Save to `.claude/archon/reports/{slug}-report.md` using the plan's slug.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Implementation Report

**Plan**: `{path to plan file}`
**Branch**: {current branch}
**Date**: {YYYY-MM-DD}
**Status**: COMPLETE / PARTIAL

---

## Summary

{What was done — 2-3 sentences}

## Tasks Completed

| # | Task | Status |
|---|------|--------|
| 1 | {task description} | Done |
| 2 | {task description} | Done |
| 3 | {task description} | Skipped — {reason} |

## Validation Results

| Check | Result | Details |
|-------|--------|---------|
| Type check | PASS/FAIL | {notes} |
| Lint | PASS/FAIL | {notes} |
| Unit tests | PASS/FAIL | {X passed, Y failed} |
| Full validation | PASS/FAIL | {notes} |

## Files Changed

| File | Action | Lines Changed |
|------|--------|---------------|
| `{path}` | Created | +{N} |
| `{path}` | Modified | +{N}, -{M} |

## Deviations from Plan

{List any deviations from the plan and why they were necessary.
"None" if the plan was followed exactly.}

## Issues Encountered

{List any problems hit during implementation and how they were resolved.
"None" if smooth.}

## Open Items

{Anything left undone — "None" if fully complete.}
```

---

## Phase 6: ARCHIVE — Move Plan to Completed

Move the plan file to `.claude/archon/plans/completed/`:

```bash
mkdir -p .claude/archon/plans/completed
mv {plan-path} .claude/archon/plans/completed/
```

---

## Phase 7: REPORT — Present and Suggest Next Step

Summarize the implementation:
- Tasks completed vs total
- Validation status
- Any deviations or issues

Link to the report artifact.

**Next steps**:
- To commit: `/archon-dev commit`
- To create PR: `/archon-dev pr`
- To review: `/archon-dev review`
