# Feature: Default Commands and Workflows

## Summary

Automatically copy bundled default commands and workflows to newly cloned repositories. The defaults are stored in `.archon/commands/defaults/` and `.archon/workflows/defaults/` within the app repository. These defaults serve dual purpose: (1) they're loaded and usable by this repo itself, and (2) they get copied to target repos on `/clone`. Users can opt-out via config.

## User Story

As a user who clones a new repository via Archon
I want default commands and workflows automatically available
So that I have a working starting point without creating commands from scratch

As a developer working on the Archon app itself
I want the defaults to be loaded from the defaults/ subfolder
So that I can use and test the same commands that users will receive

## Problem Statement

When a user clones a repository that doesn't have `.archon/commands/` or `.archon/workflows/`, they have no commands or workflows available. They must manually create everything from scratch, creating a poor onboarding experience.

## Solution Statement

1. Move existing commands/workflows to `.archon/{commands,workflows}/defaults/` subdirectories
2. Existing recursive loading already picks up files in subdirectories (no change needed)
3. On `/clone`, copy contents of app's `defaults/` to target's `.archon/{commands,workflows}/` (flat, not nested)
4. This repo can have additional commands outside `defaults/` that are repo-specific and won't be copied
5. Add config option `defaults.copyDefaults: false` to opt out
6. Apply same logic for GitHub adapter's auto-clone behavior

## Metadata

| Field            | Value                                             |
| ---------------- | ------------------------------------------------- |
| Type             | NEW_CAPABILITY                                    |
| Complexity       | MEDIUM                                            |
| Systems Affected | command-handler.ts, github.ts, config-types.ts, archon-paths.ts |
| Dependencies     | fs/promises (native), existing worktree-copy.ts patterns |
| Estimated Tasks  | 9                                                 |

---

## UX Design

### Before State
```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   APP REPO STRUCTURE:                                                         ║
║   .archon/                                                                    ║
║   ├── commands/                                                               ║
║   │   ├── assist.md          ◄── All commands at root level                  ║
║   │   ├── implement.md                                                        ║
║   │   └── ...                                                                 ║
║   └── workflows/                                                              ║
║       ├── fix-github-issue.yaml                                               ║
║       └── ...                                                                 ║
║                                                                               ║
║   User: /clone https://github.com/user/new-project                            ║
║                     │                                                          ║
║                     ▼                                                          ║
║   TARGET REPO: No commands, no workflows → User must create from scratch      ║
║                                                                               ║
║   PAIN_POINTS:                                                                ║
║   1. New users have no commands after cloning                                 ║
║   2. No distinction between "defaults to share" vs "repo-specific"            ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State
```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   APP REPO STRUCTURE:                                                         ║
║   .archon/                                                                    ║
║   ├── commands/                                                               ║
║   │   ├── defaults/          ◄── Shared defaults (copied to targets)         ║
║   │   │   ├── assist.md                                                       ║
║   │   │   ├── implement.md                                                    ║
║   │   │   └── ...                                                             ║
║   │   └── repo-specific.md   ◄── Only for this repo (NOT copied)             ║
║   └── workflows/                                                              ║
║       ├── defaults/          ◄── Shared defaults (copied to targets)         ║
║       │   ├── fix-github-issue.yaml                                           ║
║       │   └── ...                                                             ║
║       └── repo-specific.yaml ◄── Only for this repo (NOT copied)             ║
║                                                                               ║
║   User: /clone https://github.com/user/new-project                            ║
║                     │                                                          ║
║                     ▼                                                          ║
║   TARGET REPO:                                                                ║
║   .archon/                                                                    ║
║   ├── commands/              ◄── Defaults copied here (flat, not nested)     ║
║   │   ├── assist.md                                                           ║
║   │   ├── implement.md                                                        ║
║   │   └── ...                                                                 ║
║   └── workflows/             ◄── Defaults copied here (flat, not nested)     ║
║       ├── fix-github-issue.yaml                                               ║
║       └── ...                                                                 ║
║                                                                               ║
║   DUAL PURPOSE:                                                               ║
║   1. App repo loads from defaults/ (recursive search includes subdirs)        ║
║   2. Target repos get defaults/ contents copied to their root .archon/        ║
║                                                                               ║
║   OPT-OUT: Target can set `defaults.copyDefaults: false` in config.yaml       ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes
| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| `/clone` | No commands if repo empty | Copies defaults automatically | Has commands immediately |
| GitHub webhook | No commands if repo empty | Copies defaults automatically | Has commands immediately |
| `.archon/config.yaml` | N/A | Can set `defaults.copyDefaults: false` | Can opt out of defaults |
| `/status` | Shows "No commands" | Shows copied default commands | Clear visibility of what's available |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/handlers/command-handler.ts` | 335-534 | Clone command implementation to modify |
| P0 | `src/handlers/command-handler.ts` | 56-85 | `findMarkdownFilesRecursive` pattern to use |
| P0 | `src/utils/worktree-copy.ts` | 86-150 | File copy pattern with security checks |
| P1 | `src/adapters/github.ts` | 453-479 | GitHub adapter command loading to modify |
| P1 | `src/config/config-types.ts` | 69-111 | RepoConfig structure to extend |
| P1 | `src/config/config-loader.ts` | 109-133 | How repo config is loaded |
| P2 | `src/utils/archon-paths.ts` | 70-104 | Path helper functions to extend |

