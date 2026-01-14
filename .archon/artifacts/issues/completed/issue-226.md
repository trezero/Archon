# Investigation: Add pre-commit hook to prevent formatting drift

**Issue**: #226 (https://github.com/dynamous-community/remote-coding-agent/issues/226)
**Type**: CHORE
**Investigated**: 2026-01-14T11:08:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | LOW | Quality-of-life improvement as noted by author; prevents future drift but doesn't fix existing bugs |
| Complexity | LOW | Only modifies package.json and adds 1-2 config files; no code changes required |
| Confidence | HIGH | Well-documented solution with clear implementation path; husky + lint-staged is industry standard |

---

## Problem Statement

Files were committed without running Prettier, causing 12 files to fail `bun run format:check` during E2E validation. This indicates a gap in the development workflow where formatting isn't enforced before commits.

---

## Analysis

### Root Cause / Change Rationale

The project lacks automated formatting enforcement. Developers can commit code without running `bun run format`, leading to inconsistent code style that only surfaces during CI validation or manual checks.

### Evidence Chain

WHY: Files fail format:check during E2E validation
↓ BECAUSE: Files were committed without being formatted
  Evidence: 12 files listed in issue had formatting inconsistencies

↓ BECAUSE: No pre-commit hook exists to enforce formatting
  Evidence: No `.husky/` directory, no `lefthook.yml`, no git hooks configured

↓ ROOT CAUSE: Missing automated formatting enforcement in git workflow
  Evidence: `package.json` has `format` script but no pre-commit hook integration

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `package.json` | scripts, devDeps | UPDATE | Add husky, lint-staged dependencies and prepare script |
| `.husky/pre-commit` | NEW | CREATE | Pre-commit hook that runs lint-staged |
| `.lintstagedrc.json` | NEW | CREATE | Configuration for lint-staged to format staged files |

### Integration Points

- `package.json` scripts section - add `prepare` script for husky init
- Git hooks directory `.git/hooks/` - husky will manage this
- CI/CD - no changes needed, format:check already runs in validation

### Git History

- **Current state**: No pre-commit hooks configured
- **Related commit**: `f0dec0c` - "fix: Update router prompt and apply Prettier formatting" (recent fix of formatting issues)
- **Implication**: This is a process improvement to prevent recurrence

---

## Implementation Plan

### Step 1: Install husky and lint-staged

**File**: `package.json`
**Action**: UPDATE (devDependencies section)

**Current code:**
```json
"devDependencies": {
  "@eslint/js": "^9.39.1",
  "@types/bun": "latest",
  ...
}
```

**Required change:**
```json
"devDependencies": {
  "@eslint/js": "^9.39.1",
  "@types/bun": "latest",
  ...
  "husky": "^9.1.7",
  "lint-staged": "^15.2.0"
}
```

**Why**: husky manages git hooks, lint-staged runs formatters only on staged files (faster than full format)

---

### Step 2: Add prepare script for husky initialization

**File**: `package.json`
**Action**: UPDATE (scripts section)

**Current code:**
```json
"scripts": {
  "dev": "bun --watch src/index.ts",
  "build": "bun build src/index.ts --outdir=dist --target=bun",
  ...
}
```

**Required change:**
```json
"scripts": {
  "dev": "bun --watch src/index.ts",
  "build": "bun build src/index.ts --outdir=dist --target=bun",
  "prepare": "husky",
  ...
}
```

**Why**: `prepare` script runs automatically after `bun install`, ensuring hooks are set up for all developers

---

### Step 3: Create lint-staged configuration

**File**: `.lintstagedrc.json`
**Action**: CREATE

**Content:**
```json
{
  "*.{ts,tsx,js,jsx,json}": ["prettier --write"],
  "*.md": ["prettier --write"]
}
```

**Why**: Only format file types that Prettier handles; excludes yaml/yml per .prettierignore

---

### Step 4: Initialize husky and create pre-commit hook

**Commands to run after dependency installation:**
```bash
# Install dependencies (this will run prepare script)
bun install

# Create pre-commit hook
echo "bun x lint-staged" > .husky/pre-commit
```

**File**: `.husky/pre-commit`
**Action**: CREATE

**Content:**
```bash
bun x lint-staged
```

**Why**: Uses bun's package executor to run lint-staged; simple one-liner hook

---

### Step 5: Verify setup works

**Validation commands:**
```bash
# Test that lint-staged works on staged files
echo "const x=1" > test-format.ts
git add test-format.ts
bun x lint-staged
# Should format the file
cat test-format.ts  # Should show "const x = 1;"
rm test-format.ts
git reset HEAD test-format.ts 2>/dev/null || true
```

---

## Patterns to Follow

**From codebase - mirror existing script naming:**

```json
// SOURCE: package.json scripts section
// Pattern for script naming - use simple, clear names
"format": "bun x prettier --write .",
"format:check": "bun x prettier --check ."
```

The `prepare` script follows npm/bun convention for post-install hooks.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Developers skip hooks with `--no-verify` | Document in CONTRIBUTING.md that this should be avoided |
| CI environments without git | husky's `prepare` script handles this gracefully (exits 0 if not a git repo) |
| Large staged changes slow down commits | lint-staged only processes staged files, not entire codebase |
| Bun vs npm compatibility | Using `bun x lint-staged` ensures bun runtime is used |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test
bun run lint
bun run format:check
```

### Manual Verification

1. Run `bun install` - should see husky setup message
2. Make a change to a `.ts` file without formatting
3. `git add` the file
4. `git commit` - should auto-format the file before commit
5. Verify the committed file is properly formatted

---

## Scope Boundaries

**IN SCOPE:**
- Adding husky for git hook management
- Adding lint-staged for staged file formatting
- Creating pre-commit hook configuration

**OUT OF SCOPE (do not touch):**
- ESLint pre-commit (could add later, separate issue)
- Type-checking pre-commit (too slow for pre-commit, leave for CI)
- Changing existing .prettierrc or .prettierignore
- Modifying any source code files

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-14T11:08:00Z
- **Artifact**: `.archon/artifacts/issues/issue-226.md`
