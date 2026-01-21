# Implementation Report

**Plan**: `.claude/PRPs/plans/runtime-loading-defaults.plan.md`
**Source Issue**: #322
**Branch**: `feature/runtime-loading-defaults`
**Date**: 2026-01-21
**Status**: COMPLETE

---

## Summary

Implemented runtime loading of default commands/workflows instead of copying them to target repos. Fixed the path resolution bug in `getAppArchonBasePath()` and added multi-source discovery for both workflows and commands.

---

## Assessment vs Reality

| Metric | Predicted | Actual | Reasoning |
|--------|-----------|--------|-----------|
| Complexity | MEDIUM | MEDIUM | Implementation matched prediction - architecture was already 80% ready |
| Confidence | 8/10 | 9/10 | Codebase patterns were well-documented, implementation went smoothly |

**Implementation matched the plan closely.** Only minor adjustments needed:
- Had to update existing loader tests to mock app defaults path (otherwise they loaded real defaults)
- Had to update command-handler tests to match new response message format

---

## Tasks Completed

| # | Task | File | Status |
|---|------|------|--------|
| 1 | Fix getAppArchonBasePath() path resolution | `packages/core/src/utils/archon-paths.ts` | done |
| 2 | Add new config options to config-types.ts | `packages/core/src/config/config-types.ts` | done |
| 3 | Add defaults for new options in config-loader.ts | `packages/core/src/config/config-loader.ts` | done |
| 4 | Update workflow loader for multi-source discovery | `packages/core/src/workflows/loader.ts` | done |
| 5 | Update executor for app defaults command search | `packages/core/src/workflows/executor.ts` | done |
| 6 | Remove copyDefaultsToRepo from command-handler.ts | `packages/core/src/handlers/command-handler.ts` | done |
| 7 | Remove copyDefaultsToRepo from github.ts | `packages/server/src/adapters/github.ts` | done |
| 8 | Add tests for archon-paths.ts | `packages/core/src/utils/archon-paths.test.ts` | done |
| 9 | Add tests for loader.ts multi-source loading | `packages/core/src/workflows/loader.test.ts` | done |

---

## Validation Results

| Check | Result | Details |
|-------|--------|---------|
| Type check | done | No errors (all 3 packages) |
| Lint | done | 0 errors, 0 warnings |
| Format | done | All files formatted |
| Unit tests | done | 932 passed, 0 failed |
| Build | done | Compiled successfully |

---

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `packages/core/src/utils/archon-paths.ts` | UPDATE | +4/-3 |
| `packages/core/src/config/config-types.ts` | UPDATE | +18/-0 |
| `packages/core/src/config/config-loader.ts` | UPDATE | +2/-0 |
| `packages/core/src/workflows/loader.ts` | UPDATE | +56/-17 |
| `packages/core/src/workflows/executor.ts` | UPDATE | +27/-2 |
| `packages/core/src/handlers/command-handler.ts` | UPDATE | +4/-25 |
| `packages/server/src/adapters/github.ts` | UPDATE | +2/-21 |
| `packages/core/src/utils/archon-paths.test.ts` | UPDATE | +42/-0 |
| `packages/core/src/workflows/loader.test.ts` | UPDATE | +135/-8 |
| `packages/core/src/handlers/command-handler.test.ts` | UPDATE | +2/-2 |

---

## Deviations from Plan

1. **Existing tests required mocking**: Had to add mocks for `getDefaultWorkflowsPath` and `loadConfig` in the existing loader tests to prevent them from loading real app defaults
2. **Response message format change**: Updated test assertions to match the new "repo commands" terminology

---

## Issues Encountered

1. **ESLint boolean comparison rule**: Initial implementation used `!== false` which triggered `@typescript-eslint/no-unnecessary-boolean-literal-compare`. Fixed by extracting to a variable with nullish coalescing: `const loadDefaultWorkflows = config.defaults?.loadDefaultWorkflows ?? true`

2. **Existing tests broke**: The loader tests were checking exact workflow counts which changed when app defaults started loading. Fixed by mocking the app defaults path for all tests.

---

## Tests Written

| Test File | Test Cases |
|-----------|------------|
| `archon-paths.test.ts` | getAppArchonBasePath returns repo root path, getDefaultCommandsPath returns correct path, getDefaultWorkflowsPath returns correct path |
| `loader.test.ts` | Loads from app defaults when repo has none, overrides app defaults with repo workflows, skips app defaults when opted out, combines workflows from both sources |

---

## Next Steps

- [ ] Review implementation
- [ ] Create PR: `gh pr create`
- [ ] Merge when approved
