## Project Overview

**Remote Agentic Coding Platform**: Control AI coding assistants (Claude Code SDK, Codex SDK) remotely from Slack, Telegram, and GitHub. Built with **Bun + TypeScript + PostgreSQL**, single-developer tool for practitioners of the Dynamous Agentic Coding Course. Architecture prioritizes simplicity, flexibility, and user control.

## Core Principles

**Single-Developer Tool**
- No multi-tenant complexity
- Commands versioned with Git (not stored in database)
- All credentials in environment variables only
- 3-table database schema (conversations, codebases, sessions)

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
- **NEVER run `git clean -fd`** - it permanently deletes untracked files (use `git checkout .` instead)

## Essential Commands

### Development (Recommended)

Run postgres in Docker, app locally for hot reload:

```bash
# Terminal 1: Start postgres only
docker-compose --profile with-db up -d postgres

# Terminal 2: Run app with hot reload
bun run dev
```

Requires `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent` in `.env`.

Code changes auto-reload instantly. Telegram/Slack work from any device (polling-based, no port forwarding needed).

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
bun test src/handlers/command-handler.test.ts
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
- **ESLint**: Flat config with TypeScript-ESLint (strict rules, 0 errors enforced)
- **Prettier**: Opinionated formatter (single quotes, semicolons, 2-space indent)
- **Integration**: ESLint + Prettier configured to work together (no conflicts)
- **Validation**: All PRs must pass `lint` and `format:check` before merge

### Database

```bash
# Run SQL migrations (manual)
psql $DATABASE_URL < migrations/001_initial_schema.sql

# Start PostgreSQL (Docker)
docker-compose --profile with-db up -d postgres
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

### Cloud Deployment

For production cloud deployment with automatic HTTPS via Caddy, use the `docker-compose.cloud.yml` overlay:

```bash
# With external database (Supabase, Neon, etc.)
docker compose --profile external-db -f docker-compose.yml -f docker-compose.cloud.yml up -d --build

# With local PostgreSQL
docker compose --profile with-db -f docker-compose.yml -f docker-compose.cloud.yml up -d --build
```

The overlay file adds:
- Caddy reverse proxy with automatic HTTPS (Let's Encrypt)
- Profile-specific Caddy services (`caddy` for `external-db`, `caddy-with-db` for `with-db`)
- Internal-only networking (app not exposed on host ports)

**Caddyfile configuration:**
- Copy `Caddyfile.example` to `Caddyfile`
- Update domain name
- Set service name based on profile: `app:3000` for `external-db`, `app-with-db:3000` for `with-db`

See [Cloud Deployment Guide](docs/cloud-deployment.md) for complete setup instructions.

## Architecture

### Directory Structure

```
src/
├── adapters/       # Platform adapters (Slack, Telegram, GitHub)
│   ├── slack.ts
│   ├── telegram.ts
│   └── github.ts
├── clients/        # AI assistant clients (Claude, Codex)
│   ├── claude.ts
│   └── codex.ts
├── handlers/       # Command handler (slash commands)
│   └── command-handler.ts
├── orchestrator/   # AI conversation management
│   └── orchestrator.ts
├── db/             # Database connection, queries
│   ├── connection.ts
│   ├── conversations.ts
│   ├── codebases.ts
│   └── sessions.ts
├── types/          # TypeScript types and interfaces
│   └── index.ts
├── utils/          # Shared utilities
│   ├── variable-substitution.ts
│   ├── git.ts      # Git operations (commits, status checks)
│   └── archon-paths.ts
└── index.ts        # Entry point (Express server)
```

### Database Schema

**5 Tables (all prefixed with `remote_agent_`):**
1. **`codebases`** - Repository metadata and commands (JSONB)
2. **`conversations`** - Track platform conversations (Slack thread, Telegram chat, GitHub issue)
3. **`sessions`** - Track AI SDK sessions with resume capability
4. **`command_templates`** - Global command templates (manually added via `/template-add`)
5. **`isolation_environments`** - Git worktree isolation tracking

**Key Patterns:**
- Conversation ID format: Platform-specific (`thread_ts`, `chat_id`, `user/repo#123`)
- One active session per conversation
- Codebase commands stored in filesystem, paths in `codebases.commands` JSONB
- Global templates stored in database, added via `/template-add`
- Session persistence: Sessions survive restarts, loaded from database

