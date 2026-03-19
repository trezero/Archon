# Archon

Make AI coding deterministic and repeatable.

Archon is a workflow engine for AI coding agents. Define your development processes as YAML workflows — planning, implementation, validation, code review, PR creation — and run them reliably across all your projects.

Think n8n, but for software development.

## Why Archon?

When you ask an AI agent to "fix this bug", what happens depends on the model's mood. It might skip planning. It might forget to run tests. It might write a PR description that ignores your template. Every run is different.

Archon fixes this. Encode your development process as a workflow. The workflow defines the phases, validation gates, and artifacts. The AI fills in the intelligence at each step, but the structure is deterministic and owned by you.

- **Repeatable** — Same workflow, same sequence, every time. Plan, implement, validate, review, PR.
- **Isolated** — Every workflow run gets its own git worktree. Run 5 fixes in parallel with no conflicts.
- **Fire and forget** — Kick off a workflow, go do other work. Come back to a finished PR with review comments.
- **Composable** — Mix deterministic nodes (bash scripts, tests, git ops) with AI nodes (planning, code generation, review). The AI only runs where it adds value.
- **Portable** — Define workflows once in `.archon/workflows/`, commit them to your repo. They work the same from CLI, Web UI, Slack, Telegram, or GitHub.

## What It Looks Like

```yaml
# .archon/workflows/idea-to-pr.yaml
name: idea-to-pr
description: Take a feature idea from plan to merged PR

steps:
  - command: create-plan
  - command: implement-tasks
    clearContext: true
  - command: validate
  - command: create-pr
    clearContext: true
  - parallel:
      - command: review-security
      - command: review-tests
      - command: review-types
  - command: self-fix
```

```bash
archon workflow run idea-to-pr --branch feat/dark-mode "Add dark mode to settings"
# → Creates isolated worktree
# → Runs: plan → implement → validate → create PR → parallel reviews → self-fix
# → Result: PR ready for human review
```

## Quickstart

### AI-Assisted Setup (recommended, 2 min)

```bash
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install
claude
```

Then say: **"Set up Archon"**

The setup skill walks you through everything: CLI installation, authentication, platform selection, and copies the Archon skill to your target repo. When done, open Claude Code in your project and start using it.

### Manual CLI Setup (5 min)

<details>
<summary>Expand for manual steps</summary>

**Prerequisites:** [Git](https://git-scm.com/), [Bun](https://bun.sh), [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/installation)

```bash
# Clone and install
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install

# Install CLI globally
cd packages/cli && bun link && cd ../..

# Authenticate with Claude
claude /login

# Go to any git repo and run
cd /path/to/your/project
archon workflow list
archon workflow run assist "What does this codebase do?"
```

See the [CLI User Guide](docs/cli-user-guide.md) for full documentation.

</details>

### Web UI Setup (5 min)

<details>
<summary>Expand for Web UI steps</summary>

```bash
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install

# Configure
cp .env.example .env
# Edit .env: set GH_TOKEN, GITHUB_TOKEN, CLAUDE_USE_GLOBAL_AUTH=true

# Start server + Web UI
bun run dev
# Open http://localhost:5173
```

See the [Web UI Guide](docs/adapters/web.md) for features and configuration.

</details>

## What Can You Automate?

Archon ships with workflows for common development tasks:

| Workflow | What it does |
|----------|-------------|
| `idea-to-pr` | Feature description → plan → implement → validate → PR → 5 parallel review agents → self-fix |
| `fix-github-issue` | Fetch issue → classify (bug/feature) → investigate → implement → validate → PR → close issue |
| `smart-pr-review` | Classify PR complexity → run targeted review agents → synthesize → post structured comment |
| `ralph` | Read PRD with multiple stories → implement one by one → reset context each iteration → loop until done |
| `resolve-conflicts` | Detect merge conflicts → analyze both sides → resolve → validate → commit |
| `assist` | Simple Q&A — no workflow overhead, just talk to the AI about your code |

**Or define your own.** Workflows are YAML files in `.archon/workflows/`. Commands are markdown files in `.archon/commands/`. Commit them to your repo — your whole team runs the same process.

See [Authoring Workflows](docs/authoring-workflows.md) and [Authoring Commands](docs/authoring-commands.md).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Platform Adapters (Web UI, CLI, Telegram, Slack,       │
│                    Discord, GitHub)                      │
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
│              SQLite / PostgreSQL (7 Tables)             │
│   Codebases • Conversations • Sessions • Workflow Runs  │
│    Isolation Environments • Messages • Workflow Events  │
└─────────────────────────────────────────────────────────┘
```

## Add a Platform

The Web UI and CLI work out of the box. Optionally connect a chat platform for remote access:

| Platform | Setup time | Guide |
|----------|-----------|-------|
| **Telegram** | 5 min | [docs/adapters/telegram.md](docs/adapters/telegram.md) |
| **Slack** | 15 min | [docs/slack-setup.md](docs/slack-setup.md) |
| **GitHub Webhooks** | 15 min | [docs/adapters/github.md](docs/adapters/github.md) |
| **Discord** | 5 min | [docs/adapters/discord.md](docs/adapters/discord.md) |

## Documentation

| Topic | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | CLI-focused setup guide |
| [CLI User Guide](docs/cli-user-guide.md) | Full CLI reference |
| [Authoring Workflows](docs/authoring-workflows.md) | Create custom YAML workflows |
| [Authoring Commands](docs/authoring-commands.md) | Create reusable AI commands |
| [Configuration](docs/configuration.md) | All config options, env vars, YAML settings |
| [AI Assistants](docs/ai-assistants.md) | Claude and Codex setup details |
| [Database](docs/database.md) | SQLite, PostgreSQL, schema reference |
| [Deployment](docs/deployment.md) | Docker, VPS, production setup |
| [Commands Reference](docs/commands-reference.md) | All slash commands |
| [Architecture](docs/architecture.md) | System design and internals |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |
| [Windows Setup](docs/windows.md) | Windows and WSL2 guide |

## Contributing

Contributions welcome. See the open [issues](https://github.com/dynamous-community/remote-coding-agent/issues) for things to work on.

## License

MIT
