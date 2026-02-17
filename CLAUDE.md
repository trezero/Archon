## Project Overview

**Remote Agentic Coding Platform**: Control AI coding assistants (Claude Code SDK, Codex SDK) remotely from Slack, Telegram, and GitHub. Built with **Bun + TypeScript + PostgreSQL/SQLite**, single-developer tool for practitioners of the Dynamous Agentic Coding Course. Architecture prioritizes simplicity, flexibility, and user control.

## Core Principles

**Single-Developer Tool**
- No multi-tenant complexity
- Commands versioned with Git (not stored in database)
- All credentials in environment variables only
- 7-table database schema (see Database Schema section)

**User-Controlled Workflows**
- Manual phase transitions via slash commands
- Generic command system - users define their own commands
- Working directory + codebase context determine behavior
- Session persistence across restarts

**Platform Agnostic**
- Unified conversation interface across Slack/Telegram/GitHub
- Platform adapters implement `IPlatformAdapter`
- Stream AI responses in real-time to all platforms

**Type Safety (CRITICAL)**
- Strict TypeScript configuration enforced
- All functions must have complete type annotations
- No `any` types without explicit justification
- Interfaces for all major abstractions

**Git as First-Class Citizen**
- Let git handle what git does best (conflicts, uncommitted changes, branch management)
- Surface git errors to users for actionable issues (conflicts, uncommitted changes)
- Handle expected failure cases gracefully (missing directories during cleanup)
- Trust git's natural guardrails (e.g., refuse to remove worktree with uncommitted changes)
- Use `execFileAsync` for git commands (not `exec`) to prevent command injection
- Worktrees enable parallel development per conversation without branch conflicts
- Workspaces automatically sync with origin before worktree creation (ensures latest code)
- **NEVER run `git clean -fd`** - it permanently deletes untracked files (use `git checkout .` instead)

## Essential Commands

### Development (Recommended)

Run app locally for hot reload (SQLite auto-detected if no `DATABASE_URL`):

```bash
# Start server + Web UI together (hot reload for both)
bun run dev

# Or start individually
bun run dev:server  # Backend only (port 3090)
bun run dev:web     # Frontend only (port 5173)
```

Optional: Use PostgreSQL instead of SQLite by setting `DATABASE_URL` in `.env`:

```bash
docker-compose --profile with-db up -d postgres
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent in .env
```

Code changes auto-reload instantly. Web UI available at `http://localhost:5173`. Telegram/Slack work from any device (polling-based, no port forwarding needed).

### Build Commands

```bash
# Install dependencies
bun install

# Build TypeScript (optional - Bun runs TS directly)
bun run build

# Start production server (no hot reload)
bun run start
```

### Testing

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run specific test file
bun test packages/core/src/handlers/command-handler.test.ts
```

### Type Checking

```bash
# TypeScript compiler check
bun run type-check

# Or use tsc directly
bun x tsc --noEmit
```

### Linting & Formatting

```bash
# Check linting
bun run lint

# Auto-fix linting issues
bun run lint:fix

# Format code
bun run format

