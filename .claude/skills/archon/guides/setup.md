# Archon Setup Wizard

Interactive setup guide. Follow these steps in order, using AskUserQuestion to gather input.

**IMPORTANT — When to use AskUserQuestion vs plain text**:
- **AskUserQuestion**: Use ONLY for multiple-choice decisions (pick A or B).
- **Plain text**: Use for freeform input (paths, URLs, tokens, usernames). Just ask the user directly in your message — e.g., "Paste the path to your repo here." Never wrap freeform input in AskUserQuestion with an "I'll provide it" option — that creates a pointless double question.

## Prerequisites

Run these checks first:

```bash
bun --version
git --version
```

If `bun` is not installed, tell the user to install it from https://bun.sh and stop. If `git` is not installed, tell the user to install it and stop.

## Context

The user is inside the **remote-coding-agent** repository — that's how they have access to this skill. The Archon repo path is the current working directory. Store it as `<archon-repo>`.

## Step 1: Setup Mode

Use **AskUserQuestion** to determine setup approach:

```
Header: "Setup mode"
Question: "How would you like to set up Archon?"
Options:
  1. "Quick setup (defaults)" (Recommended) — Use sensible defaults, get running fast
  2. "Guided setup" — Walk through all configuration options interactively
```

Store the choice. If "Quick setup", skip Step 7 (repo config) — defaults will be used. If "Guided setup", include Step 7.

## Step 2: Ask for Target Repo

**IMPORTANT**: The target repo is the user's own project — **never** the remote-coding-agent (Archon) repo itself. Do not suggest or offer the current directory as an option.

Use **AskUserQuestion** with a single question:

```
Header: "Target repo"
Question: "What is the path to the repository you want to work on using Archon? (This should be your own project, not the Archon repo.)"
Options:
  1. "Clone from GitHub" — user provides a GitHub URL; clone it to ~/.archon/workspaces/
```

The user will either select "Clone from GitHub" or type a local path via "Other". **Do NOT add a second question to collect the path** — the "Other" freeform input captures it directly in one step.

Store the result as `<target-repo>`.

If "Clone from GitHub": ask for the URL in plain text (not AskUserQuestion), then:
```bash
archon-repo-path=$(pwd)
mkdir -p ~/.archon/workspaces
cd ~/.archon/workspaces && git clone <url>
```
Set `<target-repo>` to the cloned directory.

## Step 3: Ask for Platforms

Use **AskUserQuestion** with `multiSelect: true`:

```
Header: "Platforms"
Question: "Which platforms do you want to set up? CLI is always included."
Options:
  1. "CLI + GitHub" (Recommended) — CLI for local use, GitHub webhooks for issue/PR automation
  2. "CLI only" — terminal-only, simplest setup
  3. "Telegram" — chat bot via BotFather
  4. "Slack" — Socket Mode app
```

Discord is also available — mention it as the "Other" option text.

## Step 4: Run CLI Setup

**Always run this.** Read and follow `guides/cli.md`:

1. `cd <archon-repo> && bun install`
2. `cd <archon-repo>/packages/cli && bun link`
3. Verify: `archon version`
4. Check Claude is installed: `which claude`, then `claude /login` if needed

## Step 5: Database Setup

The CLI loads infrastructure config (database, tokens) from `~/.archon/.env` only. This prevents conflicts with project `.env` files that may contain different database URLs.

### 5a: Check for existing config

```bash
test -f ~/.archon/.env && echo "exists" || echo "missing"
```

**If `~/.archon/.env` exists**: Read it and check which values are already filled in. Tell the user: "Found existing Archon config — I'll check what's already configured."

### 5b: Choose database mode

Use **AskUserQuestion**:

```
Header: "Database"
Question: "Which database should Archon use?"
Options:
  1. "PostgreSQL (Recommended)" — Shared database, supports server + CLI, production-ready
  2. "SQLite" — Local file at ~/.archon/archon.db, CLI-only, simpler setup
```

**If PostgreSQL selected**:
1. Ask (plain text): "Paste your PostgreSQL connection string (DATABASE_URL):"
2. Create the global config:
   ```bash
   mkdir -p ~/.archon
   echo "DATABASE_URL=<value>" >> ~/.archon/.env
   ```
3. If running the server, also create `.env` in the archon repo (or symlink):
   ```bash
   cp ~/.archon/.env <archon-repo>/.env
   # Or: ln -s ~/.archon/.env <archon-repo>/.env
   ```
4. Run the database migrations:
   ```bash
   cd <archon-repo>
   psql $DATABASE_URL < migrations/000_combined.sql
   ```

