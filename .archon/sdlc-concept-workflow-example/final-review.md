---
description: Final comprehensive review before marking feature complete
argument-hint: <sdlc-feature-dir>
---

<objective>
Final comprehensive review of the complete feature at `$ARGUMENTS`.

**Dual-Agent Pattern**:
- Agent 1 (Senior): Final code and quality review
- Agent 2 (Auditor): Compliance and completeness audit

**Input**: `.agents/sdlc/{feature}/` (entire SDLC directory)
**Output**: `.agents/sdlc/{feature}/done.md`

**Previous Commands**: All previous SDLC commands
**Next Command**: Feature is COMPLETE - ready for PR
</objective>

<context>
Feature directory: $ARGUMENTS
Spec: @$ARGUMENTS/spec-validated.md
Plan: @$ARGUMENTS/plan-reviewed.md
Implementation: @$ARGUMENTS/impl.md
Tests: !`cat $ARGUMENTS/tests-reviewed.md 2>/dev/null | head -30`
Docs: @$ARGUMENTS/docs.md
</context>

<process>

## Phase 1: GATHER - Collect All Artifacts

**Load all SDLC artifacts:**
```
.agents/sdlc/{feature}/
├── spec-validated.md     ✓ or ✗
├── plan.md               ✓ or ✗
├── plan-reviewed.md      ✓ or ✗
├── impl.md               ✓ or ✗
├── unit-tests.md         ✓ or ✗
├── integration-tests.md  ✓ or ✗
├── tests-reviewed.md     ✓ or ✗
└── docs.md               ✓ or ✗
```

**GATE**: If any required artifact is missing → STOP:
"Cannot complete final review. Missing: {list}"

---

## Phase 2: REVIEW - Agent 1 (Senior Engineer)

**Use Task tool to launch Senior agent:**

```
You are a SENIOR ENGINEER conducting final review.

ARTIFACTS:
- Spec: {summary}
- Plan: {summary}
- Implementation: {summary}
- Tests: {summary}
- Docs: {summary}

FINAL REVIEW CHECKLIST:

1. REQUIREMENT_FULFILLMENT
   For each FR-xxx in spec:
   - Implemented? ✓/✗
   - Tested? ✓/✗
   - Documented? ✓/✗

2. CODE_QUALITY
   - Follows project patterns?
   - No obvious bugs?
   - Maintainable?
   - Performance acceptable?

3. TEST_COVERAGE
   - Critical paths tested?
   - Edge cases covered?
   - Tests pass?

4. DOCUMENTATION
   - Complete?
   - Accurate?
   - Useful?

5. INTEGRATION
   - Works with existing code?
   - No regressions?
   - Clean integration points?

6. READINESS
   - Ready for production?
   - Any concerns?
   - Blocking issues?

RETURN:
- Verdict: APPROVED | NEEDS_WORK | NOT_READY
- Fulfillment: {X}/{Y} requirements met
- Issues: [list]
- Concerns: [list]
```

---

## Phase 3: AUDIT - Agent 2 (Auditor)

**Use Task tool to launch Auditor agent:**

```
You are an AUDITOR verifying process compliance.

ARTIFACTS: {list all artifacts}
PROCESS: SDLC pipeline

AUDIT CHECKLIST:

1. PROCESS_COMPLIANCE
   - All required steps completed?
   - Artifacts in correct order?
   - No steps skipped?

2. ARTIFACT_QUALITY
   For each artifact:
   - Present? ✓/✗
   - Complete? ✓/✗
   - Approved status? ✓/✗

3. VALIDATION_CHAIN
   - Spec validated → Plan created → Plan reviewed → ...
   - Each step properly gated?
   - No bypassed validations?

4. TRACEABILITY
   - Requirements traceable to implementation?
   - Implementation traceable to tests?
   - Changes documented?

5. ACCEPTANCE_CRITERIA
   - All criteria from spec met?
   - Evidence provided?

RETURN:
- Compliance: FULL | PARTIAL | NON_COMPLIANT
- Missing steps: [list]
- Issues: [list]
```

---

## Phase 4: VALIDATE - Run Final Checks

**Execute final validation suite:**

```bash
# Full lint and type check
bun run lint && npx tsc --noEmit

# All tests
bun test

# Build
bun run build
```

**Capture results.**

---

## Phase 5: SYNTHESIZE - Create Completion Report