# Check formatting (CI-safe)
bun run format:check
```

**Code Quality Setup:**
- **ESLint**: Flat config with TypeScript-ESLint (strict rules, 0 warnings enforced via `--max-warnings 0`)
- **Prettier**: Opinionated formatter (single quotes, semicolons, 2-space indent)
- **Integration**: ESLint + Prettier configured to work together (no conflicts)
- **Validation**: All PRs must pass `type-check`, `lint`, `format:check`, and `test` before merge

### Pre-PR Validation

**Before creating a pull request, always run:**

```bash
bun run validate
```

This runs type-check, lint, format check, and tests. All four must pass for CI to succeed.

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

**Preferred approach - use guard clauses instead of disables:**
```typescript
// Instead of: const steps = validatedSteps!;
// Use a guard clause that satisfies TypeScript and provides runtime safety:
if (!steps) {
  throw new Error('Steps validation failed unexpectedly');
}
// Now TypeScript knows steps is defined, no assertion needed
```

**Never acceptable:**
- Disabling `no-explicit-any` without justification
- Disabling rules to "make CI pass"
- Bulk disabling at file level (`/* eslint-disable */`)

**Disabled rules** (turned off globally, no need to suppress):

*Template/expression rules:*
- `restrict-template-expressions` - Numbers in templates are valid JS
- `restrict-plus-operands` - Similar to above, mixed operands are often intentional

*Defensive coding patterns:*
- `no-unnecessary-condition` - Defensive coding (switch defaults, null checks) is encouraged
- `prefer-nullish-coalescing` - Truthy checks with `||` are intentional for env vars

*External SDK interop (types are often `any` or incomplete):*
- `no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-argument` - SDK responses
- `no-misused-promises`, `no-floating-promises` - Event handler patterns in SDKs

*Style preferences (not critical for type safety):*
- `require-await` - Empty async functions valid for interface compliance
- `consistent-generic-constructors` - Style preference
- `no-deprecated` - Allow using deprecated APIs during migration
- `use-unknown-in-catch-callback-variable` - Catch variable typing preference

### Database

**Auto-Detection:**
- **With `DATABASE_URL` set**: Uses PostgreSQL
- **Without `DATABASE_URL`**: Uses SQLite at `~/.archon/archon.db` (auto-initialized)

```bash
# PostgreSQL: Run SQL migrations (manual)
psql $DATABASE_URL < migrations/001_initial_schema.sql
```

### Docker (Production)

For production deployment (no hot reload):

```bash
# Build and start all services (app + postgres)
docker-compose --profile with-db up -d --build

# Start app only (external database like Supabase/Neon)
docker-compose --profile external-db up -d

# View logs
docker-compose logs -f app-with-db

# Stop all services
docker-compose --profile with-db down
```

**Note:** For development, use the hybrid approach above instead (postgres in Docker, app locally).

### CLI (Command Line)

Run workflows directly from the command line without needing the server. Workflow and isolation commands require running from within a git repository (subdirectories work - resolves to repo root).

```bash
# List available workflows (requires git repo)
bun run cli workflow list

# Run a workflow
bun run cli workflow run assist "What does the orchestrator do?"

# Run in a specific directory
bun run cli workflow run plan --cwd /path/to/repo "Add dark mode"

# Isolation: Create/reuse worktree for a branch
bun run cli workflow run implement --branch feature-auth "Add auth"

# Isolation: Run on branch directly without worktree
bun run cli workflow run quick-fix --no-worktree "Fix typo"

# List active worktrees/environments
bun run cli isolation list

# Clean up stale environments (default: 7 days)
bun run cli isolation cleanup
bun run cli isolation cleanup 14  # Custom days

# Clean up environments with branches merged into main (also deletes remote branches)
bun run cli isolation cleanup --merged