**If SQLite selected**:
- No additional setup needed — SQLite database is auto-created at `~/.archon/archon.db`
- Works for both CLI and server (single-developer usage)

### 5c: Verify database connection

```bash
archon version
```

Should show `Database: postgresql` or `Database: sqlite` based on selection.

**Troubleshooting**:
| Issue | Cause | Fix |
|-------|-------|-----|
| Shows `sqlite` but expected `postgresql` | `~/.archon/.env` missing or no DATABASE_URL | Create `~/.archon/.env` with DATABASE_URL |
| "relation does not exist" | Tables not created | Run `psql $DATABASE_URL < migrations/000_combined.sql` |
| Connection refused | Database not running or wrong URL | Check DATABASE_URL and database server status |

## Step 6: Run Platform-Specific Setup

Based on the platforms selected in Step 3, read and follow the corresponding guides:

| Selection | Guides to follow |
|-----------|-----------------|
| CLI only | Done — skip to Step 7 |
| CLI + GitHub | `guides/github.md` |
| Telegram | `guides/telegram.md` |
| Slack | `guides/slack.md` |
| Discord (Other) | `guides/discord.md` |

For multiple platforms, follow each platform guide. Each guide will tell the user which values to add to the `.env` created in Step 5.

## Step 7: Configure Target Repo (Guided setup only)

**Skip this step if "Quick setup" was selected in Step 1.** Defaults will be used automatically.

This step creates `.archon/config.yaml` in the target repo. Walk the user through each option using **AskUserQuestion**. Only include non-default values in the generated file.

### 7a: AI Assistant

```
Header: "AI assistant"
Question: "Which AI assistant should Archon use for this repo?"
Options:
  1. "Claude" (Recommended) — Anthropic's Claude Code SDK
  2. "Codex" — OpenAI's Codex SDK
```

Default: `claude`. Only write to config if user picks codex.

### 7b: Worktree Base Branch

```
Header: "Base branch"
Question: "What is the main branch for this repo? (Used as base for worktree creation)"
Options:
  1. "main" (Recommended) — Most common default
  2. "master" — Legacy default
  3. "develop" — Gitflow-style
```

Default: auto-detected from repo. Only write to config if user picks something non-standard.

### 7c: Worktree Copy Files

```
Header: "Worktree files"
Question: "Should Archon copy any files into new worktrees? (Git-ignored files like .env aren't included in worktrees by default)"
Options:
  1. "No extra files needed" (Recommended) — Skip this
  2. "Copy .env" — Copy .env file into worktrees
  3. "Copy .env.example as .env" — Copy .env.example and rename to .env
```

If user selects option 2 or 3, or provides a custom answer, add to `worktree.copyFiles` array. Option 3 uses the `"source -> destination"` syntax: `".env.example -> .env"`.

If user provides "Other", let them list files comma-separated. Each entry becomes an item in `copyFiles`.

### 7d: Default Commands & Workflows Loading

```
Header: "Defaults"
Question: "Archon bundles default commands and workflows. How should they be loaded?"
Options:
  1. "Load at runtime" (Recommended) — Defaults loaded automatically, your repo commands/workflows override by name
  2. "Disable defaults" — Only use commands and workflows defined in your repo's .archon/ folder
```

Default: load at runtime. Only write to config if user disables.

### 7e: Generate config.yaml

Based on the answers, generate `<target-repo>/.archon/config.yaml`. Only include options that differ from defaults. If all defaults were kept, create a minimal commented file.

**Template (all defaults — commented reference):**
```yaml
# Archon Repo Configuration
# All values below show defaults — uncomment to override.

# AI assistant for this repo (claude | codex)
# assistant: claude

# Worktree settings
# worktree:
#   baseBranch: main
#   copyFiles:
#     - ".env"
#     - ".env.example -> .env"

# Default commands/workflows
# defaults:
#   loadDefaultCommands: true
#   loadDefaultWorkflows: true
```

**Template (with user overrides — uncommented values):**
```yaml
# Archon Repo Configuration

assistant: codex

worktree:
  baseBranch: develop
  copyFiles:
    - ".env"

defaults:
  loadDefaultCommands: false
  loadDefaultWorkflows: false
```

Write the file:
```bash
mkdir -p <target-repo>/.archon
# Write config.yaml content
```

## Step 8: Copy Defaults to Target Repo

Copy the bundled default commands and workflows to the target repo so the user can read, inspect, and modify them:

```bash
mkdir -p <target-repo>/.archon/commands
mkdir -p <target-repo>/.archon/workflows
cp -r <archon-repo>/.archon/commands/defaults/* <target-repo>/.archon/commands/
cp -r <archon-repo>/.archon/workflows/defaults/* <target-repo>/.archon/workflows/
```

