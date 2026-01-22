# Test Coverage Findings: PR #320

**Reviewer**: test-coverage-agent
**Date**: 2026-01-22T06:41:58Z
**Source Files**: 1
**Test Files**: 0

---

## Summary

This PR only changes the root `package.json` scripts that developers rely on for `bun run dev`/`start`, but no automated test exercises those commands or their Bun workspace wiring. The rest of the codebase has strong behavioral unit tests (e.g., in `packages/core` and `packages/server`), yet the scripts that glue the workflow together remain unvalidated and could regress silently. Manual verification is insufficient for CI, so additional hot-reload smoke tests are required before merge.

**Verdict**: REQUEST_CHANGES

---

## Coverage Map

| Source File | Test File | New Code Tested | Modified Code Tested |
|-------------|-----------|-----------------|---------------------|
| `package.json:10-12` | (missing) | NONE | NONE |

---

## Findings

### Finding 1: No automated coverage for `bun run dev` / `bun run start`

**Severity**: HIGH
**Category**: missing-test
**Location**: `package.json:10-12`
**Criticality Score**: 7

**Issue**:
The PR fixes the hot-reload regression by routing `dev`/`start` through `bun --filter @archon/server`, but CI still lacks any test that launches these scripts from the repo root. Previous regressions (the ENOENT issue) happened precisely because bugs in this area only surface during manual runs. Without a regression test, future refactors of workspace names or script wiring can break every developer’s boot flow without detection.

**Untested Code**:
```json
  "dev": "bun --filter @archon/server dev",
  "start": "bun --filter @archon/server start",
```

**Why This Matters**:
- If the workspace name changes or Bun CLI flags regress, `bun run dev` could stop reloading and no CI check would fail.
- `scripts/validate-setup.sh:177-179` promises contributors that `bun run dev` works; a silent failure blocks onboarding and undermines docs/tests alignment.
- Without automated coverage, regressions will only be caught after developers file issues, prolonging hot-reload outages.

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Add a Bun test (e.g., `packages/server/src/dev-script.smoke.test.ts`) that spawns `bun run dev` via `spawn` with `ARCHON_SKIP_SERVICES=1`, touches `packages/server/src/index.ts`, and asserts the process logs a restart instead of exiting with ENOENT. | Verifies watch mode and cwd handling end-to-end. | MED |
| B | Create a lightweight shell smoke test (`scripts/test/dev-hot-reload.sh`) invoked on CI linux runners that runs `bun run dev` for ~5s, edits a temp file in `packages/server/src`, and ensures exit code stays 0. | Validates real CLI pipeline exactly as contributors use it. | HIGH |

**Recommended**: Option A

**Reasoning**:
- Fits existing Bun `describe`/`test` patterns, so it can run with `bun test` locally and on CI without special runners.
- Focuses on behavior (process survives reload) instead of duplicating implementation details from `package.json`.
- Medium effort yet powerful enough to detect future workspace misconfigurations.

**Recommended Test**:
```typescript
describe('root dev script', () => {
  it('restarts server on file change without ENOENT', async () => {
    const dev = spawn('bun', ['run', 'dev'], { env: { ...process.env, ARCHON_SKIP_SERVICES: '1' } });
    await waitForStdout(dev, 'ready');
    await touch(join(repoRoot, 'packages/server/src/index.ts'));
    await expect(waitForStdout(dev, 'Restarting')).resolves.not.toThrow();
    dev.kill();
  });
});
```

**Test Pattern Reference**:
```typescript
// SOURCE: packages/core/src/utils/git.test.ts:8-42
describe('git utilities', () => {
  describe('isWorktreePath', () => {
    test('returns false for directory without .git', async () => {
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(false);
    });
    // … more behavior-first assertions …
  });
});
```

---

## Test Quality Audit

| Test | Tests Behavior | Resilient | Meaningful Assertions | Verdict |
|------|----------------|-----------|-----------------------|---------|
| `packages/core/src/utils/git.test.ts#L19` (`describe('isWorktreePath')`) | YES | YES | YES | GOOD |
| `packages/server/src/adapters/github.test.ts#L74` (`describe('GitHubAdapter')`) | YES | YES | YES | GOOD |

Existing suites assert observable outcomes (return values, console output) rather than implementation details, so they’re solid references for new smoke tests.

---

## Statistics

| Severity | Count | Criticality 8-10 | Criticality 5-7 | Criticality 1-4 |
|----------|-------|------------------|-----------------|-----------------|
| CRITICAL | 0 | - | - | - |
| HIGH | 1 | - | 1 | - |
| MEDIUM | 0 | - | - | - |
| LOW | 0 | - | - | - |

---

## Risk Assessment

| Untested Area | Failure Mode | User Impact | Priority |
|---------------|--------------|-------------|----------|
| Root `dev`/`start` scripts (`package.json:10-12`) | Bun workspace filter breaks or watcher cannot find `@archon/server` | `bun run dev` fails to hot-reload, blocking onboarding and active development | HIGH |

---

## Patterns Referenced

| Test File | Lines | Pattern |
|-----------|-------|---------|
| `packages/core/src/utils/git.test.ts` | 8-42 | Nested `describe` blocks with behavior-first expectations and fs mocks |
| `packages/server/src/adapters/github.test.ts` | 66-112 | Adapter-level tests that mock integrations but assert observable behavior |

---

## Positive Observations

- Core and adapter suites already exercise realistic behavior (filesystem, adapters, mocks), demonstrating a mature test harness to build on.
- Existing Bun `bun:test` setup comfortably handles async process management/mocking, so extending it to cover dev scripts is feasible.

---

## Metadata

- **Agent**: test-coverage-agent
- **Timestamp**: 2026-01-22T06:41:58Z
- **Artifact**: `.archon/artifacts/reviews/pr-320/test-coverage-findings.md`
