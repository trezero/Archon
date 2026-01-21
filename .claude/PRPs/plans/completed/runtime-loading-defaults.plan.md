# Feature: Runtime Loading of Default Commands/Workflows

## Summary

Remove the copy-on-clone behavior for default commands/workflows and instead load them at runtime from the app's bundled `defaults/` directories. This eliminates sync issues between cloned repos and the app, keeps repos clean, and ensures defaults are always up-to-date.

## User Story

As a user working with Archon
I want default commands and workflows to be loaded at runtime from the app
So that I always have the latest defaults without sync issues or repo clutter

## Problem Statement

After the monorepo refactor, `getAppArchonBasePath()` returns `packages/core/.archon` instead of the repo root's `.archon`, breaking the default copying mechanism. Additionally, the copy-based approach has fundamental issues:
- Defaults copied to `~/.archon/workspaces/` never sync back to user's local clone or GitHub
- User works in their local clone, Archon works in workspace clone - two separate worlds
- Repos get cluttered with 24+ default files

## Solution Statement

Change from copy-on-clone to runtime discovery:
1. Fix `getAppArchonBasePath()` to resolve to repo root (not `packages/core/`)
2. Update workflow and command discovery to search the app's bundled defaults directory in addition to the target repo's directories
3. Add config options `loadDefaultCommands` and `loadDefaultWorkflows` for opt-out
4. Remove the `copyDefaultsToRepo()` calls from `/clone` and GitHub adapter

## Metadata

| Field | Value |
|-------|-------|
| Type | BUG_FIX + ENHANCEMENT |
| Complexity | MEDIUM |
| Systems Affected | archon-paths, config, workflow-loader, executor, command-handler, github-adapter |
| Dependencies | None (internal refactor) |
| Estimated Tasks | 9 |

---

## UX Design

