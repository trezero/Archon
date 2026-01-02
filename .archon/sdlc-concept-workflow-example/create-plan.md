---
description: Create implementation plan from validated spec
argument-hint: <validated-spec-path>
---

<objective>
Create a detailed implementation plan from validated spec at `$ARGUMENTS`.

**Dual-Agent Pattern**:
- Agent 1 (Planner): Creates implementation plan with tasks
- Agent 2 (Reviewer): Validates plan against spec and codebase

**Input**: `.agents/sdlc/{feature}/spec-validated.md`
**Output**: `.agents/sdlc/{feature}/plan.md`

**Previous Command**: `sdlc:validate-spec`
**Next Command**: `sdlc:review-plan`
</objective>

<context>
Validated spec: @$ARGUMENTS
Project conventions: @CLAUDE.md
Existing patterns: !`ls src/features/ 2>/dev/null || echo "No features"`
</context>

<process>

## Phase 1: PARSE - Load Validated Spec

**Read the validated spec and extract:**
- Feature name
- Functional requirements (FR-xxx)
- Acceptance criteria
- Dependencies
- Constraints

**Determine output path from input:**
```
Input:  .agents/sdlc/{feature}/spec-validated.md
Output: .agents/sdlc/{feature}/plan.md
```

**GATE**: If spec status is not PASS → STOP and report:
"Cannot create plan. Spec status is {status}. Resolve issues first."

---

## Phase 2: EXPLORE - Codebase Intelligence

**Use Task tool with subagent_type="Explore":**

```
Explore the codebase to find patterns for implementing the feature.

Feature requirements:
{List FR-xxx from spec}

DISCOVER:
1. Similar implementations to mirror
2. File locations where new code should go
3. Existing types, interfaces, utilities to reuse
4. Integration points (routes, providers, exports)
5. Testing patterns to follow
6. Potential conflicts with existing code

Return file:line references for all patterns found.
```

**Capture codebase patterns.**

---

## Phase 3: PLAN - Agent 1 (Planner)

**Use Task tool to launch Planner agent:**

```
You are the PLANNER agent. Create a detailed implementation plan.

CONTEXT:
- Validated spec: {spec summary}
- Requirements: {FR-xxx list}
- Codebase patterns: {from Explore}

CREATE PLAN WITH:

1. ARCHITECTURE_OVERVIEW
   - High-level design
   - Component structure
   - Data flow

2. FILES_TO_CREATE
   For each new file:
   - Path
   - Purpose
   - Key exports
   - Pattern to mirror (file:line)

3. FILES_TO_MODIFY
   For each existing file:
   - Path
   - What to change
   - Why

4. TASK_LIST
   Ordered tasks with:
   - Task ID (T-001, T-002)
   - Description
   - Requirement it satisfies (FR-xxx)
   - Files involved
   - Dependencies (other T-xxx)
   - Validation command
   - Estimated complexity (S/M/L)

5. TESTING_STRATEGY
   - Unit tests needed
   - Integration tests needed
   - Edge cases to cover

6. RISK_ASSESSMENT
   - Technical risks
   - Mitigation strategies

Return complete implementation plan.
```

**Capture Planner output.**

---

## Phase 4: VALIDATE - Agent 2 (Reviewer)

**Use Task tool to launch Reviewer agent:**

```
You are the REVIEWER agent. Validate the implementation plan.

PLAN: {Planner output}
SPEC: {Validated spec}
CODEBASE: {Explore findings}

VERIFY:

1. REQUIREMENT_COVERAGE
   For each FR-xxx in spec:
   - Is there a task that implements it?
   - Is the approach correct?
   Mark: COVERED | MISSING | PARTIAL

2. PATTERN_ADHERENCE
   For each new file:
   - Does it follow codebase patterns?
   - Is the location correct?
   Mark: FOLLOWS_PATTERN | DEVIATES

3. TASK_ORDER
   - Are dependencies correct?
   - Can tasks be executed top-to-bottom?
   Mark: CORRECT | INCORRECT

4. COMPLETENESS
   - Missing tests?
   - Missing error handling?
   - Missing edge cases?
   List gaps.

5. FEASIBILITY
   - Any impossible tasks?
   - Any unclear tasks?
   Rate: FEASIBLE | NEEDS_CLARIFICATION | INFEASIBLE

Return validation report with all findings.
```

**Capture Reviewer output.**

---

## Phase 5: SYNTHESIZE - Create Final Plan

**If Reviewer found issues**: Iterate with Planner to fix.

**Create final plan:**

```markdown
# Implementation Plan: {Feature Name}

## Metadata
- **Source Spec**: {spec path}
- **Created**: {date}
- **Status**: READY | NEEDS_REVIEW
- **Estimated Complexity**: S | M | L | XL

## Architecture Overview

### Design Diagram
```
{ASCII diagram of component structure}
```

### Data Flow
```
{ASCII diagram of data flow}
```

## Requirement Coverage

| Requirement | Task(s) | Status |
|-------------|---------|--------|
| FR-001 | T-001, T-002 | COVERED |
| FR-002 | T-003 | COVERED |

## Files to Create

| Path | Purpose | Pattern Source |
|------|---------|----------------|
| `src/features/x/models.ts` | Types | `src/features/y/models.ts` |

## Files to Modify

| Path | Change | Reason |
|------|--------|--------|
| `src/core/routes.ts` | Add route | New endpoint |

## Task List

### T-001: {Task Name}
- **Implements**: FR-001
- **Action**: CREATE | UPDATE
- **File**: `path/to/file.ts`
- **Dependencies**: None
- **Complexity**: S | M | L

**Details**:
{Specific implementation instructions}

**Validation**:
```bash
npx tsc --noEmit && bun run lint
```

### T-002: {Task Name}
...

## Testing Strategy

### Unit Tests
| Test File | Covers | Priority |
|-----------|--------|----------|
| `tests/x.test.ts` | T-001, T-002 | HIGH |

### Integration Tests
| Test File | Covers | Priority |
|-----------|--------|----------|
| `tests/x.integration.test.ts` | End-to-end flow | HIGH |

### Edge Cases
- [ ] Empty input
- [ ] Invalid input
- [ ] Concurrent access

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| ... | ... | ... | ... |

## Validation Report

{From Reviewer agent}

## Next Step

Run: `/sdlc:review-plan .agents/sdlc/{feature}/plan.md`
```

**Save to**: `.agents/sdlc/{feature}/plan.md`

</process>

<output>
**OUTPUT_FILE**: `.agents/sdlc/{feature}/plan.md`

**REPORT_TO_USER**:
```markdown
## Implementation Plan Created

**File**: `.agents/sdlc/{feature}/plan.md`

**Status**: {READY | NEEDS_REVIEW}

**Coverage**:
- Requirements covered: {X}/{Y}
- Tasks: {count}
- Files to create: {count}
- Files to modify: {count}

**Complexity**: {S | M | L | XL}

**Next Step**: `/sdlc:review-plan .agents/sdlc/{feature}/plan.md`
```
</output>

<verification>
**Before completing:**
- [ ] Codebase explored for patterns
- [ ] Planner agent created task list
- [ ] Reviewer agent validated plan
- [ ] All requirements have tasks
- [ ] Tasks are ordered by dependency
- [ ] Each task has validation command
</verification>

<success_criteria>
**DUAL_AGENT**: Planner and Reviewer both ran
**COVERAGE**: Every FR-xxx has implementing task(s)
**ORDERED**: Tasks can execute top-to-bottom
**VALIDATED**: Reviewer confirmed plan is sound
</success_criteria>
