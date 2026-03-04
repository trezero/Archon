# PRD Cookbook

Problem-first product requirement documents. Focus on WHAT and WHY, not HOW.

**Input**: `$ARGUMENTS` — feature idea, problem description, or path to research artifact.

---

## Phase 1: UNDERSTAND — Define the Problem

Parse `$ARGUMENTS`. If it references a research artifact, read it first.

**Ask yourself (and the user if unclear):**
- What specific problem does this solve?
- Who experiences this problem?
- What evidence exists that this is a real problem?
- What happens if we do nothing?

**CHECKPOINT**: You must be able to state the problem in one sentence before continuing.

---

## Phase 2: EXPLORE — Research Current State

Investigate the codebase to understand what exists today:

1. **Launch an Explore agent** to find code relevant to the feature area
2. **Read CLAUDE.md** for project conventions and constraints
3. **Check existing artifacts** in `.claude/archon/` for related work

Focus on:
- What already exists that's related
- What would need to change
- What constraints exist (dependencies, architecture boundaries)

---

## Phase 3: DRAFT — Write the PRD

Use the template below. Fill every section. Mark unknowns as `TBD — needs research` rather than guessing.

**Critical rules:**
- Start with PROBLEMS, not solutions
- Evidence section must reference actual code (`file:line`) or user reports
- "What We're NOT Building" prevents scope creep — be explicit
- Success metrics must be measurable
- Open questions must be answered before planning begins

---

## Phase 4: REVIEW — Iterate with User

Present the draft PRD to the user. Ask:
- "Does this accurately capture the problem?"
- "Are the non-goals correct?"
- "Any open questions you can answer now?"

Iterate until the user is satisfied.

---

## Phase 5: WRITE — Save Artifact

Save to `.claude/archon/prds/{slug}.prd.md` where `{slug}` is a kebab-case feature name.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# {Feature Name}

## Problem Statement

{What is broken/missing and why it matters. Be specific.}

## Evidence

{Concrete evidence — file paths with line numbers, user reports, metrics, error logs.
Every claim must be verifiable.}

- `{file}:{line}` — {what this shows}
- `{file}:{line}` — {what this shows}

## Proposed Solution

{High-level approach. 3-5 numbered points. NO implementation details —
that's for the plan.}

## Key Hypothesis

{What we believe will be true after shipping this.
How we'll know we're right.}

## What We're NOT Building

{Explicit non-goals. Prevent scope creep. Be specific about what's out of scope
and WHY it's out of scope.}

- **{non-goal}** — {reason}

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| {metric} | {target} | {measurement method} |

## Users & Context

**Who benefits**: {description}
**Current behavior**: {what happens today}
**Desired behavior**: {what should happen}
**Trigger**: {when does the user encounter this}

## Open Questions

{Decisions that need to be made before planning. Mark resolved ones with [x].}

- [ ] {question 1}
- [ ] {question 2}

## Phases (if large)

{Break into numbered phases if scope exceeds what one plan can cover.
Each phase should be independently shippable.}

| Phase | Scope | Dependencies |
|-------|-------|-------------|
| 1 | {minimal viable scope} | None |
| 2 | {extension} | Phase 1 |
```

---

## Phase 6: REPORT — Present and Suggest Next Step

Summarize the PRD in 3-5 bullet points. Link to the artifact.

**Next step**: `/archon-dev plan .claude/archon/prds/{slug}.prd.md`