```markdown
# Feature Complete: {Feature Name}

## Summary
- **Feature**: {name}
- **Started**: {from first artifact}
- **Completed**: {now}
- **Status**: COMPLETE | INCOMPLETE | BLOCKED

## Requirement Fulfillment

| Requirement | Implemented | Tested | Documented |
|-------------|-------------|--------|------------|
| FR-001 | ✓ | ✓ | ✓ |
| FR-002 | ✓ | ✓ | ✓ |

**Coverage**: {X}/{Y} requirements ({%})

## SDLC Process Audit

| Step | Artifact | Status | Approved |
|------|----------|--------|----------|
| Validate Spec | spec-validated.md | ✓ | PASS |
| Create Plan | plan.md | ✓ | - |
| Review Plan | plan-reviewed.md | ✓ | APPROVED |
| Implement | impl.md | ✓ | COMPLETE |
| Unit Tests | unit-tests.md | ✓ | PASS |
| Integration Tests | integration-tests.md | ✓ | PASS |
| Review Tests | tests-reviewed.md | ✓ | APPROVED |
| Document | docs.md | ✓ | COMPLETE |

**Process Compliance**: {FULL | PARTIAL}

## Final Validation

### Code Quality
```
bun run lint: {PASS | FAIL}
npx tsc --noEmit: {PASS | FAIL}
```

### Tests
```
bun test: {PASS | FAIL}
Unit: {X} passed, {Y} failed
Integration: {X} passed, {Y} failed
Coverage: {%}
```

### Build
```
bun run build: {PASS | FAIL}
```

## Senior Review

### Verdict: {APPROVED | NEEDS_WORK | NOT_READY}

### Assessment
{Senior's overall assessment}

### Concerns
{Any concerns raised}

## Auditor Review

### Compliance: {FULL | PARTIAL | NON_COMPLIANT}

### Findings
{Audit findings}

## Files Changed

### Created
| File | Lines | Purpose |
|------|-------|---------|
| ... | ... | ... |

### Modified
| File | +/- | Purpose |
|------|-----|---------|
| ... | ... | ... |

## Outstanding Items

### Must Address
{Critical items if any}

### Should Address
{Recommended items if any}

### Consider Later
{Nice-to-haves}

## Metrics

| Metric | Value |
|--------|-------|
| Requirements | {X}/{Y} |
| Test Coverage | {%} |
| Files Created | {count} |
| Files Modified | {count} |
| Lines Added | {count} |
| Duration | {time} |

## Approval

| Reviewer | Verdict |
|----------|---------|
| Senior Engineer | {verdict} |
| Auditor | {verdict} |
| **Final** | {APPROVED | NOT_APPROVED} |

## Next Steps

If APPROVED:
  Feature is complete. Ready to:
  1. Create PR: `/create-pr`
  2. Or commit directly: `/commit`

If NOT APPROVED:
  Address outstanding items and re-run:
  `/sdlc:final-review .agents/sdlc/{feature}/`
```

**Save to**: `.agents/sdlc/{feature}/done.md`

</process>

<output>
**OUTPUT_FILE**: `.agents/sdlc/{feature}/done.md`

**REPORT_TO_USER**:
```markdown
## SDLC Complete

**File**: `.agents/sdlc/{feature}/done.md`

**Status**: {COMPLETE | INCOMPLETE | BLOCKED}

**Requirements**: {X}/{Y} fulfilled ({%})

**Final Verdict**:
- Senior: {verdict}
- Auditor: {compliance}
- Overall: {APPROVED | NOT_APPROVED}

**Validation**:
- Lint: {PASS | FAIL}
- Types: {PASS | FAIL}
- Tests: {X passed}
- Build: {PASS | FAIL}

**Next Step**:
{If APPROVED}: `/create-pr` or `/commit`
{If not}: Address issues and re-run final review
```
</output>

<verification>
**Before completing:**
- [ ] All artifacts present
- [ ] Senior reviewed
- [ ] Auditor verified compliance
- [ ] Final validation passed
- [ ] All requirements fulfilled
- [ ] Completion report created
</verification>

<success_criteria>
**DUAL_AGENT**: Senior and Auditor both reviewed
**COMPLETE**: All requirements implemented, tested, documented
**COMPLIANT**: Full SDLC process followed
**VALIDATED**: All checks pass
**APPROVED**: Ready for production
</success_criteria>
