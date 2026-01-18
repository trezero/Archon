# Dynamous Remote Coding Agent

Control AI coding assistants (Claude Code, Codex) remotely from Telegram, GitHub, and more. Built for developers who want to code from anywhere with persistent sessions and flexible workflows/systems.

**Quick Start:** [Core Configuration](#1-core-configuration-required) • [AI Assistant Setup](#2-ai-assistant-setup-choose-at-least-one) • [Platform Setup](#3-platform-adapter-setup-choose-at-least-one) • [Start the App](#4-start-the-application) • [Usage Guide](#usage)

## Features

- **Multi-Platform Support**: Interact via Telegram, Slack, Discord, GitHub issues/PRs, and more
- **Multiple AI Assistants**: Choose between Claude Code or Codex (or both)
- **Persistent Sessions**: Sessions survive container restarts with full context preservation
- **Codebase Management**: Clone and work with any GitHub repository
- **Flexible Streaming**: Real-time or batch message delivery per platform
- **Generic Command System**: User-defined commands versioned with Git
- **Docker Ready**: Simple deployment with Docker Compose

## Prerequisites

**System Requirements:**
- Docker & Docker Compose (for deployment)
- [Bun](https://bun.sh) 1.0+ (for local development)

**Accounts Required:**
- GitHub account (for repository cloning via `/clone` command)
- At least one of: Claude Pro/Max subscription OR Codex account
- At least one of: Telegram, Slack, Discord, or GitHub account (for interaction)

---

## Quick Start

### Option 1: Docker (*Not working yet => works when repo goes public*)

```bash
# 1. Get the files
mkdir remote-agent && cd remote-agent
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/.env.example -o .env

# 2. Configure (edit .env with your tokens)
nano .env

# 3. Run
docker compose up -d --profile <yourprofile>

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
psql $DATABASE_URL < migrations/000_combined.sql

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

---

## Setup Guide

**Get started:**
```bash
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install
```

### 1. Core Configuration (Required)

**Create environment file:**
```bash
cp .env.example .env
```

**Set these required variables:**

| Variable | Purpose | How to Get |
|----------|---------|------------|
| `DATABASE_URL` | PostgreSQL connection | See database options below |
| `GH_TOKEN` | Repository cloning | [Generate token](https://github.com/settings/tokens) with `repo` scope |
| `GITHUB_TOKEN` | Same as `GH_TOKEN` | Use same token value |
| `PORT` | HTTP server port | Default: `3000` (optional) |
| `ARCHON_HOME` | (Optional) Override base directory | Default: `~/.archon` |

**GitHub Personal Access Token Setup:**

1. Visit [GitHub Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)" → Select scope: **`repo`**
3. Copy token (starts with `ghp_...`) and set both variables:

```env
# .env
GH_TOKEN=ghp_your_token_here
GITHUB_TOKEN=ghp_your_token_here  # Same value
```

**Note:** Repository clones are stored in `~/.archon/workspaces/` by default (or `/.archon/workspaces/` in Docker). Set `ARCHON_HOME` to override the base directory.

**Database Setup - Choose One:**

<details>
<summary><b>Option A: Remote PostgreSQL (Supabase, Neon)</b></summary>

Set your remote connection string:

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

**For fresh installations**, run the combined migration:

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

This creates 5 tables:
- `remote_agent_codebases` - Repository metadata
- `remote_agent_conversations` - Platform conversation tracking
- `remote_agent_sessions` - AI session management
- `remote_agent_command_templates` - Global command templates
- `remote_agent_isolation_environments` - Worktree isolation tracking

**For updates to existing installations**, run only the migrations you haven't applied yet:

```bash
# Check which migrations you've already run, then apply new ones:
psql $DATABASE_URL < migrations/002_command_templates.sql
psql $DATABASE_URL < migrations/003_add_worktree.sql
psql $DATABASE_URL < migrations/004_worktree_sharing.sql
psql $DATABASE_URL < migrations/006_isolation_environments.sql
psql $DATABASE_URL < migrations/007_drop_legacy_columns.sql
```

</details>

<details>
<summary><b>Option B: Local PostgreSQL (via Docker)</b></summary>

Use the `with-db` profile for automatic PostgreSQL setup:

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

**For fresh installations**, database schema is created automatically when you start with `docker compose --profile with-db`. The combined migration runs on first startup.

**For updates to existing Docker installations**, you need to manually run new migrations:

```bash
# Connect to the running postgres container
docker compose exec postgres psql -U postgres -d remote_coding_agent

# Then run the migrations you haven't applied yet
\i /migrations/002_command_templates.sql
\i /migrations/003_add_worktree.sql
\i /migrations/004_worktree_sharing.sql
\i /migrations/006_isolation_environments.sql
\i /migrations/007_drop_legacy_columns.sql
\q
```

Or from your host machine (requires `psql` installed):

```bash
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/002_command_templates.sql
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/003_add_worktree.sql
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/004_worktree_sharing.sql
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/006_isolation_environments.sql
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/007_drop_legacy_columns.sql
```

</details>

---

### 2. AI Assistant Setup (Choose At Least One)

You must configure **at least one** AI assistant. Both can be configured if desired.

<details>
<summary><b>🤖 Claude Code</b></summary>

**Recommended for Claude Pro/Max subscribers.**

**Authentication Options:**

Claude Code supports three authentication modes via `CLAUDE_USE_GLOBAL_AUTH`:

1. **Global Auth** (set to `true`): Uses credentials from `claude /login`
2. **Explicit Tokens** (set to `false`): Uses tokens from env vars below
3. **Auto-Detect** (not set): Uses tokens if present in env, otherwise global auth

**Option 1: Global Auth (Recommended)**

```env
CLAUDE_USE_GLOBAL_AUTH=true
```

**Option 2: OAuth Token**

```bash
# Install Claude Code CLI first: https://docs.claude.com/claude-code/installation
claude setup-token

# Copy the token starting with sk-ant-oat01-...
```

```env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

**Option 3: API Key (Pay-per-use)**

1. Visit [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new key (starts with `sk-ant-`)

```env
CLAUDE_API_KEY=sk-ant-xxxxx
```

**Set as default assistant (optional):**

If you want Claude to be the default AI assistant for new conversations without codebase context, set this environment variable:

```env
DEFAULT_AI_ASSISTANT=claude
```

</details>

<details>
<summary><b>🤖 Codex</b></summary>

**Authenticate with Codex CLI:**

```bash
# Install Codex CLI first: https://docs.codex.com/installation
codex login

# Follow browser authentication flow
```

**Extract credentials from auth file:**

On Linux/Mac:
```bash
cat ~/.codex/auth.json
```

On Windows:
```cmd
type %USERPROFILE%\.codex\auth.json
```

**Set all four environment variables:**

```env
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

**Set as default assistant (optional):**

If you want Codex to be the default AI assistant for new conversations without codebase context, set this environment variable:

```env
DEFAULT_AI_ASSISTANT=codex
```

</details>

**How Assistant Selection Works:**
- Assistant type is set per codebase (auto-detected from `.codex/` or `.claude/` folders)
- Once a conversation starts, the assistant type is locked for that conversation
- `DEFAULT_AI_ASSISTANT` (optional) is used only for new conversations without codebase context

---

### 3. Platform Adapter Setup (Choose At Least One)

You must configure **at least one** platform to interact with your AI assistant.

<details>
<summary><b>💬 Telegram</b></summary>

**Create Telegram Bot:**

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Set environment variable:**

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
```

**Configure streaming mode (optional):**

```env
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

**For streaming mode details, see [Advanced Configuration](#advanced-configuration).**

</details>

<details>
<summary><b>💼 Slack</b></summary>

**Create Slack App with Socket Mode:**

See the detailed **[Slack Setup Guide](docs/slack-setup.md)** for step-by-step instructions.

**Quick Overview:**

1. Create app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode and get App Token (`xapp-...`)
3. Add Bot Token Scopes: `app_mentions:read`, `chat:write`, `channels:history`, `im:history`, `im:write`
4. Subscribe to events: `app_mention`, `message.im`
5. Install to workspace and get Bot Token (`xoxb-...`)

**Set environment variables:**

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

**Optional configuration:**

```env
# Restrict to specific users (comma-separated Slack user IDs)
SLACK_ALLOWED_USER_IDS=U1234ABCD,W5678EFGH

# Streaming mode
SLACK_STREAMING_MODE=batch  # batch (default) | stream
```

**Usage:**

Interact by @mentioning your bot in channels or DM directly:

```
@your-bot /clone https://github.com/user/repo
@your-bot /status
```

Thread replies maintain conversation context, enabling workflows like:
1. Clone repo in main channel
2. Continue work in thread
3. Use `/worktree` for parallel development

</details>

<details>
<summary><b>🐙 GitHub Webhooks</b></summary>

**Requirements:**
- GitHub repository with issues enabled
- `GITHUB_TOKEN` already set in Core Configuration above
- Public endpoint for webhooks (see ngrok setup below for local development)

**Step 1: Generate Webhook Secret**

On Linux/Mac:
```bash
openssl rand -hex 32
```

On Windows (PowerShell):
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Save this secret - you'll need it for steps 3 and 4.

**Step 2: Expose Local Server (Development Only)**

<details>
<summary>Using ngrok (Free Tier)</summary>

```bash
# Install ngrok: https://ngrok.com/download
# Or: choco install ngrok (Windows)
# Or: brew install ngrok (Mac)

# Start tunnel
ngrok http 3000

# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
# ⚠️ Free tier URLs change on restart
```

Keep this terminal open while testing.

</details>

<details>
<summary>Using Cloudflare Tunnel (Persistent URLs)</summary>

```bash
# Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
cloudflared tunnel --url http://localhost:3000

# Get persistent URL from Cloudflare dashboard
```

Persistent URLs survive restarts.

</details>

**For production deployments**, use your deployed server URL (no tunnel needed).

**Step 3: Configure GitHub Webhook**

Go to your repository settings:
- Navigate to: `https://github.com/owner/repo/settings/hooks`
- Click "Add webhook"
- **Note**: For multiple repositories, you'll need to add the webhook to each one individually

**Webhook Configuration:**

| Field | Value |
|-------|-------|
| **Payload URL** | Local: `https://abc123.ngrok-free.app/webhooks/github`<br>Production: `https://your-domain.com/webhooks/github` |
| **Content type** | `application/json` |
| **Secret** | Paste the secret from Step 1 |
| **SSL verification** | Enable SSL verification (recommended) |
| **Events** | Select "Let me select individual events":<br>✓ Issues<br>✓ Issue comments<br>✓ Pull requests |

Click "Add webhook" and verify it shows a green checkmark after delivery.

**Step 4: Set Environment Variables**

```env
WEBHOOK_SECRET=your_secret_from_step_1
```

**Important**: The `WEBHOOK_SECRET` must match exactly what you entered in GitHub's webhook configuration.

**Step 5: Configure Streaming (Optional)**

```env
GITHUB_STREAMING_MODE=batch  # batch (default) | stream
```

**For streaming mode details, see [Advanced Configuration](#advanced-configuration).**

**Usage:**

Interact by @mentioning `@Archon` in issues or PRs:

```
@Archon can you analyze this bug?
@Archon /command-invoke prime
@Archon review this implementation
```

**First mention behavior:**
- Automatically clones the repository to `/.archon/workspaces/`
- Detects and loads commands from `.archon/commands/` if present
- Injects full issue/PR context for the AI assistant

**Subsequent mentions:**
- Resumes existing conversation
- Maintains full context across comments

</details>

<details>
<summary><b>💬 Discord</b></summary>

**Create Discord Bot:**

1. Visit [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" → Enter a name → Click "Create"
3. Go to the "Bot" tab in the left sidebar
4. Click "Add Bot" → Confirm

**Get Bot Token:**

1. Under the Bot tab, click "Reset Token"
2. Copy the token (starts with a long alphanumeric string)
3. **Save it securely** - you won't be able to see it again

**Enable Message Content Intent (Required):**

1. Scroll down to "Privileged Gateway Intents"
2. Enable **"Message Content Intent"** (required for the bot to read messages)
3. Save changes

**Invite Bot to Your Server:**

1. Go to "OAuth2" → "URL Generator" in the left sidebar
2. Under "Scopes", select:
   - ✓ `bot`
3. Under "Bot Permissions", select:
   - ✓ Send Messages
   - ✓ Read Message History
   - ✓ Create Public Threads (optional, for thread support)
   - ✓ Send Messages in Threads (optional, for thread support)
4. Copy the generated URL at the bottom
5. Paste it in your browser and select your server
6. Click "Authorize"

**Note:** You need "Manage Server" permission to add bots.

**Set environment variable:**

```env
DISCORD_BOT_TOKEN=your_bot_token_here
```

**Configure user whitelist (optional):**

To restrict bot access to specific users, enable Developer Mode in Discord:
1. User Settings → Advanced → Enable "Developer Mode"
2. Right-click on users → "Copy User ID"
3. Add to environment:

```env
DISCORD_ALLOWED_USER_IDS=123456789012345678,987654321098765432
```

**Configure streaming mode (optional):**

```env
DISCORD_STREAMING_MODE=batch  # batch (default) | stream
```

**For streaming mode details, see [Advanced Configuration](#advanced-configuration).**

**Usage:**

The bot responds to:
- **Direct Messages**: Just send messages directly
- **Server Channels**: @mention the bot (e.g., `@YourBotName help me with this code`)
- **Threads**: Bot maintains context in thread conversations

</details>

---

### 4. Start the Application

Choose the Docker Compose profile based on your database setup:

**Option A: With Remote PostgreSQL (Supabase, Neon, etc.)**

Starts only the app container (requires `DATABASE_URL` set to remote database in `.env`):

```bash
# Start app container
docker compose --profile external-db up -d --build

# View logs
docker compose logs -f app
```

**Option B: With Local PostgreSQL (Docker)**

Starts both the app and PostgreSQL containers:

```bash
# Start containers
docker compose --profile with-db up -d --build

# Wait for startup (watch logs)
docker compose logs -f app-with-db

# Database tables are created automatically via init script
```

**Option C: Local Development (No Docker)**

Run directly with Bun (requires local PostgreSQL or remote `DATABASE_URL` in `.env`):

```bash
bun install  # First time only
bun run dev
```

**Stop the application:**

```bash
docker compose --profile external-db down  # If using Option A
docker compose --profile with-db down      # If using Option B
```

---

## Usage

### Available Commands

Once your platform adapter is running, you can use these commands. Type `/help` to see this list.

#### Command Templates (Global)

| Command | Description |
|---------|-------------|
| `/<name> [args]` | Invoke a template directly (e.g., `/plan "Add dark mode"`) |
| `/templates` | List all available templates |
| `/template-add <name> <path>` | Add template from file |
| `/template-delete <name>` | Remove a template |

#### Codebase Commands (Per-Project)

| Command | Description |
|---------|-------------|
| `/command-set <name> <path> [text]` | Register a command from file |
| `/load-commands <folder>` | Bulk load commands (recursive) |
| `/command-invoke <name> [args]` | Execute a codebase command |
| `/commands` | List registered commands |

> **Note:** Commands use relative paths (e.g., `.archon/commands/plan.md`)

#### Codebase Management

| Command | Description |
|---------|-------------|
| `/clone <repo-url>` | Clone repository |
| `/repos` | List repositories (numbered) |
| `/repo <#\|name> [pull]` | Switch repo (auto-loads commands) |
| `/repo-remove <#\|name>` | Remove repo and codebase record |
| `/getcwd` | Show working directory |
| `/setcwd <path>` | Set working directory |

> **Tip:** Use `/repo` for quick switching between cloned repos, `/setcwd` for manual paths.

#### Worktrees (Isolation)

| Command | Description |
|---------|-------------|
| `/worktree create <branch>` | Create isolated worktree |
| `/worktree list` | Show worktrees for this repo |
| `/worktree remove [--force]` | Remove current worktree |
| `/worktree cleanup merged\|stale` | Clean up worktrees |
| `/worktree orphans` | Show all worktrees from git |

#### Workflows

| Command | Description |
|---------|-------------|
| `/workflow list` | Show available workflows |
| `/workflow reload` | Reload workflow definitions |
| `/workflow cancel` | Cancel running workflow |

> **Note:** Workflows are YAML files in `.archon/workflows/`

#### Session Management

| Command | Description |
|---------|-------------|
| `/status` | Show conversation state |
| `/reset` | Clear session completely |
| `/reset-context` | Reset AI context, keep worktree |
| `/help` | Show all commands |

#### Setup

| Command | Description |
|---------|-------------|
| `/init` | Create `.archon` structure in current repo |

### Example Workflow (Telegram)

**Clone a Repository**
```
You: /clone https://github.com/user/my-project

Bot: Repository cloned successfully!

     Repository: my-project
     ✓ Copied 16 default commands
     ✓ Copied 8 default workflows

     Session reset - starting fresh on next message.

     You can now start asking questions about the code.
```

> **Note:** Default commands and workflows are automatically copied to new repos. If the repo already has `.archon/commands/` or `.archon/workflows/`, existing files are preserved. To opt out, set `defaults.copyDefaults: false` in the repo's `.archon/config.yaml`.

**Ask Questions Directly**
```
You: What's the structure of this repo?

Bot: [Claude analyzes and responds...]
```

**Create Custom Commands (Optional)**
```
You: /init

Bot: Created .archon structure:
       .archon/
       ├── config.yaml
       └── commands/
           └── example.md

     Use /load-commands .archon/commands to register commands.
```

You can then create your own commands in `.archon/commands/` and load them with `/load-commands`.

**Check Status**
```
You: /status

Bot: Platform: telegram
     AI Assistant: claude

     Codebase: my-project
     Repository: https://github.com/user/my-project

     Repository: my-project @ main

     Worktrees: 0/10
```

**Work in Isolation with Worktrees**
```
You: /worktree create feature-auth

Bot: Worktree created!

     Branch: feature-auth
     Path: feature-auth/

     This conversation now works in isolation.
     Run dependency install if needed (e.g., bun install).
```

**Reset Session**
```
You: /reset

Bot: Session cleared. Starting fresh on next message.

     Codebase configuration preserved.
```

### Example Workflow (GitHub)

Create an issue or comment on an existing issue/PR:

```
@your-bot-name can you help me understand the authentication flow?
```

Bot responds with analysis. Continue the conversation:

```
@your-bot-name can you create a sequence diagram for this?
```

Bot maintains context and provides the diagram.

---

## Advanced Configuration

<details>
<summary><b>Streaming Modes Explained</b></summary>

### Stream Mode

Messages are sent in real-time as the AI generates responses.

**Configuration:**
```env
TELEGRAM_STREAMING_MODE=stream
GITHUB_STREAMING_MODE=stream
```

**Pros:**
- Real-time feedback and progress indication
- More interactive and engaging
- See AI reasoning as it works

**Cons:**
- More API calls to platform
- May hit rate limits with very long responses
- Creates many messages/comments

**Best for:** Interactive chat platforms (Telegram)

### Batch Mode

Only the final summary message is sent after AI completes processing.

**Configuration:**
```env
TELEGRAM_STREAMING_MODE=batch
GITHUB_STREAMING_MODE=batch
```

**Pros:**
- Single coherent message/comment
- Fewer API calls
- No spam or clutter

**Cons:**
- No progress indication during processing
- Longer wait for first response
- Can't see intermediate steps

**Best for:** Issue trackers and async platforms (GitHub)

</details>

<details>
<summary><b>Concurrency Settings</b></summary>

Control how many conversations the system processes simultaneously:

```env
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**How it works:**
- Conversations are processed with a lock manager
- If max concurrent limit reached, new messages are queued
- Prevents resource exhaustion and API rate limits
- Each conversation maintains its own independent context

**Check current load:**
```bash
curl http://localhost:3000/health/concurrency
```

**Response:**
```json
{
  "status": "ok",
  "active": 3,
  "queued": 0,
  "maxConcurrent": 10
}
```

**Tuning guidance:**
- **Low resources**: Set to 3-5
- **Standard**: Default 10 works well
- **High resources**: Can increase to 20-30 (monitor API limits)

</details>

<details>
<summary><b>Health Check Endpoints</b></summary>

The application exposes health check endpoints for monitoring:

**Basic Health Check:**
```bash
curl http://localhost:3000/health
```
Returns: `{"status":"ok"}`

**Database Connectivity:**
```bash
curl http://localhost:3000/health/db
```
Returns: `{"status":"ok","database":"connected"}`

**Concurrency Status:**
```bash
curl http://localhost:3000/health/concurrency
```
Returns: `{"status":"ok","active":0,"queued":0,"maxConcurrent":10}`

**Use cases:**
- Docker healthcheck configuration
- Load balancer health checks
- Monitoring and alerting systems (Prometheus, Datadog, etc.)
- CI/CD deployment verification

</details>

<details>
<summary><b>Custom Command System</b></summary>

Create your own commands by adding markdown files to your codebase:

**1. Create command file:**
```bash
mkdir -p .archon/commands
cat > .archon/commands/analyze.md << 'EOF'
You are an expert code analyzer.

Analyze the following aspect of the codebase: $1

Provide:
1. Current implementation analysis
2. Potential issues or improvements
3. Best practices recommendations

Focus area: $ARGUMENTS
EOF
```

**2. Load commands:**
```
/load-commands .archon/commands
```

**3. Invoke your command:**
```
/command-invoke analyze "security vulnerabilities"
```

**Variable substitution:**
- `$1`, `$2`, `$3`, etc. - Positional arguments
- `$ARGUMENTS` - All arguments as a single string
- `$PLAN` - Previous plan from session metadata
- `$IMPLEMENTATION_SUMMARY` - Previous execution summary

Commands are version-controlled with your codebase, not stored in the database.

</details>

<details>
<summary><b>Workflows (Multi-Step Automation)</b></summary>

Workflows are YAML files that define multi-step AI processes. They can be step-based (sequential commands) or loop-based (autonomous iteration).

**Location:** `.archon/workflows/`

**Example step-based workflow** (`.archon/workflows/fix-github-issue.yaml`):
```yaml
name: fix-github-issue
description: |
  Use when: User wants to FIX or RESOLVE a GitHub issue.
  Does: Investigates root cause -> creates plan -> makes code changes -> creates PR.

provider: claude
model: sonnet

steps:
  - command: investigate-issue

  - command: implement-issue
    clearContext: true
```

**Example loop-based workflow** (autonomous iteration):
```yaml
name: ralph-loop
description: Execute plan until all validations pass

provider: claude
model: sonnet

loop:
  until: "All validations pass"
  max_iterations: 10
  fresh_context: true

prompt: |
  Continue implementing the plan. Run validation after each change.
  Signal completion with: "All validations pass"
```

**How workflows are invoked:**
- AI routes to workflows automatically based on user intent
- Workflows use commands defined in `.archon/commands/`
- Only one workflow can run per conversation at a time

**Managing workflows:**
```
/workflow list    # Show available workflows
/workflow reload  # Reload definitions after editing
/workflow cancel  # Cancel a running workflow
```

</details>

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────┐
│   Platform Adapters (Telegram, Slack, Discord, GitHub) │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Orchestrator                        │
│          (Message Routing & Context Management)         │
└─────────────┬───────────────────────────┬───────────────┘
              │                           │
      ┌───────┴────────┐          ┌───────┴────────┐
      │                │          │                │
      ▼                ▼          ▼                ▼
┌───────────┐  ┌────────────┐  ┌──────────────────────────┐
│  Command  │  │  Workflow  │  │    AI Assistant Clients  │
│  Handler  │  │  Executor  │  │      (Claude / Codex)    │
│  (Slash)  │  │  (YAML)    │  │                          │
└───────────┘  └────────────┘  └──────────────────────────┘
      │              │                      │
      └──────────────┴──────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   PostgreSQL (6 Tables)                 │
│   Codebases • Conversations • Sessions • Workflow Runs  │
│        Command Templates • Isolation Environments       │
└─────────────────────────────────────────────────────────┘
```

### Key Design Patterns

- **Adapter Pattern**: Platform-agnostic via `IPlatformAdapter` interface
- **Strategy Pattern**: Swappable AI assistants via `IAssistantClient` interface
- **Session Persistence**: AI context survives restarts via database storage
- **Generic Commands**: User-defined markdown commands versioned with Git
- **Workflow Engine**: YAML-based multi-step automation with step and loop modes
- **Worktree Isolation**: Git worktrees enable parallel work per conversation
- **Concurrency Control**: Lock manager prevents race conditions

### Database Schema

<details>
<summary><b>6 tables with `remote_agent_` prefix</b></summary>

1. **`remote_agent_codebases`** - Repository metadata
   - Commands stored as JSONB: `{command_name: {path, description}}`
   - AI assistant type per codebase
   - Default working directory

2. **`remote_agent_conversations`** - Platform conversation tracking
   - Platform type + conversation ID (unique constraint)
   - Linked to codebase via foreign key
   - AI assistant type locked at creation

3. **`remote_agent_sessions`** - AI session management
   - Active session flag (one per conversation)
   - Session ID for resume capability
   - Metadata JSONB for command context

4. **`remote_agent_command_templates`** - Global command templates
   - Shared command definitions (like `/plan`, `/commit`)
   - Available across all codebases

5. **`remote_agent_isolation_environments`** - Worktree isolation
   - Tracks git worktrees per issue/PR
   - Enables worktree sharing between linked issues and PRs

6. **`remote_agent_workflow_runs`** - Workflow execution tracking
   - Tracks active workflows per conversation
   - Prevents concurrent workflow execution
   - Stores workflow state and step progress

</details>

---

## Troubleshooting

### Bot Not Responding

**Check if application is running:**
```bash
docker compose ps
# Should show 'app' or 'app-with-db' with state 'Up'
```

**Check application logs:**
```bash
docker compose logs -f app          # If using --profile external-db
docker compose logs -f app-with-db  # If using --profile with-db
```

**Verify bot token:**
```bash
# In your .env file
cat .env | grep TELEGRAM_BOT_TOKEN
```

**Test with health check:**
```bash
curl http://localhost:3000/health
# Expected: {"status":"ok"}
```

### Database Connection Errors

**Check database health:**
```bash
curl http://localhost:3000/health/db
# Expected: {"status":"ok","database":"connected"}
```

**For local PostgreSQL (`with-db` profile):**
```bash
# Check if postgres container is running
docker compose ps postgres

# Check postgres logs
docker compose logs -f postgres

# Test direct connection
docker compose exec postgres psql -U postgres -c "SELECT 1"
```

**For remote PostgreSQL:**
```bash
# Verify DATABASE_URL
echo $DATABASE_URL

# Test connection directly
psql $DATABASE_URL -c "SELECT 1"
```

**Verify tables exist:**
```bash
# For local postgres
docker compose exec postgres psql -U postgres -d remote_coding_agent -c "\dt"

# Should show: remote_agent_codebases, remote_agent_conversations, remote_agent_sessions,
# remote_agent_command_templates, remote_agent_isolation_environments
```

### Clone Command Fails

**Verify GitHub token:**
```bash
cat .env | grep GH_TOKEN
# Should have both GH_TOKEN and GITHUB_TOKEN set
```

**Test token validity:**
```bash
# Test GitHub API access
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/user
```

**Check workspace permissions:**
```bash
# Use the service name matching your profile
docker compose exec app ls -la /.archon/workspaces          # --profile external-db
docker compose exec app-with-db ls -la /.archon/workspaces  # --profile with-db
```

**Try manual clone:**
```bash
docker compose exec app git clone https://github.com/user/repo /.archon/workspaces/test-repo
# Or app-with-db if using --profile with-db
```

### GitHub Webhook Not Triggering

**Verify webhook delivery:**
1. Go to your webhook settings in GitHub
2. Click on the webhook
3. Check "Recent Deliveries" tab
4. Look for successful deliveries (green checkmark)

**Check webhook secret:**
```bash
cat .env | grep WEBHOOK_SECRET
# Must match exactly what you entered in GitHub
```

**Verify ngrok is running (local dev):**
```bash
# Check ngrok status
curl http://localhost:4040/api/tunnels
# Or visit http://localhost:4040 in browser
```

**Check application logs for webhook processing:**
```bash
docker compose logs -f app | grep GitHub          # --profile external-db
docker compose logs -f app-with-db | grep GitHub  # --profile with-db
```

### TypeScript Compilation Errors

**Clean and rebuild:**
```bash
# Stop containers (use the profile you started with)
docker compose --profile external-db down  # or --profile with-db

# Clean build
rm -rf dist node_modules
bun install
bun run build

# Restart (use the profile you need)
docker compose --profile external-db up -d --build  # or --profile with-db
```

**Check for type errors:**
```bash
bun run type-check
```

### Container Won't Start

**Check logs for specific errors:**
```bash
docker compose logs app          # If using --profile external-db
docker compose logs app-with-db  # If using --profile with-db
```

**Verify environment variables:**
```bash
# Check if .env is properly formatted (include your profile)
docker compose --profile external-db config  # or --profile with-db
```

**Rebuild without cache:**
```bash
docker compose --profile external-db build --no-cache  # or --profile with-db
docker compose --profile external-db up -d             # or --profile with-db
```

**Check port conflicts:**
```bash
# See if port 3000 is already in use
# Linux/Mac:
lsof -i :3000

# Windows:
netstat -ano | findstr :3000
```
