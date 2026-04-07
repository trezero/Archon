# Archon

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/coleam00/Archon/actions/workflows/test.yml/badge.svg)](https://github.com/coleam00/Archon/actions/workflows/test.yml)
[![Docs](https://img.shields.io/badge/docs-archon.diy-blue)](https://archon.diy)

The first open-source harness builder for AI coding. Make AI coding deterministic and repeatable.

Archon is a workflow engine for AI coding agents. Define your development processes as YAML workflows — planning, implementation, validation, code review, PR creation — and run them reliably across all your projects.

Like what Dockerfiles did for infrastructure and GitHub Actions did for CI/CD — Archon does for AI coding workflows. Think n8n, but for software development.

## Install

**macOS / Linux**
```bash
curl -fsSL https://archon.diy/install | bash
```

**Windows (PowerShell)**
```powershell
irm https://archon.diy/install.ps1 | iex
```

**Homebrew**
```bash
brew install coleam00/archon/archon
```

**Docker**
```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/coleam00/archon:latest workflow list
```

See the [Installation Guide](https://archon.diy/getting-started/installation/) for all options.

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

nodes:
  - id: plan
    command: create-plan
  - id: implement
    command: implement-tasks
    context: fresh
    depends_on: [plan]
  - id: validate
    command: validate
    depends_on: [implement]
  - id: create-pr
    command: create-pr
    context: fresh
    depends_on: [validate]
  - id: review-security
    command: review-security
    depends_on: [create-pr]
  - id: review-tests
    command: review-tests
    depends_on: [create-pr]
  - id: review-types
    command: review-types
    depends_on: [create-pr]
  - id: self-fix
    command: self-fix
    depends_on: [review-security, review-tests, review-types]
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

**agent-browser** *(optional)* — [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)

Only needed for E2E/UI testing workflows (`archon-validate-pr`). Core functionality works without it.

```bash
npm install -g agent-browser
agent-browser install
```

See the [E2E Testing Guide](https://archon.diy/deployment/e2e-testing/) for platform-specific setup.

</details>

### Setup (2 min)

```bash
git clone https://github.com/coleam00/Archon
cd Archon
bun install
claude
```

Then say: **"Set up Archon"**

The setup wizard walks you through everything: CLI installation, authentication, platform selection, and copies the Archon skill to your target repo.

### Start Using Archon

Once setup is complete:

```bash
# 1. Exit Claude Code in the Archon repo (Ctrl+C or /exit)

# 2. Go to your project
cd /path/to/your/project

# 3. Open Claude Code from your project
claude
```

Then start working:

```
Use archon to fix issue #42
```

```
What archon workflows do I have? When would I use each one?
```

The coding agent handles workflow selection, branch naming, and worktree isolation for you. Projects are registered automatically the first time they're used.

> **Important:** Always run Claude Code from your target repo, not from the Archon repo. The setup wizard copies the Archon skill into your project so it works from there.

### Alternative setup paths

- **[Getting Started](https://archon.diy/getting-started/overview/)** — Full setup guide (Web UI or CLI)

## Web UI

Archon includes a web dashboard for chatting with your coding agent, running workflows, and monitoring activity. To start it, ask your coding agent to run the frontend from the Archon repo, or run `bun run dev` from the repo root yourself.

Register a project by clicking **+** next to "Project" in the chat sidebar — enter a GitHub URL or local path. Then start a conversation, invoke workflows, and watch progress in real time.

**Key pages:**
- **Chat** — Conversation interface with real-time streaming and tool call visualization
- **Dashboard** — Mission Control for monitoring running workflows, with filterable history by project, status, and date
- **Workflow Builder** — Visual drag-and-drop editor for creating DAG workflows with loop nodes
- **Workflow Execution** — Step-by-step progress view for any running or completed workflow

**Monitoring hub:** The sidebar shows conversations from **all platforms** — not just the web. Workflows kicked off from the CLI, messages from Slack or Telegram, GitHub issue interactions — everything appears in one place.

See the [Web UI Guide](https://archon.diy/adapters/web/) for full documentation.

## What Can You Automate?

Archon ships with workflows for common development tasks:

| Workflow | What it does |
|----------|-------------|
| `archon-assist` | General Q&A, debugging, exploration — full Claude Code agent with all tools |
| `archon-fix-github-issue` | Classify issue → investigate/plan → implement → validate → PR → smart review → self-fix |
| `archon-idea-to-pr` | Feature idea → plan → implement → validate → PR → 5 parallel reviews → self-fix |
| `archon-plan-to-pr` | Execute existing plan → implement → validate → PR → review → self-fix |
| `archon-issue-review-full` | Comprehensive fix + full multi-agent review pipeline for GitHub issues |
| `archon-smart-pr-review` | Classify PR complexity → run targeted review agents → synthesize findings |
| `archon-comprehensive-pr-review` | Multi-agent PR review (5 parallel reviewers) with automatic fixes |
| `archon-create-issue` | Classify problem → gather context → investigate → create GitHub issue |
| `archon-validate-pr` | Thorough PR validation testing both main and feature branches |
| `archon-resolve-conflicts` | Detect merge conflicts → analyze both sides → resolve → validate → commit |
| `archon-feature-development` | Implement feature from plan → validate → create PR |
| `archon-architect` | Architectural sweep, complexity reduction, codebase health improvement |
| `archon-refactor-safely` | Safe refactoring with type-check hooks and behavior verification |
| `archon-ralph-dag` | PRD implementation loop — iterate through stories until done |
| `archon-remotion-generate` | Generate or modify Remotion video compositions with AI |
| `archon-test-loop-dag` | Loop node test workflow — iterative counter until completion |
| `archon-piv-loop` | Guided Plan-Implement-Validate loop with human review between iterations |

Archon ships 17 default workflows — run `archon workflow list` or describe what you want and the router picks the right one.

**Or define your own.** Default workflows are great starting points — copy one from `.archon/workflows/defaults/` and customize it. Workflows are YAML files in `.archon/workflows/`, commands are markdown files in `.archon/commands/`. Same-named files in your repo override the bundled defaults. Commit them — your whole team runs the same process.

See [Authoring Workflows](https://archon.diy/guides/authoring-workflows/) and [Authoring Commands](https://archon.diy/guides/authoring-commands/).

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
| **Telegram** | 5 min | [Telegram Guide](https://archon.diy/adapters/telegram/) |
| **Slack** | 15 min | [Slack Guide](https://archon.diy/adapters/slack/) |
| **GitHub Webhooks** | 15 min | [GitHub Guide](https://archon.diy/adapters/github/) |
| **Discord** | 5 min | [Discord Guide](https://archon.diy/adapters/community/discord/) |

## Documentation

Full documentation is available at **[archon.diy](https://archon.diy)**.

| Topic | Description |
|-------|-------------|
| [Getting Started](https://archon.diy/getting-started/overview/) | Setup guide (Web UI or CLI) |
| [The Book of Archon](https://archon.diy/book/) | 10-chapter narrative tutorial |
| [CLI Reference](https://archon.diy/reference/cli/) | Full CLI reference |
| [Authoring Workflows](https://archon.diy/guides/authoring-workflows/) | Create custom YAML workflows |
| [Authoring Commands](https://archon.diy/guides/authoring-commands/) | Create reusable AI commands |
| [Configuration](https://archon.diy/reference/configuration/) | All config options, env vars, YAML settings |
| [AI Assistants](https://archon.diy/getting-started/ai-assistants/) | Claude and Codex setup details |
| [Deployment](https://archon.diy/deployment/) | Docker, VPS, production setup |
| [Architecture](https://archon.diy/reference/architecture/) | System design and internals |
| [Troubleshooting](https://archon.diy/reference/troubleshooting/) | Common issues and fixes |

## Contributing

Contributions welcome! See the open [issues](https://github.com/coleam00/Archon/issues) for things to work on.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## License

[MIT](LICENSE)
