# Getting Started

A practical guide to getting the Archon CLI installed and running against your own repository.

## Setup

**Step 1: Clone and install**

```bash
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install
```

**Step 2: Install the CLI globally**

```bash
cd packages/cli && bun link && cd ../..
```

This registers the `archon` command globally so you can run it from any repository.

**Step 3: Authenticate with Claude**

If you already use Claude Code on your system, this is probably already done.

```bash
claude /login
```

The CLI uses your existing Claude authentication by default — no API keys or `.env` file needed.

**Step 4: Run workflows from your repository**

```bash
cd /path/to/your/repository

# See available workflows
archon workflow list

# Ask a question about the codebase
archon workflow run archon-assist "How does the auth module work?"

# Plan a feature on an isolated branch
archon workflow run archon-feature-development --branch feat/dark-mode "Add dark mode"

# Fix a GitHub issue
archon workflow run archon-fix-github-issue --branch fix/issue-42 "Fix issue #42"
```

That's it. The CLI auto-detects the git repo, uses SQLite for state tracking (`~/.archon/archon.db`), and streams output to stdout.

---

## CLI Reference

### Workflows

```bash
# List all available workflows
archon workflow list

# Run a workflow
archon workflow run <name> "<message>"

# Run with worktree isolation (recommended for code changes)
archon workflow run <name> --branch <branch-name> "<message>"

# Run on branch directly without worktree
archon workflow run <name> --branch <branch-name> --no-worktree "<message>"

# Run against a different directory
archon workflow run <name> --cwd /path/to/repo "<message>"
```

### Worktree Management

```bash
archon isolation list              # show active worktrees
archon isolation cleanup           # remove stale (>7 days)
archon isolation cleanup 14        # custom staleness threshold
archon isolation cleanup --merged  # remove merged branches (deletes remote too)
archon complete <branch>           # complete branch lifecycle (worktree + branches)
archon complete <branch> --force   # skip uncommitted-changes check
```

### Available Workflows

| Workflow | What It Does |
|----------|-------------|
| `archon-assist` | General questions, debugging, exploration |
| `archon-fix-github-issue` | Investigate → plan → fix → PR for a GitHub issue |
| `archon-idea-to-pr` | From idea to plan to implementation to PR |
| `archon-plan-to-pr` | Execute an existing plan through to PR |
| `archon-feature-development` | Implement a feature from a plan |
| `archon-comprehensive-pr-review` | Multi-agent PR review |
| `archon-resolve-conflicts` | Resolve merge conflicts |
| `archon-ralph-fresh` | Iterate through PRD stories (stateless) |
| `archon-ralph-stateful` | Iterate through PRD stories (with memory) |
| `archon-test-loop` | Run tests in a loop until passing |

---

## Optional: Customize Your Target Repo

Add an `.archon/` directory to your target repo for repo-specific behavior:

```
your-repo/
└── .archon/
    ├── config.yaml         # AI assistant, worktree copy rules
    ├── commands/            # Custom commands (.md files)
    └── workflows/           # Custom multi-step workflows (.yaml files)
```

**Example `.archon/config.yaml`:**

```yaml
assistant: claude
commands:
  folder: .claude/commands/archon    # additional command search path
worktree:
  copyFiles:
    - .env.example -> .env           # copy + rename into worktrees
    - .env
```

Without any `.archon/` config, the platform uses sensible defaults (bundled commands and workflows).

### Custom Commands

Place `.md` files in your repo's `.archon/commands/`:

```markdown
---
description: Run the full test suite
argument-hint: <module>
---

# Test Runner

Run tests for: $ARGUMENTS
```

Variables available: `$1`, `$2`, `$3` (positional), `$ARGUMENTS` (all args), `$PLAN` (previous plan output), `$CONTEXT` (GitHub issue/PR context).

### Custom Workflows

Place `.yaml` files in your repo's `.archon/workflows/`:

```yaml
name: my-workflow
description: Plan then implement a feature
model: sonnet

steps:
  - command: plan
  - command: implement
    args: |
      --goal "$ARGUMENTS"
      --plan "$PLAN"
```

Workflows chain multiple commands together, support parallel steps, and carry context between steps via variable substitution.

> **Where are commands and workflows loaded from?**
>
> Commands and workflows are loaded at runtime from the current working directory — not from a fixed global location.
>
> - **CLI:** Reads from wherever you run the `archon` command. If you run from your local repo, it picks up uncommitted changes immediately.
> - **Server (Telegram/Slack/GitHub):** Reads from the workspace clone at `~/.archon/workspaces/owner/repo/`. This clone only syncs from the remote before worktree creation, so you need to **commit and push** changes for the server to see them.
>
> In short: the CLI sees your local files, the server sees what's been pushed.

---

## Isolation (Worktrees)

When you use the `--branch` flag, the CLI creates a git worktree so your work happens in an isolated directory under `~/.archon/worktrees/`. This prevents parallel tasks from conflicting with each other or your main branch.

```
~/.archon/
├── archon.db              # SQLite database (auto-created)
├── workspaces/            # Cloned repos (synced from origin)
│   └── owner/repo/
└── worktrees/             # Isolated working copies per task
    └── repo-name/
        ├── fix/issue-42/
        └── feat/dark-mode/
```

---

## Using With Claude Code (Skill)

If you want Claude Code to be able to invoke Archon workflows on your behalf, copy the Archon skill into your Claude configuration:

```bash
cp -r remote-coding-agent/.claude/skills/archon /path/to/your/repo/.claude/skills/
```

Then in Claude Code, say things like "use archon to fix issue #42" and it will invoke the appropriate workflow.

---

## Running the Full Platform (Server + Chat Adapters)

The CLI is standalone, but if you also want to interact via Telegram, Slack, Discord, or GitHub webhooks, see the [README Server Setup](../README.md#server-quick-start) or run the setup wizard by opening Claude Code in the Archon repo and saying "set up archon".
