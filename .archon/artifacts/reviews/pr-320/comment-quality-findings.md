# Comment Quality Findings: PR #320

**Reviewer**: comment-quality-agent
**Date**: 2026-01-22T08:41:49+02:00
**Comments Reviewed**: 6

---

## Summary

Both newly added investigation artifacts still describe the pre-fix `bun --cwd packages/server` scripts even though this PR already replaced them with `bun --filter @archon/server` commands. The stale narrative misstates current behavior, repeats across the completed copy, and even claims "no newer commits touched the dev script," which is contradicted by this change. The documentation otherwise has solid structure, but these outdated sections require correction before the artifact can be considered reliable historical context.

**Verdict**: REQUEST_CHANGES

---

## Findings

### Finding 1: Root-cause narrative still documents removed `--cwd` scripts

**Severity**: HIGH
**Category**: outdated
**Location**: `.archon/artifacts/issues/issue-315.md:27` (duplicated in `.archon/artifacts/issues/completed/issue-315.md:27`)

**Issue**:
The “Root Cause / Change Rationale”, Evidence Chain, Key Findings, and Implementation Step 1/2 sections all assert that the root `dev`/`start` scripts currently run `bun --cwd packages/server ...`. In this PR the scripts already delegate via `bun --filter @archon/server`, so the artifact no longer reflects reality.

**Current Comment**:
```markdown
The root script (`package.json:9-12`) runs `bun --cwd packages/server --watch src/index.ts`, which depends on `packages/server` being resolvable relative to the launcher directory.
```

```json
  "dev": "bun --cwd packages/server --watch src/index.ts",
```

**Actual Code Behavior**:
`package.json:10-12` now contains:
```json
  "dev": "bun --filter @archon/server dev",
  "start": "bun --filter @archon/server start",
```
Hot reload no longer uses `--cwd`, so the described failure mode is no longer the “current code”; it should be framed as historic context for issue #315.

**Impact**:
Future readers (or automation) will believe the fix is still pending and may re-open the issue or re-implement the same changes. The doc also points reviewers at stale line numbers, reducing trust in the artifacts.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Update the narrative to describe the new `bun --filter @archon/server` behavior and explicitly call out that the prior `--cwd` script caused ENOENT before this PR. | Keeps artifacts accurate without losing historical detail. | Requires editing multiple sections in both copies. |
| B | Remove the outdated code snippets entirely and just summarize the resolved issue outcome. | Quick to apply; avoids line-number drift. | Loses the concrete evidence chain the artifact is meant to preserve. |
| C | Expand the artifact with a "Before vs After" section that contrasts `--cwd` and `--filter` scripts and links to the fixing commit. | Provides rich context and future-proofing. | Slightly longer artifact; needs coordination across duplicated file. |

**Recommended**: Option A

**Reasoning**:
- Keeps the investigation artifact truthful while retaining the diagnostic reasoning.
- Aligns with other issue docs that explain the observed behavior first, then state how the fix changed the scripts.
- Requires only textual edits; no code changes.

**Recommended Fix**:
```markdown
### Root Cause / Change Rationale

Prior to PR #320 the root script (`package.json:10-12`) invoked `bun --cwd packages/server --watch src/index.ts`, which broke when Bun restarted from a temp directory. The fix now delegates via `bun --filter @archon/server dev`, eliminating the fragile relative path. Document both states so future readers understand why the change was necessary.
```

**Good Comment Pattern**:
```markdown
| Risk/Edge Case | Mitigation |
|----------------|------------|
| Bun might run multiple packages if the filter pattern is too broad. | Use the explicit package name `@archon/server` so only that workspace runs. |
```
_Source: `.archon/artifacts/issues/issue-315.md:150-155`_

---

### Finding 2: Git-history section contradicts this PR

**Severity**: MEDIUM
**Category**: outdated
**Location**: `.archon/artifacts/issues/issue-315.md:63` (duplicated in `.archon/artifacts/issues/completed/issue-315.md:63`)

