# PR Review Scope: #356

**Title**: Fix: Replace hardcoded src/ paths in command templates (#336)
**URL**: https://github.com/dynamous-community/remote-coding-agent/pull/356
**Branch**: task-fix-issue-336 → main
**Author**: Wirasm
**Date**: 2026-01-30

---

## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | ✅ None | MERGEABLE |
| CI Status | ⚠️ Unknown | No CI checks found (merge state: UNSTABLE) |
| Behind Main | ✅ Up to date | 0 commits behind |
| Draft | ✅ Ready | Not a draft |
| Size | ✅ Small | 2 files, +2 -4 |

---

## Changed Files

| File | Type | Additions | Deletions |
|------|------|-----------|-----------|
| `.claude/commands/archon/create-plan.md` | command-template | +1 | -3 |
| `.claude/commands/create-command.md` | command-template | +1 | -1 |

**Total**: 2 files, +2 -4

---

## File Categories

### Source Files (0)
_None_

### Test Files (0)
_None_

### Documentation (0)
_None_

### Configuration (0)
_None_

### Command Templates (2)
- `.claude/commands/archon/create-plan.md`
- `.claude/commands/create-command.md`

---

## Review Focus Areas

Based on changes, reviewers should focus on:

1. **Correctness**: Verify `ls -la` is a sufficient replacement for `ls -la src/` and the removed `cat package.json` / `ls src/features/` lines
2. **Consistency**: Check that the fix aligns with the defaults version at `.archon/commands/defaults/archon-create-plan.md`
3. **Completeness**: Verify no other command templates have the same hardcoded `src/` assumption
4. **No Regressions**: Ensure removing `Package info` and `Existing features` context lines doesn't degrade plan quality for Node.js projects

---

## CLAUDE.md Rules to Check

- Commands stored in filesystem, paths in `codebases.commands` JSONB
- `.archon/commands/` is the primary location for repo commands
- Project-agnostic approach: Do NOT assume `src/` exists

---

## Workflow Context (from automated workflow)

### Source

This PR was created by the `archon-fix-github-issue` workflow.

- **Investigation**: `.archon/artifacts/runs/1b2e3f7a-fd15-47f9-91e5-a727fdd84836/investigation.md`
- **Implementation**: `.archon/artifacts/runs/1b2e3f7a-fd15-47f9-91e5-a727fdd84836/implementation.md`

### Scope Limits (OUT OF SCOPE)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

**IN SCOPE:**
- Fix the `<context>` section in `.claude/commands/archon/create-plan.md` (lines 16-21)
- Fix the `<context>` section in `.claude/commands/create-command.md` (lines 19-24)

**OUT OF SCOPE (do not touch):**
- Template example paths like `src/features/X/service.ts` in documentation sections (these are illustrative placeholders, not executed)
- The `.archon/commands/defaults/archon-create-plan.md` file (already fixed)
- The `exp-piv-loop/plan.md` file (uses `npm run` but with fallback pattern, and is a different command)

### Implementation Deviations

Implementation matched the investigation exactly. No deviations.

---

## CI Details

No CI checks were found. Merge state status is UNSTABLE (likely due to missing required checks or branch protection rules).

---

## Metadata

- **Scope created**: 2026-01-30
- **Artifact path**: `.archon/artifacts/runs/1b2e3f7a-fd15-47f9-91e5-a727fdd84836/review/`
