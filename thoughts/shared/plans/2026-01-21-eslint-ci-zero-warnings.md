# ESLint CI Zero-Warnings Policy Implementation Plan

## Overview

Configure ESLint for CI enforcement with a zero-warnings policy. This involves turning off rules that produce false positives, fixing legitimate issues, updating pre-commit hooks, and documenting linting guidelines in CLAUDE.md for agent behavior.

## Current State Analysis

**61 warnings currently**, broken down by rule:

| Rule                            | Count | Issue                                  | Action              |
| ------------------------------- | ----- | -------------------------------------- | ------------------- |
| `restrict-template-expressions` | 24    | Numbers in templates flagged as errors | Turn OFF            |
| `no-unnecessary-condition`      | 18    | Defensive coding flagged as dead code  | Turn OFF            |
| `no-non-null-assertion`         | 11    | 8 fixable, 3 need refactoring          | Keep ERROR, fix all |
| `prefer-nullish-coalescing`     | 8     | Env var truthy checks flagged          | Turn OFF            |

**Current CI**: Runs `bun run lint` but passes with warnings (no `--max-warnings 0`).

**Current pre-commit**: Only runs Prettier, not ESLint.

## Desired End State

1. **Zero warnings** - CI fails if any linting issues exist
2. **Fast pre-commit** - ESLint runs on staged files with auto-fix
3. **Validation script** - `bun run validate` for agents to run before PRs
4. **Documented guidelines** - CLAUDE.md explains when/how to handle lint issues

### Verification:

- `bun run lint` exits with 0 (no warnings or errors)
- `bun run validate` passes (type-check + lint + format:check)
- Pre-commit hook runs ESLint and Prettier on staged files
- CI fails on any lint warning

## What We're NOT Doing

- Adding type-check to pre-commit (too slow - checks entire project)
- Keeping rules as "warn" - everything is either "error" or "off"
- Adding new strict rules beyond current config

---

## Phase 1: ESLint Configuration Changes

### Overview

Update `eslint.config.mjs` to turn off false-positive rules and ensure remaining rules are errors (not warnings).

### Changes Required:

#### 1.1 Update ESLint Config

**File**: `eslint.config.mjs`
**Changes**: Turn off 3 rules, keep `no-non-null-assertion` as error, remove all "warn" severities

```javascript
// Replace lines 65-78 with:
rules: {
  // === ENFORCED RULES (errors) ===
  '@typescript-eslint/explicit-function-return-type': 'error',
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  quotes: ['error', 'single', { avoidEscape: true }],
  semi: ['error', 'always'],
  '@typescript-eslint/naming-convention': [
    'error',
    {
      selector: 'interface',
      format: ['PascalCase'],
      custom: { regex: '^I?[A-Z]', match: true },
    },
    { selector: 'typeAlias', format: ['PascalCase'] },
    { selector: 'function', format: ['camelCase'] },
    { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
  ],
  '@typescript-eslint/no-non-null-assertion': 'error',

  // === DISABLED RULES ===
  // Numbers/booleans in template literals are valid JS (auto-converted to string)
  '@typescript-eslint/restrict-template-expressions': 'off',
  // Defensive coding patterns (switch defaults, null checks) are valuable
  '@typescript-eslint/no-unnecessary-condition': 'off',
  // Env var checks need || for truthy evaluation (empty string = missing)
  '@typescript-eslint/prefer-nullish-coalescing': 'off',
  // These have too many false positives with external SDKs
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-argument': 'off',
  '@typescript-eslint/no-misused-promises': 'off',
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/restrict-plus-operands': 'off',
  '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
  '@typescript-eslint/no-deprecated': 'off',
  '@typescript-eslint/require-await': 'off',
  '@typescript-eslint/consistent-generic-constructors': 'off',
},
```

### Success Criteria:

#### Automated Verification:

- [x] `bun run lint` shows only the 11 `no-non-null-assertion` errors (others gone)
- [x] No "warn" severity rules remain in config

---

## Phase 2: Fix Non-Null Assertion Issues

### Overview

Fix all 11 `no-non-null-assertion` errors by refactoring to avoid the `!` operator.

### Changes Required:

#### 2.1 Fix `packages/core/src/workflows/loader.ts:178`

**File**: `packages/core/src/workflows/loader.ts`
**Issue**: `steps!` used after validation, but TypeScript doesn't know it's defined
**Fix**: Restructure the return logic

```typescript
// Current (lines 160-179):
if (hasLoop && loopConfig) {
  return {
    name: raw.name,
    description: raw.description,
    provider,
    model,
    loop: loopConfig,
    prompt: raw.prompt as string,
  };
}

// Step-based workflow
return {
  name: raw.name,
  description: raw.description,
  provider,
  model,
  steps: steps!, // <-- Error here
};

// Fixed version:
if (hasLoop && loopConfig) {
  return {
    name: raw.name,
    description: raw.description,
    provider,
    model,
    loop: loopConfig,
    prompt: raw.prompt as string,
  };
}

// Step-based workflow - steps is guaranteed defined when hasSteps is true
if (!steps) {
  console.error(`[WorkflowLoader] Workflow ${filename} has no steps or loop`);
  return null;
}

return {
  name: raw.name,
  description: raw.description,
  provider,
  model,
  steps,
};
```

#### 2.2 Fix `packages/core/src/workflows/executor.ts:678-679`

**File**: `packages/core/src/workflows/executor.ts`
**Issue**: `workflow.loop!` and `workflow.prompt!` used after type narrowing
**Fix**: Add explicit type guard

