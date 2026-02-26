## Project Overview

**Remote Agentic Coding Platform**: Control AI coding assistants (Claude Code SDK, Codex SDK) remotely from Slack, Telegram, and GitHub. Built with **Bun + TypeScript + SQLite/PostgreSQL**, single-developer tool for practitioners of the Dynamous Agentic Coding Course. Architecture prioritizes simplicity, flexibility, and user control.

## Core Principles

**Single-Developer Tool**
- No multi-tenant complexity

**Platform Agnostic**
- Unified conversation interface across Slack/Telegram/GitHub/cli/web
- Platform adapters implement `IPlatformAdapter`
- Stream/batch AI responses in real-time to all platforms

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
- Use `@archon/git` functions for git operations; use `execFileAsync` (not `exec`) when calling git directly
- Worktrees enable parallel development per conversation without branch conflicts
- Workspaces automatically sync with origin before worktree creation (ensures latest code)
- **NEVER run `git clean -fd`** - it permanently deletes untracked files (use `git checkout .` instead)

## Engineering Principles

These are implementation constraints, not slogans. Apply them by default.

**KISS — Keep It Simple, Stupid**
- Prefer straightforward control flow over clever meta-programming
- Prefer explicit branches and typed interfaces over hidden dynamic behavior
- Keep error paths obvious and localized

**YAGNI — You Aren't Gonna Need It**
- Do not add config keys, interface methods, feature flags, or workflow branches without a concrete accepted use case
- Do not introduce speculative abstractions without at least one current caller
- Keep unsupported paths explicit (error out) rather than adding partial fake support

**DRY + Rule of Three**
- Duplicate small, local logic when it preserves clarity
- Extract shared utilities only after the same pattern appears at least three times and has stabilized
- When extracting, preserve module boundaries and avoid hidden coupling

**SRP + ISP — Single Responsibility + Interface Segregation**
- Keep each module and package focused on one concern
- Extend behavior by implementing existing narrow interfaces (`IPlatformAdapter`, `IAssistantClient`, `IDatabase`, `IWorkflowStore`) whenever possible
- Avoid fat interfaces and "god modules" that mix policy, transport, and storage
- Do not add unrelated methods to an existing interface — define a new one

**Fail Fast + Explicit Errors** — Silent fallback in agent runtimes can create unsafe or costly behavior
- Prefer throwing early with a clear error for unsupported or unsafe states — never silently swallow errors
- Never silently broaden permissions or capabilities
- Document fallback behavior with a comment when a fallback is intentional and safe; otherwise throw

**Determinism + Reproducibility**
- Prefer reproducible commands and locked dependency behavior in CI-sensitive paths
- Keep tests deterministic — no flaky timing or network dependence without guardrails
- Ensure local validation commands (`bun run validate`) map directly to CI expectations

**Reversibility + Rollback-First Thinking**
- Keep changes easy to revert: small scope, clear blast radius
- For risky changes, define the rollback path before merging
- Avoid mixed mega-patches that block safe rollback

## Essential Commands

### Development

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

### Testing

```bash
bun test
bun test --watch
bun test packages/core/src/handlers/command-handler.test.ts
```

### Type Checking & Linting

```bash
bun run type-check
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

### Pre-PR Validation

**Always run before creating a pull request:**

```bash
bun run validate
```

This runs type-check, lint, format check, and tests. All four must pass for CI to succeed.

### ESLint Guidelines

**Zero-tolerance policy**: CI enforces `--max-warnings 0`. No warnings allowed.

**When to use inline disable comments** (`// eslint-disable-next-line`):
- **Almost never** - fix the issue instead
- Only acceptable when:
  1. External SDK types are incorrect (document which SDK and why)
  2. Intentional type assertion after validation (must include comment explaining the validation)

**Never acceptable:**
- Disabling `no-explicit-any` without justification
- Disabling rules to "make CI pass"
- Bulk disabling at file level (`/* eslint-disable */`)

### Database

**Auto-Detection (SQLite is the default — zero setup):**
- **Without `DATABASE_URL`**: Uses SQLite at `~/.archon/archon.db` (auto-initialized, recommended for most users)
- **With `DATABASE_URL` set**: Uses PostgreSQL (optional, for cloud/advanced deployments)

```bash
# PostgreSQL only: Run SQL migrations (manual)
psql $DATABASE_URL < migrations/000_combined.sql
```

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

