---
title: Quick Start
description: Run your first Archon workflow in minutes.
---

## Prerequisites

1. [Install Archon](/getting-started/installation/)
2. Set your Anthropic API key: `export ANTHROPIC_API_KEY=sk-ant-...`
3. Navigate to any git repository

## Run Your First Workflow

```bash
# List available workflows
archon workflow list

# Ask Archon to assist with your codebase
archon workflow run assist "What does this codebase do?"

# Run a code review
archon workflow run smart-review
```

## Key Concepts

### Workflows

Workflows are YAML files that define multi-step AI coding tasks. Each workflow has **nodes** that execute in order (or as a DAG with dependencies).

### Isolation

By default, workflows run in **git worktrees** — isolated copies of your repo. This means:
- Your working branch stays clean
- Multiple workflows can run in parallel
- Failed workflows don't leave a mess

### Commands

Commands are reusable prompt files (`.md` or `.txt`) that workflows reference. They define what the AI should do at each step.

## What's Next?

- [Configuration](/getting-started/configuration/) — Customize Archon for your project
- [GitHub Repository](https://github.com/coleam00/Archon) — Source code, issues, and discussions
