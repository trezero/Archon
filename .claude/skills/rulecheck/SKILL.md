---
name: rulecheck
description: |
  Autonomous rule adherence checker. Scans the codebase for rule violations,
  fixes the highest-impact ones in an isolated worktree, runs full validation,
  creates a PR, and notifies Slack. Uses memory to track progress across runs.
disable-model-invocation: true
context: fork
agent: rulecheck-agent
argument-hint: "[focus area]"
---

# Rulecheck — Autonomous Rule Adherence Checker

Scan the codebase for rule violations, fix the top items, and create a PR.

## Current Context

- **Branch**: !`git branch --show-current`
- **Recent changes**: !`git log --oneline -10`
- **Lint status**: !`bun run lint 2>&1 | tail -5`

---

## Focus Area

**$ARGUMENTS**

If a focus area is specified (e.g., "error handling", "imports", "type safety"),
prioritize violations in that category. Otherwise, scan all categories and pick
the highest-impact items.

## Rules Reference

Load [rules-guide.md](rules-guide.md) for a categorized guide on where to find
project rules and how violations are ranked by impact.

## Instructions

1. **Read your memory** — check for previous runs, backlog, meta-judge feedback
2. **Scan rules** — read CLAUDE.md, eslint config, tsconfig for current rules
3. **Find violations** — use Grep/Glob across `packages/` to locate issues
4. **Rank by impact** — severity, occurrences, blast radius
5. **Fix top 3-5** — minimal, focused edits in the worktree
6. **Validate** — `bun run validate` must pass (type-check + lint + format + tests)
7. **Write summary** — `.claude/archon/rulecheck-last-run.json` for Slack hook
8. **Create PR** — follow `.github/pull_request_template.md`
9. **Update memory** — record what was fixed, what remains, patterns noticed
