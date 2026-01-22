# Investigation: Hot reload fails with ENOENT after code changes

**Issue**: #315 (https://github.com/dynamous-community/remote-coding-agent/issues/315)
**Type**: BUG
**Investigated**: 2026-01-21T11:29:11Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | MEDIUM | Hot reload (documented in README.md:69-72 and docs/getting-started.md:154-160) is the recommended dev loop, so the failure blocks smooth iteration but has a manual restart workaround. |
| Complexity | LOW | Fix is limited to adjusting the root dev script in package.json:8-12 to avoid brittle cwd handling; no runtime logic needs to move. |
| Confidence | MEDIUM | The ENOENT matches Bun's behavior when re-run commands drop relative cwd, and the package.json script clearly relies on `--cwd packages/server`, but we still need to validate on a live process once patched. |

---

## Problem Statement

Running `bun run dev` from the repo root starts the server once, but the Bun watcher fails on subsequent reloads with `ENOENT: Could not change directory to "packages/server"`, forcing developers to stop and restart manually despite documentation promising automatic hot reload.

---

## Analysis

### Root Cause / Change Rationale

Hot reload relies on Bun rerunning the dev command whenever files change. Before PR #320, the root script (`package.json:9-12`) ran `bun --cwd packages/server --watch src/index.ts`, which depended on `packages/server` being resolvable relative to the launcher directory. Bun restarts watchers from an internal temp directory, so its attempt to reapply `--cwd packages/server` failed on reload, producing the observed ENOENT. PR #320 replaced that relative path with `bun --filter @archon/server dev`, delegating to the workspace's own `dev` script (defined in `packages/server/package.json:6-11`) and letting Bun change into the package before running `bun --watch src/index.ts`. This mirrors how other workspace-wide scripts already use `bun --filter` targeting specific packages and eliminates the ENOENT regression.

### Evidence Chain

WHY: Hot reload restarts exit with `ENOENT: Could not change directory to "packages/server"`.
↓ BECAUSE: The watcher tries to `chdir` into a relative path that no longer exists from its temp working directory during restarts.
  Evidence: Prior to PR #320 the root script used `bun --cwd packages/server --watch src/index.ts` (`package.json:9-12`), so any change in the caller's working directory broke the relative path.
↓ BECAUSE: Bun watcher restarts use the executable's own working directory rather than the repo root when a process exits, so relative `--cwd` targets are not stable.
  Evidence: Issue #315 reproduction plus Bun's documented behavior; the watcher-run process logs ENOENT exactly at restart time.
↓ ROOT CAUSE: Development relied on a relative `--cwd packages/server` inside the root package script instead of invoking the server workspace's `dev` script (which already handles the correct cwd).
  Evidence: `packages/server/package.json:6-11` shows a self-contained `dev` script (`bun --watch src/index.ts`) that works when run inside the package; we simply never delegated to it before the fix.
↓ FIX: Delegate to the workspace script with `bun --filter @archon/server dev/start` so Bun enters the package before executing, which landed in PR #320.
  Evidence: `package.json:9-12` now contains the `bun --filter @archon/server` commands, matching other workspace-wide scripts.

### Key Findings

| Area | File:Lines | Notes |
|------|------------|-------|
| Dev entry script | `package.json:9-12` | Before PR #320 the root `dev` script hardcoded `bun --cwd packages/server --watch src/index.ts`, causing ENOENT once Bun restarted from a temp dir; it now delegates via `bun --filter @archon/server` to keep restarts stable. |
| Server workspace script | `packages/server/package.json:6-11` | Defines `"dev": "bun --watch src/index.ts"` which works when invoked via Bun's workspace runner. |
| Developer docs | `README.md:62-72`, `docs/getting-started.md:154-160`, `scripts/validate-setup.sh:177-179` | All instruct developers to rely on `bun run dev`, so the regression impacts every onboarding path. |
| Monorepo restructure | `git blame package.json:9-12` | Commit `718e01b1` introduced the workspace split and the fragile `--cwd` command, aligning with reporter's suspicion. |

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `package.json` | 9-12 | UPDATE | Replace relative `--cwd packages/server` dev script with `bun --filter @archon/server dev` (and optionally align `start` for consistency) so Bun handles cwd internally. |
| `README.md` / `docs` | n/a | VERIFY | No wording changes needed because command name stays `bun run dev`, but double-check instructions after the script update. |