**Session Transitions:**
- **NEW session needed:** Plan → Execute transition only
- **Resume session:** All other transitions (prime→plan, execute→commit)

### Architecture Layers

**1. Platform Adapters** (`src/adapters/`)
- Implement `IPlatformAdapter` interface
- Handle platform-specific message formats
- **Slack**: SDK with polling (not webhooks), conversation ID = `thread_ts`
- **Telegram**: Bot API with polling, conversation ID = `chat_id`
- **GitHub**: Webhooks + GitHub CLI, conversation ID = `owner/repo#number`
- **Discord**: discord.js WebSocket, conversation ID = channel ID

**Adapter Authorization Pattern:**
- Auth checks happen INSIDE adapters (encapsulation, consistency)
- Auth utilities in `src/utils/{platform}-auth.ts`
- Parse whitelist from env var in constructor (e.g., `TELEGRAM_ALLOWED_USER_IDS`)
- Check authorization in message handler (before calling `onMessage` callback)
- Silent rejection for unauthorized users (no error response)
- Log unauthorized attempts with masked user IDs for privacy

**Adapter Message Handler Pattern:**
- Adapters expose `onMessage(handler)` callback registration
- Auth check happens internally before invoking callback
- `index.ts` only registers the callback and handles orchestrator routing
- Errors handled by caller (callback returns Promise)

**2. Command Handler** (`src/handlers/`)
- Process slash commands (deterministic, no AI)
- Commands: `/command-set`, `/command-invoke`, `/load-commands`, `/clone`, `/getcwd`, `/setcwd`, `/codebase-switch`, `/status`, `/commands`, `/help`, `/reset`
- Update database, perform operations, return responses

**3. Orchestrator** (`src/orchestrator/`)
- Manage AI conversations
- Load conversation + codebase context from database
- Variable substitution: `$1`, `$2`, `$3`, `$ARGUMENTS`, `$PLAN`
- Session management: Create new or resume existing
- Stream AI responses to platform

**4. AI Assistant Clients** (`src/clients/`)
- Implement `IAssistantClient` interface
- **ClaudeClient**: `@anthropic-ai/claude-agent-sdk`
- **CodexClient**: `@openai/codex-sdk`
- Streaming: `for await (const event of events) { await platform.send(event) }`

### Configuration

**Environment Variables:**

```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# AI Assistants
# Claude Auth Options:
# - CLAUDE_USE_GLOBAL_AUTH=true: Use global auth from `claude /login` (recommended)
# - CLAUDE_USE_GLOBAL_AUTH=false: Use explicit tokens below
# - Not set: Auto-detect (use tokens if present, otherwise global auth)
CLAUDE_USE_GLOBAL_AUTH=true
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# CLAUDE_API_KEY=sk-ant-...

CODEX_ID_TOKEN=eyJ...
CODEX_ACCESS_TOKEN=eyJ...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=...

# Platforms
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321  # Optional: Restrict bot to specific user IDs
DISCORD_BOT_TOKEN=<from Discord Developer Portal>
DISCORD_ALLOWED_USER_IDS=123456789012345678  # Optional: Restrict bot to specific user IDs
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...  # Required for Socket Mode
GH_TOKEN=ghp_...          # For git operations and GitHub CLI
GITHUB_TOKEN=ghp_...      # Same as GH_TOKEN
WEBHOOK_SECRET=<random string>
GITHUB_ALLOWED_USERS=octocat,monalisa  # Optional: Restrict webhook processing to specific users

# Platform Streaming Mode (stream | batch)
TELEGRAM_STREAMING_MODE=stream  # Default: stream
SLACK_STREAMING_MODE=batch      # Default: batch
DISCORD_STREAMING_MODE=batch    # Default: batch
GITHUB_STREAMING_MODE=batch     # Default: batch

# Optional
ARCHON_HOME=~/.archon  # Override the base directory
PORT=3000
MAX_CONCURRENT_CONVERSATIONS=10
```

**Loading:** Use `dotenv` package, load in `src/index.ts`

### Worktree Symbiosis (Skill + App)

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
# [Express] Worktree detected (/path/to/worktree)
# [Express] Auto-allocated port: 3547 (base: 3000, offset: +547)

