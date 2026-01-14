# Feature: Default Commands and Workflows System

## Summary

Implement a system where users get bundled default commands and workflows automatically available. On `/init`, the app sets up both the user's global `~/.archon/` directory (with defaults) AND the target repo's `.archon/` structure. Users can also manually import commands from other folders (like `.claude/commands/`) into `.archon/` using a new `/commands-import` command.

## User Story

As a user of the Remote Agentic Coding Platform
I want default commands and workflows to be available out-of-the-box
So that I can start using the platform immediately without manually setting up commands for each repo

## Problem Statement

Currently:
1. Each repo must have its own `.archon/commands/` folder with commands, or users have no commands
2. The app ships with example commands in its own `.archon/commands/` but there's no mechanism to share them with users
3. Users working on repos that have commands in `.claude/commands/` or `.agents/commands/` can't easily import them into the Archon system
4. Path validation prevents loading commands from outside `~/.archon/workspaces/`

## Solution Statement

1. **Restructure bundled defaults**: Move default commands/workflows to `defaults/` subfolders in the app's `.archon/`
2. **Extend `/init` command**: When run, also set up `~/.archon/commands/` and `~/.archon/workflows/` with bundled defaults if they don't exist
3. **Add fallback resolution**: Commands and workflows check `~/.archon/` as fallback if not found in repo
4. **Add `/commands-import`**: New command to copy commands from any repo-relative folder into `.archon/commands/`

## Metadata

| Field            | Value                                                |
| ---------------- | ---------------------------------------------------- |
| Type             | ENHANCEMENT                                          |
| Complexity       | MEDIUM                                               |
| Systems Affected | command-handler.ts, archon-paths.ts, workflow/loader.ts, github.ts |
| Dependencies     | fs/promises (already used)                           |
| Estimated Tasks  | 8                                                    |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   User clones repo → No .archon/commands/ in repo                             ║
║                              │                                                ║
║                              ▼                                                ║
║                    ❌ No commands available                                   ║
║                                                                               ║
║   OR                                                                          ║
║                                                                               ║
║   User clones repo → Has .claude/commands/ with prompts                       ║
║                              │                                                ║
║                              ▼                                                ║
║                    ❌ Can't use them (wrong folder)                           ║
║                                                                               ║
║   DATA_FLOW:                                                                  ║
║   /clone → auto-load from .archon/commands/ → NOT FOUND → no commands        ║
║                                                                               ║
║   PAIN_POINT: New users have zero commands unless repo has .archon/commands/ ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   User runs /init (first time)                                                ║
║           │                                                                   ║
║           ▼                                                                   ║
║   ┌─────────────────────────────────────────────┐                             ║
║   │  1. Create ~/.archon/commands/ (if missing) │                             ║
║   │  2. Copy bundled defaults to ~/.archon/     │                             ║
║   │  3. Create repo .archon/ structure          │                             ║
║   └─────────────────────────────────────────────┘                             ║
║           │                                                                   ║
║           ▼                                                                   ║
║   ✅ Default commands available globally                                      ║
║                                                                               ║
║   User clones repo → Has .claude/commands/                                    ║
║           │                                                                   ║
║           ▼                                                                   ║
║   /commands-import .claude/commands                                           ║
║           │                                                                   ║
║           ▼                                                                   ║
║   ✅ Commands copied to repo's .archon/commands/                              ║
║                                                                               ║
║   COMMAND RESOLUTION ORDER:                                                   ║
║   1. Repo's .archon/commands/                                                 ║
║   2. User's ~/.archon/commands/ (NEW - fallback)                              ║
║                                                                               ║
║   VALUE_ADD: Users have commands immediately, can import existing prompts    ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| `/init` | Only creates repo `.archon/` | Also sets up `~/.archon/` with defaults | One command sets up everything |
| `/commands-import` | N/A | Copies commands from source to `.archon/` | Can import existing prompts |
| Command resolution | Only repo `.archon/commands/` | Repo first, then `~/.archon/commands/` fallback | Commands always available |
| Workflow resolution | Only repo workflow folders | Repo first, then `~/.archon/workflows/` fallback | Workflows always available |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/handlers/command-handler.ts` | 55-84 | `findMarkdownFilesRecursive` - MIRROR for command discovery |
| P0 | `src/handlers/command-handler.ts` | 1358-1432 | `/init` command - EXTEND this |
| P0 | `src/handlers/command-handler.ts` | 574-624 | `/load-commands` - MIRROR for `/commands-import` |
| P1 | `src/utils/archon-paths.ts` | 43-68 | Path resolution functions - ADD new functions |
| P1 | `src/utils/worktree-copy.ts` | 86-150 | File copy pattern - REUSE for defaults copy |
| P1 | `src/workflows/loader.ts` | 231-266 | `discoverWorkflows` - ADD fallback |
| P2 | `src/adapters/github.ts` | 453-479 | `autoDetectAndLoadCommands` - UPDATE for fallback |

**External Documentation:**
| Source | Section | Why Needed |
|--------|---------|------------|
| [Bun fs/promises](https://bun.sh/docs/api/file-io) | File I/O | File copy operations |

---

## Patterns to Mirror

**NAMING_CONVENTION:**
```typescript
// SOURCE: src/utils/archon-paths.ts:59-68
// COPY THIS PATTERN:
export function getArchonWorkspacesPath(): string {
  return join(getArchonHome(), 'workspaces');
}