### Before State
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BEFORE: COPY ON CLONE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────────┐                  ┌─────────────────────────────┐    │
│   │  /clone repo     │ ───────────────► │ Copy 24 files to            │    │
│   │  (or GitHub      │                  │ ~/.archon/workspaces/repo/  │    │
│   │   auto-clone)    │                  │ .archon/commands/           │    │
│   └──────────────────┘                  │ .archon/workflows/          │    │
│                                         └─────────────────────────────┘    │
│                                                    │                        │
│   PROBLEMS:                                        ▼                        │
│   ❌ Path resolution broken (returns packages/core/.archon)                 │
│   ❌ Defaults never sync back to user's local clone                         │
│   ❌ 24 files copied per repo (clutter)                                     │
│   ❌ User's local clone ≠ workspace clone (confusion)                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### After State
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             AFTER: RUNTIME LOADING                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────────┐                  ┌─────────────────────────────┐    │
│   │  /clone repo     │ ───────────────► │ Just clone + load commands  │    │
│   │  (or GitHub      │                  │ (no file copying)           │    │
│   │   auto-clone)    │                  └─────────────────────────────┘    │
│   └──────────────────┘                                                      │
│                                                                             │
│   RUNTIME COMMAND/WORKFLOW INVOCATION:                                      │
│                                                                             │
│   ┌──────────────────┐      ┌──────────────────────────────────────────┐   │
│   │ /command-invoke  │ ──►  │ Search in order:                         │   │
│   │ assist           │      │ 1. repo/.archon/commands/assist.md       │   │
│   │                  │      │ 2. repo/.archon/commands/defaults/       │   │
│   │                  │      │ 3. APP/.archon/commands/defaults/  ←NEW  │   │
│   └──────────────────┘      └──────────────────────────────────────────┘   │
│                                                                             │
│   ┌──────────────────┐      ┌──────────────────────────────────────────┐   │
│   │ /workflow list   │ ──►  │ Discover from:                           │   │
│   │                  │      │ 1. repo/.archon/workflows/ (recursive)   │   │
│   │                  │      │ 2. APP/.archon/workflows/defaults/ ←NEW  │   │
│   └──────────────────┘      └──────────────────────────────────────────┘   │
│                                                                             │
│   BENEFITS:                                                                 │
│   ✅ Always have latest defaults                                            │
│   ✅ Clean repos (no clutter)                                               │
│   ✅ No sync issues                                                         │
│   ✅ Repo commands override app defaults (priority order)                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| `/clone` | Copies 24 default files | Just clones repo | Faster, cleaner |
| GitHub auto-clone | Copies 24 default files | Just clones repo | Cleaner workspace |
| `/command-invoke` | Searches repo only | Searches repo + app defaults | Always finds defaults |
| `/workflow list` | Lists repo workflows only | Lists repo + app defaults | Always sees defaults |
| Config | `copyDefaults: false` to opt-out | `loadDefaultCommands/Workflows: false` | More granular control |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/utils/archon-paths.ts` | 118-137 | Path resolution functions to FIX |
| P0 | `packages/core/src/workflows/loader.ts` | 205-271 | Workflow discovery pattern to EXTEND |
| P0 | `packages/core/src/workflows/executor.ts` | 263-328 | Command loading pattern to EXTEND |
| P1 | `packages/core/src/config/config-types.ts` | 113-156 | Config types to UPDATE |
| P1 | `packages/core/src/utils/defaults-copy.ts` | all | Function to understand (will remove calls) |
| P2 | `packages/core/src/handlers/command-handler.ts` | 692-733 | Clone handler to UPDATE |
| P2 | `packages/server/src/adapters/github.ts` | 796-819 | GitHub adapter to UPDATE |
| P3 | `packages/core/src/utils/archon-paths.test.ts` | all | Test pattern to FOLLOW |
| P3 | `packages/core/src/utils/defaults-copy.test.ts` | all | Test pattern to FOLLOW |
| P3 | `packages/core/src/workflows/loader.test.ts` | 1-100 | Test pattern to FOLLOW |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| Bun Test Docs | spyOn, mock | Testing patterns |

---

## Patterns to Mirror

**NAMING_CONVENTION:**
```typescript
// SOURCE: packages/core/src/utils/archon-paths.ts:88-101
// COPY THIS PATTERN for search path functions:
export function getCommandFolderSearchPaths(configuredFolder?: string): string[] {
  const paths = ['.archon/commands', '.archon/commands/defaults'];
  // Add configured folder if specified (and not already in paths)
  if (configuredFolder &&
      configuredFolder !== '.archon/commands' &&
      configuredFolder !== '.archon/commands/defaults') {
    paths.push(configuredFolder);
  }
  return paths;
}
```

**CONFIG_TYPE_PATTERN:**
```typescript
// SOURCE: packages/core/src/config/config-types.ts:113-123
// COPY THIS PATTERN for config options:
defaults?: {
  /**
   * Copy bundled default commands and workflows on clone
   * Set to false to skip copying defaults
   * @default true
   */
  copyDefaults?: boolean;
};
```

**WORKFLOW_DISCOVERY_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/loader.ts:245-271
// COPY THIS PATTERN for workflow discovery:
export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
  const [workflowFolder] = getWorkflowFolderSearchPaths();
  const workflowPath = join(cwd, workflowFolder);

  console.log(`[WorkflowLoader] Searching for workflows in: ${workflowPath}`);

  try {
    await access(workflowPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log(`[WorkflowLoader] No workflow folder found at: ${workflowPath}`);
      return [];
    }
    throw new Error(`Cannot access workflow folder...`);
  }

  const workflows = await loadWorkflowsFromDir(workflowPath);
  return workflows;
}
```

**COMMAND_LOADING_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/executor.ts:278-328
// COPY THIS PATTERN for command search:
const searchPaths = getCommandFolderSearchPaths(configuredFolder);