**Issue**:
The Git History bullets state “No newer commits touched the `dev` script, so the bug has existed since the monorepo split.” This PR itself modifies `package.json:10-12`, so the statement is now false and undermines the credibility of the history section.

**Current Comment**:
```markdown
- **Last modified**: No newer commits touched the `dev` script, so the bug has existed since the monorepo split.
```

**Actual Code Behavior**:
`package.json:10-12` changed in this PR to the `bun --filter @archon/server` scripts, so there *is* a newer commit touching the `dev` and `start` entries.

**Impact**:
Readers may assume the fix never landed and fail to reference the correct commit when auditing regressions. Automated tooling that mines these artifacts could also misclassify the issue as unresolved.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Update the Git History bullets to mention PR #320 as the fix point. | Keeps provenance accurate and traceable. | Needs manual maintenance if the script changes again. |
| B | Replace the Git History section with a link to `git blame` output captured during the investigation. | Automates future verification. | Slightly less readable offline. |
| C | Add a "Status" note indicating the statement referred to the pre-fix timeline. | Minimal editing. | Still leaves the misleading sentence intact. |

**Recommended**: Option A

**Reasoning**:
- Explicitly acknowledging PR #320 ties the artifact back to the fix and prevents confusion.
- Consistent with other issue docs that note when/how a bug was closed.

**Recommended Fix**:
```markdown
- **Last modified**: Updated in PR #320 to delegate `dev`/`start` via `bun --filter @archon/server`, resolving the ENOENT restarts introduced in `718e01b1`.
```

**Good Comment Pattern**:
```markdown
### Validation

- `bun run dev` from the repo root, edit `packages/server/src/index.ts`, and confirm the watcher restarts cleanly.
- `bun run start` to verify production entry continues to work via the filtered script.
```
_Source: `.archon/artifacts/issues/issue-315.md:122-127`_

---

## Comment Audit

| Location | Type | Accurate | Up-to-date | Useful | Verdict |
|----------|------|----------|------------|--------|---------|
| `.archon/artifacts/issues/issue-315.md:27` | investigation note | NO | NO | YES | UPDATE |
| `.archon/artifacts/issues/issue-315.md:77` | code snippet | NO | NO | YES | UPDATE |
| `.archon/artifacts/issues/completed/issue-315.md:27` | investigation note | NO | NO | YES | UPDATE |
| `.archon/artifacts/issues/issue-315.md:63` | git history | NO | NO | PARTIAL | UPDATE |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | 0 | 0 |
| HIGH | 1 | 1 |
| MEDIUM | 1 | 1 |
| LOW | 0 | 0 |

---

## Documentation Gaps

| Code Area | What's Missing | Priority |
|-----------|----------------|----------|
| `.archon/artifacts/issues/issue-315.md` | Needs a post-change description explaining the new `bun --filter @archon/server` scripts and linking to the fixing commit. | HIGH |
| `.archon/artifacts/issues/completed/issue-315.md` | Same stale narrative as the in-progress artifact; should be updated or deduplicated to avoid drift. | HIGH |

---

## Comment Rot Found

| Location | Comment Says | Code Does | Age |
|----------|--------------|-----------|-----|
| `.archon/artifacts/issues/issue-315.md:27` | "The root script runs `bun --cwd packages/server --watch src/index.ts`" | `package.json:10-12` now runs `bun --filter @archon/server dev/start`. | Introduced 2026-01-21 |
| `.archon/artifacts/issues/issue-315.md:63` | "No newer commits touched the `dev` script" | PR #320 modifies the script in the same lines. | Introduced 2026-01-21 |

---

## Positive Observations

- Investigation artifacts clearly enumerate validation steps (`issue-315.md:122-129`), which will still be valuable after textual updates.
- The Risk & Mitigation table (`issue-315.md:150-155`) succinctly captures edge cases and is a good template for future write-ups.

---

## Metadata

- **Agent**: comment-quality-agent
- **Timestamp**: 2026-01-22T08:41:49+02:00
- **Artifact**: `.archon/artifacts/reviews/pr-320/comment-quality-findings.md`
