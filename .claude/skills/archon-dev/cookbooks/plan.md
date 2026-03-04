# Plan Cookbook

Detailed implementation plans with codebase intelligence. The most critical cookbook — plans drive everything downstream.

**Input**: `$ARGUMENTS` — path to PRD, feature description, or GitHub issue number.

---

## Phase 1: LOAD — Gather Context

1. **If `$ARGUMENTS` is a file path** (`.prd.md` or `.md`): Read it as the source document
2. **If `$ARGUMENTS` is a GitHub issue** (`#123`): Fetch with `gh issue view 123`
3. **If `$ARGUMENTS` is a description**: Use it directly as the feature specification
4. **Always read CLAUDE.md** for project conventions, architecture, and constraints

**CHECKPOINT**: You must understand WHAT to build and WHY before continuing.

---

## Phase 2: ANALYZE — Deep Codebase Intelligence

Launch 2-3 agents in parallel using the Agent tool:

### Agent 1: Pattern Finder (`codebase-pattern-finder`)
**Always launch.** Write a detailed prompt asking it to find similar features already implemented, related type definitions, test patterns, and error handling patterns nearby. Request actual code snippets with file:line references — these become the "Patterns to Mirror" section.

### Agent 2: Dependency Mapper (`Explore`)
**Always launch.** Write a detailed prompt asking it to map the blast radius — all files that would need to change, import chains affected, test files covering the area, and configuration that might need updates.

### Agent 3: Web Researcher (`web-researcher`)
**Launch only if the feature involves external libraries or APIs.** Write a detailed prompt asking for version-specific docs, known gotchas, migration notes, and best practices.

---

## Phase 3: DRAFT — Write the Plan

After agents return, synthesize findings into the plan template below.

**Critical rules:**
- Every file path must be verified (agents can hallucinate paths)
- "Patterns to Mirror" must contain ACTUAL code from the codebase, not invented examples
- "Mandatory Reading" lists files the implementer MUST read before starting
- Tasks must be atomic — each independently verifiable
- Validation commands must be dynamically detected (no hardcoded runners)

---

## Phase 4: VALIDATE — Check Completeness

Before saving, verify:
- [ ] Every file in "Files to Change" actually exists (for UPDATE/DELETE) or its parent directory exists (for CREATE)
- [ ] Every pattern cited in "Patterns to Mirror" matches the actual codebase
- [ ] Every task has a clear validation step
- [ ] Acceptance criteria are testable, not vague
- [ ] No circular dependencies between tasks

---

## Phase 5: WRITE — Save Artifact

Save to `.claude/archon/plans/{slug}.plan.md` where `{slug}` is a kebab-case feature name.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Feature: {Title}

## Summary

{1-2 sentences: what changes and why}

## User Story

As {role}
I want {goal}
So that {benefit}

## Problem Statement

{What's wrong today, with evidence — file:line references}

## Solution Statement

{Numbered list of concrete changes}

1. {change 1}
2. {change 2}
3. {change 3}

## Metadata

| Field | Value |
|-------|-------|
| Type | FEATURE / REFACTOR / BUGFIX / ENHANCEMENT |
| Complexity | LOW / MEDIUM / HIGH |
| Systems Affected | {packages, modules, or areas} |
| Dependencies | {what must exist first} |
| Estimated Tasks | {number} |

---

## Mandatory Reading

**The implementation agent MUST read these files before starting any task.**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `{path}` | {range} | {reason — e.g., "Pattern to MIRROR exactly"} |
| P1 | `{path}` | {range} | {reason — e.g., "Types to IMPORT"} |
| P2 | `{path}` | {range} | {reason — e.g., "Tests to EXTEND"} |

## Patterns to Mirror

**Copy these patterns from the existing codebase.**

**{PATTERN_NAME}:**
\`\`\`{language}
// SOURCE: {file}:{lines}
{actual code snippet from the codebase}
\`\`\`

**{PATTERN_NAME}:**
\`\`\`{language}
// SOURCE: {file}:{lines}
{actual code snippet from the codebase}
\`\`\`

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `{path}` | CREATE | {why} |
| `{path}` | UPDATE | {why} |
| `{path}` | DELETE | {why} |

---

## Step-by-Step Tasks

### Task 1: {ACTION} `{file path}`

**Action**: CREATE / UPDATE / DELETE
**Details**: {Exact changes with code snippets where helpful}
**Mirror**: `{source file}:{lines}` — follow this pattern
**Validate**: `{specific command to verify this task}`

### Task 2: {ACTION} `{file path}`

...

---

## Validation Commands

**Detect project runner**:
- `bun.lockb` → bun
- `pnpm-lock.yaml` → pnpm
- `yarn.lock` → yarn
- else → npm

**Levels:**

1. **Type check**: `{runner} run type-check` (or equivalent from package.json)
2. **Lint**: `{runner} run lint`
3. **Unit tests**: `{runner} run test` (or specific test file)
4. **Full validation**: `{runner} run validate` (if available)
5. **Manual verification**: {specific curl, CLI, or browser commands}

## Acceptance Criteria

- [ ] {criterion 1 — specific and testable}
- [ ] {criterion 2}
- [ ] All validation commands pass
- [ ] No regressions in existing tests

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| {risk} | Low/Med/High | Low/Med/High | {specific mitigation} |
```

---

## Phase 6: REPORT — Present and Suggest Next Step

Summarize the plan in 5-7 bullet points:
- What will change
- How many tasks
- Key risks
- Estimated complexity

Link to the artifact.

**Next step**: `/archon-dev implement .claude/archon/plans/{slug}.plan.md`
