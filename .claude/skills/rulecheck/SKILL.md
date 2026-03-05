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

# Rulecheck — Autonomous Rule Adherence Checker

Scan the codebase for rule violations, fix the top items, and create a PR.

## Current Context

- **Branch**: !`git branch --show-current`
- **Recent changes**: !`git log --oneline -10`

---

## Focus Area

**$ARGUMENTS**

If a focus area is specified (e.g., "error handling", "logging", "fail fast",
"imports", "DRY"), prioritize violations in that category. Otherwise, scan all
categories and pick the highest-impact items.

## Rules Reference

Load [rules-guide.md](rules-guide.md) for a categorized guide on where to find
project rules and how violations are ranked by impact.

## Instructions

1. **Read your memory** — check for previous runs, backlog, meta-judge feedback
2. **Read CLAUDE.md** — learn the engineering rules (not lint rules — those are automated)
3. **Deep scan source code** — grep and read actual `.ts` files in `packages/*/src/`
4. **Group related violations** — cluster by type (e.g., "all swallowed errors")
5. **Pick one group** — fix a cohesive set, not scattered unrelated things
6. **Fix the group** — minimal, focused edits in the worktree
7. **Validate after changes** — `bun run validate` (only after editing, not before)
8. **Create PR** — read `.github/pull_request_template.md`, fill it in
9. **Write summary** — `.claude/archon/rulecheck-last-run.json` for Slack hook
10. **Update memory** — record what was fixed, what remains, patterns noticed
