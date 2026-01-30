# Investigation: archon/create-plan.md assumes src/ directory structure (fails on non-Node.js projects)

**Issue**: #336 (https://github.com/dynamous-community/remote-coding-agent/issues/336)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | MEDIUM | Command fails on non-Node.js projects but has no workaround; however it only affects plan creation, not runtime |
| Complexity | LOW | 2 files need `<context>` section updates, isolated changes with no integration risk |
| Confidence | HIGH | Root cause is explicit in the error message and confirmed by reading the hardcoded lines; the defaults version already has the fix |

---

## Problem Statement

The `.claude/commands/archon/create-plan.md` command's `<context>` section executes `!ls -la src/` and `!ls src/features/` which fail on any project without a `src/` directory (Python, Go, flat structures, monorepos with `packages/`). The `.claude/commands/create-command.md` has the same hardcoded `!ls -la src/` assumption. The defaults version (`.archon/commands/defaults/archon-create-plan.md`) was already fixed to be project-agnostic, but the `.claude/commands/` versions were not updated.

---

## Analysis

### Root Cause / Change Rationale

WHY 1: Why does `create-plan` fail on non-Node.js projects?
-> Because the `<context>` section runs `!ls -la src/` which errors when `src/` doesn't exist
-> Evidence: `.claude/commands/archon/create-plan.md:17` - `Project structure: !`ls -la src/``

WHY 2: Why does it assume `src/` exists?
-> Because the command was written for Node.js/TypeScript projects with hardcoded paths
-> Evidence: `.claude/commands/archon/create-plan.md:19` - `Existing features: !`ls src/features/ 2>/dev/null || echo "No features directory"``

WHY 3: Why wasn't it project-agnostic from the start?
-> Original commit `c5b289e` (2026-01-02) hardcoded Node.js assumptions when moving commands to archon folder

ROOT CAUSE: Lines 17-19 of `.claude/commands/archon/create-plan.md` and line 22 of `.claude/commands/create-command.md` use hardcoded `src/` paths instead of project-agnostic discovery commands.
Evidence: `.claude/commands/archon/create-plan.md:17-19` and `.claude/commands/create-command.md:22`

### Evidence Chain

WHY: `create-plan` command fails with `ls: src/: No such file or directory`
-> BECAUSE: Line 17 hardcodes `!ls -la src/`
  Evidence: `.claude/commands/archon/create-plan.md:17` - `Project structure: !`ls -la src/``

-> BECAUSE: Line 19 hardcodes `!ls src/features/`
  Evidence: `.claude/commands/archon/create-plan.md:19` - `Existing features: !`ls src/features/ 2>/dev/null || echo "No features directory"``

-> ROOT CAUSE: Context section assumes Node.js project structure
  Evidence: The defaults version (`.archon/commands/defaults/archon-create-plan.md:83-98`) already has the correct project-agnostic approach

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `.claude/commands/archon/create-plan.md` | 16-21 | UPDATE | Replace hardcoded `src/` context with project-agnostic discovery |
| `.claude/commands/create-command.md` | 19-24 | UPDATE | Replace hardcoded `src/` context with project-agnostic discovery |

### Integration Points

- These files are Claude Code slash commands invoked by users
- No runtime code depends on them; they are prompt templates
- The defaults version at `.archon/commands/defaults/archon-create-plan.md` is the reference implementation

### Git History

- **Introduced**: `c5b289e` - 2026-01-02 - "Move issue commands to archon folder and add review-pr command"
- **Defaults fixed**: `133a3cc` - Recent - "feat: Add interactive setup wizard and config editor to Archon skill"
- **Implication**: The `.claude/commands/` versions were not updated when the defaults version was fixed

---

## Implementation Plan

### Step 1: Update `<context>` section in `.claude/commands/archon/create-plan.md`

**File**: `.claude/commands/archon/create-plan.md`
**Lines**: 16-21
**Action**: UPDATE

**Current code:**
```markdown
<context>
Project structure: !`ls -la src/`
Package info: !`cat package.json | head -30`
Existing features: !`ls src/features/ 2>/dev/null || echo "No features directory"`
CLAUDE.md rules: @CLAUDE.md
</context>
```

**Required change:**
```markdown
<context>
Project structure: !`ls -la`
CLAUDE.md rules: @CLAUDE.md
</context>
```

**Why**: Replace hardcoded `src/` and `package.json` references with a simple `ls -la` that works on any project. The Phase 1 section already handles detailed project structure discovery (the defaults version at `.archon/commands/defaults/archon-create-plan.md:83-98` shows the correct approach with `ls -la`, `ls -la */ 2>/dev/null | head -50`, and multi-language config detection). Detailed discovery belongs in the process phases, not the static context section which runs before the agent starts working.

---

### Step 2: Update `<context>` section in `.claude/commands/create-command.md`

**File**: `.claude/commands/create-command.md`
**Lines**: 19-24
**Action**: UPDATE

**Current code:**
```markdown
<context>
Existing commands: !`ls -la .claude/commands/`
Command patterns: @.claude/commands/plan-feature.md
Project structure: !`ls -la src/`
CLAUDE.md conventions: @CLAUDE.md
</context>
```

**Required change:**
```markdown
<context>
Existing commands: !`ls -la .claude/commands/`
Command patterns: @.claude/commands/plan-feature.md
Project structure: !`ls -la`
CLAUDE.md conventions: @CLAUDE.md
</context>
```

**Why**: Same fix - replace `!ls -la src/` with `!ls -la` so it works on any project structure.

---

## Patterns to Follow

**From the defaults version - the correct project-agnostic approach:**

```markdown
# SOURCE: .archon/commands/defaults/archon-create-plan.md:83-98
# Phase 1 section shows proper discovery:

### 1.1 Discover Project Structure

**CRITICAL**: Do NOT assume `src/` exists. Discover actual structure:

```bash
# List root contents
ls -la

# Find main source directories
ls -la */ 2>/dev/null | head -50

# Identify project type from config files
cat package.json 2>/dev/null | head -20
cat pyproject.toml 2>/dev/null | head -20
cat Cargo.toml 2>/dev/null | head -20
cat go.mod 2>/dev/null | head -20
```
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Other commands may have similar hardcoded paths | Searched all `.claude/commands/` - only these 2 files have the `!ls -la src/` issue |
| Template examples in the plan still reference `src/features/` | These are documentation placeholders, not executed commands - acceptable as illustrative examples |

---

## Validation

### Automated Checks

No automated tests exist for command templates. These are markdown prompt files.

### Manual Verification

1. Open a non-Node.js project (e.g., Python project without `src/`)
2. Run `/archon:create-plan "Add a new feature"`
3. Verify the command does not error on the `<context>` section
4. Verify Phase 1 correctly discovers the actual project structure

---

## Scope Boundaries

**IN SCOPE:**
- Fix the `<context>` section in `.claude/commands/archon/create-plan.md` (lines 16-21)
- Fix the `<context>` section in `.claude/commands/create-command.md` (lines 19-24)

**OUT OF SCOPE (do not touch):**
- Template example paths like `src/features/X/service.ts` in documentation sections (these are illustrative placeholders, not executed)
- The `.archon/commands/defaults/archon-create-plan.md` file (already fixed)
- The `exp-piv-loop/plan.md` file (uses `npm run` but with fallback pattern, and is a different command)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/1b2e3f7a-fd15-47f9-91e5-a727fdd84836/investigation.md`