# Test via test adapter (use the auto-allocated port from logs)
curl -X POST http://localhost:3547/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test","message":"/status"}'

# Check response
curl http://localhost:3547/test/messages/test
```

**Port Allocation:**
- Worktrees: Automatic unique port (3100-3999 range, hash-based on path)
- Main repo: Default 3000
- Override: `PORT=4000 bun dev` (works in both contexts)
- Same worktree always gets same port (deterministic)

**Important:**
- Only use test adapter - Telegram/Slack/Discord tokens conflict across instances
- Database is shared (same conversations/codebases available)
- Kill the server when done: `pkill -f "bun.*dev"` or use the specific port

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

**Command folder detection:**
- `.archon/commands/` - Primary location for repo commands
- Additional folder can be configured in `.archon/config.yaml`

**Workflow folder location:**
- `.archon/workflows/` - Workflow definitions (YAML files)

## Development Guidelines

### When Creating New Features

**See detailed implementation guide:** `.agents/reference/new-features.md`

**Quick reference:**
- **Platform Adapters**: Implement `IPlatformAdapter`, handle auth, polling/webhooks
- **AI Clients**: Implement `IAssistantClient`, session management, streaming
- **Slash Commands**: Add to command-handler.ts, update database, no AI
- **Database Operations**: Use `pg` with parameterized queries, connection pooling

### Type Checking

**Critical Rules:**
- All functions must have return type annotations
- All parameters must have type annotations
- Use interfaces for contracts (`IPlatformAdapter`, `IAssistantClient`)
- Avoid `any` - use `unknown` and type guards instead
- Enable `strict: true` in `tsconfig.json`

**Example:**
```typescript
// ✅ CORRECT
async function sendMessage(conversationId: string, message: string): Promise<void> {
  await adapter.sendMessage(conversationId, message);
}

// ❌ WRONG - missing return type
async function sendMessage(conversationId: string, message: string) {
  await adapter.sendMessage(conversationId, message);
}
```

**SDK Type Patterns:**

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
- Use Jest or similar framework

**Integration Tests:**
- Test database operations with test database
- Test end-to-end flows (mock platforms/AI but use real orchestrator)
- Clean up test data after each test

**Pattern:**
```typescript
describe('CommandHandler', () => {
  it('should parse /command-invoke with arguments', () => {
    const result = parseCommand('/command-invoke plan "Add dark mode"');
    expect(result.command).toBe('plan');
    expect(result.args).toEqual(['Add dark mode']);
  });
});
```

**Manual Validation with Test Adapter:**

The application includes a built-in test adapter (`src/adapters/test.ts`) with HTTP endpoints for programmatic testing without requiring Telegram/Slack setup.

**Test Adapter Endpoints:**
```bash
# Send message to bot (triggers full orchestrator flow)
POST http://localhost:3000/test/message
Body: {"conversationId": "test-123", "message": "/help"}

# Get bot responses (all messages sent by bot)
GET http://localhost:3000/test/messages/test-123

# Clear conversation history
DELETE http://localhost:3000/test/messages/test-123
```

**Complete Test Workflow:**
```bash
# 1. Start application (hybrid mode - recommended)
docker-compose --profile with-db up -d postgres
bun run dev

# 2. Send test message (use your configured PORT, default 3000)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-123","message":"/status"}'

# 3. Verify bot response
curl http://localhost:3000/test/messages/test-123 | jq

# 4. Clean up
curl -X DELETE http://localhost:3000/test/messages/test-123
```

**Test Adapter Features:**
- Implements `IPlatformAdapter` (same interface as Telegram/Slack)
- In-memory message storage (no external dependencies)
- Tracks message direction (sent by bot vs received from user)
- Full orchestrator integration (real AI, real database)
- Useful for feature validation, debugging, and CI/CD integration

**When to Use Test Adapter:**
- ✅ Manual validation after implementing new features
- ✅ End-to-end testing of command flows
- ✅ Debugging orchestrator logic without Telegram setup
- ✅ Automated integration tests (future CI/CD)
- ❌ NOT for unit tests (use Jest mocks instead)

### Logging

**Use `console.log` with structured data for MVP:**

```typescript
// Good: Structured logging
console.log('[Orchestrator] Starting session', {
  conversationId,
  codebaseId,
  command: 'plan',
  timestamp: new Date().toISOString()
});

