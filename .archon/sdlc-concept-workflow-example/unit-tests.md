---
description: Create unit tests for implemented feature
argument-hint: <impl-log-path>
---

<objective>
Create comprehensive unit tests for the implementation documented at `$ARGUMENTS`.

**Dual-Agent Pattern**:
- Agent 1 (Tester): Writes unit tests
- Agent 2 (Critic): Reviews tests for coverage and quality

**Input**: `.agents/sdlc/{feature}/impl.md`
**Output**: Test files + `.agents/sdlc/{feature}/unit-tests.md`

**Previous Command**: `sdlc:implement`
**Next Command**: `sdlc:review-tests`

**Can run parallel with**: `sdlc:integration-tests`, `sdlc:document`
</objective>

<context>
Implementation log: @$ARGUMENTS
Test patterns: !`ls src/features/*/tests/*.test.ts 2>/dev/null | head -5`
Project conventions: @CLAUDE.md
</context>

<process>

## Phase 1: PARSE - Analyze Implementation

**Read implementation log and extract:**
- Files created
- Files modified
- Functions/classes to test
- Edge cases from plan

**Identify test locations:**
```
For: src/features/x/service.ts
Test: src/features/x/tests/service.test.ts
```

---

## Phase 2: EXPLORE - Find Test Patterns

**Use Task tool with subagent_type="Explore":**

```
Find unit test patterns in this codebase.

DISCOVER:
1. Test file naming convention
2. Test structure (describe/it blocks)
3. Mocking patterns used
4. Assertion styles
5. Setup/teardown patterns
6. Coverage requirements

Return actual test snippets as examples.
```

---

## Phase 3: CREATE - Agent 1 (Tester)

**For each file that needs tests:**

**Use Task tool to launch Tester agent:**

```
You are the TESTER agent. Create comprehensive unit tests.

FILE TO TEST: {path}
CODE: {file contents}
PATTERN TO FOLLOW: {test pattern from Explore}

CREATE TESTS FOR:

1. HAPPY_PATH
   - Normal operation
   - Expected inputs → expected outputs

2. ERROR_CASES
   - Invalid inputs
   - Edge cases
   - Boundary conditions

3. EDGE_CASES
   - Empty inputs
   - Null/undefined
   - Maximum values
   - Concurrent calls

4. MOCKING
   - External dependencies
   - Database calls
   - API calls

REQUIREMENTS:
- Follow existing test patterns exactly
- Use project's test framework (bun:test)
- Mock external dependencies
- Test public interface only
- Aim for 80%+ coverage

RETURN:
- Test file content
- Test cases: [list with descriptions]
- Coverage estimate: [%]
```

**Write test files.**

---

## Phase 4: VALIDATE - Agent 2 (Critic)

**Use Task tool to launch Critic agent:**

```
You are the CRITIC agent. Review these unit tests.

TESTS: {test file contents}
SOURCE: {source file being tested}

EVALUATE:

1. COVERAGE
   - All public functions tested?
   - All code paths covered?
   - Edge cases included?
   Rate: COMPLETE | PARTIAL | INSUFFICIENT

2. QUALITY
   - Tests are independent?
   - Tests are deterministic?
   - Assertions are meaningful?
   Rate: HIGH | MEDIUM | LOW

3. MAINTAINABILITY
   - Test names are descriptive?
   - Arrange-Act-Assert structure?
   - DRY (shared setup)?
   Rate: HIGH | MEDIUM | LOW

4. EFFECTIVENESS
   - Would catch real bugs?
   - Tests the right things?
   - Not testing implementation details?
   Rate: HIGH | MEDIUM | LOW

5. MISSING_TESTS
   - List specific tests that should exist but don't

RETURN:
- Verdict: PASS | NEEDS_MORE | INADEQUATE
- Issues: [list]
- Suggested additions: [list]
```

**If NEEDS_MORE**: Iterate with Tester to add missing tests.

---

## Phase 5: EXECUTE - Run Tests

**Run the tests:**

```bash
bun test src/features/{feature}/tests/
```

**Check coverage:**

```bash
bun test --coverage src/features/{feature}/tests/
```

**Capture results.**

---

## Phase 6: REPORT - Create Test Summary

```markdown
# Unit Tests: {Feature Name}

## Summary
- **Created**: {timestamp}
- **Status**: PASS | FAIL | PARTIAL
- **Coverage**: {X}%

## Test Files Created

| File | Tests | Passing | Coverage |
|------|-------|---------|----------|
| `tests/service.test.ts` | 15 | 15 | 92% |
| `tests/schemas.test.ts` | 8 | 8 | 100% |

## Test Cases

### {File 1}

| Test Case | Description | Status |
|-----------|-------------|--------|
| `creates item successfully` | Happy path creation | PASS |
| `throws on invalid input` | Error handling | PASS |
| `handles empty string` | Edge case | PASS |

### {File 2}
...

## Coverage Report

| File | Lines | Branches | Functions |
|------|-------|----------|-----------|
| `service.ts` | 92% | 85% | 100% |
| `schemas.ts` | 100% | 100% | 100% |

## Critic Review

### Verdict: {PASS | NEEDS_MORE | INADEQUATE}

### Quality Ratings
- Coverage: {rating}
- Quality: {rating}
- Maintainability: {rating}
- Effectiveness: {rating}

### Issues Found
{list or "None"}

### Suggested Improvements
{list or "None"}

## Test Execution Output

```
{bun test output}
```

## Next Step

After integration tests complete:
  `/sdlc:review-tests .agents/sdlc/{feature}/`
```

**Save to**: `.agents/sdlc/{feature}/unit-tests.md`

</process>

<output>
**OUTPUT_FILES**:
- Test files in `src/features/{feature}/tests/`
- Summary: `.agents/sdlc/{feature}/unit-tests.md`

**REPORT_TO_USER**:
```markdown
## Unit Tests Created

**Summary**: `.agents/sdlc/{feature}/unit-tests.md`

**Status**: {PASS | FAIL | PARTIAL}

**Tests**:
- Files: {count}
- Cases: {count}
- Passing: {count}

**Coverage**: {X}%

**Next Step**: After `integration-tests` completes:
  `/sdlc:review-tests .agents/sdlc/{feature}/`
```
</output>

<verification>
**Before completing:**
- [ ] All source files have test files
- [ ] Tester agent created tests
- [ ] Critic agent reviewed tests
- [ ] All tests executed
- [ ] Coverage meets 80%+ threshold
- [ ] Test summary created
</verification>

<success_criteria>
**DUAL_AGENT**: Tester and Critic both ran
**COVERAGE**: 80%+ line coverage achieved
**PASSING**: All tests pass
**QUALITY**: Critic approved test quality
</success_criteria>