---

## Patterns to Mirror

**FILE_COPY_PATTERN:**
```typescript
// SOURCE: src/utils/worktree-copy.ts:86-150
// COPY THIS PATTERN for copying files with security checks:
export async function copyWorktreeFile(
  sourceRoot: string,
  destRoot: string,
  entry: CopyFileEntry
): Promise<boolean> {
  // Security: Validate paths don't escape their roots
  if (!isPathWithinRoot(sourceRoot, entry.source)) {
    console.error('[WorktreeCopy] Path traversal blocked', {
      source: entry.source,
      sourceRoot,
      reason: 'Source path escapes repository root',
    });
    return false;
  }

  const sourcePath = join(sourceRoot, entry.source);
  const destPath = join(destRoot, entry.destination);

  try {
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);
    return true;
  } catch (error) {
    // Handle gracefully
    return false;
  }
}
```

**CONFIG_TYPE_PATTERN:**
```typescript
// SOURCE: src/config/config-types.ts:69-111
// COPY THIS PATTERN for adding new config options:
export interface RepoConfig {
  // ... existing options ...

  /**
   * Defaults configuration
   */
  defaults?: {
    /**
     * Copy default commands/workflows on clone
     * @default true
     */
    copyDefaults?: boolean;
  };
}
```

**LOGGING_PATTERN:**
```typescript
// SOURCE: src/utils/worktree-copy.ts:130-145
// COPY THIS PATTERN for logging with context:
console.log(`[DefaultsCopy] Copied ${entry.source} -> ${entry.destination}`);
console.error('[DefaultsCopy] Copy failed', {
  source: entry.source,
  errorCode: err.code ?? 'UNKNOWN',
  errorMessage: err.message,
});
```

**COMMAND_LOADING_PATTERN:**
```typescript
// SOURCE: src/handlers/command-handler.ts:488-511
// COPY THIS PATTERN for loading commands after copying:
const markdownFiles = await findMarkdownFilesRecursive(commandPath);
if (markdownFiles.length > 0) {
  const commands = await codebaseDb.getCodebaseCommands(codebase.id);
  markdownFiles.forEach(({ commandName, relativePath }) => {
    commands[commandName] = {
      path: join(folder, relativePath),
      description: `From ${folder}`,
    };
  });
  await codebaseDb.updateCodebaseCommands(codebase.id, commands);
}
```

---

## Files to Change