// Good: Error logging with context
console.error('[GitHub] Webhook signature verification failed', {
  error: err.message,
  timestamp: new Date().toISOString()
});

// Bad: Generic logs
console.log('Processing...');
```

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

### Streaming Patterns

**AI Response Streaming:**
Platform streaming mode configured per platform via environment variables (`{PLATFORM}_STREAMING_MODE`).

```typescript
// Stream mode: Send each chunk immediately (real-time)
for await (const event of client.streamResponse()) {
  if (streamingMode === 'stream') {
    if (event.type === 'text') {
      await platform.sendMessage(conversationId, event.content);
    } else if (event.type === 'tool') {
      await platform.sendMessage(conversationId, `🔧 ${event.toolName}`);
    }
  } else {
    // Batch mode: Accumulate chunks
    buffer.push(event);
  }
}

// Batch mode: Send accumulated response
if (streamingMode === 'batch') {
  const fullResponse = buffer.map(e => e.content).join('');
  await platform.sendMessage(conversationId, fullResponse);
}
```

**Platform-Specific Defaults:**
- **Telegram/Slack**: `stream` mode (real-time chat experience)
- **GitHub**: `batch` mode (single comment, avoid spam)
- **Future platforms** (Asana, Notion): `batch` mode (single update)
- **Typing indicators**: Send periodically during long operations in `stream` mode

### Command System Patterns

**Variable Substitution:**
- `$1`, `$2`, `$3` - Positional arguments
- `$ARGUMENTS` - All arguments as single string
- `$PLAN` - Previous plan from session metadata
- `$IMPLEMENTATION_SUMMARY` - Previous execution summary

**Command Files:**
- Stored in codebase (e.g., `.archon/commands/plan.md`)
- Plain text/markdown format
- Users edit with Git version control
- Paths stored in `codebases.commands` JSONB

**Auto-detection:**
- On `/clone`, auto-load commands from `.archon/commands/` if present
- Commands are registered per-codebase (not global)

**Default Commands/Workflows:**
- Bundled defaults are stored in `.archon/commands/defaults/` and `.archon/workflows/defaults/`
- On `/clone`, if target repo has no `.archon/commands/`, defaults are copied automatically
- Defaults are copied flat (not into a `defaults/` subfolder in target)
- Opt-out: Set `defaults.copyDefaults: false` in target's `.archon/config.yaml`

### Command Types

**1. Codebase Commands** (per-repo):
- Stored in filesystem (e.g., `.archon/commands/plan.md`)
- Loaded via `/clone` (auto) or `/load-commands <folder>` (manual)
- Invoked via `/command-invoke <name> [args]`
- Paths stored in `codebases.commands` JSONB

**2. Global Templates** (database):
- Stored in `remote_agent_command_templates` table
- Added manually via `/template-add <name> <file-path>`
- Invoked directly via `/<name> [args]`
- Shared across all codebases

**3. Workflows** (YAML-based):
- Stored in `.archon/workflows/` (searched recursively, includes subdirectories like `defaults/`)
- Multi-step AI execution chains
- Discovered at runtime, routed by AI
- Concurrent execution prevented - only one workflow can run per conversation at a time
- Auto-commits artifacts on completion (safety net for uncommitted changes)
- Commands: `/workflow list`, `/workflow reload`, `/workflow cancel`

### Default Commands and Workflows

This repo includes bundled default commands in `.archon/commands/defaults/` and workflows in `.archon/workflows/defaults/`. These serve two purposes:

1. **For this repo**: Loaded via recursive search (developers working on Archon can use these)
2. **For target repos**: Copied automatically on `/clone` to give users a starting point

To opt out of automatic copying, add to target repo's `.archon/config.yaml`:
```yaml
defaults:
  copyDefaults: false
```

### Example Commands in This Repo

This repo includes 16 default commands in `.archon/commands/defaults/` and 8 default workflows in `.archon/workflows/defaults/`. Key examples:
- Feature development: `implement.md`, `create-pr.md`
- GitHub issue workflow: `investigate-issue.md`, `implement-issue.md`
- Code review: `code-review-agent.md`, `synthesize-review.md`
- General assistance: `assist.md`

These are **automatically copied** to new repos on `/clone` (unless opted out).

### Error Handling

**Database Errors:**
```typescript
// INSERT operations
try {
  await db.query('INSERT INTO conversations ...', params);
} catch (error) {
  console.error('[DB] Insert failed', { error, params });
  throw new Error('Failed to create conversation');
}