## Architecture

### Directory Structure

**Monorepo Layout (Bun Workspaces):**

```
packages/
├── cli/                      # @archon/cli - Command-line interface
│   └── src/
│       ├── adapters/         # CLI adapter (stdout output)
│       ├── commands/         # CLI command implementations
│       └── cli.ts            # CLI entry point
├── core/                     # @archon/core - Shared business logic
│   └── src/
│       ├── clients/          # AI SDK clients (Claude, Codex)
│       ├── config/           # YAML config loading
│       ├── db/               # Database connection, queries
│       ├── handlers/         # Command handler (slash commands)
│       ├── isolation/        # Re-exports from @archon/isolation (backward compat)
│       ├── orchestrator/     # AI conversation management
│       ├── services/         # Background services (cleanup)
│       ├── state/            # Session state machine
│       ├── types/            # TypeScript types and interfaces
│       ├── utils/            # Shared utilities
│       ├── workflows/        # Store adapter (createWorkflowStore) bridging core DB → IWorkflowStore
│       └── index.ts          # Package exports
├── workflows/                # @archon/workflows - Workflow engine (depends on @archon/git + @archon/paths)
│   └── src/
│       ├── types.ts          # Workflow type definitions (step, loop, DAG)
│       ├── loader.ts         # YAML parsing + validation (discoverWorkflows, parseWorkflow)
│       ├── router.ts         # Prompt building + invocation parsing
│       ├── executor.ts       # Sequential, parallel, loop, DAG execution (executeWorkflow)
│       ├── dag-executor.ts   # DAG-specific execution logic
│       ├── store.ts          # IWorkflowStore interface (database abstraction)
│       ├── deps.ts           # WorkflowDeps injection types (IWorkflowPlatform, IWorkflowAssistantClient)
│       ├── event-emitter.ts  # Workflow observability events
│       ├── logger.ts         # JSONL file logger
│       ├── defaults/         # Bundled default commands and workflows
│       ├── utils/            # Variable substitution, tool formatting
│       └── index.ts          # Package exports
├── git/                      # @archon/git - Git operations (no @archon/core dep)
│   └── src/
│       ├── branch.ts         # Branch operations (checkout, merge detection, etc.)
│       ├── exec.ts           # execFileAsync and mkdirAsync wrappers
│       ├── repo.ts           # Repository operations (clone, sync, remote URL)
│       ├── types.ts          # Branded types (RepoPath, BranchName, etc.)
│       ├── worktree.ts       # Worktree operations (create, remove, list)
│       └── index.ts          # Package exports
├── isolation/                # @archon/isolation - Worktree isolation (depends on @archon/git + @archon/paths)
│   └── src/
│       ├── types.ts          # Isolation types and interfaces
│       ├── errors.ts         # Error classifiers (classifyIsolationError, IsolationBlockedError)
│       ├── factory.ts        # Provider factory (getIsolationProvider, configureIsolation)
│       ├── resolver.ts       # IsolationResolver (request → environment resolution)
│       ├── store.ts          # IIsolationStore interface
│       ├── worktree-copy.ts  # File copy utilities for worktrees
│       ├── providers/
│       │   └── worktree.ts   # WorktreeProvider implementation
│       └── index.ts          # Package exports
├── paths/                    # @archon/paths - Path resolution and logger (zero @archon/* deps)
│   └── src/
│       ├── archon-paths.ts   # Archon directory path utilities
│       ├── logger.ts         # Pino logger factory
│       └── index.ts          # Package exports
├── adapters/                 # @archon/adapters - Platform adapters (Slack, Telegram, GitHub, Discord)
│   └── src/
│       ├── chat/             # Chat platform adapters (Slack, Telegram)
│       ├── forge/            # Forge adapters (GitHub)
│       ├── community/        # Community adapters (Discord)
│       ├── utils/            # Shared adapter utilities (message splitting)
│       └── index.ts          # Package exports
├── server/                   # @archon/server - HTTP server + Web adapter
│   └── src/
│       ├── adapters/         # Web platform adapter (SSE streaming)
│       ├── routes/           # API routes (REST + SSE)
│       └── index.ts          # Hono server entry point
└── web/                      # @archon/web - React frontend (Web UI)
    └── src/
        ├── components/       # React components (chat, layout, projects, ui, workflows)
        ├── hooks/            # Custom hooks (useSSE, etc.)
        ├── lib/              # API client, types, utilities
        ├── routes/           # Route pages (ChatPage, WorkflowsPage, WorkflowBuilderPage, etc.)
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
import * as git from '@archon/git';

// ✅ CORRECT: Import workflow engine types/functions directly from @archon/workflows
import type { WorkflowDeps, IWorkflowStore } from '@archon/workflows';
import { executeWorkflow, discoverWorkflows } from '@archon/workflows';

// ❌ WRONG: Never use generic import for main package
import * as core from '@archon/core';  // Don't do this
```

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
- **@archon/paths**: Path resolution utilities and Pino logger factory (no @archon/* deps)
- **@archon/git**: Git operations - worktrees, branches, repos, exec wrappers (depends only on @archon/paths)
- **@archon/isolation**: Worktree isolation types, providers, resolver, error classifiers (depends only on @archon/git + @archon/paths)
- **@archon/workflows**: Workflow engine - loader, router, executor, DAG, logger, bundled defaults (depends only on @archon/git + @archon/paths; DB/AI/config injected via `WorkflowDeps`)
- **@archon/cli**: Command-line interface for running workflows
- **@archon/core**: Business logic, database, orchestration, AI clients (re-exports @archon/git, @archon/paths, @archon/isolation; provides `createWorkflowStore()` adapter bridging core DB → `IWorkflowStore`)
- **@archon/adapters**: Platform adapters for Slack, Telegram, GitHub, Discord (depends on @archon/core)
- **@archon/server**: Hono HTTP server, Web adapter (SSE), API routes, Web UI static serving (depends on @archon/adapters)
- **@archon/web**: React frontend (Vite + Tailwind v4 + shadcn/ui), SSE streaming to server

**1. Platform Adapters**
- Implement `IPlatformAdapter` interface
- Handle platform-specific message formats
- **Web** (`packages/server/src/adapters/web/`): Server-Sent Events (SSE) streaming, conversation ID = user-provided string
- **Slack** (`packages/adapters/src/chat/slack/`): SDK with polling (not webhooks), conversation ID = `thread_ts`
- **Telegram** (`packages/adapters/src/chat/telegram/`): Bot API with polling, conversation ID = `chat_id`
- **GitHub** (`packages/adapters/src/forge/github/`): Webhooks + GitHub CLI, conversation ID = `owner/repo#number`
- **Discord** (`packages/adapters/src/community/chat/discord/`): discord.js WebSocket, conversation ID = channel ID

**Adapter Authorization Pattern:**
- Auth checks happen INSIDE adapters (encapsulation, consistency)
- Auth utilities co-located with each adapter (e.g., `packages/adapters/src/chat/slack/auth.ts`)
- Parse whitelist from env var in constructor (e.g., `TELEGRAM_ALLOWED_USER_IDS`)
- Check authorization in message handler (before calling `onMessage` callback)
- Silent rejection for unauthorized users (no error response)
- Log unauthorized attempts with masked user IDs for privacy
- Adapters expose `onMessage(handler)` callback; errors handled by caller

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

**User-level (`~/.archon/`):**
```
~/.archon/
├── workspaces/owner/repo/        # Project-centric layout
│   ├── source/                   # Clone (from /clone) or symlink → local path
│   ├── worktrees/                # Git worktrees for this project
│   ├── artifacts/                # Workflow artifacts (NEVER in git)
│   └── logs/                     # Workflow execution logs
├── archon.db                     # SQLite database (when DATABASE_URL not set)
└── config.yaml                   # Global configuration (non-secrets)
```

**Repo-level (`.archon/` in any repository):**
```
.archon/
├── commands/       # Custom commands
├── workflows/      # Workflow definitions (YAML files)
└── config.yaml     # Repo-specific configuration
```

- `ARCHON_HOME` - Override the base directory (default: `~/.archon`)
- Docker: Paths automatically set to `/.archon/`

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

**Integration Tests:**
- Test database operations with test database
- Test end-to-end flows (mock platforms/AI but use real orchestrator)
- Clean up test data after each test

**Manual Validation:** Use the web API (`curl`) or CLI commands directly for end-to-end testing of new features.

### Logging

**Structured logging with Pino** (`packages/paths/src/logger.ts`, re-exported from `@archon/core`):

```typescript
import { createLogger } from '@archon/core';

const log = createLogger('orchestrator');

// Event naming: {domain}.{action}_{state}
// Standard states: _started, _completed, _failed, _validated, _rejected
async function createSession(conversationId: string, codebaseId: string) {
  log.info({ conversationId, codebaseId }, 'session.create_started');

  try {
    const session = await doCreate();
    log.info({ conversationId, codebaseId, sessionId: session.id }, 'session.create_completed');
    return session;
  } catch (e) {
    const err = e as Error;
    log.error(
      { conversationId, error: err.message, errorType: err.constructor.name, err },
      'session.create_failed',
    );
    throw err;
  }
}
```

**Event naming rules:**
- Format: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`
- Avoid generic events like `processing` or `handling`
- Always pair `_started` with `_completed` or `_failed`
- Include context: IDs, durations, error details

**Log Levels:** `fatal` > `error` > `warn` > `info` (default) > `debug` > `trace`

**Verbosity:**
- CLI: `archon --quiet` (errors only) or `archon --verbose` (debug)
- Server: `LOG_LEVEL=debug bun run start`

**Never log:** API keys or tokens (mask: `token.slice(0, 8) + '...'`), user message content, PII.

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
   - Three execution modes (mutually exclusive): `steps:` (sequential), `loop:` (iterative), `nodes:` (DAG)
   - **`nodes:` (DAG mode)**: Nodes with explicit `depends_on` edges; independent nodes in the same topological layer run concurrently. Node types: `command:` (named command file), `prompt:` (inline prompt), `bash:` (shell script, stdout captured as `$nodeId.output`, no AI). Supports `when:` conditions, `trigger_rule` join semantics, `$nodeId.output` substitution, `output_format` for structured JSON output (Claude only), and `allowed_tools`/`denied_tools` for per-node tool restrictions (Claude only)
   - Provider inherited from `.archon/config.yaml` unless explicitly set; per-node `provider` and `model` overrides supported in DAG mode
   - Model and options can be set per workflow or inherited from config defaults
   - Model validation ensures provider/model compatibility at load time
   - Commands: `/workflow list`, `/workflow reload`, `/workflow status`, `/workflow cancel`
   - Resilient loading: One broken YAML doesn't abort discovery; errors shown in `/workflow list`
   - Router uses case-insensitive matching and provides helpful errors for unknown workflows
   - Router fallback: if no `/invoke-workflow` is produced, falls back to `archon-assist` (with "Routing unclear" notice); raw AI response returned only when `archon-assist` is unavailable
   - Claude routing calls use `tools: []` to prevent tool use at the API level; Codex tool bypass is detected and triggers the same fallback

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

**Git Operation Errors (don't fail silently):**
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

Pattern: Use `classifyIsolationError()` (from `@archon/isolation`) to map git errors (permission denied, timeout, no space, not a git repo) to user-friendly messages. Always log the raw error for debugging and send a classified message to the user.

### API Endpoints

**Web UI REST API** (`packages/server/src/routes/api.ts`):

**Workflow Management:**
- `POST /api/workflows/validate` - Validate a workflow definition in-memory (no save); body: `{ definition: object }`; returns `{ valid: boolean, errors?: string[] }`
- `GET /api/workflows/:name` - Fetch a single workflow by name; optional `?cwd=` query param; returns `{ workflow, filename, source: 'project' | 'bundled' }`
- `PUT /api/workflows/:name` - Save (create or update) a workflow YAML; body: `{ definition: object }`; validates before writing; requires `?cwd=` or registered codebase
- `DELETE /api/workflows/:name` - Delete a user-defined workflow; bundled defaults cannot be deleted

**Command Listing:**
- `GET /api/commands` - List available command names (bundled + project-defined); optional `?cwd=`; returns `{ commands: [{ name, source: 'bundled' | 'project' }] }`

**Webhooks:**
- `POST /webhooks/github` - GitHub webhook events
- Signature verification required (HMAC SHA-256)
- Return 200 immediately, process async

**Security:**
- Verify webhook signatures (GitHub: `X-Hub-Signature-256`)
- Use `c.req.text()` for raw webhook body (signature verification)
- Never log or expose tokens in responses

**@Mention Detection:**
- Parse `@archon` in issue/PR **comments only** (not descriptions)
- Events: `issue_comment` only
- Note: Descriptions often contain example commands or documentation - these are NOT command invocations (see #96)