```typescript
// Find the location (around line 675-680) and add guard:
// Current:
const loop = workflow.loop!;
const prompt = workflow.prompt!;

// Fixed - add explicit null check that helps TypeScript:
if (!('loop' in workflow) || !workflow.loop || !workflow.prompt) {
  throw new Error(`[WorkflowExecutor] Loop workflow missing required fields`);
}
const loop = workflow.loop;
const prompt = workflow.prompt;
```

#### 2.3 Fix `packages/core/src/handlers/command-handler.ts` (8 locations)

**File**: `packages/core/src/handlers/command-handler.ts`
**Lines**: 487, 565, 683, 925, 943, 1061, 1174, 1452
**Issue**: Various `!` assertions on potentially null values
**Fix**: Use `?? ''` or proper null checks

For each location, examine the context and apply one of these patterns:

```typescript
// Pattern A: Use nullish coalescing for string fallback
const value = possiblyNull ?? '';

// Pattern B: Early return if null
if (!value) {
  return { handled: true, response: 'Value not found' };
}

// Pattern C: Use optional chaining with fallback
const result = obj?.property ?? defaultValue;
```

**Specific fixes** (will examine each in implementation):

- Line 487: Check what's being asserted, add proper null handling
- Line 565: `codebase.default_cwd!` → `codebase.default_cwd ?? process.cwd()`
- Line 683: Similar pattern
- Lines 925, 943, 1061, 1174, 1452: Examine and fix each

### Success Criteria:

#### Automated Verification:

- [x] `bun run lint` exits with 0 (no errors, no warnings)
- [x] `bun run type-check` passes
- [x] `bun test` passes

---

## Phase 3: CI and Pre-commit Configuration

### Overview

Update CI to enforce zero warnings and add ESLint to pre-commit hooks.

### Changes Required:

#### 3.1 Update CI Workflow

**File**: `.github/workflows/test.yml`
**Changes**: Add `--max-warnings 0` to lint command, add format check

```yaml
# Update line 34-35:
- name: Lint
  run: bun run lint --max-warnings 0

- name: Check formatting
  run: bun run format:check
```

#### 3.2 Update lint-staged Configuration

**File**: `.lintstagedrc.json`
**Changes**: Add ESLint to pre-commit

```json
{
  "*.{ts,tsx}": ["eslint --fix --max-warnings 0", "prettier --write"],
  "*.{json,md,yaml,yml}": ["prettier --write"]
}
```

#### 3.3 Add Validation Script

**File**: `package.json`
**Changes**: Add `validate` script

```json
{
  "scripts": {
    "validate": "bun run type-check && bun run lint --max-warnings 0 && bun run format:check"
  }
}
```

### Success Criteria:

#### Automated Verification:

- [x] `bun run validate` passes
- [x] Pre-commit hook runs on staged `.ts` files
- [x] CI workflow includes format check step

---

## Phase 4: CLAUDE.md Documentation

### Overview

Add linting guidelines section to CLAUDE.md explaining how agents should handle lint issues.

### Changes Required:

#### 4.1 Add Linting Guidelines Section

**File**: `CLAUDE.md`
**Location**: After "### Linting & Formatting" section (around line 108)
**Changes**: Add new subsection

````markdown
### Pre-PR Validation

**Before creating a pull request, always run:**

```bash
bun run validate
```
````

This runs type-check, lint, and format check. All three must pass for CI to succeed.

**If validation fails:**

1. **Type errors**: Fix the type annotations
2. **Lint errors**: Fix the code (do not use inline disables without justification)
3. **Format errors**: Run `bun run format` to auto-fix

### ESLint Guidelines

**Zero-tolerance policy**: CI enforces `--max-warnings 0`. No warnings allowed.

**When to use inline disable comments** (`// eslint-disable-next-line`):

- **Almost never** - fix the issue instead
- Only acceptable when:
  1. External SDK types are incorrect (document which SDK and why)
  2. Intentional type assertion after validation (must include comment explaining the validation)

**Example of acceptable disable:**

```typescript
// Value validated above in parseWorkflow() - raw.steps checked for array
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const steps = validatedSteps!;
```

**Never acceptable:**

- Disabling `no-explicit-any` without justification
- Disabling rules to "make CI pass"
- Bulk disabling at file level (`/* eslint-disable */`)

**Disabled rules** (turned off globally, no need to suppress):

- `restrict-template-expressions` - Numbers in templates are valid JS
- `no-unnecessary-condition` - Defensive coding is encouraged
- `prefer-nullish-coalescing` - Truthy checks with `||` are intentional for env vars

```

### Success Criteria:

#### Manual Verification:
- [x] CLAUDE.md includes clear validation instructions
- [x] Guidelines explain when inline disables are acceptable
- [x] Disabled rules are documented with rationale

---

## Testing Strategy

### Automated Tests:
- All existing tests must pass after changes
- No new tests needed (this is configuration, not logic)

### Manual Testing Steps:
1. Make a commit with a lint error → pre-commit should fail
2. Make a commit with clean code → pre-commit should pass
3. Push to a branch → CI should run lint and format check
4. `bun run validate` should pass on clean codebase

---

## Implementation Order

1. **Phase 1** first - reduces warnings from 61 to 11
2. **Phase 2** second - fixes remaining 11 errors
3. **Phase 3** third - enables CI enforcement (only after code is clean)
4. **Phase 4** last - documents the policy

This order ensures we never have a broken CI state.

---

## References

- Research document: `thoughts/shared/research/2026-01-21-linting-formatting-biome-exploration.md`
- Current ESLint config: `eslint.config.mjs`
- Current CI workflow: `.github/workflows/test.yml`
- Lint-staged config: `.lintstagedrc.json`
```