| File                                  | Action | Justification                                      |
| ------------------------------------- | ------ | -------------------------------------------------- |
| `.archon/commands/defaults/`          | CREATE | Move current commands here (16 files)              |
| `.archon/workflows/defaults/`         | CREATE | Move current workflows here (8 files)              |
| `src/utils/defaults-copy.ts`          | CREATE | Copy defaults utility (mirrors worktree-copy.ts)   |
| `src/utils/archon-paths.ts`           | UPDATE | Add `getDefaultsPath()` function                   |
| `src/config/config-types.ts`          | UPDATE | Add `defaults.copyDefaults` option                 |
| `src/config/config-loader.ts`         | UPDATE | Add defaults config to merge logic                 |
| `src/handlers/command-handler.ts`     | UPDATE | Call copyDefaults in /clone handler                |
| `src/adapters/github.ts`              | UPDATE | Call copyDefaults in webhook handler               |
| `src/utils/defaults-copy.test.ts`     | CREATE | Unit tests for copy logic                          |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **No selective default copying** - Either all defaults or none (no cherry-picking individual commands)
- **No version tracking** - Defaults are copied once on clone; no updates if defaults change later
- **No UI for managing defaults** - Opt-out only via config file
- **No merge logic** - If target already has `.archon/commands/`, skip copying entirely
- **Defaults copied flat** - Files from `app/defaults/` go to `target/` root, not `target/defaults/`
- **No nested subdirs in defaults** - Only direct children of `defaults/` folder are copied

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: CREATE defaults directory structure and move files

- **ACTION**: Create `.archon/commands/defaults/` and `.archon/workflows/defaults/`, move existing files
- **IMPLEMENT**:
  ```bash
  # Create defaults directories
  mkdir -p .archon/commands/defaults
  mkdir -p .archon/workflows/defaults

  # Move commands (16 files)
  mv .archon/commands/*.md .archon/commands/defaults/

  # Move workflows (8 files)
  mv .archon/workflows/*.yaml .archon/workflows/defaults/
  ```
- **RATIONALE**: Organizing defaults in subdirectories allows:
  - Clear separation between "defaults to copy" vs "repo-specific commands"
  - This repo can still load and use the defaults (recursive search picks them up)
  - Future ability to have repo-specific commands in parent folder that won't be copied
- **EXPECTED RESULT**:
  ```
  .archon/
  ├── commands/
  │   └── defaults/           ← All 16 .md files moved here
  │       ├── assist.md
  │       ├── implement.md
  │       └── ... (14 more)
  └── workflows/
      └── defaults/           ← All 8 .yaml files moved here
          ├── fix-github-issue.yaml
          └── ... (7 more)
  ```
- **VALIDATE**: `ls .archon/commands/defaults/*.md | wc -l` returns 16
- **VALIDATE**: `ls .archon/workflows/defaults/*.yaml | wc -l` returns 8
- **VALIDATE**: Existing functionality still works (recursive loading picks up files in subdirs)

### Task 2: CREATE `src/utils/archon-paths.ts` (update) - Add getDefaultsPath function

- **ACTION**: ADD function to get app's defaults directory path
- **IMPLEMENT**:
  ```typescript
  /**
   * Get the path to the app's bundled defaults directory
   * This is where default commands/workflows are stored for copying to new repos
   *
   * In Docker: /app/.archon/{commands,workflows}/defaults
   * Locally: {repo_root}/.archon/{commands,workflows}/defaults
   */
  export function getAppDefaultsBasePath(): string {
    // Use import.meta.dir to find path relative to this file
    // This file is at src/utils/archon-paths.ts
    // Defaults are at .archon/{commands,workflows}/defaults/
    const srcDir = dirname(dirname(import.meta.dir)); // Go up from src/utils to repo root
    return join(srcDir, '.archon');
  }

  export function getDefaultCommandsPath(): string {
    return join(getAppDefaultsBasePath(), 'commands', 'defaults');
  }

  export function getDefaultWorkflowsPath(): string {
    return join(getAppDefaultsBasePath(), 'workflows', 'defaults');
  }
  ```
- **MIRROR**: Existing path functions at lines 70-104
- **IMPORTS**: Add `dirname` to existing `path` import
- **GOTCHA**: Use `import.meta.dir` for Bun compatibility (not `__dirname`)
- **VALIDATE**: `bun run type-check`

### Task 3: UPDATE `src/config/config-types.ts` - Add defaults config option

