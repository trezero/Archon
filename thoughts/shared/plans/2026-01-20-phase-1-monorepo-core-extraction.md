# Phase 1: Monorepo Structure + Core Package Extraction

## Overview

Restructure the codebase into a Bun monorepo with workspaces, extracting shared business logic into `@archon/core` while keeping platform adapters and the HTTP server in `@archon/server`. This is the foundation for the CLI-first architecture refactor.

## Current State Analysis

### Directory Structure (96 files in src/)

- **adapters/** (10 files) - Platform integrations (Telegram, Slack, Discord, GitHub, Test) + tests
- **clients/** (6 files) - AI SDK wrappers (Claude, Codex) + factory + tests
- **config/** (4 files) - YAML config loading (config-loader, config-types, index) + tests
- **db/** (14 files) - PostgreSQL operations (7 modules + 7 tests)
- **handlers/** (2 files) - Slash command processing + tests
- **isolation/** (4 files) - Git worktree management (providers/worktree, types, index) + tests
- **orchestrator/** (2 files) - AI conversation orchestration + tests
- **services/** (2 files) - Background cleanup + tests
- **state/** (2 files) - Session state machine + tests
- **types/** (1 file) - Core TypeScript interfaces
- **utils/** (30 files) - Shared utilities (15 modules + 15 tests)
- **workflows/** (10 files) - YAML workflow system (5 modules + 5 tests)
- **scripts/** (1 file) - setup-auth.ts
- **test/** (4 files) - Test mocks and setup
- **index.ts** - Express server entry point

### Key Dependencies Discovered

1. **GitHub adapter imports orchestrator** (`src/adapters/github.ts:8`) - handles webhooks internally
2. **Types re-export workflow types** (`src/types/index.ts:183-190`) - creates cross-module dependency (MUST be removed)
3. **All other adapters are pure** - only implement `IPlatformAdapter` interface
4. **Orchestrator is the central hub** - imports from 15 other modules (db, handlers, utils, clients, isolation, workflows, state)
5. **Command handler is heavy consumer** - imports from 16 other modules
6. **Config module has internal dependency** - config-loader imports from utils/archon-paths
7. **DB modules have no index.ts** - need to create one for clean exports
8. **Clients module has no index.ts** - need to create one for clean exports

### Current Configuration

- **tsconfig.json**: ES2022, ESNext modules, bundler resolution, strict mode
- **eslint.config.mjs**: Flat config with typescript-eslint strict rules
- **.prettierrc**: Single quotes, semicolons, 100 print width

## Desired End State

```
remote-coding-agent/
├── packages/
│   ├── core/                    # @archon/core
│   │   ├── src/
│   │   │   ├── clients/         # AI SDK clients
│   │   │   ├── config/          # Config loading
│   │   │   ├── db/              # Database layer
│   │   │   ├── handlers/        # Slash commands
│   │   │   ├── isolation/       # Worktree providers
│   │   │   ├── orchestrator/    # Message orchestration
│   │   │   ├── services/        # Background services
│   │   │   ├── state/           # Session state machine
│   │   │   ├── types/           # Core interfaces
│   │   │   ├── utils/           # Shared utilities
│   │   │   ├── workflows/       # Workflow engine
│   │   │   └── index.ts         # Package exports
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── server/                  # @archon/server
│       ├── src/
│       │   ├── adapters/        # Platform adapters
│       │   └── index.ts         # Express server
│       ├── package.json
│       └── tsconfig.json
├── migrations/                  # Unchanged
├── .archon/                     # Unchanged
├── package.json                 # Workspace root
├── tsconfig.json                # Base config (shared)
├── eslint.config.mjs            # Shared ESLint
├── .prettierrc                  # Shared Prettier
└── bun.lockb
```

### Verification Checklist

- [ ] `bun install` succeeds from root
- [ ] `bun run dev` starts the server
- [ ] `bun run test` passes all tests
- [ ] `bun run type-check` passes
- [ ] `bun run lint` passes
- [ ] All adapters can send/receive messages
- [ ] GitHub webhooks work
- [ ] Workflow execution works

## What We're NOT Doing

- NOT creating the CLI package yet (Phase 2)
- NOT migrating from Express to Hono (Phase 4)
- NOT changing any business logic
- NOT adding new features
- NOT refactoring the GitHub adapter's webhook handling (works as-is)

## Implementation Approach

1. Create workspace structure with empty packages first
2. Move files incrementally, running tests after each batch
3. Update imports to use `@archon/core` package reference
4. Keep all functionality working throughout

---

## Sub-Phase 1.1: Create Workspace Root Structure

### Overview

Set up the monorepo workspace configuration at the root level.

### Changes Required:

#### 1.1.1 Update Root package.json

**File**: `package.json`
**Changes**: Convert to workspace root

```json
{
  "name": "archon",
  "private": true,
  "workspaces": ["packages/*"],
  "type": "module",
  "scripts": {
    "dev": "bun --filter @archon/server dev",
    "start": "bun --filter @archon/server start",
    "build": "bun --filter '*' build",
    "test": "bun --filter '*' test",
    "test:watch": "bun --filter @archon/server test:watch",
    "type-check": "bun --filter '*' type-check",
    "lint": "bun x eslint . --cache",
    "lint:fix": "bun x eslint . --cache --fix",
    "format": "bun x prettier --write .",
    "format:check": "bun x prettier --check .",
    "validate": "bun run type-check && bun run lint && bun run test",
    "prepare": "husky",
    "setup-auth": "bun --filter @archon/server setup-auth"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.1",
    "@types/bun": "latest",
    "bun-types": "^1.3.5",
    "eslint": "^9.39.1",
    "eslint-config-prettier": "10.1.8",
    "husky": "^9.1.7",
    "lint-staged": "^15.2.0",
    "prettier": "^3.7.4",
    "typescript": "^5.3.0",
    "typescript-eslint": "^8.48.0"
  },
  "engines": {
    "bun": ">=1.0.0"
  },
  "overrides": {
    "test-exclude": "^7.0.1"
  }
}
```

#### 1.1.2 Update Root tsconfig.json

**File**: `tsconfig.json`
**Changes**: Convert to base config that packages extend

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["bun-types"]
  }
}
```

#### 1.1.3 Update eslint.config.mjs

**File**: `eslint.config.mjs`
**Changes**: Update paths for monorepo structure

```javascript
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores (applied to all configs)
  {
    ignores: [
      'node_modules/**',
      'packages/*/node_modules/**',
      'packages/*/dist/**',
      'dist/**',
      'coverage/**',
      '.agents/examples/**',
      'workspace/**',
      'worktrees/**',
      '**/*.js',
      '*.mjs',
      '**/*.test.ts',
    ],
  },

  // Base configs
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // Prettier integration
  prettierConfig,

  // Project-specific settings
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
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
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/restrict-plus-operands': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-deprecated': 'warn',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'warn',
    },
  }
);
```

#### 1.1.4 Create packages directory

**Action**: Create `packages/` directory structure

```bash
mkdir -p packages/core/src
mkdir -p packages/server/src
```

### Success Criteria:

#### Automated Verification:

- [ ] Directory structure exists: `ls packages/core packages/server`
- [ ] Root package.json is valid: `cat package.json | bun x json5`

#### Manual Verification:

- [ ] None for this sub-phase

---

## Sub-Phase 1.2: Create @archon/core Package

### Overview

Create the core package with its package.json and tsconfig.json.

### Changes Required:

#### 1.2.1 Create packages/core/package.json

**File**: `packages/core/package.json`
**Changes**: New file

```json
{
  "name": "@archon/core",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types/index.ts",
    "./db": "./src/db/index.ts",
    "./db/*": "./src/db/*.ts",
    "./clients": "./src/clients/index.ts",
    "./workflows": "./src/workflows/index.ts",
    "./isolation": "./src/isolation/index.ts",
    "./orchestrator": "./src/orchestrator/orchestrator.ts",
    "./handlers": "./src/handlers/command-handler.ts",
    "./config": "./src/config/index.ts",
    "./utils/*": "./src/utils/*.ts",
    "./services/*": "./src/services/*.ts",
    "./state/*": "./src/state/*.ts"
  },
  "scripts": {
    "test": "bun test src/",
    "type-check": "bun x tsc --noEmit",
    "build": "echo 'No build needed - Bun runs TypeScript directly'"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.7",
    "@openai/codex-sdk": "^0.87.0",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  }
}
```

#### 1.2.2 Create packages/core/tsconfig.json

**File**: `packages/core/tsconfig.json`
**Changes**: New file

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

#### 1.2.3 Create packages/core/src/index.ts

**File**: `packages/core/src/index.ts`
**Changes**: New file - main exports (will be populated as files move)

```typescript
/**
 * @archon/core - Shared business logic for Archon
 *
 * This package contains:
 * - Workflow engine (YAML-based multi-step workflows)
 * - AI client adapters (Claude, Codex)
 * - Database operations (PostgreSQL)
 * - Isolation providers (git worktrees)
 * - Orchestration logic
 * - Utility functions
 */