export function getArchonWorktreesPath(): string {
  return join(getArchonHome(), 'worktrees');
}
```

**FILE_COPY_PATTERN:**
```typescript
// SOURCE: src/utils/worktree-copy.ts:86-150
// COPY THIS PATTERN:
export async function copyWorktreeFile(
  sourceRoot: string,
  destRoot: string,
  entry: CopyFileEntry
): Promise<boolean> {
  const sourcePath = join(sourceRoot, entry.source);
  const destPath = join(destRoot, entry.destination);

  try {
    const stats = await stat(sourcePath);
    await mkdir(dirname(destPath), { recursive: true });

    if (stats.isDirectory()) {
      await cp(sourcePath, destPath, { recursive: true });
    } else {
      await copyFile(sourcePath, destPath);
    }
    console.log(`[WorktreeCopy] Copied ${entry.source} -> ${entry.destination}`);
    return true;
  } catch (error) {
    // Handle errors...
  }
}
```

**COMMAND_HANDLER_PATTERN:**
```typescript
// SOURCE: src/handlers/command-handler.ts:574-624
// COPY THIS PATTERN:
case 'load-commands': {
  if (!args.length) {
    return { success: false, message: 'Usage: /load-commands <folder>' };
  }
  if (!conversation.codebase_id) {
    return { success: false, message: 'No codebase configured.' };
  }

  const folderPath = args.join(' ');
  const basePath = conversation.cwd ?? workspacePath;
  const fullPath = resolve(basePath, folderPath);

  // ... validation and processing
}
```

**RECURSIVE_DISCOVERY_PATTERN:**
```typescript
// SOURCE: src/handlers/command-handler.ts:55-84
// COPY THIS PATTERN:
async function findMarkdownFilesRecursive(
  rootPath: string,
  relativePath = ''
): Promise<{ commandName: string; relativePath: string }[]> {
  const results: { commandName: string; relativePath: string }[] = [];
  const fullPath = join(rootPath, relativePath);

  const entries = await readdir(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      const subResults = await findMarkdownFilesRecursive(rootPath, join(relativePath, entry.name));
      results.push(...subResults);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push({
        commandName: basename(entry.name, '.md'),
        relativePath: join(relativePath, entry.name),
      });
    }
  }

  return results;
}
```

**TEST_STRUCTURE:**
```typescript
// SOURCE: src/handlers/command-handler.test.ts:150-160
// COPY THIS PATTERN:
function setupSpies(): void {
  spyIsPathWithinWorkspace = spyOn(pathValidation, 'isPathWithinWorkspace').mockReturnValue(true);
  spyExecFileAsync = spyOn(gitModule, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
  spyListWorktrees = spyOn(gitModule, 'listWorktrees').mockResolvedValue([]);
  // ... setup spies for fs operations
}
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `.archon/commands/defaults/` | CREATE | Move current commands here as bundled defaults |
| `.archon/workflows/defaults/` | CREATE | Move current workflows here as bundled defaults |
| `src/utils/archon-paths.ts` | UPDATE | Add `getArchonUserCommandsPath()`, `getArchonUserWorkflowsPath()`, `getAppDefaultsPath()` |
| `src/utils/defaults-copy.ts` | CREATE | Utility for copying bundled defaults to user's ~/.archon/ |
| `src/handlers/command-handler.ts` | UPDATE | Extend `/init`, add `/commands-import` |
| `src/workflows/loader.ts` | UPDATE | Add ~/.archon/workflows/ as fallback search path |
| `src/adapters/github.ts` | UPDATE | Update `autoDetectAndLoadCommands` to check fallback |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **NOT building full onboarding wizard** - /init will just set up defaults, not guide OAuth setup (future enhancement)
- **NOT modifying database schema** - commands stay in filesystem, paths in JSONB
- **NOT changing /clone auto-load** - it still loads from repo first, fallback is just for resolution
- **NOT removing path validation** - we're adding specific exceptions for user's ~/.archon/ only
- **NOT auto-importing from .claude/.agents** - user must explicitly run /commands-import

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: REORGANIZE bundled defaults structure

- **ACTION**: Move current `.archon/commands/*.md` to `.archon/commands/defaults/*.md`
- **ACTION**: Move current `.archon/workflows/*.yaml` to `.archon/workflows/defaults/*.yaml`
- **IMPLEMENT**:
  ```bash
  mkdir -p .archon/commands/defaults
  mv .archon/commands/*.md .archon/commands/defaults/
  mkdir -p .archon/workflows/defaults
  mv .archon/workflows/*.yaml .archon/workflows/defaults/
  ```
- **GOTCHA**: Keep `.archon/commands/` and `.archon/workflows/` directories (now empty except for defaults/)
- **VALIDATE**: `ls .archon/commands/defaults/` shows all .md files

### Task 2: UPDATE `src/utils/archon-paths.ts`

- **ACTION**: Add new path resolution functions
- **IMPLEMENT**:
  ```typescript
  /**
   * Get the user's global commands directory (~/.archon/commands/)
   */
  export function getArchonUserCommandsPath(): string {
    return join(getArchonHome(), 'commands');
  }

  /**
   * Get the user's global workflows directory (~/.archon/workflows/)
   */
  export function getArchonUserWorkflowsPath(): string {
    return join(getArchonHome(), 'workflows');
  }

  /**
   * Get the app's bundled defaults directory
   * This uses import.meta.dir to find the app's installation location
   */
  export function getAppDefaultsPath(): string {
    // Go up from src/utils/ to repo root, then to .archon
    return join(import.meta.dir, '..', '..', '..', '.archon');
  }
  ```
- **MIRROR**: `src/utils/archon-paths.ts:59-68`
- **IMPORTS**: Add `import.meta.dir` usage (Bun-specific)
- **GOTCHA**: `import.meta.dir` gives directory of current file, not cwd
- **VALIDATE**: `bun run type-check` passes

### Task 3: CREATE `src/utils/defaults-copy.ts`

- **ACTION**: Create utility for copying bundled defaults to user's ~/.archon/
- **IMPLEMENT**:
  ```typescript
  import { access, mkdir, readdir, copyFile, cp, stat } from 'fs/promises';
  import { join, dirname } from 'path';
  import { getAppDefaultsPath, getArchonUserCommandsPath, getArchonUserWorkflowsPath } from './archon-paths';

  /**
   * Copy bundled default commands to user's ~/.archon/commands/
   * Only copies if destination directory is empty or doesn't exist
   */
  export async function copyDefaultCommands(): Promise<{ copied: number; skipped: boolean }> {
    const sourcePath = join(getAppDefaultsPath(), 'commands', 'defaults');
    const destPath = getArchonUserCommandsPath();

    return copyDefaults(sourcePath, destPath);
  }

  /**
   * Copy bundled default workflows to user's ~/.archon/workflows/
   */
  export async function copyDefaultWorkflows(): Promise<{ copied: number; skipped: boolean }> {
    const sourcePath = join(getAppDefaultsPath(), 'workflows', 'defaults');
    const destPath = getArchonUserWorkflowsPath();

    return copyDefaults(sourcePath, destPath);
  }

  async function copyDefaults(sourcePath: string, destPath: string): Promise<{ copied: number; skipped: boolean }> {
    // Check if source exists
    try {
      await access(sourcePath);
    } catch {
      console.log(`[DefaultsCopy] Source not found: ${sourcePath}`);
      return { copied: 0, skipped: true };
    }

    // Check if dest already has files
    try {
      await access(destPath);
      const existing = await readdir(destPath);
      if (existing.length > 0) {
        console.log(`[DefaultsCopy] Destination already has files: ${destPath}`);
        return { copied: 0, skipped: true };
      }
    } catch {
      // Dest doesn't exist, create it
      await mkdir(destPath, { recursive: true });
    }

    // Copy all files from source to dest
    const files = await readdir(sourcePath);
    let copied = 0;

    for (const file of files) {
      const srcFile = join(sourcePath, file);
      const destFile = join(destPath, file);

      try {
        const stats = await stat(srcFile);
        if (stats.isDirectory()) {
          await cp(srcFile, destFile, { recursive: true });
        } else {
          await copyFile(srcFile, destFile);
        }
        copied++;
        console.log(`[DefaultsCopy] Copied ${file}`);
      } catch (error) {
        console.error(`[DefaultsCopy] Failed to copy ${file}:`, error);
      }
    }

    return { copied, skipped: false };
  }
  ```
- **MIRROR**: `src/utils/worktree-copy.ts:86-150` for copy pattern
- **VALIDATE**: `bun run type-check` passes

### Task 4: EXTEND `/init` command in `command-handler.ts`

- **ACTION**: Update `/init` to also set up ~/.archon/ with defaults
- **IMPLEMENT**:
  - Import `copyDefaultCommands`, `copyDefaultWorkflows` from `../utils/defaults-copy`
  - Before creating repo `.archon/`, check if `~/.archon/commands/` exists and copy defaults if not
  - Update success message to include global setup info
- **LOCATION**: `src/handlers/command-handler.ts:1358-1432`
- **BEHAVIOR**:
  ```typescript
  case 'init': {
    // First: Set up user's global ~/.archon/ with defaults (if needed)
    const commandsResult = await copyDefaultCommands();
    const workflowsResult = await copyDefaultWorkflows();

    let globalMsg = '';
    if (commandsResult.copied > 0 || workflowsResult.copied > 0) {
      globalMsg = `\nGlobal setup (~/.archon/):\n`;
      if (commandsResult.copied > 0) {
        globalMsg += `  ✓ Copied ${commandsResult.copied} default commands\n`;
      }
      if (workflowsResult.copied > 0) {
        globalMsg += `  ✓ Copied ${workflowsResult.copied} default workflows\n`;
      }
    }

    // Then: Create repo .archon/ structure (existing logic)
    // ...rest of existing /init code...

    return {
      success: true,
      message: `${globalMsg}Created .archon structure:
  .archon/
  ├── config.yaml
  └── commands/
      └── example.md

Use /load-commands .archon/commands to register commands.`,
    };
  }
  ```
- **GOTCHA**: If user has no cwd set, still set up global ~/.archon/ but skip repo .archon/
- **VALIDATE**: Run `/init` and check both ~/.archon/ and repo .archon/ are created

### Task 5: ADD `/commands-import` command

- **ACTION**: Add new command to import commands from other folders
- **LOCATION**: `src/handlers/command-handler.ts` - add new case before `default:`
- **IMPLEMENT**:
  ```typescript
  case 'commands-import': {
    if (!args.length) {
      return { success: false, message: 'Usage: /commands-import <source-folder>\n\nExamples:\n  /commands-import .claude/commands\n  /commands-import .agents/commands' };
    }
    if (!conversation.cwd) {
      return { success: false, message: 'No working directory set. Use /clone or /setcwd first.' };
    }

    const sourceFolder = args.join(' ');
    const sourcePath = resolve(conversation.cwd, sourceFolder);
    const destPath = join(conversation.cwd, '.archon', 'commands');

    // Validate source exists
    try {
      await access(sourcePath);
    } catch {
      return { success: false, message: `Source folder not found: ${sourceFolder}` };
    }

    // Ensure dest directory exists
    await mkdir(destPath, { recursive: true });

    // Find all .md files in source
    const markdownFiles = await findMarkdownFilesRecursive(sourcePath);

    if (!markdownFiles.length) {
      return { success: false, message: `No .md files found in ${sourceFolder}` };
    }

    // Copy files
    let copied = 0;
    for (const { relativePath } of markdownFiles) {
      const src = join(sourcePath, relativePath);
      const dest = join(destPath, relativePath);

      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      copied++;
    }

    // Auto-load the imported commands if codebase is configured
    if (conversation.codebase_id) {
      const commands = await codebaseDb.getCodebaseCommands(conversation.codebase_id);
      markdownFiles.forEach(({ commandName, relativePath }) => {
        commands[commandName] = {
          path: join('.archon/commands', relativePath),
          description: `Imported from ${sourceFolder}`,
        };
      });
      await codebaseDb.updateCodebaseCommands(conversation.codebase_id, commands);
    }

    return {
      success: true,
      message: `Imported ${copied} command(s) from ${sourceFolder} to .archon/commands/\n\nCommands: ${markdownFiles.map(f => f.commandName).join(', ')}`,
    };
  }
  ```
- **MIRROR**: `src/handlers/command-handler.ts:574-624` for `/load-commands` pattern
- **IMPORTS**: Add `copyFile` and `dirname` to existing fs/promises import
- **VALIDATE**: `bun run type-check` passes

### Task 6: UPDATE `/help` command

- **ACTION**: Add `/commands-import` to help text
- **LOCATION**: `src/handlers/command-handler.ts:173-221` (help case)
- **IMPLEMENT**: Add to Codebase Commands section:
  ```
  /commands-import <folder> - Import commands from folder
  ```
- **VALIDATE**: Run `/help` and verify new command appears

### Task 7: ADD fallback resolution for commands

- **ACTION**: Update command resolution to check ~/.archon/commands/ as fallback
- **LOCATION**: `src/orchestrator/orchestrator.ts:468-471`
- **IMPLEMENT**: After failing to find command in repo, try ~/.archon/commands/
  ```typescript
  // Read command file using the conversation's cwd
  const commandCwd = conversation.cwd ?? codebase.default_cwd;
  let commandFilePath = join(commandCwd, commandDef.path);

  // Try to read from repo location first
  let commandText: string;
  try {
    commandText = await readCommandFile(commandFilePath);
  } catch {
    // Fallback: Try user's global ~/.archon/commands/
    const globalCommandPath = join(getArchonUserCommandsPath(), basename(commandDef.path));
    try {
      commandText = await readCommandFile(globalCommandPath);
      console.log(`[Orchestrator] Using global command fallback: ${globalCommandPath}`);
    } catch {
      await platform.sendMessage(conversationId, `Failed to read command file: ${commandDef.path}`);
      return;
    }
  }
  ```
- **IMPORTS**: Add `getArchonUserCommandsPath` from `../utils/archon-paths`
- **GOTCHA**: Only fallback if repo command file not found, not on other errors
- **VALIDATE**: Command executes from ~/.archon/commands/ when repo doesn't have it

### Task 8: ADD fallback resolution for workflows

- **ACTION**: Update workflow discovery to check ~/.archon/workflows/ as fallback
- **LOCATION**: `src/workflows/loader.ts:231-266`
- **IMPLEMENT**: After checking repo folders, also check ~/.archon/workflows/
  ```typescript
  export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
    const allWorkflows: WorkflowDefinition[] = [];
    const searchPaths = getWorkflowFolderSearchPaths();

    // First: Search in repo folders (existing logic)
    for (const folder of searchPaths) {
      const fullPath = join(cwd, folder);
      // ... existing logic ...
    }

    // Second: If no workflows found, check user's global ~/.archon/workflows/
    if (allWorkflows.length === 0) {
      const globalWorkflowsPath = getArchonUserWorkflowsPath();
      try {
        await access(globalWorkflowsPath);
        console.log(`[WorkflowLoader] Checking global workflows: ${globalWorkflowsPath}`);
        const workflows = await loadWorkflowsFromDir(globalWorkflowsPath);
        if (workflows.length > 0) {
          console.log(`[WorkflowLoader] Loaded ${String(workflows.length)} global workflows`);
          allWorkflows.push(...workflows);
        }
      } catch {
        // Global folder doesn't exist, that's fine
      }
    }

    return allWorkflows;
  }
  ```
- **IMPORTS**: Add `getArchonUserWorkflowsPath` from `../utils/archon-paths`
- **VALIDATE**: Workflows load from ~/.archon/workflows/ when repo has none

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|-----------|-----------|
| `src/utils/archon-paths.test.ts` | `getArchonUserCommandsPath`, `getArchonUserWorkflowsPath` | New path functions |
| `src/utils/defaults-copy.test.ts` | Copy when empty, skip when exists, handle missing source | Defaults copy logic |
| `src/handlers/command-handler.test.ts` | `/commands-import` with valid/invalid paths | Import command |

### Edge Cases Checklist

- [ ] `/init` when ~/.archon/ already has commands (should skip copy)
- [ ] `/init` when app bundled defaults are missing (should not crash)
- [ ] `/commands-import` with nested subfolders
- [ ] `/commands-import` when .archon/commands/ already has files (should merge)
- [ ] Command resolution when command exists in both repo and global (repo wins)
- [ ] Workflow discovery when workflows exist in both repo and global (repo wins)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run type-check && bun run lint
```

**EXPECT**: Exit 0, no errors or warnings

### Level 2: UNIT_TESTS

```bash
bun test src/utils/archon-paths.test.ts
bun test src/utils/defaults-copy.test.ts
bun test src/handlers/command-handler.test.ts
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

1. Remove ~/.archon/ directory (backup first if needed)
2. Start app: `bun run dev`
3. Run `/init` - verify:
   - ~/.archon/commands/ created with default commands
   - ~/.archon/workflows/ created with default workflows
   - Repo .archon/ created with structure
4. Clone a repo that has `.claude/commands/`
5. Run `/commands-import .claude/commands` - verify:
   - Files copied to .archon/commands/
   - Commands registered in database
6. Run `/command-invoke <imported-command>` - verify it works

---

## Acceptance Criteria

- [ ] `/init` sets up both ~/.archon/ (with bundled defaults) and repo .archon/ structure
- [ ] `/commands-import <folder>` copies commands from source to .archon/commands/
- [ ] Commands resolve from repo first, then fall back to ~/.archon/commands/
- [ ] Workflows resolve from repo first, then fall back to ~/.archon/workflows/
- [ ] Bundled defaults moved to `defaults/` subfolders in app's .archon/
- [ ] All validation commands pass with exit 0
- [ ] No regressions in existing tests

---

## Completion Checklist

- [ ] Task 1: Reorganize bundled defaults structure
- [ ] Task 2: Update archon-paths.ts with new functions
- [ ] Task 3: Create defaults-copy.ts utility
- [ ] Task 4: Extend /init command
- [ ] Task 5: Add /commands-import command
- [ ] Task 6: Update /help command
- [ ] Task 7: Add fallback for command resolution
- [ ] Task 8: Add fallback for workflow discovery
- [ ] Level 1: `bun run type-check && bun run lint` passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] Level 4: Manual validation passes

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `import.meta.dir` path resolution differs in built vs dev mode | MEDIUM | HIGH | Test in both modes; add fallback to check ARCHON_INSTALL_PATH env var |
| Users confused about repo vs global commands | LOW | MEDIUM | Clear messaging in /init and /status output |
| Copying large default folders slow | LOW | LOW | Defaults are small (<20 files); async copy |

---

## Notes

**Future Enhancements (not in scope):**
- Full onboarding wizard in /init (OAuth setup, model selection)
- Auto-sync defaults on app update
- /commands-export to share repo commands as defaults
- Conflict resolution when importing commands that already exist

**Design Decisions:**
- Repo commands always take precedence over global (local customization wins)
- /init is idempotent - running twice doesn't duplicate anything
- /commands-import merges, doesn't replace (existing commands preserved)
- Bundled defaults stored in `defaults/` subfolder to keep root clean for user additions