# Show version
bun run cli version
```

**How it works:**
- Discovers workflows from `.archon/workflows/` in working directory
- Creates a new conversation for each invocation (ID: `cli-{timestamp}-{random}`)
- Streams AI responses to stdout in real-time

**Isolation flags:**
- `--branch/-b <name>`: Creates or reuses a worktree for the specified branch (auto-registers codebase if in a git repo)
- `--no-worktree`: Checks out branch directly in current directory without creating a worktree

### Cloud Deployment

See [Cloud Deployment Guide](docs/cloud-deployment.md) for complete setup instructions. (only if the user asks about this)

## Architecture

### Directory Structure

**Monorepo Layout (Bun Workspaces):**

```
packages/
├── cli/                      # @archon/cli - Command-line interface
│   └── src/
│       ├── adapters/         # CLI adapter (stdout output)
│       ├── commands/         # CLI command implementations
│       │   ├── version.ts
│       │   └── workflow.ts
│       └── cli.ts            # CLI entry point
├── core/                     # @archon/core - Shared business logic
│   └── src/
│       ├── clients/          # AI SDK clients (Claude, Codex)
│       ├── config/           # YAML config loading
│       ├── db/               # Database connection, queries
│       │   ├── connection.ts
│       │   ├── conversations.ts
│       │   ├── codebases.ts
│       │   └── sessions.ts
│       ├── handlers/         # Command handler (slash commands)
│       ├── isolation/        # Git worktree management
│       ├── orchestrator/     # AI conversation management
│       ├── services/         # Background services (cleanup)
│       ├── state/            # Session state machine
│       ├── types/            # TypeScript types and interfaces
│       ├── utils/            # Shared utilities
│       │   ├── variable-substitution.ts
│       │   ├── git.ts
│       │   └── archon-paths.ts
│       ├── workflows/        # YAML workflow engine
│       └── index.ts          # Package exports
├── server/                   # @archon/server - HTTP server + adapters
│   └── src/
│       ├── adapters/         # Platform adapters (Slack, Telegram, GitHub, Discord, Web, Test)
│       │   ├── slack.ts
│       │   ├── telegram.ts
│       │   ├── github.ts
│       │   ├── discord.ts
│       │   ├── web.ts        # Web UI adapter (SSE streaming)
│       │   └── test.ts
│       ├── routes/           # API routes
│       │   └── api.ts        # REST + SSE endpoints for Web UI
│       ├── scripts/          # Setup utilities
│       └── index.ts          # Hono server entry point
└── web/                      # @archon/web - React frontend (Web UI)
    └── src/
        ├── components/       # React components (chat, layout, projects, ui)
        ├── hooks/            # Custom hooks (useSSE, etc.)
        ├── lib/              # API client, types, utilities
        ├── pages/            # Route pages (ChatPage, ProjectsPage)
        └── App.tsx           # Router + layout
```

**Import Patterns:**

**IMPORTANT**: Always use typed imports - never use generic `import *` for the main package.

```typescript
// ✅ CORRECT: Use `import type` for type-only imports
import type { IPlatformAdapter, Conversation, MergedConfig } from '@archon/core';

// ✅ CORRECT: Use specific named imports for values
import { handleMessage, ConversationLockManager, pool } from '@archon/core';

// ✅ CORRECT: Namespace imports for submodules with many exports
import * as conversationDb from '@archon/core/db/conversations';
import * as git from '@archon/core/utils/git';

