# Commands Reference

All slash commands available in Archon. Type `/help` in any platform adapter (Web UI, Telegram, Slack, Discord, GitHub) to see this list.

---

## Codebase Commands (Per-Project)

| Command | Description |
|---------|-------------|
| `/command-set <name> <path> [text]` | Register a command from file |
| `/load-commands <folder>` | Bulk load commands (recursive) |
| `/commands` | List registered commands |

> **Note:** Commands use relative paths (e.g., `.archon/commands/plan.md`)

## Codebase Management

| Command | Description |
|---------|-------------|
| `/clone <repo-url>` | Clone repository |
| `/repos` | List repositories (numbered) |
| `/repo <#\|name> [pull]` | Switch repo (auto-loads commands) |
| `/repo-remove <#\|name>` | Remove repo and codebase record |
| `/getcwd` | Show working directory |
| `/setcwd <path>` | Set working directory |

> **Tip:** Use `/repo` for quick switching between cloned repos, `/setcwd` for manual paths.

## Worktrees (Isolation)

| Command | Description |
|---------|-------------|
| `/worktree create <branch>` | Create isolated worktree |
| `/worktree list` | Show worktrees for this repo |
| `/worktree remove [--force]` | Remove current worktree |
| `/worktree cleanup merged\|stale` | Clean up worktrees |
| `/worktree orphans` | Show all worktrees from git |

## Workflows

| Command | Description |
|---------|-------------|
| `/workflow list` | Show available workflows |
| `/workflow reload` | Reload workflow definitions |
| `/workflow status` | Show active workflows |
| `/workflow cancel` | Cancel running workflow |
| `/workflow resume <id>` | Resume a failed run (re-runs, skipping completed nodes) |
| `/workflow abandon <id>` | Discard a non-terminal run |
| `/workflow cleanup [days]` | CLI only — delete old run records (default: 7 days) |

> **Note:** Workflows are YAML files in `.archon/workflows/`

## Session Management

| Command | Description |
|---------|-------------|
| `/status` | Show conversation state |
| `/reset` | Clear session completely |
| `/reset-context` | Reset AI context, keep worktree |
| `/help` | Show all commands |

## Setup

| Command | Description |
|---------|-------------|
| `/init` | Create `.archon` structure in current repo |

---

## Example Workflow (Telegram)

### Clone a Repository

```
You: /clone https://github.com/user/my-project

Bot: Repository cloned successfully!

     Repository: my-project
     ✓ App defaults available at runtime

     Session reset - starting fresh on next message.

     You can now start asking questions about the code.
```

> **Note:** Default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. To disable defaults, set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` in the repo's `.archon/config.yaml`.

### Ask Questions Directly

```
You: What's the structure of this repo?

Bot: [Claude analyzes and responds...]
```

### Create Custom Commands (Optional)

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

### Check Status

```
You: /status

Bot: Platform: telegram
     AI Assistant: claude

     Codebase: my-project
     Repository: https://github.com/user/my-project

     Repository: my-project @ main

     Worktrees: 0/10
```

### Work in Isolation with Worktrees

```
You: /worktree create feature-auth

Bot: Worktree created!

     Branch: feature-auth
     Path: feature-auth/

     This conversation now works in isolation.
     Run dependency install if needed (e.g., bun install).
```

### Reset Session

```
You: /reset

Bot: Session cleared. Starting fresh on next message.

     Codebase configuration preserved.
```

---

## Example Workflow (GitHub)

Create an issue or comment on an existing issue/PR:

```
@your-bot-name can you help me understand the authentication flow?
```

Bot responds with analysis. Continue the conversation:

```
@your-bot-name can you create a sequence diagram for this?
```

Bot maintains context and provides the diagram.
