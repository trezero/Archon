---
description: Generate documentation for implemented feature
argument-hint: <impl-log-path>
---

<objective>
Generate documentation for the implementation at `$ARGUMENTS`.

**Dual-Agent Pattern**:
- Agent 1 (Writer): Creates documentation
- Agent 2 (Reviewer): Reviews for clarity and completeness

**Input**: `.agents/sdlc/{feature}/impl.md`
**Output**: Documentation files + `.agents/sdlc/{feature}/docs.md`

**Previous Command**: `sdlc:implement`
**Next Command**: `sdlc:final-review`

**Can run parallel with**: `sdlc:unit-tests`, `sdlc:integration-tests`
</objective>

<context>
Implementation: @$ARGUMENTS
Spec: !`cat $(dirname $ARGUMENTS)/spec-validated.md 2>/dev/null | head -50`
Project docs pattern: !`ls docs/ 2>/dev/null || ls README.md 2>/dev/null || echo "No docs found"`
</context>

<process>

## Phase 1: ANALYZE - Understand What to Document

**Read implementation log and extract:**
- Feature purpose
- Public APIs/interfaces
- Configuration options
- Dependencies
- Usage patterns

**Identify documentation needs:**
- README updates?
- API documentation?
- Inline code documentation?
- Usage examples?

---

## Phase 2: WRITE - Agent 1 (Writer)

**Use Task tool to launch Writer agent:**

```
You are a TECHNICAL WRITER. Create documentation for this feature.

FEATURE: {feature name}
IMPLEMENTATION: {summary of what was built}
FILES: {list of new files}
PURPOSE: {from spec}

CREATE DOCUMENTATION:

1. FEATURE_README (if new feature)
   ```markdown
   # {Feature Name}

   ## Overview
   {What this feature does and why}

   ## Quick Start
   {Minimal example to get started}

   ## API Reference
   {Public functions/methods with signatures}

   ## Configuration
   {Options and environment variables}

   ## Examples
   {Common use cases with code}

   ## Troubleshooting
   {Common issues and solutions}
   ```

2. INLINE_DOCUMENTATION
   For each public function:
   - JSDoc/TSDoc comments
   - Parameter descriptions
   - Return value descriptions
   - Usage examples
   - Throws/errors documented

3. TYPE_DOCUMENTATION
   For each exported type:
   - Purpose description
   - Property descriptions
   - Example usage

4. CHANGELOG_ENTRY
   ```markdown
   ## [{version}] - {date}
   ### Added
   - {Feature}: {description}
   ```

RETURN:
- Files to create/update: [list]
- Documentation content: [for each file]
```

---

## Phase 3: VALIDATE - Agent 2 (Reviewer)

**Use Task tool to launch Reviewer agent:**

```
You are a DOCUMENTATION REVIEWER. Review this documentation.

DOCS: {documentation content}
IMPLEMENTATION: {what was built}

EVALUATE:

1. COMPLETENESS
   - All public APIs documented?
   - All parameters explained?
   - All return values described?
   Rate: COMPLETE | PARTIAL | INCOMPLETE

2. CLARITY
   - Easy to understand?
   - Jargon explained?
   - Good examples?
   Rate: CLEAR | CONFUSING | UNCLEAR

3. ACCURACY
   - Matches actual implementation?
   - Examples work?
   - Types correct?
   Rate: ACCURATE | MINOR_ISSUES | INACCURATE

4. USABILITY
   - Can someone use feature from docs alone?
   - Quick start actually quick?
   - Troubleshooting helpful?
   Rate: USABLE | NEEDS_WORK | UNUSABLE

5. MISSING_DOCS
   - What's not documented that should be?
   List: [specific gaps]

RETURN:
- Verdict: APPROVED | NEEDS_REVISION | REJECTED
- Issues: [list]
- Suggestions: [improvements]
```

**If NEEDS_REVISION**: Iterate with Writer.

---

## Phase 4: UPDATE - Apply Documentation

**Update/create documentation files:**

1. Feature README (if applicable)
2. Inline code documentation
3. CHANGELOG entry
4. Main README (if feature affects it)

**Run documentation linting if available:**
```bash
# Check for broken links, etc.
```

---

## Phase 5: REPORT - Create Documentation Summary

```markdown
# Documentation: {Feature Name}

## Summary
- **Created**: {timestamp}
- **Status**: COMPLETE | PARTIAL

## Documentation Created

### Files Created
| File | Type | Description |
|------|------|-------------|
| `docs/features/x.md` | Feature README | Full feature documentation |

### Files Updated
| File | Changes |
|------|---------|
| `CHANGELOG.md` | Added feature entry |
| `README.md` | Added feature to list |

### Inline Documentation
| File | Functions Documented | Types Documented |
|------|---------------------|------------------|
| `service.ts` | 5 | 3 |

## Documentation Review

### Verdict: {APPROVED | NEEDS_REVISION}

### Ratings
- Completeness: {rating}
- Clarity: {rating}
- Accuracy: {rating}
- Usability: {rating}

### Issues Found
{list or "None"}

## Quick Reference

### Feature Overview
{One paragraph summary}

### Key APIs
| Function | Purpose |
|----------|---------|
| `createX()` | Creates new X |
| `getX()` | Retrieves X |

### Configuration
| Option | Default | Description |
|--------|---------|-------------|
| `X_ENABLED` | `true` | Enables feature |

## Next Step

Proceed to final review:
  `/sdlc:final-review .agents/sdlc/{feature}/`
```

**Save to**: `.agents/sdlc/{feature}/docs.md`

</process>

<output>
**OUTPUT_FILES**:
- Documentation files (README, inline docs, etc.)
- Summary: `.agents/sdlc/{feature}/docs.md`

**REPORT_TO_USER**:
```markdown
## Documentation Created

**Summary**: `.agents/sdlc/{feature}/docs.md`

**Status**: {COMPLETE | PARTIAL}

**Files**:
- Created: {count}
- Updated: {count}

**Coverage**:
- Functions documented: {count}
- Types documented: {count}

**Next Step**: `/sdlc:final-review .agents/sdlc/{feature}/`
```
</output>

<verification>
**Before completing:**
- [ ] Writer agent created documentation
- [ ] Reviewer agent approved documentation
- [ ] All public APIs documented
- [ ] Examples provided
- [ ] CHANGELOG updated
</verification>

<success_criteria>
**DUAL_AGENT**: Writer and Reviewer both ran
**COMPLETE**: All public interfaces documented
**CLEAR**: Reviewer approved clarity
**ACCURATE**: Documentation matches implementation
</success_criteria>
