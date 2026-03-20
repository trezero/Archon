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
# .archon/workflows/archon-idea-to-pr.yaml
name: archon-idea-to-pr
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
archon workflow run archon-idea-to-pr --branch feat/dark-mode "Add dark mode to settings"
# → Creates isolated worktree
# → Runs: plan → implement → validate → create PR → parallel reviews → self-fix
# → Result: PR ready for human review
```

## Quickstart

<details>
<summary><b>Prerequisites</b> — Node.js, Claude Code, and the GitHub CLI</summary>

**Node.js** (v18+) — [nodejs.org](https://nodejs.org/)

```bash
# macOS/Linux (via nvm, recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install --lts

# Windows (via winget)
winget install OpenJS.NodeJS.LTS
```

**GitHub CLI** — [cli.github.com](https://cli.github.com/)

```bash
# macOS
brew install gh

# Windows (via winget)
winget install GitHub.cli

# Linux (Debian/Ubuntu)
sudo apt install gh
```

**Claude Code** — [code.claude.com](https://code.claude.com/docs/en/getting-started)

```bash
# macOS/Linux/WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

</details>

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
archon workflow run archon-assist "What does this codebase do?"
```

See the [CLI User Guide](docs/cli-user-guide.md) for full documentation.

</details>

## Using Archon on Your Project

Once installed, there are two ways to use Archon on your codebases:

**Option A: From the Archon repo** — Open Claude Code in the Archon repo and tell it what to do. The skill can target any project on your machine:

```
Use archon to fix issue #42 on /path/to/my-project
```

**Option B: From your own repo (recommended)** — Copy the Archon skill so you can use it directly:

```bash
cp -r <archon-repo>/.claude/skills/archon /path/to/your-repo/.claude/skills/archon
```

Then open Claude Code in your project and start working:

```
Use archon to implement a dark mode feature
```

```
What archon workflows do I have? When would I use each one?
```

The coding agent handles workflow selection, branch naming, and worktree isolation for you. Projects are registered automatically the first time they're used — no manual setup needed.

## Web UI

Archon includes a web dashboard for chatting with your coding agent, running workflows, and monitoring activity. To start it, ask your coding agent to run the frontend from the Archon repo, or run `bun run dev` from the repo root yourself.

Register a project by clicking **+** next to "Project" in the chat sidebar — enter a GitHub URL or local path. Then start a conversation, invoke workflows, and watch progress in real time.

**Key pages:**
- **Chat** — Conversation interface with real-time streaming and tool call visualization
- **Dashboard** — Mission Control for monitoring running workflows, with filterable history by project, status, and date
- **Workflow Builder** — Visual drag-and-drop editor for creating DAG, sequential, and loop workflows
- **Workflow Execution** — Step-by-step progress view for any running or completed workflow

**Monitoring hub:** The sidebar shows conversations from **all platforms** — not just the web. Workflows kicked off from the CLI, messages from Slack or Telegram, GitHub issue interactions — everything appears in one place.

See the [Web UI Guide](docs/adapters/web.md) for full documentation.

## What Can You Automate?

Archon ships with workflows for common development tasks:

| Workflow | What it does |
|----------|-------------|
| `archon-idea-to-pr` | Feature description → plan → implement → validate → PR → 5 parallel review agents → self-fix |
| `archon-fix-github-issue` | Fetch issue → classify (bug/feature) → investigate → implement → validate → PR → close issue |
| `archon-smart-pr-review` | Classify PR complexity → run targeted review agents → synthesize → post structured comment |
| `archon-ralph-fresh` | Read PRD with multiple stories → implement one by one → fresh context each iteration → loop until done |
| `archon-ralph-stateful` | Same as above but preserves context across iterations for interdependent stories |
| `archon-resolve-conflicts` | Detect merge conflicts → analyze both sides → resolve → validate → commit |
| `archon-assist` | Simple Q&A — no workflow overhead, just talk to the AI about your code |

Archon ships 16 workflows total — run `archon workflow list` or ask your agent to see them all.

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
| **Slack** | 15 min | [docs/adapters/slack.md](docs/adapters/slack.md) |
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