// UPDATE operations - verify rowCount to catch missing records
try {
  await db.updateConversation(conversationId, { codebase_id: codebaseId });
} catch (error) {
  // updateConversation throws if no rows matched (conversation not found)
  console.error('[DB] Update failed', { error, conversationId });
  throw error; // Re-throw to surface the issue
}
```

**Platform Errors:**
```typescript
try {
  await telegram.sendMessage(chatId, message);
} catch (error) {
  console.error('[Telegram] Send failed', { error, chatId });
  // Don't retry - let user know manually
}
```

**AI SDK Errors:**
```typescript
try {
  await claudeClient.sendMessage(session, prompt);
} catch (error) {
  console.error('[Claude] Session error', { error, sessionId });
  await platform.sendMessage(conversationId, '❌ AI error. Try /reset');
}
```

**Git Operation Errors (Graceful Handling):**
```typescript
// Handle expected failure cases gracefully (don't throw to users)
try {
  await execFileAsync('git', ['worktree', 'remove', path]);
} catch (error) {
  // Missing directories are expected during cleanup (manual deletion, OS cleanup)
  if (error.message.includes('No such file or directory')) {
    console.log('[Cleanup] Directory already removed, marking as destroyed');
    await db.markEnvironmentDestroyed(envId);
    return; // Success - goal achieved
  }
  // Surface unexpected git errors (permission issues, git repo corruption)
  throw error;
}
```

### API Endpoints

**Webhooks:**
- `POST /webhooks/github` - GitHub webhook events
- Signature verification required (HMAC SHA-256)
- Return 200 immediately, process async

**Health Checks:**
- `GET /health` - Basic health check
- `GET /health/db` - Database connectivity check

**Security:**
- Verify webhook signatures (GitHub: `X-Hub-Signature-256`)
- Use `express.raw()` middleware for webhook body (signature verification)
- Never log or expose tokens in responses

### Docker Patterns

**Profiles:**
- `external-db`: App only (for remote databases like Supabase/Neon)
- `with-db`: App + PostgreSQL 18 (for production with local DB)

**Development Setup (Recommended):**
- Run only postgres: `docker-compose --profile with-db up -d postgres`
- Run app locally: `bun run dev` (hot reload enabled)

**Volumes:**
- `/.archon/` - All Archon-managed data (workspaces, worktrees)

**Networking:**
- App: Port 3000 (configurable via `PORT` env var)
- PostgreSQL: Port 5432 (exposed on localhost for local development)

### GitHub-Specific Patterns

**Authentication:**
- GitHub CLI operations: Use `GITHUB_TOKEN` (personal access token)
- Webhook events: Use GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`)

**Operations:**
```bash
# Clone repo
git clone https://github.com/user/repo.git /workspace/repo

# Create PR
gh pr create --title "Fix #42" --body "Fixes #42"

# Comment on issue
gh issue comment 42 --body "Working on this..."

# Review PR
gh pr review 15 --comment -b "Looks good!"
```

**@Mention Detection:**
- Parse `@coding-assistant` in issue/PR **comments only** (not descriptions)
- Events: `issue_comment` only
- Note: Descriptions often contain example commands or documentation - these are NOT command invocations (see #96)

## Common Workflows

**Fix Issue (GitHub):**
1. User: Comments `@coding-assistant fix this` on issue #42
2. Webhook: `issue_comment` event triggers, conversationId = `user/repo#42`
3. Clone repo if needed
4. AI: Analyze issue, make changes, commit
5. `gh pr create` with "Fixes #42"
6. Comment on issue with PR link

**Review PR (GitHub):**
1. User: `@coding-assistant review` on PR #15
2. Fetch PR diff: `gh pr diff 15`
3. AI: Review code, generate feedback
4. `gh pr review 15 --comment -b "feedback"`

**Remote Development (Telegram/Slack):**
1. `/clone https://github.com/user/repo`
2. `/load-commands .claude/commands`
3. `/command-invoke prime`
4. `/command-invoke plan "Add dark mode"`
5. `/command-invoke execute`
6. `/command-invoke commit`
