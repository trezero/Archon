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
2. Create New Application > Bot > Reset Token
3. Enable MESSAGE CONTENT INTENT in Bot settings
4. Copy the bot token

**Slack:**
1. Go to [Slack API](https://api.slack.com/apps)
2. Create New App > From Scratch
3. See [Slack Setup Guide](slack-setup.md) for detailed steps

**GitHub Webhooks:**
1. Generate a webhook secret: `openssl rand -hex 32`
2. Add webhook to your repo (Settings > Webhooks)
3. Set URL: `https://your-server/webhooks/github`
4. See [README GitHub Webhooks section](../README.md#-github-webhooks) for detailed steps

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
bun run setup:check
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
