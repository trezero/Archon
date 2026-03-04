# Rulecheck — Workshop Guide

## What This Skill Demonstrates

An autonomous code quality agent that combines **16 Claude Code features** into one
genuinely useful tool: isolated execution, custom agents, safety hooks, LLM-as-judge,
persistent memory, Slack notifications, and worktree isolation.

Replaces the existing advisory-only `code-rulecheck` agent with a fully autonomous
version that finds violations, fixes them, validates, creates PRs, and learns.

## Architecture

```
User invokes /rulecheck [focus area]
        │
        ▼
┌──────────────────────────┐
│  SKILL.md                │  context: fork
│  (entry point)           │  agent: rulecheck-agent
│                          │  disable-model-invocation: true
│  Injects:                │  argument-hint: "[focus area]"
│  - branch, log, lint     │
│  - rules-guide.md (lazy) │
└────────┬─────────────────┘
         │ forks into isolated context
         ▼
┌──────────────────────────┐
│  rulecheck-agent.md     │  isolation: worktree
│  (.claude/agents/)       │  background: true
│                          │  memory: project
│  model: sonnet           │  permissionMode: acceptEdits
│  maxTurns: 50            │
│                          │
│  hooks:                  │
│  ├─ PreToolUse [Bash]    │──→ block-dangerous.sh (safety gate)
│  ├─ PostToolUse [Edit]   │──→ bun run lint:fix (auto-fix)
│  └─ Stop                 │
│     ├─ command           │──→ slack-notify.sh (Slack webhook)
│     └─ agent             │──→ meta-judge (LLM evaluation)
└────────┬─────────────────┘
         │ works in worktree
         ▼
┌──────────────────────────┐
│  Worktree                │
│  1. Scan rules           │
│  2. Find violations      │
│  3. Fix top 3-5          │
│  4. bun run validate     │
│  5. Write summary JSON   │
│  6. gh pr create         │
│  7. Update memory        │
└──────────────────────────┘
         │
         ▼
   Summary returned to main conversation
   + PR created + Slack notified + memory updated
```

## Features to Walk Through

### 1. `context: fork` — Isolated Execution

**What is it?** Runs the skill in a new subagent context. All intermediate work
(file reads, grep results, lint output) stays in the fork. Only the final summary
returns to the main conversation.

**In this skill**: The agent might scan hundreds of files and make dozens of tool
calls. None of that pollutes the user's conversation.

### 2. `agent: rulecheck-agent` — Custom Agent Delegation

**What is it?** The `agent:` field delegates the forked context to a custom agent
with its own system prompt, model, hooks, and memory configuration.

**In this skill**: Instead of a generic agent, this skill delegates to a specialist
that knows how to scan rules, prioritize violations, and create PRs.

### 3. `disable-model-invocation: true` — User-Only Trigger

**What is it?** Prevents Claude from auto-invoking this skill. Since it creates
PRs and pushes branches (side effects), only the user should trigger it.

### 4. `argument-hint: "[focus area]"` — Usage Hint

**What is it?** Shows in `/help` and tab completion to tell users what arguments
the skill accepts. Optional — the agent works without arguments too.

### 5. `!`command`` — Dynamic Context Injection

**What is it?** Shell commands that execute at skill load time (before Claude sees
the prompt). Stdout replaces the placeholder.

**In this skill**: Injects current branch, recent git log, and lint status so the
agent starts with real context instead of having to fetch it.

### 6. Supporting Files — On-Demand Loading

**What is it?** Markdown files linked from the skill body with `[name](file.md)`.
Claude loads them only when needed, keeping the initial prompt small.

**In this skill**: `rules-guide.md` documents where to find rules and how to rank
violations. The agent loads it during the scan phase.

### 7. `isolation: worktree` — Git Worktree Isolation

**What is it?** The agent works in a temporary git worktree — a separate working
directory with its own branch. Changes are isolated from the main repo.

**In this skill**: The agent edits files and creates commits without affecting the
user's working directory. If something goes wrong, the worktree is disposable.

### 8. `background: true` — Concurrent Execution

**What is it?** The agent runs in the background. The user can continue working
in the main conversation while the agent scans, fixes, and creates a PR.

### 9. `memory: project` — Persistent Memory

**What is it?** The agent has a persistent memory directory at
`.claude/agent-memory/rulecheck-agent/`. It reads from and writes to `MEMORY.md`
across runs.

**In this skill**: The agent remembers what it fixed last time, what's in the
backlog, and meta-judge feedback — so each run builds on the previous one.

### 10. `permissionMode: acceptEdits` — Auto-Accept Edits

**What is it?** File edits (Edit/Write tools) are automatically approved without
user confirmation. Other tools still require approval per the normal flow.

**In this skill**: The agent needs to edit many files to fix violations. Prompting
for each edit would defeat the purpose of autonomous execution.

### 11. `maxTurns: 50` — Safety Cap

