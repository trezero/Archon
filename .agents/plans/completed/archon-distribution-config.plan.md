# Feature: Archon Distribution & Configuration System

The following plan should be complete, but it's important that you validate documentation and codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils types and models. Import from the right files etc.

## Feature Description

A comprehensive distribution and configuration system for the remote-coding-agent that establishes:
1. **Unified directory structure** under `~/.archon/` for all managed files (workspaces, worktrees, config)
2. **Docker image publishing** to GitHub Container Registry (GHCR) for easy distribution
3. **YAML-based configuration** using Bun's native YAML support for non-secret settings
4. **Config precedence chain**: Environment variables > `~/.archon/config.yaml` > `.archon/config.yaml` > defaults

This foundation enables future workflow engine development, where workflows will be defined in YAML and orchestrated by the system.

## User Story

As a self-hosting developer
I want a clean directory structure and simple Docker deployment
So that I can run the remote-coding-agent without building from source and organize my workspaces consistently

As a future workflow builder user
I want configuration in YAML format
So that workflows can be version-controlled and composed from reusable definitions

## Problem Statement

**Current issues:**
1. **Path pollution**: `WORKSPACE_PATH` defaults to `./workspace` inside project, causing test pollution and IDE confusion
2. **No published images**: Users must clone repo and build Docker images locally
3. **Flat configuration**: `.env` is the only config mechanism, limiting complex/nested settings
4. **Inconsistent paths**: Workspaces and worktrees use different path resolution logic scattered across files

## Solution Statement

1. Introduce unified `~/.archon/` directory structure with centralized path resolution
2. Publish multi-arch Docker images to GHCR via GitHub Actions
3. Add YAML configuration support using Bun's native `Bun.YAML.parse()` for non-secret settings
4. Establish clear config precedence: secrets in `.env`, structured config in YAML files

## Feature Metadata

**Feature Type**: New Capability + Refactor
**Estimated Complexity**: Medium-High
**Primary Systems Affected**: Path resolution, Docker build, Configuration loading, Startup
**Dependencies**: Bun native YAML support (built-in), GitHub Actions, GHCR

---

## CONTEXT REFERENCES

### Relevant Codebase Files IMPORTANT: YOU MUST READ THESE FILES BEFORE IMPLEMENTING!

- `src/utils/git.ts` (lines 28-62) - Why: Contains current path resolution pattern with Docker detection and tilde expansion
- `src/utils/path-validation.ts` (lines 1-51) - Why: Uses WORKSPACE_ROOT constant, needs to use dynamic resolution
- `src/handlers/command-handler.ts` (lines 31, 198, 255, 287-295) - Why: Uses WORKSPACE_PATH and command folder detection
- `src/adapters/github.ts` (lines 362, 411) - Why: Uses WORKSPACE_PATH for repo cloning
- `src/index.ts` (lines 67-76) - Why: Startup path validation and warnings
- `.github/workflows/test.yml` - Why: Pattern for GitHub Actions workflow structure
- `Dockerfile` (lines 1-67) - Why: Current Docker build configuration
- `docker-compose.yml` - Why: Current compose configuration with volume mounts
- `src/types/index.ts` - Why: Type definitions pattern

### New Files to Create

- `src/utils/archon-paths.ts` - Centralized path resolution for all Archon directories
- `src/utils/archon-paths.test.ts` - Tests for path resolution
- `src/config/loader.ts` - YAML configuration loading with precedence chain
- `src/config/loader.test.ts` - Tests for config loading
- `src/config/types.ts` - Configuration type definitions
- `.github/workflows/publish.yml` - Docker and npm publishing workflow
- `deploy/docker-compose.yml` - Minimal compose for end users
- `deploy/.env.example` - Minimal env example for end users
- `scripts/validate-setup.sh` - Setup validation script
- `docs/configuration.md` - Comprehensive configuration reference
- `docs/getting-started.md` - Step-by-step setup guide for new users
- `docs/archon-architecture.md` - Technical architecture documentation for developers

### Relevant Documentation YOU SHOULD READ THESE BEFORE IMPLEMENTING!