- **ACTION**: ADD `defaults` config section to RepoConfig interface
- **IMPLEMENT**:
  ```typescript
  // Add to RepoConfig interface (around line 91, before closing brace)
  /**
   * Default commands/workflows configuration
   */
  defaults?: {
    /**
     * Copy bundled default commands and workflows on clone
     * Set to false to skip copying defaults
     * @default true
     */
    copyDefaults?: boolean;
  };
  ```
- **MIRROR**: Pattern from `worktree?:` section at lines 93-110
- **ALSO UPDATE**: MergedConfig interface to include resolved defaults
  ```typescript
  // Add to MergedConfig interface (around line 140, before closing brace)
  defaults: {
    copyDefaults: boolean;
  };
  ```
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE `src/config/config-loader.ts` - Add defaults to merge logic

- **ACTION**: ADD defaults handling to config merge functions
- **IMPLEMENT**:
  1. Add defaults to `getDefaults()` function:
     ```typescript
     defaults: {
       copyDefaults: true,  // Default is opt-in
     },
     ```
  2. Add to `mergeRepoConfig()` function:
     ```typescript
     // Handle defaults section
     if (repo.defaults) {
       merged.defaults = {
         ...merged.defaults,
         ...repo.defaults,
       };
     }
     ```
- **MIRROR**: How `commands` is merged at lines 260-265
- **VALIDATE**: `bun run type-check`

### Task 5: CREATE `src/utils/defaults-copy.ts` - Defaults copy utility

- **ACTION**: CREATE utility for copying defaults to target repos
- **KEY BEHAVIOR**:
  - Source: `app/.archon/commands/defaults/*.md`
  - Target: `target/.archon/commands/*.md` (FLAT, not in defaults/ subfolder)
  - This means target repos get a clean structure without nesting
- **IMPLEMENT**:
  ```typescript
  /**
   * Copy default commands and workflows to a target repository
   *
   * IMPORTANT: Copies are FLAT - files from app's defaults/ folder go directly
   * to target's .archon/commands/ root (not into a defaults/ subfolder).
   *
   * Only copies if:
   * - Target doesn't already have .archon/commands/ (for commands)
   * - Target doesn't already have .archon/workflows/ (for workflows)
   * - Config allows copying (defaults.copyDefaults !== false)
   */
  import { access, readdir, mkdir, copyFile } from 'fs/promises';
  import { join } from 'path';
  import { getDefaultCommandsPath, getDefaultWorkflowsPath } from './archon-paths';
  import { loadRepoConfig } from '../config/config-loader';

  interface CopyDefaultsResult {
    commandsCopied: number;
    workflowsCopied: number;
    skipped: boolean;
    skipReason?: string;
  }

  export async function copyDefaultsToRepo(targetPath: string): Promise<CopyDefaultsResult> {
    // Check config for opt-out (target repo's config)
    let config;
    try {
      config = await loadRepoConfig(targetPath);
    } catch {
      // No config file in target - that's fine, use defaults
      config = {};
    }

    if (config.defaults?.copyDefaults === false) {
      return { commandsCopied: 0, workflowsCopied: 0, skipped: true, skipReason: 'Opted out via config' };
    }

    let commandsCopied = 0;
    let workflowsCopied = 0;

    // Copy commands if target doesn't have any
    const targetCommandsPath = join(targetPath, '.archon', 'commands');
    try {
      await access(targetCommandsPath);
      console.log('[DefaultsCopy] Target already has .archon/commands/, skipping command copy');
    } catch {
      // Target doesn't have commands - copy defaults
      commandsCopied = await copyDefaultCommands(targetPath);
    }

    // Copy workflows if target doesn't have any
    const targetWorkflowsPath = join(targetPath, '.archon', 'workflows');
    try {
      await access(targetWorkflowsPath);
      console.log('[DefaultsCopy] Target already has .archon/workflows/, skipping workflow copy');
    } catch {
      // Target doesn't have workflows - copy defaults
      workflowsCopied = await copyDefaultWorkflows(targetPath);
    }

    return { commandsCopied, workflowsCopied, skipped: false };
  }

  /**
   * Copy default commands from app's defaults/ to target's .archon/commands/
   * Files are copied FLAT (not into a defaults/ subfolder in target)
   */
  async function copyDefaultCommands(targetPath: string): Promise<number> {
    const sourceDir = getDefaultCommandsPath(); // app/.archon/commands/defaults/
    const targetDir = join(targetPath, '.archon', 'commands'); // target/.archon/commands/

    try {
      await access(sourceDir);
    } catch {
      console.log('[DefaultsCopy] No default commands found at', sourceDir);
      return 0;
    }

    const entries = await readdir(sourceDir, { withFileTypes: true });
    // Only copy files, not subdirectories (keep it simple)
    const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md'));

    if (mdFiles.length === 0) return 0;

    await mkdir(targetDir, { recursive: true });

    for (const file of mdFiles) {
      await copyFile(join(sourceDir, file.name), join(targetDir, file.name));
    }

    console.log(`[DefaultsCopy] Copied ${mdFiles.length} default commands to ${targetDir}`);
    return mdFiles.length;
  }

  /**
   * Copy default workflows from app's defaults/ to target's .archon/workflows/
   * Files are copied FLAT (not into a defaults/ subfolder in target)
   */
  async function copyDefaultWorkflows(targetPath: string): Promise<number> {
    const sourceDir = getDefaultWorkflowsPath(); // app/.archon/workflows/defaults/
    const targetDir = join(targetPath, '.archon', 'workflows'); // target/.archon/workflows/

    try {
      await access(sourceDir);
    } catch {
      console.log('[DefaultsCopy] No default workflows found at', sourceDir);
      return 0;
    }

    const entries = await readdir(sourceDir, { withFileTypes: true });
    // Only copy files, not subdirectories (keep it simple)
    const yamlFiles = entries.filter(e => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')));

    if (yamlFiles.length === 0) return 0;

    await mkdir(targetDir, { recursive: true });

    for (const file of yamlFiles) {
      await copyFile(join(sourceDir, file.name), join(targetDir, file.name));
    }

    console.log(`[DefaultsCopy] Copied ${yamlFiles.length} default workflows to ${targetDir}`);
    return yamlFiles.length;
  }
  ```