**What is it?** Limits the agent to 50 API round-trips. Prevents runaway agents
that loop endlessly.

### 12. `hooks:` in Agent Frontmatter

**What is it?** Hooks defined directly in the agent's YAML frontmatter. They
activate whenever this agent runs, regardless of which skill invokes it.

This skill demonstrates three hook types:

#### 12a. `type: "command"` — Shell Script Hooks

**PreToolUse [Bash]**: `block-dangerous.sh` reads the command from stdin, checks
against a blocklist (force push, git clean, hard reset, rm -rf), and exits 2 to
block dangerous commands.

**PostToolUse [Edit|Write]**: Runs `bun run lint:fix` after every file edit to
auto-correct formatting issues before they accumulate.

**Stop**: `slack-notify.sh` reads the agent's summary file and sends a formatted
Slack message with what was fixed, PR link, and remaining opportunities.

#### 12b. `type: "agent"` — LLM Meta-Judge

**Stop**: A second Stop hook spawns a subagent that evaluates the rulecheck's
execution. It reviews what was fixed, assesses prioritization quality, and writes
structured feedback to memory for the next run.

### 13. `statusMessage` — Hook Progress Indicators

**What is it?** A string shown in the Claude Code spinner while a hook runs.
Gives users visibility into what's happening during hook execution.

**In this skill**: "Checking command safety...", "Auto-fixing lint issues...",
"Notifying Slack...", "Running meta-judge evaluation..."

### 14. `$ARGUMENTS` — Skill Arguments

**What is it?** The text after the skill name (e.g., `/rulecheck error handling`)
is available as `$ARGUMENTS` in the skill body and passed through to the agent.

### 15. `${CLAUDE_SESSION_ID}` — Session Identifier

**What is it?** Environment variable with the current session ID. Used in the
meta-judge prompt to tag feedback with the session that produced it.

### 16. Summary File Pattern — Inter-Hook Communication

**What is it?** The agent writes `.claude/archon/rulecheck-last-run.json` as a
structured summary. The Slack hook reads this file to format its notification.

This is a practical pattern for passing data between the agent and its hooks
when the hook needs more than what's in the event JSON.

## Live Demo Steps

1. **Show the architecture** — open all files:
   - `.claude/skills/rulecheck/SKILL.md` (skill entry point)
   - `.claude/agents/rulecheck-agent.md` (the autonomous agent)
   - `.claude/skills/rulecheck/hooks/block-dangerous.sh` (safety gate)
   - `.claude/skills/rulecheck/hooks/slack-notify.sh` (Slack notification)
   - `.claude/skills/rulecheck/rules-guide.md` (supporting reference)

2. **Trace the delegation chain**:
   skill → `context: fork` → `agent: rulecheck-agent` → `isolation: worktree`

3. **Show the hooks**: PreToolUse safety gate, PostToolUse lint auto-fix,
   Stop Slack + meta-judge

4. **Test the safety hook**:
   ```bash
   echo '{"tool_input":{"command":"git push --force"}}' | .claude/skills/rulecheck/hooks/block-dangerous.sh
   # Should exit 2 with error message
   echo '{"tool_input":{"command":"bun run lint"}}' | .claude/skills/rulecheck/hooks/block-dangerous.sh
   # Should exit 0
   ```

5. **Invoke**: `/rulecheck type safety`
   - Show: background execution, user can keep working
   - Show: the agent scanning, fixing, validating in the worktree
   - Show: PR creation and Slack notification

6. **Show the outputs**:
   - PR on GitHub
   - Slack notification
   - Memory file (what was learned)
   - Meta-judge feedback

## Comparison: Before vs After

| | Advisory Code-Rulecheck | Autonomous Rulecheck |
|---|---|---|
| Format | `.claude/agents/code-rulecheck.md` | Skill + agent + hooks |
| Execution | Inline, blocks conversation | Background, forked context |
| Output | Advisory report (no changes) | Actual fixes + PR |
| Isolation | None (reads in-place) | Git worktree |
| Safety | None | PreToolUse command blocklist |
| Validation | None | `bun run validate` |
| Notifications | None | Slack webhook |
| Learning | None | Persistent memory + meta-judge |
| Autonomy | Reports findings only | Finds, fixes, validates, PRs |

## Talking Points

- "This is 16 features in one skill. Each one is simple — the power is in composition."
- "The safety hook is a shell script. It reads JSON, checks a blocklist, exits 2 to block. No framework needed."
- "Memory makes the agent better over time. Each run builds on the last — it remembers what's in the backlog."
- "The meta-judge is an LLM evaluating another LLM. It writes structured feedback the agent reads next run."
- "Worktree isolation means the agent can break things safely. Your working directory is untouched."
- "Background execution means you keep working. The agent runs, creates a PR, notifies Slack — you review when ready."
- "The old code-rulecheck was advisory. This one actually fixes things. Same domain, fundamentally different capability."
