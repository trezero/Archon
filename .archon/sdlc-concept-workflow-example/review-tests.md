---
description: Senior QA review of all tests before final approval
argument-hint: <sdlc-feature-dir>
---

<objective>
Senior QA review of all tests in `$ARGUMENTS`.

**Dual-Agent Pattern**:
- Agent 1 (Senior QA): Reviews test quality and coverage
- Agent 2 (Security Auditor): Reviews for security test gaps

**Input**: `.agents/sdlc/{feature}/` (directory with unit-tests.md and integration-tests.md)
**Output**: `.agents/sdlc/{feature}/tests-reviewed.md`

**Previous Commands**: `sdlc:unit-tests`, `sdlc:integration-tests`
**Next Command**: `sdlc:final-review`
</objective>

<context>
Unit tests: @$ARGUMENTS/unit-tests.md
Integration tests: @$ARGUMENTS/integration-tests.md
Implementation: @$ARGUMENTS/impl.md
</context>

<process>

## Phase 1: LOAD - Gather Test Artifacts

**Load all test summaries:**
- Unit test summary
- Integration test summary
- Implementation log

**Identify all test files created.**

---

## Phase 2: REVIEW - Agent 1 (Senior QA)

**Use Task tool to launch Senior QA agent:**

```
You are a SENIOR QA ENGINEER. Review all tests for this feature.

UNIT_TESTS: {summary}
INTEGRATION_TESTS: {summary}
IMPLEMENTATION: {what was built}

REVIEW FOR:

1. TEST_COVERAGE
   - All code paths tested?
   - Critical functionality covered?
   - Edge cases addressed?
   - Coverage percentage adequate (80%+)?
   Rate: EXCELLENT | ADEQUATE | INSUFFICIENT

2. TEST_QUALITY
   - Tests are meaningful (not just exist)?
   - Assertions are correct?
   - Tests would catch real bugs?
   Rate: HIGH | MEDIUM | LOW

3. TEST_MAINTAINABILITY
   - Tests are readable?
   - DRY principles followed?
   - Easy to update?
   Rate: HIGH | MEDIUM | LOW

4. TEST_RELIABILITY
   - Any flaky tests?
   - Tests isolated properly?
   - Deterministic?
   Rate: HIGH | MEDIUM | LOW

5. MISSING_TESTS
   - Critical gaps in coverage?
   - Untested scenarios?
   List: [specific missing tests]

6. TEST_STRATEGY
   - Right balance of unit vs integration?
   - Test pyramid followed?
   - Appropriate use of mocks?
   Assessment: SOUND | NEEDS_ADJUSTMENT

RETURN:
- Verdict: APPROVED | NEEDS_WORK | REJECTED
- Issues: [prioritized list]
- Recommendations: [improvements]
```

---

## Phase 3: REVIEW - Agent 2 (Security Auditor)

**Use Task tool to launch Security Auditor agent:**

```
You are a SECURITY AUDITOR. Review tests for security coverage.

TESTS: {all test summaries}
IMPLEMENTATION: {what was built}

CHECK FOR:

1. AUTH_TESTING
   - Authentication tested?
   - Authorization tested?
   - Token handling tested?

2. INPUT_VALIDATION_TESTS
   - SQL injection prevention tested?
   - XSS prevention tested?
   - Input sanitization tested?

3. ERROR_HANDLING_TESTS
   - Sensitive data not leaked in errors?
   - Error messages don't reveal internals?
   - Proper error codes returned?

4. DATA_PROTECTION_TESTS
   - PII handling tested?
   - Encryption verified?
   - Data leakage prevented?

5. ACCESS_CONTROL_TESTS
   - Role-based access tested?
   - Resource ownership tested?
   - Privilege escalation prevented?

RETURN:
- Security Test Coverage: COMPLETE | PARTIAL | MISSING
- Gaps: [list of untested security scenarios]
- Risk Level: LOW | MEDIUM | HIGH | CRITICAL
```

---

## Phase 4: SYNTHESIZE - Create Review Report

```markdown
# Test Review: {Feature Name}

## Summary
- **Reviewed**: {timestamp}
- **Status**: APPROVED | NEEDS_WORK | REJECTED

## Overall Assessment

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Coverage | {rating} | |
| Quality | {rating} | |
| Maintainability | {rating} | |
| Reliability | {rating} | |
| Security | {rating} | |

## Senior QA Review

### Verdict: {APPROVED | NEEDS_WORK | REJECTED}

### Coverage Analysis
{Detailed coverage breakdown}

### Quality Assessment
{Quality findings}

### Issues Found
| Priority | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| HIGH | ... | ... | ... |

### Positive Notes
{What's done well}

## Security Audit

### Coverage: {COMPLETE | PARTIAL | MISSING}

### Security Tests Present
- [ ] Authentication
- [ ] Authorization
- [ ] Input validation
- [ ] Error handling
- [ ] Data protection

### Security Gaps
| Gap | Risk | Recommendation |
|-----|------|----------------|
| ... | ... | ... |

### Risk Level: {LOW | MEDIUM | HIGH | CRITICAL}

## Required Actions

### Must Fix (Before Approval)
1. {Critical issue}
2. {High priority issue}

### Should Fix (Recommended)
1. {Medium priority issue}
2. {Improvement suggestion}

### Consider (Optional)
1. {Nice to have}

## Test Execution Summary

### Unit Tests
- Total: {count}
- Passing: {count}
- Coverage: {%}

### Integration Tests
- Total: {count}
- Passing: {count}
- Duration: {s}

## Approval Status

| Reviewer | Verdict | Conditions |
|----------|---------|------------|
| Senior QA | {verdict} | {conditions} |
| Security | {verdict} | {conditions} |

**Final Status**: {APPROVED | NEEDS_WORK | REJECTED}

## Next Step

If APPROVED:
  `/sdlc:final-review .agents/sdlc/{feature}/`

If NEEDS_WORK:
  1. Address issues above
  2. Re-run tests
  3. Re-run: `/sdlc:review-tests .agents/sdlc/{feature}/`
```

**Save to**: `.agents/sdlc/{feature}/tests-reviewed.md`

</process>

<output>
**OUTPUT_FILE**: `.agents/sdlc/{feature}/tests-reviewed.md`

**REPORT_TO_USER**:
```markdown
## Test Review Complete

**File**: `.agents/sdlc/{feature}/tests-reviewed.md`

**Status**: {APPROVED | NEEDS_WORK | REJECTED}

**Senior QA**: {verdict}
**Security**: {risk level}

**Issues**:
- Must Fix: {count}
- Should Fix: {count}

**Next Step**:
{Based on status}
```
</output>

<verification>
**Before completing:**
- [ ] Senior QA agent reviewed
- [ ] Security Auditor agent reviewed
- [ ] All issues documented with priority
- [ ] Required actions listed
- [ ] Final status determined
</verification>

<success_criteria>
**DUAL_AGENT**: QA and Security both reviewed
**THOROUGH**: Coverage, quality, security all assessed
**ACTIONABLE**: Issues have clear remediation
**SECURITY_AWARE**: Security gaps identified
</success_criteria>
