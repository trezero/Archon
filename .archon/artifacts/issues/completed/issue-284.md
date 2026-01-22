# Investigation: Config parse errors silently fall back to defaults

**Issue**: #284 (https://github.com/dynamous-community/remote-coding-agent/issues/284)
**Type**: BUG
**Investigated**: 2026-01-19T09:13:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | User's intended config (e.g., assistant: codex) is silently ignored, causing unexpected AI behavior with no visible error |
| Complexity | LOW | Only 2 files affected (config-loader.ts), isolated change to error handling in catch blocks |
| Confidence | HIGH | Root cause identified with evidence from code and reproduction; fix pattern exists in workflow loader |

---

## Problem Statement

When a user's `.archon/config.yaml` file contains invalid YAML syntax, the config-loader logs only a `console.warn()` and silently falls back to default values. This causes user confusion when their configuration (like `assistant: codex`) is ignored without any clear error indication. The user's workflow runs with Claude instead of their intended Codex configuration.

---

## Analysis

### Root Cause / Change Rationale

The error handling in `loadGlobalConfig()` and `loadRepoConfig()` doesn't distinguish between different error types. It checks for `ENOENT` (file not found), but YAML parse errors throw a `SyntaxError` which has no `.code` property - so they fall through to the `else` branch that only logs a warning.

### Evidence Chain

WHY: User config is silently ignored when YAML has syntax errors
↓ BECAUSE: The catch block treats YAML parse errors as non-critical
  Evidence: `src/config/config-loader.ts:91-100` - catch block only logs warning and returns empty object

↓ BECAUSE: The code only checks for `err.code === 'ENOENT'`
  Evidence: `src/config/config-loader.ts:93` - `if (err.code === 'ENOENT')`

↓ BECAUSE: `SyntaxError` from `Bun.YAML.parse()` has no `.code` property
  Evidence: Tested - `SyntaxError` has `code: undefined`, falls to `else` branch

↓ ROOT CAUSE: Error handling doesn't distinguish between "file missing" (expected) and "file corrupt" (user error)
  Evidence: `src/config/config-loader.ts:96-98`:
  ```typescript
  } else {
    console.warn(`[Config] Failed to load global config: ${err.message}`);  // Only a warning!
  }
  ```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/config/config-loader.ts` | 91-100 | UPDATE | Change `loadGlobalConfig()` to log error for parse failures |
| `src/config/config-loader.ts` | 119-127 | UPDATE | Change `loadRepoConfig()` to log error for parse failures |
| `src/config/config-loader.test.ts` | NEW | UPDATE | Add tests for YAML parse error handling |

### Integration Points

- `src/index.ts` calls `loadConfig()` at startup
- `src/orchestrator/orchestrator.ts` calls `loadConfig()` for codebase context
- `src/handlers/command-handler.ts` calls `loadConfig()` for command operations

### Git History

- **Introduced**: 3026a644 - 2025-12-17 - "Add Archon distribution config and directory structure"
- **Last modified**: 61af6fba - 2026-01-03 - "Linting and unit test fixes"
- **Implication**: This is an original design oversight, not a regression

---

## Implementation Plan

### Step 1: Update `loadGlobalConfig()` error handling

**File**: `src/config/config-loader.ts`
**Lines**: 91-100
**Action**: UPDATE

**Current code:**
```typescript
// Line 91-100
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      // File doesn't exist - create default config
      await createDefaultConfig(configPath);
    } else {
      console.warn(`[Config] Failed to load global config: ${err.message}`);
    }
    cachedGlobalConfig = {};
    return cachedGlobalConfig;
  }
```

**Required change:**
```typescript
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      // File doesn't exist - create default config
      await createDefaultConfig(configPath);
    } else {
      // YAML syntax errors or other parse failures - user should know their config is invalid
      console.error(`[Config] Failed to parse global config at ${configPath}: ${err.message}`);
      console.error(`[Config] Using default configuration. Please fix the YAML syntax in your config file.`);
    }
    cachedGlobalConfig = {};
    return cachedGlobalConfig;
  }
