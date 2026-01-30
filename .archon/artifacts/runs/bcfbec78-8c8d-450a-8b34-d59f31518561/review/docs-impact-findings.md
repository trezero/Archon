# Documentation Impact Findings: PR #364

**Reviewer**: docs-impact-agent
**Date**: 2026-01-30T12:00:00Z
**Docs Checked**: CLAUDE.md, docs/, agents, README

---

## Summary

PR #364 changes internal error handling behavior in the workflow executor (`safeSendMessage`, `updateWorkflowActivity`) and adds an `UnknownErrorTracker` mechanism. These are internal implementation details of the executor that do not change any user-facing commands, APIs, configuration, or documented patterns. The only user-visible change is new warning messages delivered to the platform when health monitoring degrades or messages fail to deliver, which are self-explanatory at runtime.

**Verdict**: NO_CHANGES_NEEDED

---

## Impact Assessment

| Document | Impact | Required Update |
|----------|--------|-----------------|
| CLAUDE.md | NONE | None |
| docs/architecture.md | NONE | None |
| docs/authoring-workflows.md | NONE | None |
| docs/configuration.md | NONE | None |
| docs/cli-developer-guide.md | NONE | None |
| docs/cli-user-guide.md | NONE | None |
| README.md | NONE | None |
| .claude/agents/*.md | NONE | None |
| .archon/commands/*.md | NONE | None |

---

## Findings

### Finding 1: updateWorkflowActivity Now Throws (Internal Contract Change)

**Severity**: LOW
**Category**: internal-behavior-change
**Document**: `CLAUDE.md` (Error Handling section)
**PR Change**: `packages/core/src/db/workflows.ts` - `updateWorkflowActivity` changed from non-throwing to throwing

**Issue**:
`updateWorkflowActivity` previously caught errors internally and logged them (non-throwing design). The PR changes it to throw, with callers now responsible for catching. This is an internal contract change between `db/workflows.ts` and `workflows/executor.ts`.

**Current Documentation**:
The CLAUDE.md Error Handling section documents general patterns (DB errors, Platform errors, AI SDK errors) but does not document `updateWorkflowActivity` specifically. The architecture docs (`docs/architecture.md`) mention UPDATE operations should verify rowCount and throw, which actually aligns better with the new behavior.

**Impact if Not Updated**:
Minimal. No developer would look to CLAUDE.md or docs/ to understand whether `updateWorkflowActivity` throws. The function's JSDoc comment (updated in the PR) and the calling code are the authoritative sources. The existing CLAUDE.md guidance ("don't fail silently") actually supports this change.

**Recommendation**: No documentation update needed. The code's own JSDoc comment is the right place for this information, and it's already updated in the PR.

---

### Finding 2: New Unknown Error Threshold Behavior

**Severity**: LOW
**Category**: new-internal-behavior
**Document**: N/A
**PR Change**: `packages/core/src/workflows/executor.ts` - New `UNKNOWN_ERROR_THRESHOLD = 3` constant and `UnknownErrorTracker` interface

**Issue**:
The executor now aborts workflows after 3 consecutive UNKNOWN errors in `safeSendMessage`. This is a new internal behavior. However, it's an error recovery mechanism, not a user-configurable setting or a documented API.

**Impact if Not Updated**:
None. Users will see the error message at runtime if this triggers ("3 consecutive unrecognized errors - aborting workflow"). The behavior is self-explanatory. The threshold is a constant, not configurable.

**Recommendation**: No documentation update needed. This is implementation-level error handling detail.

---

### Finding 3: Activity Update Failure Warning

**Severity**: LOW
**Category**: new-user-facing-message
**Document**: N/A
**PR Change**: `packages/core/src/workflows/executor.ts` - Warning after 5 consecutive activity update failures

**Issue**:
Users may now see a warning message: "Workflow health monitoring degraded. Staleness detection may be unreliable." This is a new user-visible message, but it's a degradation warning, not a feature or command.

**Impact if Not Updated**:
None. The warning is self-explanatory and only appears under database connectivity issues. Users don't need to be pre-informed about every possible warning message.

**Recommendation**: No documentation update needed.

---

## CLAUDE.md Sections to Update

| Section | Current | Needed Update |
|---------|---------|---------------|
| N/A | N/A | No updates needed |

---

## Statistics

| Severity | Count | Documents Affected |
|----------|-------|-------------------|
| CRITICAL | 0 | None |
| HIGH | 0 | None |
| MEDIUM | 0 | None |
| LOW | 3 | None (informational findings only) |

---

## New Documentation Needed

| Topic | Suggested Location | Priority |
|-------|-------------------|----------|
| N/A | N/A | N/A |

No new documentation is needed. The changes are internal error handling improvements that don't affect user-facing behavior, APIs, commands, configuration, or development workflows.

---

## Positive Observations

1. **JSDoc comments updated in-place**: The PR correctly updated the `updateWorkflowActivity` JSDoc from "Non-throwing: logs errors but doesn't fail the workflow" to "Throws on failure so callers can track consecutive failures." This is the right place for this information.

2. **Self-explanatory user messages**: The new warning messages ("health monitoring degraded", "messages failed to deliver") are clear enough that users don't need external documentation to understand them.

3. **Scope discipline**: The PR stays focused on executor error handling without touching unrelated files, keeping the documentation impact minimal.

4. **Aligned with existing CLAUDE.md guidance**: The CLAUDE.md already states "don't fail silently" in its Error Handling section. The PR's change from silent error suppression to tracked errors with thresholds aligns with this documented principle.

---

## Metadata

- **Agent**: docs-impact-agent
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/bcfbec78-8c8d-450a-8b34-d59f31518561/review/docs-impact-findings.md`
