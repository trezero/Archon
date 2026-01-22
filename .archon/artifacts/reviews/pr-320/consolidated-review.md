# Consolidated Review: PR #320

**Date**: 2026-01-22T06:46:10Z
**Agents**: code-review, error-handling, test-coverage, comment-quality, docs-impact
**Total Findings**: 5

---

## Executive Summary

The hot-reload regression is addressed, but the supporting safety net is still thin: there is no automated coverage that exercises the root `bun run dev/start` scripts, so the bug that triggered this PR can return undetected. Investigation artifacts drifted while the code changed—the root-cause narrative still describes the removed `--cwd` scripts, and the git-history bullets now contradict the state of this PR. The validation checklist instructs a command that runs zero tests, and one completed artifact’s metadata points to the wrong path, which erodes reviewer trust in the documentation. Until tests cover the workflow and the artifacts reflect reality, the PR should not merge.

**Overall Verdict**: REQUEST_CHANGES

**Auto-fix Candidates**: 1 CRITICAL + HIGH issues can be auto-fixed
**Manual Review Needed**: 3 MEDIUM + LOW issues require decision

---

## Statistics

| Agent | CRITICAL | HIGH | MEDIUM | LOW | Total |
|-------|----------|------|--------|-----|-------|
| Code Review | 0 | 0 | 1 | 1 | 2 |
| Error Handling | 0 | 0 | 0 | 0 | 0 |
| Test Coverage | 0 | 1 | 0 | 0 | 1 |
| Comment Quality | 0 | 1 | 1 | 0 | 2 |
| Docs Impact | 0 | 0 | 0 | 0 | 0 |
| **Total** | **0** | **2** | **2** | **1** | **5** |

---

## CRITICAL Issues (Must Fix)

_None._

---

## HIGH Issues (Should Fix)

### Issue 1: Dev/start scripts still have zero automated coverage

**Source Agent**: test-coverage
**Location**: `package.json:10-12`
**Category**: missing-test

**Problem**:
`bun run dev` and `bun run start` now delegate via `bun --filter @archon/server`, but no CI test launches these commands from the repo root. The previous ENOENT bug slipped in precisely because the workflow is untested; without new smoke tests, future refactors of workspace filters or package names can break hot reload for everyone without any failing check.

**Recommended Fix**:
```typescript
describe('root dev script', () => {
  it('survives restart without ENOENT', async () => {
    const dev = spawn('bun', ['run', 'dev'], {
      env: { ...process.env, ARCHON_SKIP_SERVICES: '1' },
    });
    await waitForStdout(dev, 'ready');
    await touch(join(repoRoot, 'packages/server/src/index.ts'));
    await expect(waitForStdout(dev, 'Restarting')).resolves.not.toThrow();
    dev.kill();
  });
});
```

**Why High**:
Without automation, the same regression pathway remains open—one typo in the workspace filter takes down every developer’s boot flow, and CI will still report green.

---

### Issue 2: Investigation artifacts describe the pre-fix `--cwd` scripts as current behavior

**Source Agent**: comment-quality
**Location**: `.archon/artifacts/issues/issue-315.md:27` and `.archon/artifacts/issues/completed/issue-315.md:27`
**Category**: documentation-outdated

**Problem**:
The “Root Cause / Change Rationale”, evidence chain, and implementation steps insist that the root scripts run `bun --cwd packages/server --watch src/index.ts`. This PR already swapped those entries to `bun --filter @archon/server {dev,start}`, so the artifacts now misreport the state of the repository and imply the fix never landed.

**Recommended Fix**:
```markdown
### Root Cause / Change Rationale

Prior to PR #320 the root scripts invoked `bun --cwd packages/server`, which failed once Bun restarted from a temp directory. The fix now delegates via `bun --filter @archon/server dev/start`, ensuring watcher restarts inherit the package’s cwd. Document both the historical failure and the updated behavior so readers understand why the change was required.
```

**Why High**:
These artifacts drive future automation and incident retros—it is high risk when they point reviewers at stale commands, because future contributors may re-open the issue or reapply the same fix blindly.

---

## MEDIUM Issues (Options for User)

### Issue 1: Validation checklist command skips every test