// Types (core interfaces, no workflow types - those come from ./workflows)
export * from './types';

// Database (use db submodule for namespace imports)
export * from './db';

// AI Clients
export * from './clients';

// Workflows (includes WorkflowDefinition, WorkflowRun, StepDefinition, etc.)
export * from './workflows';

// Isolation
export * from './isolation';

// Orchestrator
export { handleMessage } from './orchestrator/orchestrator';

// Handlers
export { handleCommand, parseCommand } from './handlers/command-handler';

// Config (includes loadGlobalConfig, loadRepoConfig, loadConfig, clearConfigCache, logConfig)
export * from './config';

// Services
export { startCleanupScheduler, stopCleanupScheduler } from './services/cleanup-service';

// State (includes TransitionTrigger type and all transition functions)
export * from './state/session-transitions';

// Utils - exported individually for tree-shaking
export { ConversationLockManager } from './utils/conversation-lock';
export { classifyAndFormatError } from './utils/error-formatter';
export { formatToolCalls } from './utils/tool-formatter';
export { substituteVariables } from './utils/variable-substitution';
export { sanitizeCredentialsFromLogs } from './utils/credential-sanitizer';
export * from './utils/archon-paths';
export * from './utils/git';
export * from './utils/github-graphql';
export { validatePath } from './utils/path-validation';
export { getPort, isWorktreePath } from './utils/port-allocation';
export { copyFilesToWorktree } from './utils/worktree-copy';
export { syncWorkspaceFromOrigin } from './utils/worktree-sync';
export { copyDefaultsToRepo } from './utils/defaults-copy';

