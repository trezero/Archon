---
name: rulecheck
description: |
  Autonomous rule adherence checker. Scans the codebase for rule violations,
  fixes the highest-impact ones in an isolated worktree, runs full validation,
  creates a PR, and notifies Slack. Uses memory to track progress across runs.
disable-model-invocation: true
agent: rulecheck-agent
argument-hint: "[focus area]"
---

# Rulecheck

Launch the rulecheck-agent to autonomously scan and fix CLAUDE.md rule violations.

## Your Job (Main Agent)

You are the orchestrator. Your ONLY job is to launch the rulecheck-agent and
report its results when it completes. You do NOT do the scanning or fixing yourself.

1. **Launch the rulecheck-agent** with the focus area (if any): `$ARGUMENTS`
2. **Wait for it to complete** — do NOT poll, tail, or check on it. You will be
   notified automatically when it finishes.
3. **Report the results** — summarize what was fixed, link the PR, mention any
   remaining opportunities.

## Rules for You

- **Do NOT scan the codebase yourself** — that's the agent's job
- **Do NOT grep, read source files, or run linters** — the agent handles all of that
- **Do NOT try to resume or check on the agent** while it's running — just wait
- **Do NOT do the agent's work** if it fails — report the failure to the user
- Trust the agent. It runs in an isolated worktree and will create a PR when done.