**Source Agent**: code-review
**Location**: `.archon/artifacts/issues/issue-315.md:162`

**Problem**:
The automated-checks block now says `bun run test --filter @archon/server`, but the `test` script already expands to `bun --filter '*' test`. Passing `--filter @archon/server` as an argument makes Bun try to match test files by that literal string, so zero tests execute even though the command reports success.

**Options**:

| Option | Approach | Effort | Risk if Skipped |
|--------|----------|--------|-----------------|
| Fix Now | Document the direct command `bun --filter @archon/server test` (no `bun run`). | LOW | Contributors will continue to run empty suites believing tests passed. |
| Create Issue | Track a follow-up to add a dedicated `test:server` script and update docs later. | LOW | Same silent test skips until the follow-up lands. |
| Skip | Accept the incorrect command. | NONE | CI parity is broken and regressions merge untested. |

**Recommendation**: Fix now—editing the Markdown checklist is trivial and immediately restores the intended scoped test command.

---

### Issue 2: Git-history section contradicts this PR

**Source Agent**: comment-quality
**Location**: `.archon/artifacts/issues/issue-315.md:63` (also duplicated in the completed copy)

**Problem**:
The Git history bullets claim “No newer commits touched the `dev` script,” which is instantly false once this PR edits `package.json:10-12`. The artifact therefore misleads anyone auditing provenance or trying to bisect the regression.

**Options**:

| Option | Approach | Effort | Risk if Skipped |
|--------|----------|--------|-----------------|
| Fix Now | Update the bullet to mention PR #320 as the fix point and summarize the change. | LOW | Readers will continue to think the scripts are untouched and may duplicate work. |
| Create Issue | Track a documentation follow-up to refresh git-history metadata. | LOW | Until then, the artifact remains contradictory. |
| Skip | Leave as-is. | NONE | Investigations derived from this doc will start from incorrect assumptions. |

**Recommendation**: Fix now to keep provenance accurate and align the artifact with the code that just changed it.

---

## LOW Issues (For Consideration)

| Issue | Location | Agent | Suggestion |
|-------|----------|-------|------------|
| Completed artifact metadata points to the wrong file path | `.archon/artifacts/issues/completed/issue-315.md:189` | code-review | Update the `**Artifact**` field so it references `.archon/artifacts/issues/completed/issue-315.md` instead of the non-completed path. |

---

## Positive Observations

- Root `dev`/`start` scripts now consistently use `bun --filter @archon/server`, eliminating the ENOENT restarts (code-review, error-handling).
- The investigation artifact documents validation steps, risks, and mitigations clearly; once updated it will remain a strong reference (comment-quality).
- Existing Bun/TypeScript test suites exercise realistic behavior, so extending them with a dev-script smoke test is feasible (test-coverage).
- Public docs (README, docs/getting-started, CLAUDE.md) already match the `bun run dev` workflow, so no extra changes are required (docs-impact).

---

## Suggested Follow-up Issues

| Issue Title | Priority | Related Finding |
|-------------|----------|-----------------|
| "Add CI smoke test for root bun run dev/start scripts" | P1 | HIGH issue #1 |
| "Refresh issue-315 artifacts to reflect PR #320 (root cause + git history)" | P2 | HIGH issue #2 / MEDIUM issue #2 |

---

## Next Steps

1. **Auto-fix step** will address 1 HIGH documentation issue (artifact narrative drift).
2. **Review** the MEDIUM issues to ensure validation steps and git history stay accurate.
3. **Consider** the LOW metadata fix and plan the recommended smoke test addition before merging.

---

## Agent Artifacts

| Agent | Artifact | Findings |
|-------|----------|----------|
| Code Review | `code-review-findings.md` | 2 |
| Error Handling | `error-handling-findings.md` | 0 |
| Test Coverage | `test-coverage-findings.md` | 1 |
| Comment Quality | `comment-quality-findings.md` | 2 |
| Docs Impact | `docs-impact-findings.md` | 0 |

---

## Metadata

- **Synthesized**: 2026-01-22T06:46:10Z
- **Artifact**: `.archon/artifacts/reviews/pr-320/consolidated-review.md`