- [Bun YAML Documentation](https://bun.sh/docs/api/yaml)
  - Native `Bun.YAML.parse()` API
  - Why: No external dependencies needed for YAML parsing
- [GitHub Container Registry Docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
  - Publishing and pulling images
  - Why: GHCR publishing workflow
- [Docker Build-Push Action](https://github.com/docker/build-push-action)
  - Multi-arch builds, caching
  - Why: GitHub Actions Docker publishing

### Patterns to Follow

**Path Resolution Pattern (from `src/utils/git.ts:33-51`):**
```typescript
export function getWorktreeBase(_repoPath: string): string {
  // 1. Docker: FIXED location, no override for end users
  const isDocker =
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && process.env.WORKSPACE_PATH);

  if (isDocker) {
    return '/workspace/worktrees';
  }

  // 2. Local: Check env override
  const envBase = process.env.WORKTREE_BASE;
  if (envBase) {
    return expandTilde(envBase);
  }

  // 3. Local default
  return join(homedir(), 'tmp', 'worktrees');
}
```

**Tilde Expansion Pattern (from `src/utils/git.ts:56-62`):**
```typescript
function expandTilde(path: string): string {
  if (path.startsWith('~')) {
    const pathAfterTilde = path.slice(1).replace(/^[/\\]/, '');
    return join(homedir(), pathAfterTilde);
  }
  return path;
}
```

**Command Folder Detection Pattern (from `src/handlers/command-handler.ts:287-295`):**
```typescript
for (const folder of ['.claude/commands', '.agents/commands']) {
  try {
    await access(join(targetPath, folder));
    commandFolder = folder;
    break;
  } catch {
    /* ignore */
  }
}
```

**Test Pattern with Env Mocking (from `src/utils/git.test.ts`):**
```typescript
describe('path resolution', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save original values
    ['WORKSPACE_PATH', 'WORKTREE_BASE'].forEach(key => {
      originalEnv[key] = process.env[key];
    });
  });

  afterEach(() => {
    // Restore original values
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });
});
```

**Naming Conventions:**
- Files: `kebab-case.ts`
- Functions: `camelCase`
- Types/Interfaces: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE` for env vars, `camelCase` for others

**Error Handling:**
- Use try/catch with typed errors
- Log errors with `[Module]` prefix
- Provide actionable error messages

---

## IMPLEMENTATION PLAN

### Phase 1: Archon Directory Structure (Foundation)

Introduce unified `~/.archon/` directory structure with centralized path resolution.

**Directory Structure:**
```
~/.archon/                    # User-level (ARCHON_HOME)
├── workspaces/               # Cloned repositories (via /clone)
│   └── owner/repo/
├── worktrees/                # Git worktrees for isolation
│   └── repo-name/
│       └── branch-name/
└── config.yaml               # Global user configuration (non-secrets)

/.archon/                     # Docker container
├── workspaces/
├── worktrees/
└── config.yaml

.archon/                      # Per-repo (checked into repo)
├── commands/                 # Custom command templates
├── workflows/                # Future: workflow definitions
└── config.yaml               # Repo-specific configuration
```

**Tasks:**
- Create centralized path resolution module
- Update all path references across codebase
- Update Docker configuration for new paths
- Add backwards compatibility for legacy env vars

### Phase 2: Docker Distribution

Publish Docker images to GHCR with multi-arch support.

**Tasks:**
- Create GitHub Actions publish workflow
- Add OCI labels to Dockerfile
- Create minimal compose file for end users
- Update README with pull instructions

### Phase 3: YAML Configuration System

Add YAML-based configuration using Bun native support.

**Config Precedence Chain:**
1. Environment variables (secrets, highest priority)
2. `~/.archon/config.yaml` (global user preferences)
3. `.archon/config.yaml` (per-repo settings)
4. Built-in defaults (lowest priority)

**Tasks:**
- Create configuration type definitions
- Implement config loader with precedence
- Integrate with startup and orchestrator
- Add hot-reload support for development

### Phase 4: Developer Experience

Improve setup validation and debugging.

**Tasks:**
- Create setup validation script
- Enhance status command with config info
- Update documentation

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently testable.

---

### Phase 1: Archon Directory Structure

---

#### Task 1.1: CREATE `src/utils/archon-paths.ts`

**IMPLEMENT**: Centralized path resolution for all Archon directories

```typescript
/**
 * Archon path resolution utilities
 *
 * Directory structure:
 * ~/.archon/              # User-level (ARCHON_HOME)
 * ├── workspaces/         # Cloned repositories
 * ├── worktrees/          # Git worktrees
 * └── config.yaml         # Global config
 *
 * For Docker: /.archon/
 */

import { join } from 'path';
import { homedir } from 'os';

/**
 * Expand ~ to home directory
 */
export function expandTilde(path: string): string {
  if (path.startsWith('~')) {
    const pathAfterTilde = path.slice(1).replace(/^[/\\]/, '');
    return join(homedir(), pathAfterTilde);
  }
  return path;
}

/**
 * Detect if running in Docker container
 */
export function isDocker(): boolean {
  return (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.ARCHON_DOCKER === 'true'
  );
}

/**
 * Get the Archon home directory
 * - Docker: /.archon
 * - Local: ~/.archon (or ARCHON_HOME env var)
 */
export function getArchonHome(): string {
  if (isDocker()) {
    return '/.archon';
  }

  const envHome = process.env.ARCHON_HOME;
  if (envHome) {
    return expandTilde(envHome);
  }

  return join(homedir(), '.archon');
}

/**
 * Get the workspaces directory (where repos are cloned)
 * Replaces WORKSPACE_PATH
 */
export function getArchonWorkspacesPath(): string {
  // Legacy support: if WORKSPACE_PATH is explicitly set to a custom path, use it
  const legacyPath = process.env.WORKSPACE_PATH;
  if (legacyPath && legacyPath !== './workspace' && !isDocker()) {
    return expandTilde(legacyPath);
  }

  return join(getArchonHome(), 'workspaces');
}

/**
 * Get the worktrees directory (where git worktrees are created)
 * Replaces WORKTREE_BASE
 */
export function getArchonWorktreesPath(): string {
  // Legacy support: if WORKTREE_BASE is explicitly set, use it
  const legacyPath = process.env.WORKTREE_BASE;
  if (legacyPath && !isDocker()) {
    return expandTilde(legacyPath);
  }

  return join(getArchonHome(), 'worktrees');
}

/**
 * Get the global config file path
 */
export function getArchonConfigPath(): string {
  return join(getArchonHome(), 'config.yaml');
}

/**
 * Get command folder search paths for a repository
 * Returns folders in priority order (first match wins)
 */
export function getCommandFolderSearchPaths(): string[] {
  return ['.archon/commands', '.claude/commands', '.agents/commands'];
}

/**
 * Get workflow folder search paths for a repository (future)
 */
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows', '.claude/workflows', '.agents/workflows'];
}

/**
 * Log the Archon paths configuration (for startup)
 */
export function logArchonPaths(): void {
  const home = getArchonHome();
  const workspaces = getArchonWorkspacesPath();
  const worktrees = getArchonWorktreesPath();
  const config = getArchonConfigPath();

  console.log('[Archon] Paths configured:');
  console.log(`  Home: ${home}`);
  console.log(`  Workspaces: ${workspaces}`);
  console.log(`  Worktrees: ${worktrees}`);
  console.log(`  Config: ${config}`);
}
```

- **PATTERN**: Mirror `src/utils/git.ts:33-62` for Docker detection and tilde expansion
- **IMPORTS**: `path`, `os`
- **GOTCHA**: Must handle both `/workspace` and `./workspace` legacy paths differently
- **VALIDATE**: `bun run type-check`

---

#### Task 1.2: CREATE `src/utils/archon-paths.test.ts`

**IMPLEMENT**: Comprehensive tests for path resolution

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import {
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
  getCommandFolderSearchPaths,
  expandTilde,
} from './archon-paths';

describe('archon-paths', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envVars = ['WORKSPACE_PATH', 'WORKTREE_BASE', 'ARCHON_HOME', 'ARCHON_DOCKER', 'HOME'];

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

  describe('expandTilde', () => {
    test('expands ~ to home directory', () => {
      expect(expandTilde('~/test')).toBe(join(homedir(), 'test'));
    });

    test('returns path unchanged if no tilde', () => {
      expect(expandTilde('/absolute/path')).toBe('/absolute/path');
    });
  });

  describe('isDocker', () => {
    test('returns true when WORKSPACE_PATH is /workspace', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when HOME=/root and WORKSPACE_PATH set', () => {
      process.env.HOME = '/root';
      process.env.WORKSPACE_PATH = '/app/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when ARCHON_DOCKER=true', () => {
      delete process.env.WORKSPACE_PATH;
      process.env.ARCHON_DOCKER = 'true';
      expect(isDocker()).toBe(true);
    });

    test('returns false for local development', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.HOME = homedir();
      expect(isDocker()).toBe(false);
    });
  });

  describe('getArchonHome', () => {
    test('returns /.archon in Docker', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(getArchonHome()).toBe('/.archon');
    });

    test('returns ARCHON_HOME when set (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonHome()).toBe('/custom/archon');
    });

    test('expands tilde in ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '~/my-archon';
      expect(getArchonHome()).toBe(join(homedir(), 'my-archon'));
    });

    test('returns ~/.archon by default (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonHome()).toBe(join(homedir(), '.archon'));
    });
  });

  describe('getArchonWorkspacesPath', () => {
    test('uses legacy WORKSPACE_PATH if explicitly set (non-default)', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      process.env.WORKSPACE_PATH = '/my/custom/workspace';
      expect(getArchonWorkspacesPath()).toBe('/my/custom/workspace');
    });

    test('ignores default ./workspace WORKSPACE_PATH', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      process.env.WORKSPACE_PATH = './workspace';
      expect(getArchonWorkspacesPath()).toBe(join(homedir(), '.archon', 'workspaces'));
    });

    test('returns ~/.archon/workspaces by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorkspacesPath()).toBe(join(homedir(), '.archon', 'workspaces'));
    });

    test('returns /.archon/workspaces in Docker', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(getArchonWorkspacesPath()).toBe('/.archon/workspaces');
    });
  });

  describe('getArchonWorktreesPath', () => {
    test('uses legacy WORKTREE_BASE if set (local only)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.WORKTREE_BASE = '/custom/worktrees';
      expect(getArchonWorktreesPath()).toBe('/custom/worktrees');
    });

    test('ignores WORKTREE_BASE in Docker', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      process.env.WORKTREE_BASE = '/custom/worktrees';
      expect(getArchonWorktreesPath()).toBe('/.archon/worktrees');
    });

    test('returns ~/.archon/worktrees by default (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorktreesPath()).toBe(join(homedir(), '.archon', 'worktrees'));
    });
  });

  describe('getCommandFolderSearchPaths', () => {
    test('returns folders in priority order', () => {
      const paths = getCommandFolderSearchPaths();
      expect(paths).toEqual(['.archon/commands', '.claude/commands', '.agents/commands']);
    });

    test('.archon/commands has highest priority', () => {
      const paths = getCommandFolderSearchPaths();
      expect(paths[0]).toBe('.archon/commands');
    });
  });

  describe('getArchonConfigPath', () => {
    test('returns path to config.yaml', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonConfigPath()).toBe(join(homedir(), '.archon', 'config.yaml'));
    });
  });
});
```

- **PATTERN**: Mirror `src/utils/git.test.ts` environment mocking pattern
- **VALIDATE**: `bun test src/utils/archon-paths.test.ts`

---

#### Task 1.3: UPDATE `src/utils/git.ts`

**IMPLEMENT**: Replace hardcoded path logic with archon-paths module

- **ADD** import at top:
```typescript
import { getArchonWorktreesPath } from './archon-paths';
```

- **REPLACE** `getWorktreeBase()` function (lines 28-51):
```typescript
/**
 * Get the base directory for worktrees
 * Now delegates to archon-paths module for consistency
 */
export function getWorktreeBase(_repoPath: string): string {
  return getArchonWorktreesPath();
}
```

- **KEEP** local `expandTilde()` function - it's used by other functions in this file
- **PATTERN**: `src/utils/git.ts:33-51`
- **GOTCHA**: Don't remove `getWorktreeBase()` entirely - it's part of the public API
- **VALIDATE**: `bun test src/utils/git.test.ts`

---

#### Task 1.4: UPDATE `src/utils/path-validation.ts`

**IMPLEMENT**: Use dynamic path resolution instead of constant

- **ADD** import at top:
```typescript
import { getArchonWorkspacesPath } from './archon-paths';
```

- **REPLACE** constant with function (line 7):
```typescript
// Before:
const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_PATH ?? '/workspace');

// After:
// Lazy evaluation to allow tests to modify env vars
function getWorkspaceRoot(): string {
  return resolve(getArchonWorkspacesPath());
}
```

- **UPDATE** `isPathWithinWorkspace()`:
```typescript
export function isPathWithinWorkspace(
  targetPath: string,
  basePath?: string
): boolean {
  const workspaceRoot = getWorkspaceRoot();
  const effectiveBase = basePath ?? workspaceRoot;
  const resolvedTarget = resolve(effectiveBase, targetPath);
  return resolvedTarget === workspaceRoot || resolvedTarget.startsWith(workspaceRoot + sep);
}
```

- **UPDATE** `validateAndResolvePath()`:
```typescript
export function validateAndResolvePath(
  targetPath: string,
  basePath?: string
): string {
  const workspaceRoot = getWorkspaceRoot();
  const effectiveBase = basePath ?? workspaceRoot;
  const resolvedPath = resolve(effectiveBase, targetPath);

  if (!isPathWithinWorkspace(resolvedPath)) {
    throw new Error(`Path must be within ${workspaceRoot} directory`);
  }

  return resolvedPath;
}
```

- **PATTERN**: `src/utils/path-validation.ts:1-51`
- **GOTCHA**: Use lazy evaluation (function call) not constant, to allow test env mocking
- **VALIDATE**: `bun test src/utils/path-validation.test.ts`

---

#### Task 1.5: UPDATE `src/handlers/command-handler.ts`

**IMPLEMENT**: Use centralized path resolution and command folder search

- **ADD** imports at top:
```typescript
import { getArchonWorkspacesPath, getCommandFolderSearchPaths } from '../utils/archon-paths';
```

- **REPLACE** all `resolve(process.env.WORKSPACE_PATH ?? '/workspace')` with `getArchonWorkspacesPath()`:
  - Line 31 in `shortenPath()`
  - Line 198 in `setcwd` case
  - Line 255 in `clone` case
  - Line 442-443 in `command-set` case
  - Line 481-483 in `load-commands` case
  - Line 547 in `repos` case
  - Line 632 in `repo` case
  - Line 767 in `repo-remove` case

- **REPLACE** hardcoded command folder arrays with `getCommandFolderSearchPaths()`:
  - Line 287: `for (const folder of ['.claude/commands', '.agents/commands'])`
  - Line 387: Same
  - Line 722: Same

```typescript
// Before:
for (const folder of ['.claude/commands', '.agents/commands']) {

// After:
for (const folder of getCommandFolderSearchPaths()) {
```

- **UPDATE** help text (line 118) to mention `.archon/commands`:
```typescript
Note: Commands use relative paths (e.g., .archon/commands)
```

- **PATTERN**: `src/handlers/command-handler.ts:287-295`
- **GOTCHA**: Don't change command logic, only path resolution
- **VALIDATE**: `bun test src/handlers/command-handler.test.ts`

---

#### Task 1.6: UPDATE `src/adapters/github.ts`

**IMPLEMENT**: Use centralized path resolution for repository cloning

- **ADD** imports:
```typescript
import { getArchonWorkspacesPath, getCommandFolderSearchPaths } from '../utils/archon-paths';
```

- **REPLACE** line 411:
```typescript
// Before:
const canonicalPath = join(resolve(process.env.WORKSPACE_PATH ?? '/workspace'), owner, repo);

// After:
const canonicalPath = join(getArchonWorkspacesPath(), owner, repo);
```

- **UPDATE** `autoLoadCommands()` (around line 362) to use `getCommandFolderSearchPaths()`:
```typescript
const commandFolders = getCommandFolderSearchPaths();
// Use commandFolders in the loop
```

- **PATTERN**: `src/adapters/github.ts:362, 411`
- **VALIDATE**: `bun test src/adapters/github.test.ts`

---

#### Task 1.7: UPDATE `src/index.ts`

**IMPLEMENT**: Update startup with new path logging and warnings

- **ADD** import:
```typescript
import { getArchonWorkspacesPath, logArchonPaths } from './utils/archon-paths';
```

- **REPLACE** lines 67-76 with:
```typescript
// Log Archon paths configuration
logArchonPaths();

// Warn if workspaces path is inside project directory (legacy config)
const workspacePath = getArchonWorkspacesPath();
const projectRoot = resolve(__dirname, '..');
if (workspacePath.startsWith(projectRoot + '/') || workspacePath === projectRoot) {
  console.warn('');
  console.warn('[Archon] WARNING: Workspaces path is inside project directory');
  console.warn('   This can cause nested repository issues when working on this repo.');
  console.warn(`   Current: ${workspacePath}`);
  console.warn('   The new default is: ~/.archon/workspaces');
  console.warn('   To use the new default, remove WORKSPACE_PATH from .env');
  console.warn('');
}
```

- **PATTERN**: `src/index.ts:67-76`
- **VALIDATE**: `bun run dev` - check startup logs

---

#### Task 1.8: UPDATE `Dockerfile`

**IMPLEMENT**: Update paths for new Archon structure

- **ADD** after line 30 (after creating appuser):
```dockerfile
# Create Archon directories
RUN mkdir -p /.archon/workspaces /.archon/worktrees \
    && chown -R appuser:appuser /.archon
```

- **UPDATE** line 29 to remove /workspace creation:
```dockerfile
# Before:
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && mkdir -p /workspace \
    && chown -R appuser:appuser /app /workspace

# After:
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown -R appuser:appuser /app
```

- **UPDATE** git safe.directory config (line 59-60):
```dockerfile
# Before:
RUN git config --global --add safe.directory /workspace && \
    git config --global --add safe.directory '/workspace/*'

# After:
RUN git config --global --add safe.directory '/.archon/workspaces' && \
    git config --global --add safe.directory '/.archon/workspaces/*' && \
    git config --global --add safe.directory '/.archon/worktrees' && \
    git config --global --add safe.directory '/.archon/worktrees/*'
```

- **ADD** OCI labels after FROM line:
```dockerfile
LABEL org.opencontainers.image.source="https://github.com/dynamous-community/remote-coding-agent"
LABEL org.opencontainers.image.description="Control AI coding assistants remotely from Telegram, Slack, Discord, and GitHub"
LABEL org.opencontainers.image.licenses="MIT"
```

- **GOTCHA**: Keep `/workspace` as legacy mount point for backwards compatibility
- **VALIDATE**: `docker build -t remote-coding-agent-test .`

---

#### Task 1.9: UPDATE `docker-compose.yml`

**IMPLEMENT**: Update volume mounts for new paths

- **UPDATE** app service volumes:
```yaml
# Add after existing volumes
volumes:
  - ${WORKSPACE_PATH:-./workspace}:/workspace  # Legacy support
  - archon_data:/.archon  # New Archon directory
```

- **ADD** named volume:
```yaml
volumes:
  postgres_data:
  archon_data:  # Persistent Archon data
```

- **GOTCHA**: Keep legacy `/workspace` mount for backwards compatibility
- **VALIDATE**: `docker compose config`

---

#### Task 1.10: UPDATE `.env.example`

**IMPLEMENT**: Document new configuration options

- **ADD** after existing WORKSPACE_PATH documentation:
```bash
# ============================================
# Archon Directory Configuration (NEW)
# ============================================
# All Archon-managed files go in ~/.archon/ by default
# Override with ARCHON_HOME to use a custom location
# ARCHON_HOME=~/.archon

# Legacy Configuration (still supported)
# WORKSPACE_PATH - Override workspaces location (default: ~/.archon/workspaces)
# WORKTREE_BASE - Override worktrees location (default: ~/.archon/worktrees)

# For Docker, paths are automatically set to /.archon/
```

- **VALIDATE**: Manual review

---

#### Task 1.11: UPDATE `CLAUDE.md`

**IMPLEMENT**: Document new directory structure

- **ADD** new section after "Worktree Symbiosis":
```markdown
### Archon Directory Structure

All Archon-managed files are organized under a dedicated namespace:

**User-level (`~/.archon/`):**
```
~/.archon/
├── workspaces/     # Cloned repositories (via /clone)
│   └── owner/repo/
├── worktrees/      # Git worktrees for isolation
│   └── repo-name/
│       └── branch-name/
└── config.yaml     # Global configuration (non-secrets)
```

**Repo-level (`.archon/` in any repository):**
```
.archon/
├── commands/       # Custom command templates
├── workflows/      # Future: workflow definitions
└── config.yaml     # Repo-specific configuration
```

**For Docker:** Paths are automatically set to `/.archon/`.

**Configuration:**
- `ARCHON_HOME` - Override the base directory (default: `~/.archon`)
- Legacy `WORKSPACE_PATH` and `WORKTREE_BASE` are still supported

**Command folder detection priority:**
1. `.archon/commands/` (new)
2. `.claude/commands/` (legacy)
3. `.agents/commands/` (legacy)
```

- **VALIDATE**: Manual review

---

### Phase 2: Docker Distribution

---

#### Task 2.1: CREATE `.github/workflows/publish.yml`

**IMPLEMENT**: Docker and npm publishing workflow

```yaml
name: Publish

on:
  release:
    types: [published]
  push:
    tags:
      - 'v*'
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  docker:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=sha
            type=raw,value=latest,enable=${{ github.ref == format('refs/heads/{0}', 'main') }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- **PATTERN**: `.github/workflows/test.yml`
- **GOTCHA**: Multi-arch builds require QEMU and Buildx setup
- **VALIDATE**: Check workflow syntax in GitHub Actions tab after push

---

#### Task 2.2: CREATE `deploy/docker-compose.yml`

**IMPLEMENT**: Minimal compose file for end users

```yaml
# Remote Coding Agent - Docker Compose for End Users
#
# Usage:
#   1. Copy this file and .env.example to your server
#   2. Rename .env.example to .env and configure
#   3. Run: docker compose up -d
#
# For full documentation, see:
# https://github.com/dynamous-community/remote-coding-agent

services:
  app:
    image: ghcr.io/dynamous-community/remote-coding-agent:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      - archon_data:/.archon
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

  # Uncomment to run PostgreSQL locally
  # postgres:
  #   image: postgres:16-alpine
  #   restart: unless-stopped
  #   environment:
  #     POSTGRES_DB: remote_coding_agent
  #     POSTGRES_USER: postgres
  #     POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
  #   volumes:
  #     - postgres_data:/var/lib/postgresql/data
  #   healthcheck:
  #     test: ["CMD-SHELL", "pg_isready -U postgres"]
  #     interval: 10s
  #     timeout: 5s
  #     retries: 5

volumes:
  archon_data:
  # postgres_data:
```

- **VALIDATE**: `cd deploy && docker compose config`

---

#### Task 2.3: CREATE `deploy/.env.example`

**IMPLEMENT**: Minimal environment example for end users

```bash
# Remote Coding Agent - Environment Configuration
# Copy to .env and fill in your values

# ============================================
# Required: Database
# ============================================
# Use a managed PostgreSQL (Supabase, Neon, etc.)
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Or uncomment postgres service in docker-compose.yml and use:
# DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# ============================================
# Required: AI Assistant (at least one)
# ============================================
# Claude (recommended) - Get token: claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Or Codex - Get from ~/.codex/auth.json after: codex login
# CODEX_ID_TOKEN=...
# CODEX_ACCESS_TOKEN=...
# CODEX_REFRESH_TOKEN=...
# CODEX_ACCOUNT_ID=...

# ============================================
# Required: Platform (at least one)
# ============================================
# Telegram - Create bot via @BotFather
TELEGRAM_BOT_TOKEN=123456789:ABC...

# Discord - Create bot at discord.com/developers
# DISCORD_BOT_TOKEN=...

# Slack - Create app at api.slack.com/apps
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...

# GitHub Webhooks
# GH_TOKEN=ghp_...
# GITHUB_TOKEN=ghp_...
# WEBHOOK_SECRET=...

# ============================================
# Optional
# ============================================
PORT=3000
# TELEGRAM_STREAMING_MODE=stream
# DISCORD_STREAMING_MODE=batch
```

- **VALIDATE**: Manual review

---

#### Task 2.4: UPDATE `README.md`

**IMPLEMENT**: Add Docker pull instructions

- **ADD** new section after "Prerequisites":

```markdown
---

## Quick Start with Docker

The fastest way to get started:

```bash
# Pull the latest image
docker pull ghcr.io/dynamous-community/remote-coding-agent:latest

# Create configuration
mkdir remote-agent && cd remote-agent
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/.env.example -o .env
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/docker-compose.yml -o docker-compose.yml

# Edit .env with your tokens
nano .env

# Start
docker compose up -d

# Check logs
docker compose logs -f app
```

For detailed setup including platform configuration, continue to [Setup Guide](#setup-guide).

---
```

- **VALIDATE**: Manual review

---

### Phase 3: YAML Configuration System

---

#### Task 3.1: CREATE `src/config/types.ts`

**IMPLEMENT**: Configuration type definitions

```typescript
/**
 * Configuration type definitions for Archon
 *
 * Config precedence:
 * 1. Environment variables (secrets, highest priority)
 * 2. ~/.archon/config.yaml (global user preferences)
 * 3. .archon/config.yaml (per-repo settings)
 * 4. Built-in defaults (lowest priority)
 */

/**
 * Platform-specific configuration
 */
export interface PlatformConfig {
  streaming?: 'stream' | 'batch';
  enabled?: boolean;
}

export interface TelegramConfig extends PlatformConfig {
  // Future: additional Telegram-specific options
}

export interface DiscordConfig extends PlatformConfig {
  createThreads?: boolean;
}

export interface SlackConfig extends PlatformConfig {
  // Future: additional Slack-specific options
}

export interface GitHubConfig extends PlatformConfig {
  autoClone?: boolean;
  autoLoadCommands?: boolean;
}

/**
 * AI assistant configuration
 */
export interface AIConfig {
  default?: 'claude' | 'codex';
  claude?: {
    model?: string;
  };
  codex?: {
    model?: string;
  };
}

/**
 * Path configuration (usually from env vars)
 */
export interface PathConfig {
  home?: string;
  workspaces?: string;
  worktrees?: string;
}

/**
 * Workflow configuration (future)
 */
export interface WorkflowConfig {
  enabled?: boolean;
  autoRun?: boolean;
}

/**
 * Complete Archon configuration
 */
export interface ArchonConfig {
  // Paths (usually resolved from env/defaults, can be overridden)
  paths?: PathConfig;

  // AI assistant preferences
  ai?: AIConfig;

  // Platform-specific settings
  platforms?: {
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
    slack?: SlackConfig;
    github?: GitHubConfig;
  };

  // Workflow engine settings (future)
  workflows?: WorkflowConfig;

  // Default behaviors
  defaults?: {
    streaming?: 'stream' | 'batch';
    aiAssistant?: 'claude' | 'codex';
  };
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: ArchonConfig = {
  ai: {
    default: 'claude',
  },
  platforms: {
    telegram: { streaming: 'stream' },
    discord: { streaming: 'batch', createThreads: true },
    slack: { streaming: 'batch' },
    github: { streaming: 'batch', autoClone: true, autoLoadCommands: true },
  },
  defaults: {
    streaming: 'batch',
    aiAssistant: 'claude',
  },
};
```

- **PATTERN**: `src/types/index.ts`
- **VALIDATE**: `bun run type-check`

---

#### Task 3.2: CREATE `src/config/loader.ts`

**IMPLEMENT**: YAML configuration loading with precedence chain

```typescript
/**
 * Configuration loader with precedence chain
 *
 * Precedence (highest to lowest):
 * 1. Environment variables (for secrets)
 * 2. ~/.archon/config.yaml (global user preferences)
 * 3. .archon/config.yaml (per-repo settings)
 * 4. Built-in defaults
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getArchonHome, getArchonConfigPath } from '../utils/archon-paths';
import { ArchonConfig, DEFAULT_CONFIG } from './types';

// Cache for loaded configs
let globalConfigCache: ArchonConfig | null = null;
let globalConfigMtime: number = 0;

/**
 * Deep merge two objects, with source taking precedence
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Load and parse a YAML config file
 */
async function loadYamlFile(filePath: string): Promise<ArchonConfig | null> {
  try {
    if (!existsSync(filePath)) {
      return null;
    }

    const content = await Bun.file(filePath).text();
    const parsed = Bun.YAML.parse(content) as ArchonConfig;
    return parsed;
  } catch (error) {
    console.warn(`[Config] Failed to load ${filePath}:`, error);
    return null;
  }
}

/**
 * Load global config from ~/.archon/config.yaml
 * Uses caching with mtime check for hot reload support
 */
export async function loadGlobalConfig(): Promise<ArchonConfig> {
  const configPath = getArchonConfigPath();

  try {
    if (existsSync(configPath)) {
      const stat = await Bun.file(configPath).stat();
      const mtime = stat?.mtime?.getTime() ?? 0;

      // Return cached if file hasn't changed
      if (globalConfigCache && mtime === globalConfigMtime) {
        return globalConfigCache;
      }

      const loaded = await loadYamlFile(configPath);
      if (loaded) {
        globalConfigCache = deepMerge(DEFAULT_CONFIG, loaded);
        globalConfigMtime = mtime;
        return globalConfigCache;
      }
    }
  } catch {
    // Ignore errors, return defaults
  }

  return DEFAULT_CONFIG;
}

/**
 * Load repo-specific config from .archon/config.yaml
 */
export async function loadRepoConfig(repoPath: string): Promise<ArchonConfig | null> {
  const configPath = join(repoPath, '.archon', 'config.yaml');
  return loadYamlFile(configPath);
}

/**
 * Load merged config for a specific repo
 * Merges: defaults < global < repo
 */
export async function loadConfig(repoPath?: string): Promise<ArchonConfig> {
  // Start with defaults
  let config = { ...DEFAULT_CONFIG };

  // Merge global config
  const globalConfig = await loadGlobalConfig();
  config = deepMerge(config, globalConfig);

  // Merge repo config if provided
  if (repoPath) {
    const repoConfig = await loadRepoConfig(repoPath);
    if (repoConfig) {
      config = deepMerge(config, repoConfig);
    }
  }

  return config;
}

/**
 * Get a specific config value with type safety
 */
export function getConfigValue<T>(
  config: ArchonConfig,
  path: string,
  defaultValue: T
): T {
  const parts = path.split('.');
  let current: unknown = config;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return defaultValue;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return (current as T) ?? defaultValue;
}

/**
 * Clear config cache (useful for testing)
 */
export function clearConfigCache(): void {
  globalConfigCache = null;
  globalConfigMtime = 0;
}

/**
 * Log loaded configuration (for debugging)
 */
export function logConfig(config: ArchonConfig): void {
  console.log('[Config] Loaded configuration:');
  console.log(`  AI Default: ${config.ai?.default ?? 'claude'}`);
  console.log(`  Telegram Streaming: ${config.platforms?.telegram?.streaming ?? 'stream'}`);
  console.log(`  Discord Streaming: ${config.platforms?.discord?.streaming ?? 'batch'}`);
  console.log(`  Slack Streaming: ${config.platforms?.slack?.streaming ?? 'batch'}`);
  console.log(`  GitHub Streaming: ${config.platforms?.github?.streaming ?? 'batch'}`);
}
```

- **PATTERN**: Uses Bun native YAML parsing
- **IMPORTS**: Bun built-in YAML
- **GOTCHA**: Cache invalidation based on mtime for hot reload
- **VALIDATE**: `bun run type-check`

---

#### Task 3.3: CREATE `src/config/loader.test.ts`

**IMPLEMENT**: Tests for configuration loading

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import {
  loadConfig,
  loadGlobalConfig,
  loadRepoConfig,
  getConfigValue,
  clearConfigCache,
} from './loader';
import { DEFAULT_CONFIG } from './types';

describe('config/loader', () => {
  const testDir = join(tmpdir(), 'archon-config-test-' + Date.now());
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save env
    originalEnv.ARCHON_HOME = process.env.ARCHON_HOME;

    // Create test directory
    mkdirSync(testDir, { recursive: true });
    process.env.ARCHON_HOME = testDir;

    // Clear cache
    clearConfigCache();
  });

  afterEach(() => {
    // Restore env
    if (originalEnv.ARCHON_HOME === undefined) {
      delete process.env.ARCHON_HOME;
    } else {
      process.env.ARCHON_HOME = originalEnv.ARCHON_HOME;
    }

    // Cleanup
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    clearConfigCache();
  });

  describe('loadGlobalConfig', () => {
    test('returns defaults when no config file', async () => {
      const config = await loadGlobalConfig();
      expect(config.ai?.default).toBe('claude');
    });

    test('loads and merges config file', async () => {
      const configPath = join(testDir, 'config.yaml');
      writeFileSync(configPath, `
ai:
  default: codex
platforms:
  telegram:
    streaming: batch
`);

      const config = await loadGlobalConfig();
      expect(config.ai?.default).toBe('codex');
      expect(config.platforms?.telegram?.streaming).toBe('batch');
      // Defaults should still be present
      expect(config.platforms?.discord?.streaming).toBe('batch');
    });
  });

  describe('loadRepoConfig', () => {
    test('returns null when no config file', async () => {
      const config = await loadRepoConfig('/nonexistent');
      expect(config).toBeNull();
    });

    test('loads repo config', async () => {
      const repoPath = join(testDir, 'test-repo');
      const archonDir = join(repoPath, '.archon');
      mkdirSync(archonDir, { recursive: true });
      writeFileSync(join(archonDir, 'config.yaml'), `
ai:
  default: codex
`);

      const config = await loadRepoConfig(repoPath);
      expect(config?.ai?.default).toBe('codex');
    });
  });

  describe('loadConfig', () => {
    test('merges global and repo configs', async () => {
      // Create global config
      writeFileSync(join(testDir, 'config.yaml'), `
ai:
  default: claude
platforms:
  telegram:
    streaming: stream
`);

      // Create repo config
      const repoPath = join(testDir, 'test-repo');
      const archonDir = join(repoPath, '.archon');
      mkdirSync(archonDir, { recursive: true });
      writeFileSync(join(archonDir, 'config.yaml'), `
platforms:
  telegram:
    streaming: batch
`);

      const config = await loadConfig(repoPath);

      // Global value preserved
      expect(config.ai?.default).toBe('claude');
      // Repo value overrides global
      expect(config.platforms?.telegram?.streaming).toBe('batch');
    });
  });

  describe('getConfigValue', () => {
    test('gets nested values', () => {
      const value = getConfigValue(DEFAULT_CONFIG, 'platforms.telegram.streaming', 'unknown');
      expect(value).toBe('stream');
    });

    test('returns default for missing paths', () => {
      const value = getConfigValue(DEFAULT_CONFIG, 'nonexistent.path', 'fallback');
      expect(value).toBe('fallback');
    });
  });
});
```

- **PATTERN**: `src/utils/archon-paths.test.ts` for env mocking
- **VALIDATE**: `bun test src/config/loader.test.ts`

---

#### Task 3.4: CREATE `src/config/index.ts`

**IMPLEMENT**: Re-export configuration module

```typescript
/**
 * Configuration module exports
 */
export * from './types';
export * from './loader';
```

- **VALIDATE**: `bun run type-check`

---

#### Task 3.5: UPDATE `src/index.ts` - Config Integration

**IMPLEMENT**: Load and log configuration at startup

- **ADD** import:
```typescript
import { loadGlobalConfig, logConfig } from './config';
```

- **ADD** after `logArchonPaths()`:
```typescript
// Load and log configuration
const config = await loadGlobalConfig();
logConfig(config);
```

- **VALIDATE**: `bun run dev` - check startup logs

---

### Phase 4: Developer Experience

---

#### Task 4.1: CREATE `scripts/validate-setup.sh`

**IMPLEMENT**: Setup validation script

```bash
#!/bin/bash
# validate-setup.sh - Validate Remote Coding Agent configuration
#
# Usage: ./scripts/validate-setup.sh

set -e

echo "🔍 Remote Coding Agent Setup Validator"
echo "======================================="
echo ""

ERRORS=0
WARNINGS=0

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_pass() {
  echo -e "${GREEN}✓${NC} $1"
}

check_fail() {
  echo -e "${RED}✗${NC} $1"
  ((ERRORS++))
}

check_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
  ((WARNINGS++))
}

# Check .env file
echo "📋 Configuration Files"
echo "----------------------"

if [ -f ".env" ]; then
  check_pass ".env file exists"
else
  check_fail ".env file not found (copy from .env.example)"
fi

# Check required environment variables
echo ""
echo "🔑 Required Environment Variables"
echo "----------------------------------"

# Load .env if exists
if [ -f ".env" ]; then
  set -a
  source .env 2>/dev/null || true
  set +a
fi

if [ -n "$DATABASE_URL" ]; then
  check_pass "DATABASE_URL is set"
else
  check_fail "DATABASE_URL not set"
fi

# AI Assistants
echo ""
echo "🤖 AI Assistants"
echo "----------------"

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$CLAUDE_API_KEY" ]; then
  check_pass "Claude credentials configured"
else
  check_warn "Claude credentials not found"
fi

if [ -n "$CODEX_ID_TOKEN" ] && [ -n "$CODEX_ACCESS_TOKEN" ]; then
  check_pass "Codex credentials configured"
else
  check_warn "Codex credentials not found"
fi

if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$CLAUDE_API_KEY" ] && [ -z "$CODEX_ID_TOKEN" ]; then
  check_fail "No AI assistant credentials found (need at least one)"
fi

# Platforms
echo ""
echo "💬 Platform Adapters"
echo "--------------------"

PLATFORMS=0

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  check_pass "Telegram configured"
  ((PLATFORMS++))
else
  check_warn "Telegram not configured"
fi

if [ -n "$DISCORD_BOT_TOKEN" ]; then
  check_pass "Discord configured"
  ((PLATFORMS++))
else
  check_warn "Discord not configured"
fi

if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_APP_TOKEN" ]; then
  check_pass "Slack configured"
  ((PLATFORMS++))
else
  check_warn "Slack not configured"
fi

if [ -n "$GITHUB_TOKEN" ] && [ -n "$WEBHOOK_SECRET" ]; then
  check_pass "GitHub webhooks configured"
  ((PLATFORMS++))
else
  check_warn "GitHub webhooks not configured"
fi

if [ $PLATFORMS -eq 0 ]; then
  check_fail "No platform adapters configured (need at least one)"
fi

# Docker
echo ""
echo "🐳 Docker"
echo "---------"

if command -v docker &> /dev/null; then
  check_pass "Docker is installed"

  if docker compose version &> /dev/null; then
    check_pass "Docker Compose is available"
  else
    check_warn "Docker Compose not found"
  fi
else
  check_warn "Docker not installed (required for containerized deployment)"
fi

# Archon paths
echo ""
echo "📁 Archon Paths"
echo "---------------"

ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
echo "  Home: $ARCHON_HOME"
echo "  Workspaces: $ARCHON_HOME/workspaces"
echo "  Worktrees: $ARCHON_HOME/worktrees"

if [ -d "$ARCHON_HOME" ]; then
  check_pass "Archon home directory exists"
else
  check_warn "Archon home directory will be created on first run"
fi

# Summary
echo ""
echo "======================================="
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}❌ Validation failed with $ERRORS error(s) and $WARNINGS warning(s)${NC}"
  echo ""
  echo "Please fix the errors above before running the application."
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}⚠️  Validation passed with $WARNINGS warning(s)${NC}"
  echo ""
  echo "The application should work, but some features may be unavailable."
  exit 0
else
  echo -e "${GREEN}✅ All checks passed!${NC}"
  echo ""
  echo "You can start the application with:"
  echo "  bun run dev      # Development with hot reload"
  echo "  docker compose up -d  # Docker deployment"
  exit 0
fi
```

- **VALIDATE**: `chmod +x scripts/validate-setup.sh && ./scripts/validate-setup.sh`

---

#### Task 4.2: UPDATE `package.json`

**IMPLEMENT**: Add validate script

- **ADD** to scripts:
```json
"validate": "./scripts/validate-setup.sh"
```

- **VALIDATE**: `bun run validate`

---

### Phase 5: Documentation

---

#### Task 5.1: UPDATE `README.md` - Comprehensive Setup Guide

**IMPLEMENT**: Restructure README with clear setup paths for different users

The README should have these sections in order:

1. **Quick Start with Docker** (for users who want to try it fast)
2. **Local Development Setup** (for developers)
3. **Self-Hosted Deployment** (link to docs/cloud-deployment.md)
4. **Configuration Reference** (link to docs/configuration.md)

- **ADD** after the project description:
```markdown
## Quick Start

### Option 1: Docker (Recommended for trying it out)

```bash
# 1. Get the files
mkdir remote-agent && cd remote-agent
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/.env.example -o .env

# 2. Configure (edit .env with your tokens)
nano .env

# 3. Run
docker compose up -d

# 4. Check it's working
curl http://localhost:3000/health
```

### Option 2: Local Development

```bash
# 1. Clone and install
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install

# 2. Configure
cp .env.example .env
nano .env  # Add your tokens

# 3. Start database
docker compose --profile with-db up -d postgres

# 4. Run migrations
bun run migrate

# 5. Start with hot reload
bun run dev

# 6. Validate setup
bun run validate
```

### Option 3: Self-Hosted Production

See [Cloud Deployment Guide](docs/cloud-deployment.md) for deploying to:
- DigitalOcean, Linode, AWS EC2, or any VPS
- With automatic HTTPS via Caddy

## Directory Structure

The app uses `~/.archon/` for all managed files:

```
~/.archon/
├── workspaces/     # Cloned repositories
├── worktrees/      # Git worktrees for isolation
└── config.yaml     # Optional: global configuration
```

On Windows: `C:\Users\<username>\.archon\`
In Docker: `/.archon/`

See [Configuration Guide](docs/configuration.md) for customization options.
```

- **VALIDATE**: Manual review, links work

---

#### Task 5.2: CREATE `docs/configuration.md`

**IMPLEMENT**: Comprehensive configuration reference

```markdown
# Configuration Guide

This guide covers all configuration options for the Remote Coding Agent.

## Configuration Methods

Configuration can be set via three methods (in order of precedence):

1. **Environment Variables** (highest priority) - For secrets and deployment-specific settings
2. **Global Config** (`~/.archon/config.yaml`) - For user preferences
3. **Repo Config** (`.archon/config.yaml` in each repo) - For project-specific settings

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |

### AI Assistants (at least one required)

| Variable | Description | Example |
|----------|-------------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth token | `sk-ant-oat01-...` |
| `CLAUDE_API_KEY` | Claude API key (alternative) | `sk-ant-...` |
| `CODEX_ID_TOKEN` | Codex ID token | `eyJ...` |
| `CODEX_ACCESS_TOKEN` | Codex access token | `eyJ...` |
| `CODEX_REFRESH_TOKEN` | Codex refresh token | `rt_...` |
| `CODEX_ACCOUNT_ID` | Codex account ID | `uuid` |

### Platform Adapters (at least one required)

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | `123456789:ABC...` |
| `DISCORD_BOT_TOKEN` | Discord bot token | `...` |
| `SLACK_BOT_TOKEN` | Slack bot token | `xoxb-...` |
| `SLACK_APP_TOKEN` | Slack app token | `xapp-...` |
| `GITHUB_TOKEN` | GitHub personal access token | `ghp_...` |
| `GH_TOKEN` | Same as GITHUB_TOKEN | `ghp_...` |
| `WEBHOOK_SECRET` | GitHub webhook secret | `random-string` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `ARCHON_HOME` | Override Archon directory | `~/.archon` |
| `WORKSPACE_PATH` | Legacy: override workspaces path | `~/.archon/workspaces` |
| `WORKTREE_BASE` | Legacy: override worktrees path | `~/.archon/worktrees` |
| `DEFAULT_AI_ASSISTANT` | Default AI assistant | `claude` |
| `TELEGRAM_STREAMING_MODE` | Telegram streaming mode | `stream` |
| `DISCORD_STREAMING_MODE` | Discord streaming mode | `batch` |
| `SLACK_STREAMING_MODE` | Slack streaming mode | `batch` |
| `GITHUB_STREAMING_MODE` | GitHub streaming mode | `batch` |

## YAML Configuration

For non-secret settings, you can use YAML configuration files.

### Global Config: `~/.archon/config.yaml`

```yaml
# AI assistant preferences
ai:
  default: claude  # or 'codex'

# Platform-specific settings
platforms:
  telegram:
    streaming: stream  # or 'batch'
  discord:
    streaming: batch
    createThreads: true
  slack:
    streaming: batch
  github:
    streaming: batch
    autoClone: true
    autoLoadCommands: true

# Default behaviors
defaults:
  streaming: batch
  aiAssistant: claude
```

### Repo Config: `.archon/config.yaml`

Place this in any repository to override settings for that repo:

```yaml
# Override AI assistant for this repo
ai:
  default: codex

# Repo-specific platform settings
platforms:
  github:
    autoLoadCommands: false
```

## Directory Structure

### Archon Home (`~/.archon/`)

| Path | Purpose |
|------|---------|
| `~/.archon/workspaces/` | Cloned repositories |
| `~/.archon/worktrees/` | Git worktrees for isolation |
| `~/.archon/config.yaml` | Global configuration |

### Per-Repo (`.archon/`)

| Path | Purpose |
|------|---------|
| `.archon/commands/` | Custom command templates |
| `.archon/workflows/` | Future: workflow definitions |
| `.archon/config.yaml` | Repo-specific configuration |

### Platform-Specific Paths

| Platform | Default Path |
|----------|--------------|
| macOS | `~/.archon/` → `/Users/<username>/.archon/` |
| Linux | `~/.archon/` → `/home/<username>/.archon/` |
| Windows | `~/.archon/` → `C:\Users\<username>\.archon\` |
| Docker | `/.archon/` (fixed) |

### Custom Paths

Override with environment variables:

```bash
# Change entire Archon home
export ARCHON_HOME=/custom/path

# Or change specific directories (legacy support)
export WORKSPACE_PATH=/custom/workspaces
export WORKTREE_BASE=/custom/worktrees
```

## Setup Validation

Run the validation script to check your configuration:

```bash
# From repo root
./scripts/validate-setup.sh

# Or via bun
bun run validate
```

This checks:
- Required environment variables
- AI assistant credentials
- Platform adapter configuration
- Directory permissions
- Docker availability
```

- **VALIDATE**: Manual review

---

#### Task 5.3: UPDATE `docs/cloud-deployment.md`

**IMPLEMENT**: Update cloud deployment guide for new paths

- **UPDATE** Section 4 (Environment Configuration) to reference new paths:
```markdown
### Archon Directory

The app stores cloned repositories and worktrees in `/.archon/` inside the container.

This is automatically configured. If you need to persist data between container restarts, the `docker-compose.yml` mounts a volume to `/.archon/`.

For custom paths, set `ARCHON_HOME` in your `.env`:
```env
# Default (recommended)
# ARCHON_HOME=/.archon

# Custom location
ARCHON_HOME=/data/archon
```
```

- **UPDATE** Section 7 (Start Services) to use new docker-compose:
```markdown
### Using Pre-built Images (Recommended)

```bash
# Download deploy files
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/docker-compose.yml -o docker-compose.yml

# Start (pulls from GHCR automatically)
docker compose up -d
```

### Building Locally

```bash
# Clone and build
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build
```
```

- **ADD** troubleshooting section for Archon paths:
```markdown
### Archon Directory Issues

**Check directory exists:**
```bash
docker compose exec app ls -la /.archon/
```

**Check permissions:**
```bash
docker compose exec app id
# Should show uid=1001(appuser)
```

**Manual directory creation (if needed):**
```bash
docker compose exec app mkdir -p /.archon/workspaces /.archon/worktrees
```
```

- **VALIDATE**: Manual review

---

#### Task 5.4: CREATE `docs/getting-started.md`

**IMPLEMENT**: Step-by-step getting started guide for new users

```markdown
# Getting Started

This guide walks you through setting up the Remote Coding Agent from scratch.

## Prerequisites

Before you begin, you'll need:

1. **Docker** (recommended) or **Bun** runtime
2. **PostgreSQL** database (local or managed like Supabase/Neon)
3. **AI Assistant credentials** (Claude or Codex)
4. **Platform credentials** (Telegram, Discord, Slack, or GitHub)

## Step 1: Choose Your Setup Method

| Method | Best For | Time |
|--------|----------|------|
| [Docker Quick Start](#docker-quick-start) | Trying it out, production | ~10 min |
| [Local Development](#local-development) | Contributing, customizing | ~15 min |
| [Cloud Deployment](cloud-deployment.md) | 24/7 self-hosted | ~30 min |

## Docker Quick Start

### 1.1 Get the Files

```bash
mkdir remote-agent && cd remote-agent

# Download docker-compose and env template
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/.env.example -o .env
```

### 1.2 Get Your Credentials

#### Database

**Option A: Use a managed database (recommended)**
1. Create a free database at [Supabase](https://supabase.com) or [Neon](https://neon.tech)
2. Copy the connection string

**Option B: Run PostgreSQL locally**
- Uncomment the postgres service in docker-compose.yml
- Use: `postgresql://postgres:postgres@postgres:5432/remote_coding_agent`

#### AI Assistant

**Claude (recommended):**
1. Install Claude Code CLI: https://docs.anthropic.com/claude-code
2. Run: `claude setup-token`
3. Copy the token (starts with `sk-ant-oat01-`)

**Codex:**
1. Run: `codex login`
2. Copy credentials from `~/.codex/auth.json`

#### Platform (choose at least one)

**Telegram:**
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts
3. Copy the bot token

**Discord:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create New Application → Bot → Reset Token
3. Enable MESSAGE CONTENT INTENT in Bot settings
4. Copy the bot token

**Slack:**
1. Go to [Slack API](https://api.slack.com/apps)
2. Create New App → From Scratch
3. See [Slack Setup Guide](slack-setup.md) for detailed steps

### 1.3 Configure

Edit `.env` with your credentials:

```bash
nano .env
```

At minimum, set:
- `DATABASE_URL`
- One AI assistant (`CLAUDE_CODE_OAUTH_TOKEN` or Codex credentials)
- One platform (`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, etc.)

### 1.4 Start

```bash
docker compose up -d
```

### 1.5 Verify

```bash
# Check health
curl http://localhost:3000/health
# Expected: {"status":"ok"}

# Check database
curl http://localhost:3000/health/db
# Expected: {"status":"ok","database":"connected"}
```

### 1.6 Test Your Bot

Send a message to your bot:
- **Telegram**: Message your bot with `/help`
- **Discord**: Mention your bot with `@botname /help`
- **Slack**: Message your bot with `/help`

## Local Development

### 2.1 Clone and Install

```bash
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install
```

### 2.2 Configure

```bash
cp .env.example .env
nano .env  # Add your credentials (same as Docker method)
```

### 2.3 Start Database

```bash
docker compose --profile with-db up -d postgres
```

### 2.4 Run Migrations

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

### 2.5 Validate Setup

```bash
./scripts/validate-setup.sh
```

### 2.6 Start Development Server

```bash
bun run dev
```

The server starts with hot reload. Changes to code automatically restart.

## Next Steps

- [Configuration Guide](configuration.md) - Customize settings
- [Command System](../CLAUDE.md#command-system-patterns) - Create custom commands
- [Cloud Deployment](cloud-deployment.md) - Deploy for 24/7 operation

## Troubleshooting

### "Database connection failed"

1. Check `DATABASE_URL` is correct
2. For managed DB: Ensure IP is whitelisted
3. For local: Ensure postgres container is running: `docker compose ps`

### "No AI assistant credentials found"

Set at least one of:
- `CLAUDE_CODE_OAUTH_TOKEN` (recommended)
- `CLAUDE_API_KEY`
- `CODEX_ID_TOKEN` + `CODEX_ACCESS_TOKEN` + `CODEX_REFRESH_TOKEN`

### "Bot not responding"

1. Check logs: `docker compose logs -f app` or terminal output for `bun run dev`
2. Verify bot token is correct
3. For Discord: Ensure MESSAGE CONTENT INTENT is enabled
4. For Slack: Ensure Socket Mode is enabled

### Archon Directory Not Created

The `~/.archon/` directory is created automatically on first use. To create manually:

```bash
mkdir -p ~/.archon/workspaces ~/.archon/worktrees
```
```

- **VALIDATE**: Manual review

---

#### Task 5.5: CREATE `docs/archon-architecture.md`

**IMPLEMENT**: Technical documentation explaining the Archon directory architecture for developers

```markdown
# Archon Architecture

This document explains the Archon directory structure and configuration system for developers contributing to or extending the remote-coding-agent.

## Overview

Archon is the unified directory and configuration system for the remote-coding-agent. It provides:

1. **Consistent paths** across all platforms (Mac, Linux, Windows, Docker)
2. **Configuration precedence** chain (env → global → repo → defaults)
3. **Future-ready structure** for workflow engine and UI integration

## Directory Structure

### User-Level: `~/.archon/`

```
~/.archon/                    # ARCHON_HOME
├── workspaces/               # Cloned repositories
│   └── owner/
│       └── repo/
├── worktrees/                # Git worktrees for isolation
│   └── repo-name/
│       └── branch-name/
└── config.yaml               # Global user configuration
```

**Purpose:**
- `workspaces/` - Repositories cloned via `/clone` command or GitHub adapter
- `worktrees/` - Isolated git worktrees created per conversation/issue/PR
- `config.yaml` - Non-secret user preferences

### Repo-Level: `.archon/`

```
any-repo/.archon/
├── commands/                 # Custom command templates
│   ├── plan.md
│   └── execute.md
├── workflows/                # Future: workflow definitions
│   └── pr-review.yaml
└── config.yaml               # Repo-specific configuration
```

**Purpose:**
- `commands/` - Slash command templates (replaces `.claude/commands/`, `.agents/commands/`)
- `workflows/` - Future workflow engine definitions
- `config.yaml` - Project-specific settings

### Docker: `/.archon/`

In Docker containers, the Archon home is fixed at `/.archon/` (root level). This is:
- Mounted as a named volume for persistence
- Not overridable by end users (simplifies container setup)

## Path Resolution

All path resolution is centralized in `src/utils/archon-paths.ts`.

### Core Functions

```typescript
// Get the Archon home directory
getArchonHome(): string
// Returns: ~/.archon (local) or /.archon (Docker)

// Get workspaces directory
getArchonWorkspacesPath(): string
// Returns: ~/.archon/workspaces or legacy WORKSPACE_PATH

// Get worktrees directory
getArchonWorktreesPath(): string
// Returns: ~/.archon/worktrees or legacy WORKTREE_BASE

// Get global config path
getArchonConfigPath(): string
// Returns: ~/.archon/config.yaml

// Get command folder search paths (priority order)
getCommandFolderSearchPaths(): string[]
// Returns: ['.archon/commands', '.claude/commands', '.agents/commands']
```

### Docker Detection

```typescript
function isDocker(): boolean {
  return (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.ARCHON_DOCKER === 'true'
  );
}
```

### Platform-Specific Paths

| Platform | `getArchonHome()` |
|----------|-------------------|
| macOS | `/Users/<username>/.archon` |
| Linux | `/home/<username>/.archon` |
| Windows | `C:\Users\<username>\.archon` |
| Docker | `/.archon` |

## Configuration System

### Precedence Chain

Configuration is resolved in this order (highest to lowest priority):

1. **Environment Variables** - Secrets, deployment-specific
2. **Global Config** (`~/.archon/config.yaml`) - User preferences
3. **Repo Config** (`.archon/config.yaml`) - Project-specific
4. **Built-in Defaults** - Hardcoded in `src/config/types.ts`

### Config Loading

```typescript
// Load merged config for a repo
const config = await loadConfig(repoPath);

// Load just global config
const globalConfig = await loadGlobalConfig();

// Load just repo config
const repoConfig = await loadRepoConfig(repoPath);
```

### Hot Reload

Global config supports hot reload via mtime checking:
- Config is cached after first load
- On subsequent loads, mtime is checked
- If file changed, config is reloaded
- Enables live config changes during development

## Legacy Compatibility

### Environment Variables

These legacy variables are still supported:

| Legacy | New Default | Behavior |
|--------|-------------|----------|
| `WORKSPACE_PATH` | `~/.archon/workspaces` | Custom path respected if not `./workspace` |
| `WORKTREE_BASE` | `~/.archon/worktrees` | Custom path respected |

### Command Folders

Command detection searches in priority order:
1. `.archon/commands/` (new)
2. `.claude/commands/` (legacy)
3. `.agents/commands/` (legacy)

First match wins. No migration required.

## Extension Points

### Adding New Paths

To add a new managed directory:

1. Add function to `src/utils/archon-paths.ts`:
```typescript
export function getArchonNewPath(): string {
  return join(getArchonHome(), 'new-directory');
}
```

2. Update Docker setup in `Dockerfile`
3. Update volume mounts in `docker-compose.yml`
4. Add tests in `src/utils/archon-paths.test.ts`

### Adding Config Options

To add new configuration options:

1. Add type to `src/config/types.ts`:
```typescript
export interface ArchonConfig {
  // ...existing
  newFeature?: {
    enabled?: boolean;
    setting?: string;
  };
}
```

2. Add default in `DEFAULT_CONFIG`
3. Use via `loadConfig()` in your code

## Design Decisions

### Why `~/.archon/` instead of `~/.config/archon/`?

- Simpler path (fewer nested directories)
- Follows Claude Code pattern (`~/.claude/`)
- Cross-platform without XDG complexity
- Easy to find and manage manually

### Why YAML for config?

- Bun has native support (`Bun.YAML.parse()`)
- Supports comments (unlike JSON)
- Future workflow definitions need YAML
- No external dependencies

### Why fixed Docker paths?

- Simplifies container setup
- Predictable volume mounts
- No user confusion about env vars in containers
- Matches convention (apps use fixed paths in containers)

### Why config precedence chain?

- Mirrors git config pattern (familiar to developers)
- Secrets stay in env vars (security)
- User preferences in global config (portable)
- Project settings in repo config (version-controlled)

## Future Considerations

### Workflow Engine

The `.archon/workflows/` directory is reserved for:
- YAML workflow definitions
- Multi-step automated processes
- Agent orchestration rules

### UI Integration

The config type system is designed for:
- Future web UI configuration
- API-driven config updates
- Real-time config validation

### Multi-Tenant / SaaS

Path structure supports future scenarios:
- Per-user isolation
- Organization-level config
- Shared workflow templates
```

- **VALIDATE**: Manual review

---

#### Task 5.6: UPDATE New Files to Create list

**IMPLEMENT**: Add documentation files to the "New Files to Create" section at the top of this plan

- **ADD** to "New Files to Create" section:
```markdown
- `docs/configuration.md` - Comprehensive configuration reference
- `docs/getting-started.md` - Step-by-step setup guide for new users
- `docs/archon-architecture.md` - Technical architecture docs for developers
```

- **VALIDATE**: Manual review of plan coherence

---

## TESTING STRATEGY

### Unit Tests

Based on Bun's test framework with mock.module() for isolation:

- `src/utils/archon-paths.test.ts` - Path resolution with env mocking
- `src/config/loader.test.ts` - Config loading with file system mocking

### Integration Tests

- Test path resolution in actual file operations
- Test config loading with real YAML files

### Edge Cases

- [ ] Legacy `WORKSPACE_PATH=./workspace` should be ignored
- [ ] Legacy `WORKSPACE_PATH=/custom/path` should be respected
- [ ] Docker detection with various env combinations
- [ ] Tilde expansion in all path-related env vars
- [ ] Missing config files gracefully default
- [ ] Invalid YAML files don't crash startup
- [ ] Config hot reload when file changes

---

## VALIDATION COMMANDS

Execute every command to ensure zero regressions and 100% feature correctness.

### Level 1: Syntax & Style

```bash
# TypeScript type checking
bun run type-check

# ESLint (must pass with 0 errors)
bun run lint

# Prettier formatting check
bun run format:check
```

**Expected**: All commands pass with exit code 0

### Level 2: Unit Tests

```bash
# Run all tests
bun test

# Run specific test files
bun test src/utils/archon-paths.test.ts
bun test src/config/loader.test.ts

# Run with coverage
bun test --coverage
```

**Expected**: All tests pass, no regressions

### Level 3: Build & Docker

```bash
# Build TypeScript
bun run build

# Build Docker image
docker build -t remote-coding-agent-test .

# Verify Docker image labels
docker inspect remote-coding-agent-test | grep -A10 Labels
```

**Expected**: Build succeeds, image has OCI labels

### Level 4: Manual Validation

```bash
# 1. Start the app
bun run dev

# Expected logs:
# [Archon] Paths configured:
#   Home: /Users/you/.archon
#   Workspaces: /Users/you/.archon/workspaces
#   Worktrees: /Users/you/.archon/worktrees
#   Config: /Users/you/.archon/config.yaml
# [Config] Loaded configuration:
#   AI Default: claude
#   ...

# 2. Test via test adapter
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-archon","message":"/status"}'

# 3. Verify paths in status output
curl http://localhost:3000/test/messages/test-archon | jq

# 4. Run validation script
./scripts/validate-setup.sh
```

### Level 5: Docker Validation

```bash
# Build and run
docker compose --profile with-db up -d --build

# Check logs
docker compose logs -f app-with-db

# Verify paths inside container
docker compose exec app-with-db ls -la /.archon/

# Test health endpoint
curl http://localhost:3000/health

# Cleanup
docker compose --profile with-db down
```

---

## ACCEPTANCE CRITERIA

- [ ] All path references use centralized `archon-paths` module
- [ ] Docker images publish to GHCR on release
- [ ] Multi-arch builds work (amd64, arm64)
- [ ] YAML config loads with correct precedence
- [ ] Legacy env vars (`WORKSPACE_PATH`, `WORKTREE_BASE`) still work
- [ ] All validation commands pass with zero errors
- [ ] Unit test coverage maintained (no regression)
- [ ] Documentation updated with new directory structure
- [ ] Startup logs show Archon paths and config
- [ ] README has clear Quick Start for Docker and Local Development
- [ ] `docs/configuration.md` covers all config options
- [ ] `docs/getting-started.md` provides step-by-step guide
- [ ] `docs/cloud-deployment.md` updated for new paths
- [ ] `docs/archon-architecture.md` explains system to developers
- [ ] Windows/Mac/Linux paths documented

---

## COMPLETION CHECKLIST

- [ ] All Phase 1 tasks completed (Archon Directory Structure)
- [ ] All Phase 2 tasks completed (Docker Distribution)
- [ ] All Phase 3 tasks completed (YAML Configuration)
- [ ] All Phase 4 tasks completed (Developer Experience)
- [ ] All Phase 5 tasks completed (Documentation)
- [ ] Each task validation passed immediately
- [ ] All validation commands executed successfully:
  - [ ] Level 1: type-check, lint, format:check
  - [ ] Level 2: all tests pass
  - [ ] Level 3: build, Docker image builds
  - [ ] Level 4: manual testing confirms paths/config
  - [ ] Level 5: Docker compose works end-to-end
- [ ] Full test suite passes
- [ ] No linting errors
- [ ] No type checking errors
- [ ] Build succeeds
- [ ] All acceptance criteria met

---

## NOTES

### Design Decisions

1. **YAML over JSON for config**: Bun has native support, YAML supports comments, better for workflows
2. **Lazy evaluation for paths**: Functions instead of constants allow test env mocking
3. **Backwards compatibility**: Legacy env vars still work, no migration required
4. **Config precedence**: Env > global > repo > defaults mirrors git config pattern
5. **Hot reload support**: Config cached with mtime check for development

### Future Considerations

1. **Workflow Engine**: `.archon/workflows/` directory ready for workflow definitions
2. **UI Integration**: Config types designed for future web UI consumption
3. **SaaS Mode**: Path structure supports future multi-tenant scenarios
4. **Per-Workflow Config**: Type system extensible for workflow-specific settings

### Risks

1. **Breaking existing setups**: Mitigated by legacy env var support
2. **Docker volume mounts**: Document required changes for existing deployments
3. **Test pollution during migration**: Clean env var handling in tests

### Out of Scope

- Web UI for configuration
- Workflow engine implementation
- Per-workflow configuration loading
- SaaS/multi-tenant features
- CLI wizard for setup (use validation script instead)