Tell the user:
- "Copied **{N} commands** and **{M} workflows** to your repo's `.archon/` folder."
- "You can read, modify, or delete any of these. Your repo versions take priority over bundled defaults."
- "Commands are in `.archon/commands/` — these are prompt templates for AI steps."
- "Workflows are in `.archon/workflows/` — these are YAML files defining multi-step AI pipelines."

Count the files copied to fill in {N} and {M}.

## Step 9: Start the Server (non-CLI platforms only)

**Skip if "CLI only" was selected.**

After all platform tokens are in `.env`, read and follow `guides/server.md` to start the server from the archon repo.

## Step 10: Verify from Target Repo

Run a test workflow from the target repo:

```bash
cd <target-repo> && archon workflow list
```

If the CLI is working, also run:

```bash
cd <target-repo> && archon workflow run archon-assist "Say hello"
```

### Troubleshooting

If verification fails:

| Error | Cause | Fix |
|-------|-------|-----|
| `archon: command not found` | CLI not linked | Re-run `cd <archon-repo>/packages/cli && bun link` |
| `Not a git repository` | Not in a git repo | `cd` to the target repo root |
| `No workflows found` | Missing `.archon/workflows/` | Default workflows load automatically — check `archon version` works first |
| Auth errors | Claude not authenticated | Run `claude /login` |
| `relation "remote_agent_*" does not exist` | DATABASE_URL missing or tables not created | Ensure `~/.archon/.env` has DATABASE_URL and run migrations |
| `Database: sqlite` but expected PostgreSQL | `~/.archon/.env` missing DATABASE_URL | Add DATABASE_URL to `~/.archon/.env` |

## Step 11: Copy Skill to Target Repo

Copy the archon skill so it's available when the user opens Claude Code in their target repo:

```bash
mkdir -p <target-repo>/.claude/skills
cp -r <archon-repo>/.claude/skills/archon <target-repo>/.claude/skills/archon
```

## Step 12: Final Summary

Tell the user what was set up, then give these instructions:

1. Open a new terminal
2. `cd <target-repo>`
3. Run `claude` to launch Claude Code
4. The archon skill is now loaded — ask Claude to run workflows, fix issues, review PRs, etc.

Example first command in the target repo:
```
"Use archon to fix issue #1"
```

Summarize what was copied to their repo:
- `.archon/commands/` — {N} command templates (editable prompts)
- `.archon/workflows/` — {M} workflow definitions (editable YAML pipelines)
- `.archon/config.yaml` — repo configuration (if guided setup was used)
- `.claude/skills/archon/` — skill for Claude Code integration

The end state: user is in their target repo with the Archon skill available, default commands and workflows copied locally for inspection and customization, using Claude Code as the interface.

## Configuration Reference

For advanced users — these are not needed for basic setup:

### Environment Files (`.env`)

Infrastructure config (database URL, platform tokens) is stored in `.env` files:

| Location | Used by | Purpose |
|----------|---------|---------|
| `~/.archon/.env` | **CLI** | Global infrastructure config — database, AI tokens |
| `<archon-repo>/.env` | **Server** | Platform tokens for Telegram/Slack/GitHub/Discord |

**Best practice**: Use `~/.archon/.env` as the single source of truth. Symlink or copy to `<archon-repo>/.env` if running the server.

**Note**: The CLI does NOT load `.env` from the current working directory. This prevents conflicts when running Archon from projects that have their own database configurations.

### Config Files (YAML)

Project-specific settings use layered YAML configs:

| Location | Scope | Purpose |
|----------|-------|---------|
| `~/.archon/config.yaml` | Global | Default AI assistant, streaming modes, concurrency |
| `<repo>/.archon/config.yaml` | Per-repo | AI assistant, worktree settings, commands config |

Environment variables in `.env` override matching `config.yaml` values.

### Repo Config Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `assistant` | `claude` \| `codex` | `claude` | AI assistant for this repo |
| `commands.folder` | string | `.archon/commands` | Custom command folder path (relative to repo root) |
| `commands.autoLoad` | boolean | `true` | Auto-load commands on clone |
| `worktree.baseBranch` | string | auto-detected | Base branch for worktree creation |
| `worktree.copyFiles` | string[] | `[]` | Files to copy into new worktrees (supports `"source -> dest"` syntax) |
| `defaults.loadDefaultCommands` | boolean | `true` | Load bundled default commands at runtime |
| `defaults.loadDefaultWorkflows` | boolean | `true` | Load bundled default workflows at runtime |
