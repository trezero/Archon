---
name: archon-dev
description: |
  Development workflow skill. Routes to specialized cookbooks for research,
  planning, implementation, review, debugging, commits, and PRs.
  Use when: developing features, writing PRDs, planning implementations,
  reviewing code, debugging issues, making commits, or creating pull requests.
  Triggers: "research", "investigate", "prd", "plan", "implement", "execute",
            "review", "debug", "root cause", "commit", "pr", "pull request".
  NOT for: Running Archon CLI workflows (use /archon instead).
argument-hint: "[cookbook] [task description or issue number]"
---

# archon-dev

Development workflow — research, plan, build, review, ship.

## Current State

- **Branch**: !`git branch --show-current 2>/dev/null || echo "not in git repo"`
- **Artifacts**: !`ls .claude/archon/ 2>/dev/null || echo "none yet"`
- **Active plans**: !`ls .claude/archon/plans/*.plan.md 2>/dev/null | head -5 || echo "none"`

---

## Routing

**Read `$ARGUMENTS` and determine which cookbook to load.**

If the user explicitly names a cookbook (e.g., "plan", "implement"), use that.
Otherwise, match intent from keywords:

| Intent | Keywords | Cookbook |
|--------|----------|---------|
| Explore codebase, answer questions | "research", "investigate", "explore", "how does", "what is", "trace" | [cookbooks/research.md](cookbooks/research.md) |
| Write product requirements | "prd", "requirements", "spec", "product requirement" | [cookbooks/prd.md](cookbooks/prd.md) |
| Create implementation plan | "plan", "design", "architect", "write a plan" | [cookbooks/plan.md](cookbooks/plan.md) |
| Execute an existing plan | "implement", "execute", "build", "code this", path to `.plan.md` | [cookbooks/implement.md](cookbooks/implement.md) |
| Review code or PR | "review", "review PR", "code review", "review changes" | [cookbooks/review.md](cookbooks/review.md) |
| Debug or root cause analysis | "debug", "rca", "root cause", "why is", "broken", "failing" | [cookbooks/debug.md](cookbooks/debug.md) |
| Commit changes | "commit", "save changes", "stage" | [cookbooks/commit.md](cookbooks/commit.md) |
| Create pull request | "pr", "pull request", "create pr", "open pr" | [cookbooks/pr.md](cookbooks/pr.md) |

**If ambiguous**: Ask the user which cookbook to use.

**After routing**: Read the matched cookbook file and follow its instructions exactly.

---

## Workflow Chains

Cookbooks feed into each other. After completing one, suggest the next:

```
research ──► prd ──► plan ──► implement ──► commit ──► pr
                       ▲                       │
debug ─────────────────┘         review ◄──────┘
```

---

## Artifact Directory

All artifacts go to `.claude/archon/`. Create subdirectories as needed on first use.

```
.claude/archon/
├── prds/              # Product requirement documents
├── plans/             # Implementation plans
│   └── completed/     # Archived after implementation
├── reports/           # Implementation reports
├── issues/            # GitHub issue investigations
│   └── completed/
├── reviews/           # PR review reports
├── debug/             # Root cause analysis
└── research/          # Research findings
```

---

## Project Detection

Do NOT hardcode project-specific commands. Detect dynamically:

- **Package manager**: Check for `bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm
- **Validation command**: Check `package.json` scripts for `validate`, `check`, or `verify`
- **Test command**: Check for `test` script in `package.json`
- **Conventions**: Read CLAUDE.md for project-specific rules

---

## Rules

1. **Evidence-based**: Every claim about the codebase must reference `file:line`
2. **No speculation**: If uncertain, investigate first
3. **Fail fast**: Surface errors immediately, never swallow them
4. **Respect CLAUDE.md**: Project conventions override cookbook defaults
5. **No AI attribution**: Never add "Generated with Claude" or "Co-Authored-By: Claude" to commits or PRs