```

**Why**: Changes warning to error with actionable message including file path so users know their config is broken and which file to fix.

---

### Step 2: Update `loadRepoConfig()` error handling

**File**: `src/config/config-loader.ts`
**Lines**: 119-127
**Action**: UPDATE

**Current code:**
```typescript
// Line 119-127
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // File doesn't exist - expected, try next path
        continue;
      }
      // Unexpected error (syntax error, permission denied, etc) - log so users know their config has issues
      console.warn(`[Config] Failed to load repo config from ${configPath}: ${err.message}`);
      continue;
    }
```

**Required change:**
```typescript
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // File doesn't exist - expected, try next path
        continue;
      }
      // YAML syntax errors or other parse failures - user should know their config is invalid
      console.error(`[Config] Failed to parse repo config at ${configPath}: ${err.message}`);
      console.error(`[Config] Using default configuration. Please fix the YAML syntax in your config file.`);
      continue;
    }
```

**Why**: Same pattern as global config - change warning to error with actionable message.

---

### Step 3: Add tests for YAML parse error handling

**File**: `src/config/config-loader.test.ts`
**Action**: UPDATE

**Test cases to add:**
```typescript
describe('loadGlobalConfig', () => {
  // ... existing tests ...

  test('logs error for invalid YAML syntax', async () => {
    // Mock console.error to verify it's called
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    try {
      // Simulate YAML parse error (SyntaxError)
      const syntaxError = new SyntaxError('YAML Parse error: Multiline implicit key');
      mockReadConfigFile.mockRejectedValue(syntaxError);

      const config = await loadGlobalConfig();

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error (not just warning)
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls[0][0] as string;
      expect(errorCall).toContain('[Config] Failed to parse global config');
    } finally {
      console.error = originalError;
    }
  });
});

describe('loadRepoConfig', () => {
  // ... existing tests ...

  test('logs error for invalid YAML syntax', async () => {
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    try {
      // Simulate YAML parse error (SyntaxError)
      const syntaxError = new SyntaxError('YAML Parse error: Multiline implicit key');
      mockReadConfigFile.mockRejectedValue(syntaxError);

      const config = await loadRepoConfig('/test/repo');

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error (not just warning)
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls[0][0] as string;
      expect(errorCall).toContain('[Config] Failed to parse repo config');
    } finally {
      console.error = originalError;
    }
  });
});
```

---

## Patterns to Follow

**From codebase - workflow loader uses console.error for parse failures:**

```typescript
// SOURCE: src/workflows/loader.ts:180-191
// Pattern for handling YAML parse errors prominently
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    console.error(`[WorkflowLoader] Failed to parse ${filename}${lineInfo}:`, {
      error: err.message,
      contentPreview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
    });
    return null;
  }
```

**Logging pattern from codebase - errors use console.error:**

```typescript
// SOURCE: src/index.ts:63
// Database connection failures use console.error
console.error('[Database] Connection failed:', error);

// SOURCE: src/handlers/command-handler.ts:559
// Clone failures use console.error
console.error('[Clone] Failed:', safeErr.message);
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Breaking existing behavior | Fallback to defaults still occurs, only logging level changes |
| Too much noise in logs | Error only logged once per load, and only for actual parse failures |
| Test isolation | Mock console.error in tests to avoid test output pollution |
| Permission denied errors | These also have no ENOENT code, will be logged as errors (appropriate since user can't read their own config) |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/config/config-loader.test.ts
bun run lint
```

### Manual Verification

1. Create an invalid config file:
   ```bash
   echo "assistant: codex
   streaming
     telegram: batch" > ~/.archon/config.yaml
   ```
2. Start the app with `bun run dev`
3. Verify `[Config] Failed to parse global config` appears in logs as ERROR (not warning)
4. Verify the app still starts (falls back to defaults)
5. Fix the config file and restart to verify valid configs work

---

## Scope Boundaries

**IN SCOPE:**
- Change `console.warn` to `console.error` for parse failures in config-loader.ts
- Add informative message directing users to fix their config
- Add tests for parse error handling

**OUT OF SCOPE (do not touch):**
- Throwing errors to halt startup (would be too disruptive)
- Adding YAML schema validation (separate enhancement)
- Modifying workflow loader or other YAML-parsing code
- Adding retry logic or config repair features

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-19T09:13:00Z
- **Artifact**: `.archon/artifacts/issues/issue-284.md`
