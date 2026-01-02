---
description: Senior architect review of implementation plan before execution
argument-hint: <plan-path>
---

<objective>
Senior review of implementation plan at `$ARGUMENTS` before proceeding to implementation.

**Dual-Agent Pattern**:
- Agent 1 (Senior): Reviews from experienced developer perspective
- Agent 2 (Architect): Reviews from system architecture perspective

**Input**: `.agents/sdlc/{feature}/plan.md`
**Output**: `.agents/sdlc/{feature}/plan-reviewed.md`

**Previous Command**: `sdlc:create-plan`
**Next Command**: `sdlc:implement`
</objective>

<context>
Plan: @$ARGUMENTS
Project conventions: @CLAUDE.md
Architecture: !`ls -la src/`
</context>

<process>

## Phase 1: PARSE - Load Plan

**Read the plan and extract:**
- Feature name
- Task list
- Files to create/modify
- Testing strategy
- Risks

**Locate original spec:**
```
Plan:  .agents/sdlc/{feature}/plan.md
Spec:  .agents/sdlc/{feature}/spec-validated.md
```

---

## Phase 2: REVIEW - Agent 1 (Senior Developer)

**Use Task tool to launch Senior agent:**

```
You are a SENIOR DEVELOPER with 10+ years experience. Review this plan.

PLAN: {plan content}

REVIEW FROM DEVELOPER PERSPECTIVE:

1. CODE_QUALITY
   - Will this produce maintainable code?
   - Are there simpler approaches?
   - Is there unnecessary complexity?

2. IMPLEMENTATION_CLARITY
   - Are tasks clear enough to implement?
   - Any ambiguous instructions?
   - Missing implementation details?

3. TESTING_ADEQUACY
   - Are critical paths tested?
   - Edge cases covered?
   - Test strategy realistic?

4. PATTERN_ADHERENCE
   - Does plan follow project patterns?
   - Any anti-patterns introduced?
   - Consistent with CLAUDE.md?

5. DEVELOPER_EXPERIENCE
   - Is this pleasant to implement?
   - Any tedious or error-prone steps?
   - Opportunities for automation?

For each issue found:
- Severity: BLOCKER | HIGH | MEDIUM | LOW
- Location: Task ID or section
- Problem: What's wrong
- Suggestion: How to fix

Return: APPROVED | NEEDS_CHANGES | REJECTED
```

**Capture Senior review.**

---

## Phase 3: REVIEW - Agent 2 (Architect)

**Use Task tool to launch Architect agent:**

```
You are a SYSTEM ARCHITECT. Review this plan for architectural soundness.

PLAN: {plan content}
CODEBASE: {structure overview}

REVIEW FROM ARCHITECTURE PERSPECTIVE:

1. SYSTEM_FIT
   - Does this fit the existing architecture?
   - Any architectural violations?
   - Integration approach sound?

2. SCALABILITY
   - Will this scale with growth?
   - Performance implications?
   - Resource usage concerns?

3. SECURITY
   - Security vulnerabilities introduced?
   - Auth/authz handled correctly?
   - Data exposure risks?

4. MAINTAINABILITY
   - Will future devs understand this?
   - Documentation sufficient?
   - Follows separation of concerns?

5. DEPENDENCIES
   - Dependency management sound?
   - Version compatibility checked?
   - Avoiding unnecessary coupling?

6. FAILURE_MODES
   - Error handling adequate?
   - Recovery strategies defined?
   - Graceful degradation planned?

For each issue found:
- Severity: BLOCKER | HIGH | MEDIUM | LOW
- Category: ARCHITECTURE | SECURITY | PERFORMANCE | MAINTENANCE
- Problem: What's wrong
- Suggestion: How to fix

Return: APPROVED | NEEDS_CHANGES | REJECTED
```

**Capture Architect review.**

---

## Phase 4: SYNTHESIZE - Create Review Report

**Determine final status:**
- If either agent says REJECTED → REJECTED
- If either agent says NEEDS_CHANGES → NEEDS_CHANGES
- If both say APPROVED → APPROVED

**Create reviewed plan:**

```markdown
# Plan Review: {Feature Name}

## Metadata
- **Plan**: {plan path}
- **Reviewed**: {date}
- **Status**: APPROVED | NEEDS_CHANGES | REJECTED

## Review Summary

| Reviewer | Verdict | Issues |
|----------|---------|--------|
| Senior Developer | {verdict} | {count} |
| System Architect | {verdict} | {count} |

## Senior Developer Review

### Verdict: {APPROVED | NEEDS_CHANGES | REJECTED}

### Issues Found

#### Blockers
{list or "None"}

#### High Priority
{list or "None"}

#### Medium Priority
{list or "None"}

#### Low Priority
{list or "None"}

### Positive Notes
{What's good about the plan}

## System Architect Review

### Verdict: {APPROVED | NEEDS_CHANGES | REJECTED}

### Issues Found

#### Blockers
{list or "None"}

#### High Priority
{list or "None"}

#### Medium Priority
{list or "None"}

#### Low Priority
{list or "None"}

### Positive Notes
{What's good about the plan}

## Required Changes

{If NEEDS_CHANGES, list specific changes required before approval}

| Issue | Task/Section | Required Change |
|-------|--------------|-----------------|
| ... | ... | ... |

## Approval Checklist

- [ ] All blockers resolved
- [ ] High priority issues addressed
- [ ] Architecture concerns mitigated
- [ ] Security review passed
- [ ] Ready for implementation

## Original Plan

{Include or reference the original plan}

## Next Step

If APPROVED:
  Run: `/sdlc:implement .agents/sdlc/{feature}/plan-reviewed.md`

If NEEDS_CHANGES:
  1. Address issues listed above
  2. Update plan.md
  3. Re-run: `/sdlc:review-plan .agents/sdlc/{feature}/plan.md`

If REJECTED:
  Return to spec phase and reconsider approach.
```

**Save to**: `.agents/sdlc/{feature}/plan-reviewed.md`

</process>

<output>
**OUTPUT_FILE**: `.agents/sdlc/{feature}/plan-reviewed.md`

**REPORT_TO_USER**:
```markdown
## Plan Review Complete

**File**: `.agents/sdlc/{feature}/plan-reviewed.md`

**Status**: {APPROVED | NEEDS_CHANGES | REJECTED}

**Senior Developer**: {APPROVED | NEEDS_CHANGES | REJECTED}
**System Architect**: {APPROVED | NEEDS_CHANGES | REJECTED}

**Issues Found**:
- Blockers: {count}
- High: {count}
- Medium: {count}
- Low: {count}

**Next Step**:
{Based on status}
```
</output>

<verification>
**Before completing:**
- [ ] Senior Developer agent reviewed
- [ ] System Architect agent reviewed
- [ ] All issues documented with severity
- [ ] Final status correctly determined
- [ ] Required changes listed if NEEDS_CHANGES
- [ ] Next step clearly stated
</verification>

<success_criteria>
**DUAL_AGENT**: Both Senior and Architect reviewed
**THOROUGH**: Multiple dimensions checked (quality, architecture, security)
**ACTIONABLE**: Issues have clear remediation paths
**DECISIVE**: Clear APPROVED/NEEDS_CHANGES/REJECTED verdict
</success_criteria>