for (const folder of searchPaths) {
  const filePath = join(cwd, folder, `${commandName}.md`);
  try {
    await access(filePath);
    const content = await readFile(filePath, 'utf-8');
    // ... validation
    return { success: true, content };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      continue; // Try next path
    }
    // Handle other errors
  }
}
```

**TEST_STRUCTURE:**
```typescript
// SOURCE: packages/core/src/utils/archon-paths.test.ts:15-33
// COPY THIS PATTERN for environment testing:
describe('archon-paths', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envVars = ['WORKSPACE_PATH', 'ARCHON_DOCKER', 'HOME'];

  beforeEach(() => {
    envVars.forEach(key => {
      originalEnv[key] = process.env[key];
    });
  });

  afterEach(() => {
    envVars.forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `packages/core/src/utils/archon-paths.ts` | UPDATE | Fix `getAppArchonBasePath()` path resolution |
| `packages/core/src/config/config-types.ts` | UPDATE | Add `loadDefaultCommands` and `loadDefaultWorkflows` options |
| `packages/core/src/config/config-loader.ts` | UPDATE | Add defaults for new config options |
| `packages/core/src/workflows/loader.ts` | UPDATE | Add app defaults to workflow discovery |
| `packages/core/src/workflows/executor.ts` | UPDATE | Add app defaults to command search paths |
| `packages/core/src/handlers/command-handler.ts` | UPDATE | Remove `copyDefaultsToRepo()` call, update response |
| `packages/server/src/adapters/github.ts` | UPDATE | Remove `copyDefaultsToRepo()` call |
| `packages/core/src/utils/archon-paths.test.ts` | UPDATE | Add tests for fixed path resolution |
| `packages/core/src/workflows/loader.test.ts` | UPDATE | Add tests for multi-source loading |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **Symlink approach**: Not implementing symlinks as alternative - pure runtime loading is simpler
- **Database storage of defaults**: Keeping file-based discovery, not moving to DB
- **CLI bundling changes**: This issue doesn't address the separate concern of CLI binary distribution
- **Global config path changes**: Only adding new config options, not changing structure
- **Deprecation warnings**: Not adding warnings for `copyDefaults` - just keep it functional

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: FIX `packages/core/src/utils/archon-paths.ts` - Fix path resolution

- **ACTION**: UPDATE `getAppArchonBasePath()` to correctly resolve to repo root
- **IMPLEMENT**:
  - Current code goes up 2 directories from `import.meta.dir` (utils → src → core)
  - Need to go up 4 directories: utils → src → core → packages → root
  - Add Docker fallback (already has one, just verify it works)
- **LOCATION**: Lines 118-123
- **CURRENT CODE**:
  ```typescript
  export function getAppArchonBasePath(): string {
    // This file is at src/utils/archon-paths.ts
    // Go up from src/utils to repo root
    const srcDir = dirname(dirname(import.meta.dir));
    return join(srcDir, '.archon');
  }
  ```
- **NEW CODE**:
  ```typescript
  export function getAppArchonBasePath(): string {
    // This file is at packages/core/src/utils/archon-paths.ts
    // Go up from utils → src → core → packages → repo root
    // import.meta.dir = packages/core/src/utils
    const repoRoot = dirname(dirname(dirname(dirname(import.meta.dir))));
    return join(repoRoot, '.archon');
  }
  ```
- **GOTCHA**: `import.meta.dir` in Bun returns the directory containing the file, not the file path itself
- **VALIDATE**: `bun test packages/core/src/utils/archon-paths.test.ts`

### Task 2: UPDATE `packages/core/src/config/config-types.ts` - Add new config options

- **ACTION**: UPDATE the `RepoConfig` interface to add granular defaults config
- **IMPLEMENT**: Add `loadDefaultCommands` and `loadDefaultWorkflows` boolean options
- **LOCATION**: Lines 113-123 (inside `defaults?:` block)
- **CURRENT CODE**:
  ```typescript
  defaults?: {
    /**
     * Copy bundled default commands and workflows on clone
     * Set to false to skip copying defaults
     * @default true
     */
    copyDefaults?: boolean;
  };
  ```
- **NEW CODE**:
  ```typescript
  defaults?: {
    /**
     * Copy bundled default commands and workflows on clone
     * Set to false to skip copying defaults
     * @default true
     * @deprecated Use loadDefaultCommands/loadDefaultWorkflows instead
     */
    copyDefaults?: boolean;

    /**
     * Load app's bundled default commands at runtime
     * Set to false to only use repo-specific commands
     * @default true
     */
    loadDefaultCommands?: boolean;

    /**
     * Load app's bundled default workflows at runtime
     * Set to false to only use repo-specific workflows
     * @default true
     */
    loadDefaultWorkflows?: boolean;
  };
  ```
- **ALSO UPDATE**: `MergedConfig` interface (lines 153-155) to include new fields:
  ```typescript
  defaults: {
    copyDefaults: boolean;
    loadDefaultCommands: boolean;
    loadDefaultWorkflows: boolean;
  };
  ```
- **VALIDATE**: `bun run type-check`

### Task 3: UPDATE `packages/core/src/config/config-loader.ts` - Add defaults for new options

- **ACTION**: UPDATE the `getDefaults()` function to include new config options
- **IMPLEMENT**: Add `loadDefaultCommands: true` and `loadDefaultWorkflows: true` to defaults
- **LOCATION**: Find `getDefaults()` function, update the `defaults:` block
- **MIRROR**: Existing default pattern in the function
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE `packages/core/src/workflows/loader.ts` - Add app defaults to workflow discovery

- **ACTION**: UPDATE `discoverWorkflows()` to also load from app's defaults directory
- **IMPLEMENT**:
  1. Import `getDefaultWorkflowsPath` from `archon-paths`
  2. Import `loadConfig` from `config-loader`
  3. Load config to check `loadDefaultWorkflows` setting
  4. First load from app defaults (if enabled), then load from repo (repo overrides)
  5. Dedupe by workflow name (repo wins on collision)
- **LOCATION**: Lines 245-271
- **NEW IMPLEMENTATION**:
  ```typescript
  export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
    const workflows: WorkflowDefinition[] = [];

    // Load config to check opt-out settings
    let config;
    try {
      config = await loadConfig(cwd);
    } catch {
      config = { defaults: { loadDefaultWorkflows: true } };
    }

    // 1. Load from app's bundled defaults (unless opted out)
    if (config.defaults?.loadDefaultWorkflows !== false) {
      const appDefaultsPath = getDefaultWorkflowsPath();
      console.log(`[WorkflowLoader] Loading app defaults from: ${appDefaultsPath}`);
      try {
        await access(appDefaultsPath);
        const appWorkflows = await loadWorkflowsFromDir(appDefaultsPath);
        workflows.push(...appWorkflows);
        console.log(`[WorkflowLoader] Loaded ${appWorkflows.length} app default workflows`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.warn(`[WorkflowLoader] Could not access app defaults: ${err.message}`);
        }
      }
    }

    // 2. Load from repo's workflow folder (overrides app defaults)
    const [workflowFolder] = getWorkflowFolderSearchPaths();
    const workflowPath = join(cwd, workflowFolder);

    console.log(`[WorkflowLoader] Searching for workflows in: ${workflowPath}`);

    try {
      await access(workflowPath);
      const repoWorkflows = await loadWorkflowsFromDir(workflowPath);

      // Dedupe: repo workflows override app defaults by name
      for (const repoWorkflow of repoWorkflows) {
        const existingIndex = workflows.findIndex(w => w.name === repoWorkflow.name);
        if (existingIndex >= 0) {
          console.log(`[WorkflowLoader] Repo workflow '${repoWorkflow.name}' overrides app default`);
          workflows[existingIndex] = repoWorkflow;
        } else {
          workflows.push(repoWorkflow);
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw new Error(`Cannot access workflow folder at ${workflowPath}: ${err.message}`);
      }
      console.log(`[WorkflowLoader] No workflow folder found at: ${workflowPath}`);
    }

    console.log(`[WorkflowLoader] Total workflows loaded: ${workflows.length}`);
    return workflows;
  }
  ```
- **IMPORTS TO ADD**: `getDefaultWorkflowsPath` from `../utils/archon-paths`, `loadConfig` from `../config/config-loader`
- **GOTCHA**: Must handle case where app defaults don't exist (e.g., in tests)
- **VALIDATE**: `bun test packages/core/src/workflows/loader.test.ts`

### Task 5: UPDATE `packages/core/src/workflows/executor.ts` - Add app defaults to command search

- **ACTION**: UPDATE `loadCommandPrompt()` to also search app's defaults directory
- **IMPLEMENT**:
  1. Import `getDefaultCommandsPath` from `archon-paths`
  2. Import `loadConfig` from `config-loader`
  3. After searching repo paths, also search app defaults (if enabled)
- **LOCATION**: Lines 263-328
- **CHANGES**:
  - Add app defaults path to search after repo paths
  - Check config for `loadDefaultCommands` opt-out
- **NEW IMPLEMENTATION** (key changes):
  ```typescript
  async function loadCommandPrompt(
    cwd: string,
    commandName: string,
    configuredFolder?: string
  ): Promise<LoadCommandResult> {
    // Validate command name first
    if (!isValidCommandName(commandName)) {
      // ... existing validation
    }

    // Load config to check opt-out
    let config;
    try {
      config = await loadConfig(cwd);
    } catch {
      config = { defaults: { loadDefaultCommands: true } };
    }

    // Use command folder paths with optional configured folder
    const searchPaths = getCommandFolderSearchPaths(configuredFolder);

    // Search repo paths first
    for (const folder of searchPaths) {
      const filePath = join(cwd, folder, `${commandName}.md`);
      // ... existing try/catch logic
    }

    // If not found in repo and app defaults enabled, search app defaults
    if (config.defaults?.loadDefaultCommands !== false) {
      const appDefaultsPath = getDefaultCommandsPath();
      const filePath = join(appDefaultsPath, `${commandName}.md`);
      try {
        await access(filePath);
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) {
          // Empty file - fall through to not found
        } else {
          console.log(`[WorkflowExecutor] Loaded command from app defaults: ${commandName}.md`);
          return { success: true, content };
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.warn(`[WorkflowExecutor] Error reading app default: ${err.message}`);
        }
        // Fall through to not found
      }
    }

    // Not found anywhere
    const allSearchPaths = config.defaults?.loadDefaultCommands !== false
      ? [...searchPaths, 'app defaults']
      : searchPaths;
    console.error(`[WorkflowExecutor] Command not found: ${commandName}.md (searched: ${allSearchPaths.join(', ')})`);
    return {
      success: false,
      reason: 'not_found',
      message: `Command prompt not found: ${commandName}.md`,
    };
  }
  ```
- **IMPORTS TO ADD**: `getDefaultCommandsPath` from `../utils/archon-paths`, `loadConfig` from `../config/config-loader`
- **VALIDATE**: `bun test packages/core/src/workflows/executor.test.ts`

### Task 6: UPDATE `packages/core/src/handlers/command-handler.ts` - Remove copy call from /clone

- **ACTION**: REMOVE the `copyDefaultsToRepo()` call and related response messages
- **IMPLEMENT**:
  1. Remove the import of `copyDefaultsToRepo` if no longer used elsewhere in the file
  2. Remove the `copyResult` variable declaration and try/catch block
  3. Update the response message to remove copy-related lines
- **LOCATION**: Lines 692-758
- **CHANGES**:
  - Delete lines 692-708 (copyResult declaration and try/catch)
  - Update response message (lines 735-752) to remove copy-related conditionals
- **NEW RESPONSE MESSAGE**:
  ```typescript
  let responseMessage = `Repository cloned successfully!\n\nRepository: ${repoName}`;
  if (commandsLoaded > 0) {
    responseMessage += `\n✓ Loaded ${String(commandsLoaded)} commands`;
  }
  responseMessage += '\n✓ App defaults available at runtime';
  responseMessage +=
    '\n\nSession reset - starting fresh on next message.\n\nYou can now start asking questions about the code.';
  ```
- **VALIDATE**: `bun test packages/core/src/handlers/command-handler.test.ts`

### Task 7: UPDATE `packages/server/src/adapters/github.ts` - Remove copy call

- **ACTION**: REMOVE the `copyDefaultsToRepo()` call from GitHub adapter
- **IMPLEMENT**:
  1. Remove the import of `copyDefaultsToRepo` from `@archon/core`
  2. Remove the try/catch block calling `copyDefaultsToRepo` (lines 798-816)
  3. Keep `autoDetectAndLoadCommands` call
- **LOCATION**: Lines 796-819
- **CURRENT CODE TO REMOVE**:
  ```typescript
  // Copy default commands/workflows if target doesn't have them (non-fatal)
  try {
    const copyResult = await copyDefaultsToRepo(repoPath);
    // ... logging
  } catch (copyError) {
    // ... error handling
  }
  ```
- **VALIDATE**: `bun test packages/server/src/adapters/github.test.ts`

### Task 8: UPDATE `packages/core/src/utils/archon-paths.test.ts` - Add tests for fixed path

- **ACTION**: ADD tests for `getAppArchonBasePath()` and `getDefaultCommandsPath()`
- **IMPLEMENT**: Add new describe block with tests for the fixed path resolution
- **LOCATION**: After existing tests
- **NEW TESTS**:
  ```typescript
  describe('getAppArchonBasePath', () => {
    test('returns repo root .archon path in local development', () => {
      delete process.env.ARCHON_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getAppArchonBasePath();
      // Should end with .archon and NOT contain packages/core
      expect(path).toMatch(/\.archon$/);
      expect(path).not.toContain('packages/core');
    });
  });

  describe('getDefaultCommandsPath', () => {
    test('returns commands/defaults under app archon base', () => {
      delete process.env.ARCHON_DOCKER;
      const path = getDefaultCommandsPath();
      expect(path).toContain('.archon');
      expect(path).toContain('commands');
      expect(path).toContain('defaults');
    });
  });

  describe('getDefaultWorkflowsPath', () => {
    test('returns workflows/defaults under app archon base', () => {
      delete process.env.ARCHON_DOCKER;
      const path = getDefaultWorkflowsPath();
      expect(path).toContain('.archon');
      expect(path).toContain('workflows');
      expect(path).toContain('defaults');
    });
  });
  ```
- **IMPORTS TO ADD**: `getAppArchonBasePath, getDefaultCommandsPath, getDefaultWorkflowsPath`
- **VALIDATE**: `bun test packages/core/src/utils/archon-paths.test.ts`

### Task 9: UPDATE `packages/core/src/workflows/loader.test.ts` - Add multi-source loading tests

- **ACTION**: ADD tests for loading workflows from both app defaults and repo
- **IMPLEMENT**: Test that app defaults are loaded and repo workflows override them
- **LOCATION**: Add new describe block at the end
- **NEW TESTS**:
  ```typescript
  describe('multi-source loading', () => {
    it('should load workflows from app defaults when repo has none', async () => {
      // Create test dir without .archon/workflows
      // Mock getDefaultWorkflowsPath to return a temp dir with workflows
      // Verify workflows are discovered
    });

    it('should override app defaults with repo workflows of same name', async () => {
      // Create test dir with .archon/workflows containing a workflow named 'assist'
      // Mock getDefaultWorkflowsPath to return a temp dir also with 'assist'
      // Verify repo version wins
    });

    it('should skip app defaults when loadDefaultWorkflows is false', async () => {
      // Create test dir with .archon/config.yaml containing defaults.loadDefaultWorkflows: false
      // Verify app defaults are not loaded
    });
  });
  ```
- **VALIDATE**: `bun test packages/core/src/workflows/loader.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `archon-paths.test.ts` | `getAppArchonBasePath()` returns correct repo root path | Path resolution fix |
| `archon-paths.test.ts` | `getDefaultCommandsPath()` returns correct defaults path | Defaults path |
| `loader.test.ts` | Loads from app defaults when repo has no workflows | Multi-source loading |
| `loader.test.ts` | Repo workflows override app defaults by name | Priority order |
| `loader.test.ts` | Respects `loadDefaultWorkflows: false` config | Opt-out works |
| `executor.test.ts` | Commands found in app defaults when not in repo | Multi-source loading |
| `executor.test.ts` | Respects `loadDefaultCommands: false` config | Opt-out works |

### Edge Cases Checklist

- [ ] App defaults directory doesn't exist (e.g., in tests)
- [ ] Repo has no `.archon/` directory at all
- [ ] Config file is malformed or missing
- [ ] Same workflow/command name in both app and repo (repo wins)
- [ ] `loadDefaultCommands: false` but `loadDefaultWorkflows: true` (independent)
- [ ] Docker environment (different paths)
- [ ] Empty workflow/command files

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run lint && bun run type-check
```

**EXPECT**: Exit 0, no errors or warnings

### Level 2: UNIT_TESTS

```bash
bun test packages/core/src/utils/archon-paths.test.ts
bun test packages/core/src/workflows/loader.test.ts
bun test packages/core/src/workflows/executor.test.ts
bun test packages/core/src/handlers/command-handler.test.ts
bun test packages/server/src/adapters/github.test.ts
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

1. **Test path resolution fix**:
   ```bash
   # In repo root, check the path
   bun -e "import { getAppArchonBasePath } from './packages/core/src/utils/archon-paths'; console.log(getAppArchonBasePath())"
   # Should output: /path/to/repo/.archon (NOT packages/core/.archon)
   ```

2. **Test workflow discovery**:
   ```bash
   # Run CLI to list workflows - should show app defaults
   bun run cli workflow list
   ```

3. **Test command loading**:
   ```bash
   # Run a default command that exists only in app defaults
   bun run cli workflow run assist "What is this repo about?"
   ```

---

## Acceptance Criteria

- [ ] `getAppArchonBasePath()` returns correct path to repo root's `.archon/`
- [ ] App's default commands loaded from `.archon/commands/defaults/` at runtime
- [ ] App's default workflows loaded from `.archon/workflows/defaults/` at runtime
- [ ] Target repo's `.archon/commands/` and `.archon/workflows/` also loaded (additive)
- [ ] Repo-specific commands/workflows override app defaults on name collision
- [ ] Config options `loadDefaultCommands` and `loadDefaultWorkflows` for opt-out
- [ ] No more copying of defaults to target repos on `/clone` or GitHub auto-clone
- [ ] Works in Docker environment
- [ ] All existing tests pass
- [ ] New tests added for multi-source loading

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: Static analysis (lint + type-check) passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full test suite + build succeeds
- [ ] Level 4: Manual validation passes
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| App defaults path not found in Docker | LOW | HIGH | Verify Docker path resolution works; the `isDocker()` check should handle this |
| Tests depend on file system structure | MED | MED | Use temp directories and mocks; don't depend on actual repo structure |
| Breaking existing tests that mock `copyDefaultsToRepo` | MED | LOW | Update mocks in tests that depend on the copy behavior |
| Performance impact from double file access | LOW | LOW | File system caching makes this negligible; most calls hit cache |

---

## Notes

**Why not symlinks?**: While symlinks would be simpler to implement, they add complexity around cross-platform support (Windows) and might cause confusion when users inspect their repos. Pure runtime loading is cleaner.

**Backwards compatibility**: The `copyDefaults` config option is kept functional but deprecated. Users with `copyDefaults: false` won't get defaults loaded at runtime unless they also set `loadDefaultCommands: true` / `loadDefaultWorkflows: true`. This is intentional - if they opted out of defaults before, they should opt into runtime loading explicitly.

**Future CLI binary distribution**: This change prepares the codebase for a future where the CLI is distributed as a standalone binary. In that case, the app defaults would need to be bundled with the binary, but the runtime loading pattern established here would still apply.
