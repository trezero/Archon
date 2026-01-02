---
description: Execute implementation plan with validation after each task
argument-hint: <reviewed-plan-path>
---

<objective>
Execute the approved implementation plan at `$ARGUMENTS`.

**Dual-Agent Pattern**:
- Agent 1 (Implementer): Executes each task
- Agent 2 (Validator): Validates each task immediately after

**Execution Model**: Task → Validate → Next Task (iterative)

**Input**: `.agents/sdlc/{feature}/plan-reviewed.md`
**Output**: Source files + `.agents/sdlc/{feature}/impl.md`

**Previous Command**: `sdlc:review-plan`
**Next Commands**: `sdlc:unit-tests`, `sdlc:integration-tests`, `sdlc:document` (parallel)
</objective>

<context>
Reviewed plan: @$ARGUMENTS
Project conventions: @CLAUDE.md
Current files: !`git status --short`
</context>

<process>

## Phase 1: PARSE - Load Approved Plan

**Read the reviewed plan and extract:**
- Task list with order
- Files to create/modify
- Validation commands per task
- Pattern references

**GATE**: If plan status is not APPROVED → STOP:
"Cannot implement. Plan status is {status}. Get approval first."

**Initialize implementation log:**
```markdown
# Implementation Log: {Feature Name}

## Started: {timestamp}
## Plan: {plan path}

## Task Execution

| Task | Status | Duration | Issues |
|------|--------|----------|--------|
```

---

## Phase 2: EXECUTE - Iterate Through Tasks

**For each task in order:**

### Step 2a: Implement (Agent 1)

**Use Task tool to launch Implementer agent:**

```
You are the IMPLEMENTER agent. Execute this task.

TASK: {task details from plan}
- ID: T-xxx
- Action: CREATE | UPDATE
- File: {path}
- Pattern to mirror: {file:lines}
- Details: {implementation instructions}

CONTEXT:
- Project conventions: {from CLAUDE.md}
- Related code: {pattern references}

EXECUTE:
1. Read the pattern file to understand structure
2. Create/modify the target file
3. Follow project conventions exactly
4. Run the validation command

RETURN:
- Files changed: [list]
- Code written: [summary]
- Validation result: PASS | FAIL
- Issues: [if any]
```

**Capture Implementer result.**

### Step 2b: Validate (Agent 2)

**Use Task tool to launch Validator agent:**

```
You are the VALIDATOR agent. Validate the implementation.

TASK: {task details}
IMPLEMENTATION: {what Implementer did}
FILES_CHANGED: {list}

VALIDATE:

1. CODE_CORRECTNESS
   - Does code do what task specified?
   - Any logic errors?
   - Edge cases handled?

2. PATTERN_ADHERENCE
   - Matches the pattern reference?
   - Follows project conventions?
   - Consistent naming?

3. INTEGRATION
   - Imports correct?
   - Exports correct?
   - No broken references?

4. QUALITY
   - Type safety maintained?
   - No linting errors?
   - No obvious bugs?

RUN VALIDATION:
```bash
bun run lint && npx tsc --noEmit
```

RETURN:
- Verdict: PASS | FAIL | NEEDS_FIX
- Issues: [list with specific locations]
- Suggestions: [if NEEDS_FIX]
```

**Capture Validator result.**

### Step 2c: Handle Result

**If PASS**: Log success, proceed to next task.

**If FAIL or NEEDS_FIX**:
1. Pass issues back to Implementer
2. Re-implement
3. Re-validate
4. Max 3 iterations per task

**If still failing after 3 iterations**: Log blocker, continue to next task.

**Update implementation log for each task.**

---

## Phase 3: VERIFY - Full Validation

**After all tasks, run full validation:**

```bash
# Static analysis
bun run lint && npx tsc --noEmit

# Unit tests (existing)
bun test

# Build
bun run build
```

**Check for regressions:**
- All existing tests still pass?
- Build succeeds?
- No new lint errors?

---

## Phase 4: REPORT - Create Implementation Summary

**Create implementation log:**

```markdown
# Implementation Log: {Feature Name}

## Summary
- **Started**: {timestamp}
- **Completed**: {timestamp}
- **Duration**: {total time}
- **Status**: COMPLETE | PARTIAL | BLOCKED

## Tasks Executed

| Task | Status | Attempts | Duration |
|------|--------|----------|----------|
| T-001 | PASS | 1 | 2m |
| T-002 | PASS | 2 | 5m |
| T-003 | BLOCKED | 3 | 10m |

## Files Created

| File | Purpose | Lines |
|------|---------|-------|
| `src/features/x/models.ts` | Types | 45 |

## Files Modified

| File | Changes | Lines Added | Lines Removed |
|------|---------|-------------|---------------|
| `src/core/routes.ts` | Added route | 5 | 0 |

## Validation Results

### Static Analysis
```
bun run lint: {PASS | FAIL}
npx tsc --noEmit: {PASS | FAIL}
```

### Tests
```
bun test: {PASS | FAIL}
Tests: {X passed}, {Y failed}
```

### Build
```
bun run build: {PASS | FAIL}
```

## Issues Encountered

### Resolved
| Task | Issue | Resolution |
|------|-------|------------|
| T-002 | Type error | Fixed import |

### Unresolved (Blockers)
| Task | Issue | Attempted |
|------|-------|-----------|
| T-003 | Cannot resolve X | 3 attempts |

## Code Changes Summary

```diff
{Summary of key changes}
```

## Next Steps

Parallel execution available:
- `/sdlc:unit-tests .agents/sdlc/{feature}/impl.md`
- `/sdlc:integration-tests .agents/sdlc/{feature}/impl.md`
- `/sdlc:document .agents/sdlc/{feature}/impl.md`

Or run sequentially in any order.
```

**Save to**: `.agents/sdlc/{feature}/impl.md`

</process>

<output>
**OUTPUT_FILE**: `.agents/sdlc/{feature}/impl.md`
**SOURCE_FILES**: {list of created/modified files}

**REPORT_TO_USER**:
```markdown
## Implementation Complete

**File**: `.agents/sdlc/{feature}/impl.md`

**Status**: {COMPLETE | PARTIAL | BLOCKED}

**Tasks**:
- Completed: {X}/{Y}
- Blocked: {count}

**Files**:
- Created: {count}
- Modified: {count}

**Validation**:
- Lint: {PASS | FAIL}
- Types: {PASS | FAIL}
- Tests: {PASS | FAIL}
- Build: {PASS | FAIL}

**Next Steps** (can run in parallel):
- `/sdlc:unit-tests .agents/sdlc/{feature}/impl.md`
- `/sdlc:integration-tests .agents/sdlc/{feature}/impl.md`
- `/sdlc:document .agents/sdlc/{feature}/impl.md`
```
</output>

<verification>
**Before completing:**
- [ ] All tasks attempted
- [ ] Each task had implement + validate cycle
- [ ] Failed tasks retried up to 3 times
- [ ] Full validation suite ran
- [ ] Implementation log created
- [ ] Blockers documented
</verification>

<success_criteria>
**DUAL_AGENT**: Each task had Implementer + Validator
**ITERATIVE**: Failed tasks were retried
**VALIDATED**: Full lint/type/test/build ran
**DOCUMENTED**: All changes logged
**TRACEABLE**: Each task outcome recorded
</success_criteria>
