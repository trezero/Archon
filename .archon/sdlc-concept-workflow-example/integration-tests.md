---
description: Create integration tests for implemented feature
argument-hint: <impl-log-path>
---

<objective>
Create integration tests for the implementation documented at `$ARGUMENTS`.

**Dual-Agent Pattern**:
- Agent 1 (Tester): Writes integration tests
- Agent 2 (Critic): Reviews tests for coverage and realism

**Input**: `.agents/sdlc/{feature}/impl.md`
**Output**: Test files + `.agents/sdlc/{feature}/integration-tests.md`

**Previous Command**: `sdlc:implement`
**Next Command**: `sdlc:review-tests`

**Can run parallel with**: `sdlc:unit-tests`, `sdlc:document`
</objective>

<context>
Implementation log: @$ARGUMENTS
Integration test patterns: !`ls tests/*.integration.test.ts 2>/dev/null || ls tests/*.e2e.test.ts 2>/dev/null || echo "None found"`
Project conventions: @CLAUDE.md
</context>

<process>

## Phase 1: PARSE - Analyze Implementation

**Read implementation log and identify:**
- Feature entry points (APIs, routes, services)
- External dependencies (database, APIs, queues)
- Integration boundaries
- User flows to test

---

## Phase 2: EXPLORE - Find Integration Patterns

**Use Task tool with subagent_type="Explore":**

```
Find integration test patterns in this codebase.

DISCOVER:
1. Integration test file locations
2. Test database/service setup patterns
3. Fixture and seed data patterns
4. API testing patterns (if applicable)
5. Cleanup/teardown patterns
6. Test isolation strategies

Return actual test snippets as examples.
```

---

## Phase 3: CREATE - Agent 1 (Tester)

**Use Task tool to launch Tester agent:**

```
You are the INTEGRATION TESTER. Create end-to-end tests for feature flows.

FEATURE: {feature name}
IMPLEMENTATION: {summary of what was built}
ENTRY POINTS: {APIs, routes, services}

CREATE INTEGRATION TESTS FOR:

1. HAPPY_PATH_FLOWS
   - Complete user journeys
   - Expected data flows end-to-end
   - Success scenarios

2. ERROR_FLOWS
   - Invalid input handling
   - Missing dependencies
   - Permission failures

3. EDGE_CASES
   - Concurrent operations
   - Large data sets
   - Timeout scenarios

4. INTEGRATION_POINTS
   - Database operations work correctly
   - External API calls handled
   - Event/message handling

TEST STRUCTURE:
- Setup: Create test data, configure mocks
- Execute: Run the full flow
- Assert: Verify outcomes
- Cleanup: Remove test data

REQUIREMENTS:
- Test real integration, not mocks where possible
- Use test database/sandbox
- Ensure test isolation
- Cover critical user paths

RETURN:
- Test file content
- Flows tested: [list]
- Dependencies: [what needs to be running]
```

**Write integration test files.**

---

## Phase 4: VALIDATE - Agent 2 (Critic)

**Use Task tool to launch Critic agent:**

```
You are the CRITIC. Review these integration tests.

TESTS: {test file contents}
FEATURE: {what was implemented}

EVALUATE:

1. REALISM
   - Tests real scenarios users would encounter?
   - Uses realistic data?
   - Tests actual integration, not mocks?
   Rate: HIGH | MEDIUM | LOW

2. COMPLETENESS
   - All critical paths covered?
   - Error paths included?
   - Edge cases considered?
   Rate: COMPLETE | PARTIAL | INSUFFICIENT

3. RELIABILITY
   - Tests deterministic?
   - No flaky tests?
   - Proper isolation?
   Rate: HIGH | MEDIUM | LOW

4. MAINTAINABILITY
   - Clear test names?
   - Good documentation?
   - Reusable fixtures?
   Rate: HIGH | MEDIUM | LOW

5. MISSING_FLOWS
   - List critical flows not tested

RETURN:
- Verdict: PASS | NEEDS_MORE | INADEQUATE
- Issues: [list]
- Missing flows: [list]
```

**If NEEDS_MORE**: Iterate with Tester.

---

## Phase 5: EXECUTE - Run Integration Tests

**Run the integration tests:**

```bash
bun test tests/integration/ --timeout 30000
```

**Capture results.**

---

## Phase 6: REPORT - Create Test Summary

```markdown
# Integration Tests: {Feature Name}

## Summary
- **Created**: {timestamp}
- **Status**: PASS | FAIL | PARTIAL
- **Flows Tested**: {count}

## Test Files Created

| File | Tests | Passing | Duration |
|------|-------|---------|----------|
| `tests/integration/feature.test.ts` | 8 | 8 | 5.2s |

## Flows Tested

### Happy Path Flows

| Flow | Description | Status |
|------|-------------|--------|
| Create → Read | Full CRUD cycle | PASS |
| Auth → Action | Authenticated operation | PASS |

### Error Flows

| Flow | Description | Status |
|------|-------------|--------|
| Invalid input | Rejects bad data | PASS |
| Unauthorized | Denies access | PASS |

### Edge Cases

| Case | Description | Status |
|------|-------------|--------|
| Concurrent ops | Handles race conditions | PASS |

## Dependencies

| Dependency | Required | Notes |
|------------|----------|-------|
| Database | Yes | Test database needed |
| Redis | No | Mocked |

## Critic Review

### Verdict: {PASS | NEEDS_MORE | INADEQUATE}

### Ratings
- Realism: {rating}
- Completeness: {rating}
- Reliability: {rating}
- Maintainability: {rating}

### Issues Found
{list or "None"}

## Test Execution Output

```
{test output}
```

## Next Step

After unit tests complete:
  `/sdlc:review-tests .agents/sdlc/{feature}/`
```

**Save to**: `.agents/sdlc/{feature}/integration-tests.md`

</process>

<output>
**OUTPUT_FILES**:
- Test files in `tests/integration/`
- Summary: `.agents/sdlc/{feature}/integration-tests.md`

**REPORT_TO_USER**:
```markdown
## Integration Tests Created

**Summary**: `.agents/sdlc/{feature}/integration-tests.md`

**Status**: {PASS | FAIL | PARTIAL}

**Tests**:
- Flows: {count}
- Passing: {count}
- Duration: {Xs}

**Next Step**: After `unit-tests` completes:
  `/sdlc:review-tests .agents/sdlc/{feature}/`
```
</output>

<verification>
**Before completing:**
- [ ] Critical user flows tested
- [ ] Tester agent created tests
- [ ] Critic agent reviewed tests
- [ ] All tests executed
- [ ] Tests are reliable (not flaky)
</verification>

<success_criteria>
**DUAL_AGENT**: Tester and Critic both ran
**REALISTIC**: Tests actual integration, not just mocks
**PASSING**: All tests pass reliably
**COMPLETE**: Critical flows covered
</success_criteria>