// Platform-specific auth utilities (used by adapters in @archon/server)
// Note: telegram-auth, slack-auth, discord-auth all export parseAllowedUserIds with same name
// Import these as namespaced modules to avoid conflicts:
//   import * as telegramAuth from '@archon/core/utils/telegram-auth';
export * from './utils/telegram-auth'; // parseAllowedUserIds, isUserAuthorized
export { isSlackUserAuthorized } from './utils/slack-auth'; // parseAllowedUserIds (name conflict)
export { isDiscordUserAuthorized } from './utils/discord-auth'; // parseAllowedUserIds (name conflict)
export {
  parseAllowedUsers as parseGitHubAllowedUsers,
  isGitHubUserAuthorized,
} from './utils/github-auth';

// Telegram markdown utilities
export {
  convertToTelegramMarkdown,
  escapeMarkdownV2,
  isAlreadyEscaped,
  stripMarkdown,
} from './utils/telegram-markdown';
```

### Success Criteria:

#### Automated Verification:

- [ ] Package files exist: `ls packages/core/package.json packages/core/tsconfig.json packages/core/src/index.ts`

#### Manual Verification:

- [ ] None for this sub-phase

---

## Sub-Phase 1.3: Create @archon/server Package

### Overview

Create the server package with its package.json and tsconfig.json.

### Changes Required:

#### 1.3.1 Create packages/server/package.json

**File**: `packages/server/package.json`
**Changes**: New file

```json
{
  "name": "@archon/server",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test src/",
    "type-check": "bun x tsc --noEmit",
    "setup-auth": "bun src/scripts/setup-auth.ts"
  },
  "dependencies": {
    "@archon/core": "workspace:*",
    "@octokit/rest": "^22.0.0",
    "@slack/bolt": "^4.6.0",
    "discord.js": "^14.16.0",
    "dotenv": "^17.2.3",
    "express": "^5.2.1",
    "telegraf": "^4.16.0",
    "telegramify-markdown": "^1.3.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.5",
    "@types/node": "^22.0.0"
  }
}
```

#### 1.3.2 Create packages/server/tsconfig.json

**File**: `packages/server/tsconfig.json`
**Changes**: New file

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "paths": {
      "@archon/core": ["../core/src"],
      "@archon/core/*": ["../core/src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

### Success Criteria:

#### Automated Verification:

- [ ] Package files exist: `ls packages/server/package.json packages/server/tsconfig.json`

#### Manual Verification:

- [ ] None for this sub-phase

---

## Sub-Phase 1.4: Move Core Modules to @archon/core

### Overview

Move all shared business logic modules from `src/` to `packages/core/src/`.

**IMPORTANT**: Test files (`*.test.ts`) are co-located with source files. When you `mv src/utils packages/core/src/`, all 15 test files in utils/ move with the source files. This is correct - tests should stay with their source.

### Changes Required:

#### 1.4.1 Move types module

**Action**: Move `src/types/` to `packages/core/src/types/`

```bash
mv src/types packages/core/src/
```

**Fix circular re-export**: Edit `packages/core/src/types/index.ts` to remove the workflow types re-export (lines 183-190). The workflows module will export its own types.

#### 1.4.2 Move utils module

**Action**: Move `src/utils/` to `packages/core/src/utils/`

```bash
mv src/utils packages/core/src/
```

#### 1.4.3 Move config module

**Action**: Move `src/config/` to `packages/core/src/config/`

```bash
mv src/config packages/core/src/
```

#### 1.4.4 Move state module

**Action**: Move `src/state/` to `packages/core/src/state/`

```bash
mv src/state packages/core/src/
```

**Note**: The state module exports:

- `TransitionTrigger` type
- `shouldCreateNewSession(trigger)` function
- `shouldDeactivateSession(trigger)` function
- `detectPlanToExecuteTransition(...)` function
- `getTriggerForCommand(commandName)` function

All are re-exported via `export * from './state/session-transitions'` in core/index.ts.

#### 1.4.5 Move db module

**Action**: Move `src/db/` to `packages/core/src/db/`

```bash
mv src/db packages/core/src/
```

**Create index.ts** for db module:

**File**: `packages/core/src/db/index.ts`

```typescript
/**
 * Database module exports
 *
 * Use namespace imports for db operations to avoid naming conflicts:
 *   import * as conversationDb from '@archon/core/db/conversations';
 *   import * as codebaseDb from '@archon/core/db/codebases';
 */

