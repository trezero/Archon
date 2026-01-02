---
description: Validate spec/requirements document for completeness and clarity
argument-hint: <spec-file-path>
---

<objective>
Validate the specification at `$ARGUMENTS` for implementation readiness.

**Dual-Agent Pattern**:
- Agent 1 (Analyzer): Extracts and structures requirements
- Agent 2 (Critic): Identifies gaps, ambiguities, and risks

**Output**: `.agents/sdlc/{feature-name}/spec-validated.md`

**Next Command**: `sdlc:create-plan`
</objective>

<context>
Spec file: @$ARGUMENTS
Project conventions: @CLAUDE.md
</context>

<process>

## Phase 1: PARSE - Extract Feature Identity

**Read the spec file and extract:**
- Feature name (kebab-case for directory naming)
- Feature type: NEW_CAPABILITY | ENHANCEMENT | REFACTOR | BUG_FIX
- Affected systems

**Create output directory:**
```bash
mkdir -p .agents/sdlc/{feature-name}
```

**PHASE_1_CHECKPOINT:**
- [ ] Feature name extracted
- [ ] Output directory created

---

## Phase 2: ANALYZE - Agent 1 (Analyzer)

**Use Task tool to launch Analyzer agent:**

```
You are the ANALYZER agent. Your job is to extract and structure requirements.

Read the spec file and extract:

1. USER_STORIES
   - Who is the user?
   - What do they want?
   - Why do they want it?

2. FUNCTIONAL_REQUIREMENTS
   - What must the system DO?
   - List each requirement with ID (FR-001, FR-002, etc.)

3. NON_FUNCTIONAL_REQUIREMENTS
   - Performance expectations
   - Security requirements
   - Scalability needs

4. ACCEPTANCE_CRITERIA
   - How do we know it's done?
   - Testable conditions

5. DEPENDENCIES
   - External systems
   - Libraries needed
   - Other features required

6. CONSTRAINTS
   - Technical limitations
   - Time constraints
   - Resource constraints

Return structured output with all sections populated.
```

**Capture Analyzer output.**

---

## Phase 3: VALIDATE - Agent 2 (Critic)

**Use Task tool to launch Critic agent:**

```
You are the CRITIC agent. Your job is to find problems with the spec.

Review the spec and identify:

1. AMBIGUITIES
   - Vague language ("should be fast", "user-friendly")
   - Missing specifics (what exactly?)
   - Multiple interpretations possible

2. GAPS
   - Missing requirements (auth? error handling? edge cases?)
   - Undefined behaviors
   - Missing acceptance criteria

3. CONFLICTS
   - Contradictory requirements
   - Impossible constraints
   - Incompatible dependencies

4. RISKS
   - Technical risks (can this be built?)
   - Integration risks (will it work with existing code?)
   - Scope risks (is this too big?)

5. MISSING_CONTEXT
   - Needs codebase exploration to answer?
   - Needs external research?
   - Needs stakeholder clarification?

Rate each issue: BLOCKER | HIGH | MEDIUM | LOW

Return structured list of all issues found.
```

**Capture Critic output.**

---

## Phase 4: SYNTHESIZE - Merge and Score

**Combine both agent outputs into validated spec:**

```markdown
# Validated Spec: {Feature Name}

## Metadata
- **Source**: {original spec path}
- **Feature Name**: {kebab-case}
- **Type**: {type}
- **Validation Date**: {date}
- **Status**: PASS | NEEDS_CLARIFICATION | BLOCKED

## Summary
{One paragraph summary of the feature}

## User Stories
{From Analyzer}

## Functional Requirements
| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-001 | ... | HIGH | Clear |
| FR-002 | ... | MEDIUM | Ambiguous |

## Non-Functional Requirements
{From Analyzer}

## Acceptance Criteria
{From Analyzer}

## Dependencies
{From Analyzer}

## Issues Found

### Blockers
{From Critic - must resolve before proceeding}

### High Priority
{From Critic}

### Medium Priority
{From Critic}

### Low Priority
{From Critic}

## Validation Score

| Dimension | Score (1-10) | Notes |
|-----------|--------------|-------|
| Completeness | | |
| Clarity | | |
| Feasibility | | |
| Testability | | |
| **Overall** | | |

## Resolution Required
{List of questions that need answers before proceeding}

## Next Step
If Status = PASS:
  Run: `/sdlc:create-plan .agents/sdlc/{feature}/spec-validated.md`

If Status = NEEDS_CLARIFICATION:
  Resolve issues above, then re-run: `/sdlc:validate-spec {original-spec}`

If Status = BLOCKED:
  Cannot proceed until blockers resolved.
```

**Save to**: `.agents/sdlc/{feature-name}/spec-validated.md`

</process>

<output>
**OUTPUT_FILE**: `.agents/sdlc/{feature-name}/spec-validated.md`

**REPORT_TO_USER**:
```markdown
## Spec Validation Complete

**File**: `.agents/sdlc/{feature-name}/spec-validated.md`

**Status**: {PASS | NEEDS_CLARIFICATION | BLOCKED}

**Validation Score**: {X}/10

**Issues Found**:
- Blockers: {count}
- High: {count}
- Medium: {count}
- Low: {count}

**Next Step**:
{If PASS}: `/sdlc:create-plan .agents/sdlc/{feature}/spec-validated.md`
{If not}: Resolve issues and re-validate
```
</output>

<verification>
**Before completing:**
- [ ] Both agents (Analyzer + Critic) ran
- [ ] All requirements extracted and structured
- [ ] All issues identified and rated
- [ ] Validation score calculated
- [ ] Status correctly assigned
- [ ] Next step clearly stated
</verification>

<success_criteria>
**DUAL_AGENT**: Both Analyzer and Critic agents ran
**STRUCTURED**: Requirements are ID'd and categorized
**ISSUES_FOUND**: Ambiguities and gaps identified
**ACTIONABLE**: Clear next step based on status
</success_criteria>