// ❌ WRONG: Never use generic import for main package
import * as core from '@archon/core';  // Don't do this
```

**Rules:**
1. Always use `import type { ... }` for types (interfaces, type aliases)
2. Use specific named imports `{ foo, bar }` for values from the main package
3. Namespace imports (`import * as`) are acceptable for submodules (`/db/*`, `/utils/*`)
4. Combine type and value imports when needed: `import { handleMessage, type IPlatformAdapter } from '@archon/core'`

### Database Schema

**7 Tables (all prefixed with `remote_agent_`):**
1. **`codebases`** - Repository metadata and commands (JSONB)
2. **`conversations`** - Track platform conversations with titles and soft-delete support
3. **`sessions`** - Track AI SDK sessions with resume capability
4. **`isolation_environments`** - Git worktree isolation tracking
5. **`workflow_runs`** - Workflow execution tracking and state
6. **`workflow_events`** - Step-level workflow event log (step transitions, artifacts, errors)
7. **`messages`** - Conversation message history with tool call metadata (JSONB)

**Key Patterns:**
- Conversation ID format: Platform-specific (`thread_ts`, `chat_id`, `user/repo#123`)
- One active session per conversation
- Codebase commands stored in filesystem, paths in `codebases.commands` JSONB

**Session Transitions:**
- Sessions are immutable - transitions create new linked sessions
- Each transition has explicit `TransitionTrigger` reason (first-message, plan-to-execute, reset-requested, etc.)
- Audit trail: `parent_session_id` links to previous session, `transition_reason` records why
- Only plan→execute creates new session immediately; other triggers deactivate current session

### Architecture Layers

**Package Split:**
- **@archon/cli**: Command-line interface for running workflows
- **@archon/core**: Business logic, database, orchestration, workflows
- **@archon/server**: Platform adapters, Hono server, HTTP endpoints, Web UI static serving
- **@archon/web**: React frontend (Vite + Tailwind v4 + shadcn/ui), SSE streaming to server

**1. Platform Adapters** (`packages/server/src/adapters/`)
- Implement `IPlatformAdapter` interface
- Handle platform-specific message formats
- **Web**: Server-Sent Events (SSE) streaming, conversation ID = user-provided string
- **Slack**: SDK with polling (not webhooks), conversation ID = `thread_ts`
- **Telegram**: Bot API with polling, conversation ID = `chat_id`
- **GitHub**: Webhooks + GitHub CLI, conversation ID = `owner/repo#number`
- **Discord**: discord.js WebSocket, conversation ID = channel ID

**Adapter Authorization Pattern:**
- Auth checks happen INSIDE adapters (encapsulation, consistency)
- Auth utilities in `packages/core/src/utils/{platform}-auth.ts`
- Parse whitelist from env var in constructor (e.g., `TELEGRAM_ALLOWED_USER_IDS`)
- Check authorization in message handler (before calling `onMessage` callback)
- Silent rejection for unauthorized users (no error response)
- Log unauthorized attempts with masked user IDs for privacy

**Adapter Message Handler Pattern:**
- Adapters expose `onMessage(handler)` callback registration
- Auth check happens internally before invoking callback
- Server entry point (`packages/server/src/index.ts`) registers callback and routes to orchestrator
- Errors handled by caller (callback returns Promise)

**2. Command Handler** (`packages/core/src/handlers/`)
- Process slash commands (deterministic, no AI)
- Commands: `/command-set`, `/command-invoke`, `/load-commands`, `/clone`, `/getcwd`, `/setcwd`, `/codebase-switch`, `/status`, `/commands`, `/help`, `/reset`
- Update database, perform operations, return responses

**3. Orchestrator** (`packages/core/src/orchestrator/`)
- Manage AI conversations
- Load conversation + codebase context from database
- Variable substitution: `$1`, `$2`, `$3`, `$ARGUMENTS`, `$PLAN`
- Session management: Create new or resume existing
- Stream AI responses to platform

**4. AI Assistant Clients** (`packages/core/src/clients/`)
- Implement `IAssistantClient` interface
- **ClaudeClient**: `@anthropic-ai/claude-agent-sdk`
- **CodexClient**: `@openai/codex-sdk`
- Streaming: `for await (const event of events) { await platform.send(event) }`

### Configuration

**Environment Variables:**

see .env.example
see .archon/config.yaml setup as needed

**Assistant Defaults:**

The system supports configuring default models and options per assistant in `.archon/config.yaml`:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    webSearchMode: live  # 'disabled' | 'cached' | 'live'
    additionalDirectories:
      - /absolute/path/to/other/repo
```

**Configuration Priority:**
1. Workflow-level options (in YAML `model`, `modelReasoningEffort`, etc.)
2. Config file defaults (`.archon/config.yaml` `assistants.*`)
3. SDK defaults

**Model Validation:**
- Workflows are validated at load time for provider/model compatibility
- Claude models: `sonnet`, `opus`, `haiku`, `claude-*`, `inherit`
- Codex models: Any model except Claude-specific aliases
- Invalid combinations fail workflow loading with clear error messages

### Worktree Symbiosis (Skill + App)

//TODO, This should be converted to a skill to not bload claude.md

The app can work alongside the worktree-manager Claude Code skill. Both use git worktrees for isolated development, and can share the same base directory.

**To enable symbiosis:**

1. Configure the worktree-manager skill to use Archon's worktrees directory:
   ```json
   // In ~/.claude/settings.json or worktree-manager config
   {
     "worktreeBase": "~/.archon/worktrees"
   }
   ```

2. Both systems will use the same directory:
   - Skill creates: `~/.archon/worktrees/<project>/<branch-slug>/`
   - App creates: `~/.archon/worktrees/<project>/<issue|pr>-<number>/`

3. The app will **adopt** skill-created worktrees when:
   - A PR is opened for a branch that already has a worktree
   - The worktree path matches what the app would create

4. Use `/worktree orphans` to see all worktrees from git's perspective

**Note**: Each system maintains its own metadata:
- Skill: `~/.claude/worktree-registry.json`
- App: Database (`conversations.worktree_path`)

Git (`git worktree list`) is the source of truth for what actually exists on disk.

### Running the App in Worktrees

Agents working in worktrees can run the app for self-testing (make changes → run app → test via curl → fix). Ports are automatically allocated to avoid conflicts:

```bash
# Run in worktree (port auto-allocated based on path)
bun dev &
# [Hono] Worktree detected (/path/to/worktree)
# [Hono] Auto-allocated port: 3637 (base: 3090, offset: +547)

# Test via web API (production path)
# 1) Create a conversation
curl -X POST http://localhost:3637/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}'

# 2) Send a message
curl -X POST http://localhost:3637/api/conversations/<conversationId>/message \
  -H "Content-Type: application/json" \
  -d '{"message":"/status"}'

# 3) Fetch messages (polling)
curl http://localhost:3637/api/conversations/<conversationId>/messages

# Note: SSE streaming is available at /api/stream/<conversationId>
```

**Port Allocation:**
- Worktrees: Automatic unique port (3190-4089 range, hash-based on path)
- Main repo: Default 3090
- Override: `PORT=4000 bun dev` (works in both contexts)
- Same worktree always gets same port (deterministic)

**Important:**
- Use the web API routes for manual validation (avoid running multiple platform adapters)
- Database is shared (same conversations/codebases available)
- Kill the server when done: `pkill -f "bun.*dev"` or use the specific port

### Archon Directory Structure

All Archon-managed files are organized under a dedicated namespace:

**User-level (`~/.archon/`):**
```
~/.archon/
├── workspaces/owner/repo/        # Project-centric layout
│   ├── source/                   # Clone (from /clone) or symlink → local path
│   ├── worktrees/                # Git worktrees for this project
│   │   └── feature-auth/
│   ├── artifacts/                # Workflow artifacts (NEVER in git)
│   │   └── runs/{workflow-id}/
│   └── logs/                     # Workflow execution logs
│       └── {workflow-id}.jsonl
├── worktrees/                    # Legacy global worktrees (deprecated)
├── archon.db                     # SQLite database (when DATABASE_URL not set)
└── config.yaml                   # Global configuration (non-secrets)
```

**Repo-level (`.archon/` in any repository):**
```
.archon/
├── commands/       # Custom commands
├── workflows/      # Future: workflow definitions
└── config.yaml     # Repo-specific configuration
```

**For Docker:** Paths are automatically set to `/.archon/`.

**Configuration:**
- `ARCHON_HOME` - Override the base directory (default: `~/.archon`)

**Command folder detection:**
- `.archon/commands/` - Primary location for repo commands
- Additional folder can be configured in `.archon/config.yaml`

**Workflow folder location:**
- `.archon/workflows/` - Workflow definitions (YAML files)

## Development Guidelines

### When Creating New Features

**Quick reference:**
- **Platform Adapters**: Implement `IPlatformAdapter`, handle auth, polling/webhooks
- **AI Clients**: Implement `IAssistantClient`, session management, streaming
- **Slash Commands**: Add to command-handler.ts, update database, no AI
- **Database Operations**: Use `IDatabase` interface (supports PostgreSQL and SQLite via adapters)

### SDK Type Patterns

When working with external SDKs (Claude Agent SDK, Codex SDK), prefer importing and using SDK types directly:

```typescript
// ✅ CORRECT - Import SDK types directly
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
  cwd,
  permissionMode: 'bypassPermissions',
  // ...
};

// Use type assertions for SDK response structures
const message = msg as { message: { content: ContentBlock[] } };
```

```typescript
// ❌ AVOID - Defining duplicate types
interface MyQueryOptions {  // Don't duplicate SDK types
  cwd: string;
  // ...
}
const options: MyQueryOptions = { ... };
query({ prompt, options: options as any });  // Avoid 'as any'
```

This ensures type compatibility with SDK updates and eliminates `as any` casts.

### Testing

**Unit Tests:**
- Test pure functions (variable substitution, command parsing)
- Mock external dependencies (database, AI SDKs, platform APIs)
- Fast execution (<1s total)
- Bun Test is the Framework

**Integration Tests:**
- Test database operations with test database
- Test end-to-end flows (mock platforms/AI but use real orchestrator)
- Clean up test data after each test

**Manual Validation with Web API:**

Use the production web API routes for manual validation (same flow as the web UI).

You can also run all CLI commands directly for regression testing and testing new capabilities.

**When to Use Web API and CLI Commands:**
- ✅ Manual validation after implementing new features
- ✅ End-to-end testing of command flows
- ✅ Debugging orchestrator logic without Telegram setup
- ✅ Automated integration tests (future CI/CD)
- ❌ NOT for unit tests (use Jest mocks instead)

### Logging

**Structured logging with Pino** (`packages/core/src/utils/logger.ts`):

```typescript
import { createLogger } from '@archon/core';

const log = createLogger('orchestrator');

// Object first, message second (Pino convention)
log.info({ conversationId, codebaseId }, 'session_started');
log.error({ err, conversationId }, 'session_failed');
log.debug({ step, provider }, 'step_config_loaded');
log.warn({ envVar: 'MISSING_KEY' }, 'optional_config_missing');
```

**Log Levels:**
- `fatal` (60) - Process cannot continue
- `error` (50) - Failures needing immediate attention
- `warn` (40) - Degraded behavior, fallbacks
- `info` (30) - Key user-visible events (DEFAULT)
- `debug` (20) - Internal details, tool calls, state transitions
- `trace` (10) - Fine-grained diagnostic output

**Controlling Verbosity:**
- CLI: `archon --quiet ...` (errors only) or `archon --verbose ...` (debug)
- Server: `LOG_LEVEL=debug bun run start`
- TTY output is pretty-printed; piped output is newline-delimited JSON

**Migration Note:** Existing `console.log` calls are being migrated to Pino in phases. New code should use `createLogger()`. Existing console calls will be replaced in Phase 2-3.

**What to Log:**
- Session start/end with IDs
- Command invocations with arguments
- AI streaming events (start, chunks received, completion)
- Database operations (queries, errors)
- Platform adapter events (message received, sent)
- Errors with full stack traces

**What NOT to Log:**
- API keys, tokens, secrets (mask: `token.slice(0, 8) + '...'`)
- User message content in production (privacy)
- Personal identifiable information

### Command System

**Variable Substitution:**
- `$1`, `$2`, `$3` - Positional arguments
- `$ARGUMENTS` - All arguments as single string
- `$PLAN` - Previous plan from session metadata
- `$IMPLEMENTATION_SUMMARY` - Previous execution summary
- `$ARTIFACTS_DIR` - External artifacts directory for the current workflow run (pre-created by executor)
- `$WORKFLOW_ID` - The workflow run ID
- `$BASE_BRANCH` - Base branch from config (worktree.baseBranch) or auto-detected from repo default

**Command Types:**

1. **Codebase Commands** (per-repo):
   - Stored in `.archon/commands/` (plain text/markdown)
   - Auto-detected via `/clone` or `/load-commands <folder>`
   - Invoked via `/command-invoke <name> [args]`

2. **Workflows** (YAML-based):
   - Stored in `.archon/workflows/` (searched recursively)
   - Multi-step AI execution chains, discovered at runtime
   - Provider inherited from `.archon/config.yaml` unless explicitly set
   - Model and options can be set per workflow or inherited from config defaults
   - Model validation ensures provider/model compatibility at load time
   - Commands: `/workflow list`, `/workflow reload`, `/workflow status`, `/workflow cancel`
   - Resilient loading: One broken YAML doesn't abort discovery; errors shown in `/workflow list`
   - Router uses case-insensitive matching and provides helpful errors for unknown workflows

**Defaults:**
- Bundled in `.archon/commands/defaults/` and `.archon/workflows/defaults/`
- Binary builds: Embedded at compile time (no filesystem access needed)
- Source builds: Loaded from filesystem at runtime
- Merged with repo-specific commands/workflows (repo overrides defaults by name)
- Opt-out: Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` in `.archon/config.yaml`

### Error Handling

**Database Errors:**
```typescript
// INSERT operations
try {
  await db.query('INSERT INTO conversations ...', params);
} catch (error) {
  log.error({ err: error, params }, 'db_insert_failed');
  throw new Error('Failed to create conversation');
}

// UPDATE operations - verify rowCount to catch missing records
try {
  await db.updateConversation(conversationId, { codebase_id: codebaseId });
} catch (error) {
  // updateConversation throws if no rows matched (conversation not found)
  log.error({ err: error, conversationId }, 'db_update_failed');
  throw error; // Re-throw to surface the issue
}
```

**Platform Errors:**
```typescript
try {
  await telegram.sendMessage(chatId, message);
} catch (error) {
  log.error({ err: error, chatId }, 'telegram_send_failed');
  // Don't retry - let user know manually
}
```

**AI SDK Errors:**
```typescript
try {
  await claudeClient.sendMessage(session, prompt);
} catch (error) {
  log.error({ err: error, sessionId }, 'claude_session_error');
  await platform.sendMessage(conversationId, '❌ AI error. Try /reset');
}
```

**Git Operation Errors (Graceful Handling but don't fail silently):**
```typescript
// When isolation environment creation fails:
try {
  // ... isolation creation logic ...
} catch (error) {
  const err = error as Error;
  const userMessage = classifyIsolationError(err);
  log.error({ err, codebaseId, codebaseName }, 'isolation_creation_failed');
  await platform.sendMessage(conversationId, userMessage);
}
```

Pattern: Use `classifyIsolationError()` (in `orchestrator.ts`) to map git errors (permission denied, timeout, no space, not a git repo) to user-friendly messages. Always log the raw error for debugging and send a classified message to the user.

### API Endpoints

**Web UI REST API** (`packages/server/src/routes/api.ts`):
- `GET /api/conversations` - List all conversations
- `POST /api/conversations` - Create new conversation
- `GET /api/conversations/:id` - Get conversation details
- `DELETE /api/conversations/:id` - Soft-delete conversation
- `POST /api/conversations/:id/messages` - Send message to conversation
- `GET /api/conversations/:id/messages` - Get message history
- `GET /api/conversations/:id/stream` - SSE stream for real-time updates
- `POST /api/conversations/:id/workflow` - Invoke workflow
- `GET /api/codebases` - List registered codebases
- `POST /api/codebases` - Clone or register repository
- `DELETE /api/codebases/:id` - Remove codebase
- `GET /api/workflows` - List available workflows
- `GET /api/workflow-runs/:id` - Get workflow run details
- `GET /api/workflow-runs/:id/events` - Get workflow event log

**Webhooks:**
- `POST /webhooks/github` - GitHub webhook events
- Signature verification required (HMAC SHA-256)
- Return 200 immediately, process async

**Health Checks:**
- `GET /health` - Basic health check
- `GET /health/db` - Database connectivity check

**Security:**
- Verify webhook signatures (GitHub: `X-Hub-Signature-256`)
- Use `c.req.text()` for raw webhook body (signature verification)
- Never log or expose tokens in responses

**@Mention Detection:**
- Parse `@archon` in issue/PR **comments only** (not descriptions)
- Events: `issue_comment` only
- Note: Descriptions often contain example commands or documentation - these are NOT command invocations (see #96)