export { pool } from './connection';

// Re-export namespaced for convenience
export * as conversationDb from './conversations';
export * as codebaseDb from './codebases';
export * as sessionDb from './sessions';
export * as commandTemplateDb from './command-templates';
export * as isolationEnvDb from './isolation-environments';
export * as workflowDb from './workflows';

// Also export individual functions for direct imports
export * from './conversations';
export * from './codebases';
export { SessionNotFoundError } from './sessions';
export * from './sessions';
export * from './command-templates';
export * from './isolation-environments';
export * from './workflows';
```

#### 1.4.6 Move clients module

**Action**: Move `src/clients/` to `packages/core/src/clients/`

```bash
mv src/clients packages/core/src/
```

**Create index.ts** for clients module:

**File**: `packages/core/src/clients/index.ts`

```typescript
/**
 * AI Assistant Clients
 */

export { ClaudeClient } from './claude';
export { CodexClient } from './codex';
export { getAssistantClient } from './factory';

// Re-export types from main types module for convenience
export type { IAssistantClient, MessageChunk } from '../types';
```

#### 1.4.7 Move isolation module

**Action**: Move `src/isolation/` to `packages/core/src/isolation/`

```bash
mv src/isolation packages/core/src/
```

#### 1.4.8 Move workflows module

**Action**: Move `src/workflows/` to `packages/core/src/workflows/`

```bash
mv src/workflows packages/core/src/
```

#### 1.4.9 Move services module

**Action**: Move `src/services/` to `packages/core/src/services/`

```bash
mv src/services packages/core/src/
```

#### 1.4.10 Move orchestrator module

**Action**: Move `src/orchestrator/` to `packages/core/src/orchestrator/`

```bash
mv src/orchestrator packages/core/src/
```

#### 1.4.11 Move handlers module

**Action**: Move `src/handlers/` to `packages/core/src/handlers/`

```bash
mv src/handlers packages/core/src/
```

#### 1.4.12 Move test utilities to @archon/core

**Action**: Move `src/test/` to `packages/core/src/test/`

```bash
mv src/test packages/core/src/
```

**Why core, not server?** The test mocks (database.ts, platform.ts, streaming.ts) are used by tests in:

- `db/*.test.ts` (database mock)
- `orchestrator/orchestrator.test.ts` (platform mock)
- `workflows/executor.test.ts` (database mock)

All of these are in @archon/core. The platform.ts mock imports `IPlatformAdapter` from types which is also in core.

### Success Criteria:

#### Automated Verification:

- [ ] All directories moved: `ls packages/core/src/` shows types, utils, config, state, db, clients, isolation, workflows, services, orchestrator, handlers, test
- [ ] Original src/ only has adapters, index.ts, scripts/: `ls src/` shows adapters/, index.ts, scripts/

#### Manual Verification:

- [ ] None for this sub-phase

---

## Sub-Phase 1.5: Move Server Modules to @archon/server

### Overview

Move adapters and server entry point to `@archon/server`.

### Changes Required:

#### 1.5.1 Move adapters module

**Action**: Move `src/adapters/` to `packages/server/src/adapters/`

```bash
mv src/adapters packages/server/src/
```

#### 1.5.2 Move server entry point

**Action**: Move `src/index.ts` to `packages/server/src/index.ts`

```bash
mv src/index.ts packages/server/src/
```

#### 1.5.3 Move scripts

**Action**: Move `src/scripts/` to `packages/server/src/scripts/`

```bash
mv src/scripts packages/server/src/
```

#### 1.5.4 Remove old src directory

**Action**: Remove now-empty `src/` directory

```bash
rmdir src
```

### Success Criteria:

#### Automated Verification:

- [ ] Server package has files: `ls packages/server/src/` shows adapters/, index.ts, scripts/
- [ ] Old src/ directory removed: `! test -d src`

#### Manual Verification:

- [ ] None for this sub-phase

---

## Sub-Phase 1.6: Update All Imports

### Overview

Update all import statements to use `@archon/core` package references.

### Changes Required:

#### 1.6.1 Update imports in @archon/core

**Pattern**: Change relative imports that cross module boundaries

Example changes in `packages/core/src/orchestrator/orchestrator.ts`:

- `import { pool } from '../db/connection'` → `import { pool } from '../db/connection'` (unchanged - same package)
- All internal imports stay relative within the package

#### 1.6.2 Update imports in @archon/server

**Key patterns to follow:**

1. **For database operations**, use namespace imports to avoid naming conflicts:

   ```typescript
   import * as conversationDb from '@archon/core/db/conversations';
   import * as codebaseDb from '@archon/core/db/codebases';
   import * as sessionDb from '@archon/core/db/sessions';
   ```

2. **For types**, import from the main package:

   ```typescript
   import type { IPlatformAdapter, Conversation, Codebase } from '@archon/core';
   ```

3. **For utilities and singletons**, import directly:
   ```typescript
   import { pool, handleMessage, ConversationLockManager } from '@archon/core';
   ```

**File**: `packages/server/src/index.ts`
**Changes**: Update imports to use @archon/core

```typescript
// Before
import { handleMessage } from './orchestrator/orchestrator';
import { pool } from './db/connection';
import { ConversationLockManager } from './utils/conversation-lock';
import { classifyAndFormatError } from './utils/error-formatter';
import { startCleanupScheduler, stopCleanupScheduler } from './services/cleanup-service';
import { logArchonPaths } from './utils/archon-paths';
import { loadConfig, logConfig } from './config';
import { getPort } from './utils/port-allocation';

// After
import {
  handleMessage,
  pool,
  ConversationLockManager,
  classifyAndFormatError,
  startCleanupScheduler,
  stopCleanupScheduler,
  logArchonPaths,
  loadConfig,
  logConfig,
  getPort,
  isWorktreePath,
} from '@archon/core';
import type { IPlatformAdapter, MergedConfig } from '@archon/core';
```

**File**: `packages/server/src/adapters/github.ts`
**Changes**: Update imports to use @archon/core

```typescript
// Before
import type { IPlatformAdapter, IsolationHints, IsolationEnvironmentRow } from '../types';
import { handleMessage } from '../orchestrator/orchestrator';
import { classifyAndFormatError } from '../utils/error-formatter';
import * as conversationDb from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import { parseGitHubAllowedUsers, isGitHubUserAuthorized } from '../utils/github-auth';
import * as graphql from '../utils/github-graphql';
import { startCleanupScheduler, stopCleanupScheduler } from '../services/cleanup-service';
import * as git from '../utils/git';
import { getArchonWorkspacesPath, getArchonWorktreesPath } from '../utils/archon-paths';
import { copyDefaultsToRepo } from '../utils/defaults-copy';
import { ConversationLockManager } from '../utils/conversation-lock';

// After
import type { IPlatformAdapter, IsolationHints, IsolationEnvironmentRow } from '@archon/core';
import {
  handleMessage,
  classifyAndFormatError,
  parseGitHubAllowedUsers,
  isGitHubUserAuthorized,
  startCleanupScheduler,
  stopCleanupScheduler,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
  copyDefaultsToRepo,
  ConversationLockManager,
} from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as graphql from '@archon/core/utils/github-graphql';
import * as git from '@archon/core/utils/git';
```

Similar updates needed for:

- `packages/server/src/adapters/telegram.ts` - Uses telegram-auth, telegram-markdown
- `packages/server/src/adapters/slack.ts` - Uses slack-auth
- `packages/server/src/adapters/discord.ts` - Uses discord-auth
- `packages/server/src/adapters/test.ts` - Minimal imports

**Note**: Test mocks are in `packages/core/src/test/mocks/` since they're used by core tests.

**File**: `packages/server/src/adapters/telegram.ts`
**Changes**: Example of auth utility imports

```typescript
// Before
import { parseAllowedUserIds, isUserAuthorized } from '../utils/telegram-auth';
import { convertToTelegramMarkdown, escapeMarkdownV2 } from '../utils/telegram-markdown';

// After - use namespace import to get all auth utilities without conflicts
import * as telegramAuth from '@archon/core/utils/telegram-auth';
import { convertToTelegramMarkdown, escapeMarkdownV2 } from '@archon/core';
// Usage: telegramAuth.parseAllowedUserIds(...), telegramAuth.isUserAuthorized(...)
```

**Alternative** if you need direct imports from multiple auth modules:

```typescript
// Import from specific submodules to avoid naming conflicts
import {
  parseAllowedUserIds as parseTelegramUserIds,
  isUserAuthorized as isTelegramUserAuthorized,
} from '@archon/core/utils/telegram-auth';
import {
  parseAllowedUserIds as parseSlackUserIds,
  isSlackUserAuthorized,
} from '@archon/core/utils/slack-auth';
```

#### 1.6.3 Remove circular re-export from types/index.ts

**CRITICAL**: The current `src/types/index.ts` has a re-export that will break when files are moved:

**File**: `packages/core/src/types/index.ts`
**Changes**: Remove lines 183-190 (the re-export of workflow types)

```typescript
// REMOVE these lines (183-190):
// Re-export workflow types for convenience
export type {
  WorkflowDefinition,
  WorkflowRun,
  StepDefinition,
  StepResult,
  LoadCommandResult,
} from '../workflows/types';
```

**Why**: This creates a circular dependency between types and workflows modules. The fix is:

- Workflow types are exported via `@archon/core/workflows` (the workflows/index.ts already does this)
- The main `@archon/core` index.ts re-exports `* from './workflows'` which includes all workflow types
- Consumers import workflow types from `@archon/core` or `@archon/core/workflows`

**Before (old pattern)**:

```typescript
import type { WorkflowDefinition } from '@archon/core/types'; // ❌ Will break
```

**After (new pattern)**:

```typescript
import type { WorkflowDefinition } from '@archon/core'; // ✅ Works
// or
import type { WorkflowDefinition } from '@archon/core/workflows'; // ✅ Works
```

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `bun run type-check`
- [ ] No relative imports crossing package boundaries in server: `grep -r "from '\.\./\.\." packages/server/src/ | grep -v node_modules` returns nothing

#### Manual Verification:

- [ ] None for this sub-phase

---

## Sub-Phase 1.7: Install Dependencies and Verify

### Overview

Run bun install and verify the entire setup works.

### Changes Required:

#### 1.7.1 Clean and reinstall

```bash
rm -rf node_modules packages/*/node_modules bun.lockb
bun install
```

#### 1.7.2 Verify type checking

```bash
bun run type-check
```

#### 1.7.3 Run all tests

```bash
bun run test
```

#### 1.7.4 Run linting

```bash
bun run lint
```

#### 1.7.5 Start dev server

```bash
bun run dev
```

### Success Criteria:

#### Automated Verification:

- [ ] Dependencies install: `bun install` exits 0
- [ ] Type checking passes: `bun run type-check` exits 0
- [ ] Tests pass: `bun run test` exits 0
- [ ] Linting passes: `bun run lint` exits 0
- [ ] Server starts: `bun run dev` shows "[App] Starting Remote Coding Agent"

#### Manual Verification:

- [ ] Send a test message via Telegram/Slack and verify response
- [ ] Verify GitHub webhook still works (or test with `/test/message` endpoint)
- [ ] Run a workflow to verify workflow execution works

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before considering Phase 1 complete.

---

## Known Risks and Mitigations

### Risk 1: ESLint projectService with Monorepo

**Issue**: ESLint's `projectService: true` may struggle with monorepo structure.
**Mitigation**: The updated eslint.config.mjs uses `tsconfigRootDir: import.meta.dirname` to anchor TypeScript project resolution.

### Risk 2: Bun Workspace Resolution

**Issue**: Bun workspaces use `workspace:*` protocol which differs from npm/pnpm.
**Mitigation**: Ensure both package.json files use `"@archon/core": "workspace:*"` syntax.

### Risk 3: Test Discovery

**Issue**: Tests are co-located with source files. After moving to packages, test runners need to find them.
**Mitigation**: Each package.json has its own `"test": "bun test src/"` script. Root runs all via `bun --filter '*' test`.

### Risk 4: Import Path Changes Breaking Tests

**Issue**: Test files import from relative paths that will change.
**Mitigation**: Update imports in test files along with implementation files. Tests in `packages/core/src/` use relative imports within the package.

### Risk 5: Database Connection Sharing

**Issue**: Both packages will access the same PostgreSQL connection pool.
**Mitigation**: `pool` is a singleton exported from `@archon/core`. All packages use the same connection.

---

## Testing Strategy

### Unit Tests

- All existing tests should pass without modification
- Tests are co-located with source files (`*.test.ts`)
- Test utilities (mocks) in `packages/core/src/test/mocks/`

### Integration Tests

- Test adapter message flow end-to-end
- Test workflow execution with test adapter

### Manual Testing Steps

1. Start server: `bun run dev`
2. Send `/status` command via test adapter: `curl -X POST http://localhost:3000/test/message -H "Content-Type: application/json" -d '{"conversationId":"test","message":"/status"}'`
3. Check response: `curl http://localhost:3000/test/messages/test`
4. Verify workflow discovery: `curl -X POST http://localhost:3000/test/message -H "Content-Type: application/json" -d '{"conversationId":"test2","message":"/workflow list"}'`

---

## Rollback Plan

If issues are discovered:

1. **Git reset**: `git checkout .` to restore all files
2. **Remove packages dir**: `rm -rf packages/`
3. **Restore src/**: `git checkout src/`
4. **Reinstall**: `rm -rf node_modules bun.lockb && bun install`

---

## References

- Research document: `thoughts/shared/research/2026-01-20-cli-first-refactor-feasibility.md`
- Architecture diagram: `thoughts/shared/research/2026-01-20-cli-first-architecture-diagram.md`
- Bun workspaces: https://bun.com/docs/pm/workspaces