### Integration Points

- `README.md:62-72` and `docs/getting-started.md:154-160` send every contributor through `bun run dev` for hot reload.
- `scripts/validate-setup.sh:177-179` echoes `bun run dev` as the success path after validation.
- `CLAUDE.md` and contribution guides reference the same root script; fixing it restores the documented workflow without doc edits.

### Git History

- **Introduced**: `718e01b1` (2026-01-20) “Phase 1 - Monorepo structure…” added the `bun --cwd packages/server --watch src/index.ts` script.
- **Last modified**: Updated in PR #320 to delegate `dev`/`start` via `bun --filter @archon/server`, resolving the ENOENT regression introduced in `718e01b1`.
- **Implication**: Regression specific to the new workspace setup; older single-package versions did not rely on `--cwd`.

---

## Implementation Plan

### Step 1: Route dev script through the workspace `@archon/server` package

**File**: `package.json`
**Lines**: 9-12
**Action**: UPDATE

**Current code:**
```json
  "dev": "bun --cwd packages/server --watch src/index.ts",
```

**Required change:**
```json
  "dev": "bun --filter @archon/server dev",
```

**Why**: `bun --filter` spawns the package’s own `dev` script directly inside `packages/server`, so restarts inherit the correct working directory and avoid ENOENT.

**Status**: Implemented in PR #320; retained here for historical context.

---

### Step 2: (Optional but recommended) Align `start` with the same delegation pattern

**File**: `package.json`
**Lines**: 10-12
**Action**: UPDATE

**Current code:**
```json
  "start": "bun --cwd packages/server src/index.ts",
```

**Required change:**
```json
  "start": "bun --filter @archon/server start",
```

**Why**: Keeps production startup consistent with dev tooling and removes future cwd brittleness if Bun ever reuses the script in watch/PM2 contexts.

**Status**: Implemented in PR #320 alongside the dev script change.

---

### Step 3: Verify documentation references

**Files**: `README.md`, `docs/getting-started.md`, `scripts/validate-setup.sh`
**Action**: VERIFY (no code change unless wording needs clarification)

**Steps**:
1. Ensure the instructions that point to `bun run dev` remain accurate after the script update (command stays identical, so only sanity-check for stale explanations).
2. If desired, add a short troubleshooting note mentioning that hot reload now delegates to `@archon/server` (optional, only if onboarding docs require justification).

---

### Step 4: Manual validation

1. Run `bun run dev` from the repo root; confirm the server starts (setting env vars or stubbing dependencies as needed).
2. Modify a file under `packages/server/src/` and ensure Bun restarts without the ENOENT error.
3. Stop the process and run `bun run start` to confirm production start still works through `--filter`.

---

### Step N: Add/Update Tests

Automated tests do not cover package scripts; rely on manual validation above. Consider adding a lightweight smoke test script later if needed.

---

## Patterns to Follow

Use existing workspace delegation scripts as a template:

```json
  "build": "bun --filter '*' build",
  "test": "bun --filter '*' test",
  "test:watch": "bun --filter @archon/server test:watch"
```

_Source: `package.json:12-15`_

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Bun might run multiple packages if the filter pattern is too broad. | Use the explicit package name `@archon/server` so only that workspace runs. |
| Contributors may still be in the `packages/server` directory when running `bun run dev`. | Bun handles this gracefully; the command simply reuses the existing cwd. |
| Missing dependencies/env vars stop the server before we can observe hot reload. | Document necessary env vars or run against mocked settings when validating the fix. |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun run lint
bun --filter @archon/server test
```

### Manual Verification

1. `bun run dev` from the repo root, wait for the server banner, then edit `packages/server/src/index.ts` to trigger a restart without ENOENT.
2. `bun run start` to confirm non-watch mode still boots through the workspace script.

---

## Scope Boundaries

**IN SCOPE:**
- Updating the root `dev` (and optionally `start`) scripts to delegate via `bun --filter`.
- Verifying that `bun run dev` works per documentation.

**OUT OF SCOPE:**
- Changing CLI scripts or other packages that still use `--cwd` but do not run in watch mode.
- Replacing Bun’s watch mechanism with third-party tools (only needed if this fix fails).

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-21T11:29:11Z
- **Artifact**: `.archon/artifacts/issues/completed/issue-315.md`