- **MIRROR**: `src/utils/worktree-copy.ts` structure and error handling
- **VALIDATE**: `bun run type-check && bun run lint`

### Task 6: UPDATE `src/handlers/command-handler.ts` - Integrate defaults copy in /clone

- **ACTION**: ADD call to `copyDefaultsToRepo` in clone handler before command loading
- **LOCATION**: Around line 487, BEFORE the "Auto-load commands" section
- **IMPLEMENT**:
  ```typescript
  // Add import at top of file
  import { copyDefaultsToRepo } from '../utils/defaults-copy';

  // Add in clone handler (around line 487, before auto-load commands section)
  // Copy default commands/workflows if target doesn't have them
  const copyResult = await copyDefaultsToRepo(targetPath);
  if (copyResult.commandsCopied > 0 || copyResult.workflowsCopied > 0) {
    console.log('[Clone] Copied defaults', copyResult);
  }
  ```
- **ALSO UPDATE**: Response message to show what was copied (around line 513-518)
  ```typescript
  let responseMessage = `Repository cloned successfully!\n\nCodebase: ${repoName}\nPath: ${targetPath}`;
  if (copyResult.commandsCopied > 0) {
    responseMessage += `\n✓ Copied ${copyResult.commandsCopied} default commands`;
  }
  if (copyResult.workflowsCopied > 0) {
    responseMessage += `\n✓ Copied ${copyResult.workflowsCopied} default workflows`;
  }
  if (commandsLoaded > 0) {
    responseMessage += `\n✓ Loaded ${String(commandsLoaded)} commands`;
  }
  ```
- **VALIDATE**: `bun run type-check && bun run lint`

### Task 7: UPDATE `src/adapters/github.ts` - Integrate defaults copy in webhook handler

