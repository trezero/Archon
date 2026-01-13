# Why We're Building the Core Package + CLI Architecture

## The Core Problem

Archon's purpose is simple: **run AI agents from anywhere, in isolation, in parallel, with zero cognitive load on managing that isolation**.

Right now, everything requires the Express server. If you're working in a local Claude Code session and want to trigger the same `fix-github-issue` workflow that GitHub webhooks use, you have two bad options:
1. Make HTTP requests to the running server (coupling, latency, server must be running)
2. Duplicate the workflow logic in a Claude Code skill (maintenance nightmare)

## Why CLI, Not MCP

We explicitly don't want an MCP server. MCP gives the AI control over *when* to invoke tools - we want the opposite. We want **deterministic control** over when workers spawn. The CLI is a primitive that:
- Humans can invoke directly
- Scripts can invoke
- Claude Code skills can wrap with simple instructions
- The Express server can also use internally

## The Architecture Vision

```
┌─────────────────────────────────────────────────────────────────┐
│                     Entry Points                                 │
├─────────────────┬─────────────────┬─────────────────────────────┤
│  GitHub Webhook │   Terminal CLI  │  Claude Code Skill          │
│  (Express)      │   $ archon ...  │  (wraps CLI)                │
└────────┬────────┴────────┬────────┴────────┬────────────────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           ▼
              ┌────────────────────────┐
              │     @archon/core       │  ← Single source of truth
              │  Orchestrator          │
              │  Workflow Engine       │
              │  Isolation (Worktrees) │
              │  AI Clients            │
              └────────────────────────┘
```

## Why This Matters

1. **Same logic everywhere**: Whether triggered by GitHub webhook or terminal command, the exact same `executeWorkflow()` runs. No drift, no duplication.

2. **Claude Code integration becomes trivial**: Once the CLI exists, a skill is just:
   ```markdown
   To run a workflow, use the archon CLI:
   $ archon workflow run fix-github-issue --input "$ARGUMENTS"
   ```
   That's it. No SDK integration, no complex skill logic.

3. **Background agents without a daemon**: `archon workflow run --background` spawns a subprocess. No persistent daemon needed - shell handles it. Status comes from the database (`workflow_runs` table already tracks this).

4. **GitHub adapter unchanged**: Webhooks still flow through Express → the adapter just calls the same core modules the CLI uses.

## What We're NOT Building

- **No daemon**: Background execution via subprocess fork is sufficient
- **No MCP server**: CLI is the integration point, not tool-use
- **No interactive REPL**: Command-based, not conversational
- **No web UI**: CLI only for now

## The Outcome

After this refactor:
- `archon workflow run fix-github-issue` works from any terminal
- `archon status` shows running workflows across all entry points
- `archon worktree list/cleanup` manages isolation
- GitHub webhooks continue working exactly as before
- Future Claude Code skill = instructions for using the CLI

This keeps the architecture simple while solving the "run from anywhere" problem.