- **ACTION**: ADD call to `copyDefaultsToRepo` after ensureRepoReady, before autoDetectAndLoadCommands
- **LOCATION**: Around line 670, in the webhook processing flow
- **IMPLEMENT**:
  ```typescript
  // Add import at top of file
  import { copyDefaultsToRepo } from '../utils/defaults-copy';

  // Add in webhook handler (around line 670, after ensureRepoReady)
  // Copy defaults for new codebases
  if (isNewCodebase) {
    const copyResult = await copyDefaultsToRepo(repoPath);
    if (copyResult.commandsCopied > 0 || copyResult.workflowsCopied > 0) {
      console.log('[GitHub] Copied defaults', copyResult);
    }
  }
  ```
- **MIRROR**: Existing flow where `autoDetectAndLoadCommands` is called only for new codebases
- **VALIDATE**: `bun run type-check && bun run lint`

### Task 8: CREATE `src/utils/defaults-copy.test.ts` - Unit tests

- **ACTION**: CREATE unit tests for defaults copy utility
- **IMPLEMENT**:
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
  import { mkdir, rm, writeFile, access, readdir } from 'fs/promises';
  import { join } from 'path';
  import { copyDefaultsToRepo } from './defaults-copy';

  describe('copyDefaultsToRepo', () => {
    const testDir = '/tmp/test-defaults-copy';

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('should copy commands when target has none', async () => {
      const result = await copyDefaultsToRepo(testDir);

      // Should have copied some commands (depends on defaults existing)
      expect(result.skipped).toBe(false);
      // Commands should be in target
      const targetCommands = join(testDir, '.archon', 'commands');
      try {
        const files = await readdir(targetCommands);
        expect(files.length).toBeGreaterThan(0);
      } catch {
        // If no defaults exist, that's OK for this test
      }
    });

    it('should skip if target already has commands', async () => {
      // Create existing commands directory
      const existingCommands = join(testDir, '.archon', 'commands');
      await mkdir(existingCommands, { recursive: true });
      await writeFile(join(existingCommands, 'existing.md'), '# Existing');

      const result = await copyDefaultsToRepo(testDir);

      // Should not have copied commands (already exists)
      expect(result.commandsCopied).toBe(0);
    });

    it('should respect opt-out config', async () => {
      // Create config with opt-out
      const configDir = join(testDir, '.archon');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, 'config.yaml'),
        'defaults:\n  copyDefaults: false\n'
      );

      const result = await copyDefaultsToRepo(testDir);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('Opted out');
    });
  });
  ```
- **MIRROR**: Test patterns from `src/utils/worktree-copy.test.ts`
- **VALIDATE**: `bun test src/utils/defaults-copy.test.ts`

### Task 9: UPDATE documentation

- **ACTION**: UPDATE CLAUDE.md and README.md to document defaults behavior
- **IMPLEMENT**:
  1. In CLAUDE.md, update "Command Types" section to mention defaults
  2. In README.md, update the "Clone a Repository" example to show defaults being copied
  3. Document opt-out config option in both files
- **VALIDATE**: Review changes manually for accuracy

---

## Testing Strategy

### Unit Tests to Write

| Test File                           | Test Cases                 | Validates      |
| ----------------------------------- | -------------------------- | -------------- |
| `src/utils/defaults-copy.test.ts`   | copy, skip, opt-out        | Copy logic     |
| `src/utils/archon-paths.test.ts`    | getDefaultsPath functions  | Path resolution |

### Edge Cases Checklist

- [ ] Target repo already has `.archon/commands/` - should skip command copy
- [ ] Target repo already has `.archon/workflows/` - should skip workflow copy
- [ ] Target repo has config with `copyDefaults: false` - should skip all copying
- [ ] App's defaults directory is missing - should handle gracefully
- [ ] App's defaults directory is empty - should handle gracefully
- [ ] Target path doesn't exist yet - should create directories
- [ ] File copy fails mid-way - should log error but not crash

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run lint && bun run type-check
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
bun test src/utils/defaults-copy.test.ts
bun test src/utils/archon-paths.test.ts
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

1. Start the app locally: `bun run dev`
2. Use test adapter to clone a repo without commands:
   ```bash
   curl -X POST http://localhost:3000/test/message \
     -H "Content-Type: application/json" \
     -d '{"conversationId":"test-defaults","message":"/clone https://github.com/octocat/Hello-World"}'
   ```
3. Check response includes "Copied X default commands"
4. Verify commands were copied: `ls ~/.archon/workspaces/octocat/Hello-World/.archon/commands/`
5. Test opt-out by creating config file with `copyDefaults: false`

---

## Acceptance Criteria

- [ ] Default commands exist in `.archon/commands/defaults/` (16 files)
- [ ] Default workflows exist in `.archon/workflows/defaults/` (8 files)
- [ ] `/clone` copies defaults to repos without `.archon/commands/`
- [ ] GitHub adapter copies defaults for new codebases
- [ ] Config option `defaults.copyDefaults: false` prevents copying
- [ ] Existing `.archon/commands/` in target repo prevents command copying
- [ ] All unit tests pass
- [ ] Type-check and lint pass
- [ ] Manual validation confirms end-to-end flow works

---

## Completion Checklist

- [ ] Task 1: Defaults directory structure created and files moved
- [ ] Task 2: `getDefaultsPath` functions added to archon-paths.ts
- [ ] Task 3: Config types updated with defaults option
- [ ] Task 4: Config loader updated with defaults merge logic
- [ ] Task 5: defaults-copy.ts utility created
- [ ] Task 6: command-handler.ts updated to copy defaults on /clone
- [ ] Task 7: github.ts updated to copy defaults on webhook clone
- [ ] Task 8: Unit tests created and passing
- [ ] Task 9: Documentation updated
- [ ] Level 1: `bun run lint && bun run type-check` passes
- [ ] Level 2: `bun test src/utils/defaults-copy.test.ts` passes
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] Level 4: Manual validation confirms flow works

---

## Risks and Mitigations

| Risk               | Likelihood | Impact | Mitigation                              |
| ------------------ | ---------- | ------ | --------------------------------------- |
| Defaults path not found in Docker | LOW | HIGH | Use `import.meta.dir` which works in both environments |
| File permissions issues | LOW | MEDIUM | Use `mkdir({ recursive: true })` and handle EACCES |
| Large defaults slow clone | LOW | LOW | Defaults are small (~100KB total); async copy |
| Defaults overwrite user files | LOW | HIGH | Check for existing dirs before copying; never overwrite |

---

## Notes

### Design Decisions

1. **Dual-purpose defaults folder** - The `defaults/` subfolder serves two purposes:
   - **For this repo**: Loaded via recursive search, so developers working on Archon can use these commands
   - **For target repos**: Copied to give users a starting point

2. **Flat copy to targets** - Files from `app/defaults/*.md` go to `target/*.md` (not `target/defaults/*.md`). This gives target repos a clean, non-nested structure.

3. **Repo-specific commands outside defaults/** - This repo can have commands in `.archon/commands/` (not in defaults/) that are only for working on Archon itself and won't be copied to user repos.

4. **Opt-in by default** - Users get value immediately without configuration. Only advanced users who want full control will opt out.

5. **Check for existing directories, not files** - If target has `.archon/commands/` at all (even empty), we assume they want control and don't copy.

6. **Use `import.meta.dir`** - Bun's recommended way to get file paths, works in both local and Docker environments.

7. **No merge logic** - Intentionally simple: either copy all defaults or none. Merging would add complexity and edge cases.

### Directory Structure Summary

```
THIS REPO (remote-coding-agent):
.archon/
├── commands/
│   ├── defaults/           ← Copied to targets + loaded here
│   │   ├── assist.md
│   │   └── ...
│   └── archon-specific.md  ← Only for this repo, NOT copied
└── workflows/
    ├── defaults/           ← Copied to targets + loaded here
    │   └── ...
    └── archon-specific.yaml ← Only for this repo, NOT copied

TARGET REPO (after /clone):
.archon/
├── commands/               ← Flat structure (no defaults/ subfolder)
│   ├── assist.md           ← Copied from app's defaults/
│   └── ...
└── workflows/              ← Flat structure (no defaults/ subfolder)
    └── ...
```

### Future Considerations

- Could add `/commands reset` to re-copy defaults if user wants to start fresh
- Could version defaults and offer update path when app updates
- Could allow selecting which defaults to copy (but explicitly out of scope now)
