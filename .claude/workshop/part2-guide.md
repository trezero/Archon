# Part 2: Extensibility — Skills, Agents & Hooks

**Host**: Rasmus
**Duration**: ~35 min
**Codebase**: `dynamous-community/remote-coding-agent` (this repo)
**Required**: Claude Code v2.1.63+, GitHub CLI (`gh`)

---

## Overview

Three skills, progressive complexity. Each builds on the previous:

1. **save-task-list** (simple) — Skills system, hook types, hook scoping
2. **triage** (medium) — Context forking, custom agents, tool restrictions
3. **rulecheck** (complex) — Full autonomy: worktree, background, memory, safety, notifications

---

## Transition from Part 1

> "That was the platform — what Claude Code can do out of the box. Agent Teams,
> worktrees, `/batch`, remote control, teleportation. Now let's look at how to
> build your own power on top of it — custom skills, agents, hooks, and
> autonomous workflows. Same building blocks, composed into something new."

---

## Feature 6: save-task-list — Hook Lifecycle (10 min)

> **Deep dive**: [workshop-guide.md](../skills/save-task-list/workshop-guide.md) —
> explains each feature concept in detail with "What is it?" definitions.

### What It Is

A skill that saves the current session's task list for reuse in future sessions.
Simple task — but upgraded from a plain command to a skill to demonstrate the
**hook lifecycle**: skill-scoped hooks during execution, and settings-level
hooks installed for future sessions.

### Features Covered

| # | Feature | Where |
|---|---------|-------|
| 1 | **Skills system** — SKILL.md format, frontmatter, slash menu | Skill file |
| 2 | **`disable-model-invocation: true`** — user-only trigger | Frontmatter |
| 3 | **`!`command``** — dynamic context injection at load time | Body |
| 4 | **`${CLAUDE_SESSION_ID}`** — built-in session variable | Body |
| 5 | **`type: prompt` hook** — LLM evaluates completion quality | Frontmatter |
| 6 | **`type: command` hook** — shell script reads JSON on stdin | Frontmatter |
| 7 | **`once: true`** — hook fires exactly once, then removes itself | Frontmatter |
| 8 | **`statusMessage`** — custom spinner text during hook execution | Frontmatter |
| 9 | **SessionStart hook** — settings-level, fires on every session start | Installed by skill |

### Live Demo

#### Step 1: Show the skill file

Open `.claude/skills/save-task-list/SKILL.md` and walk through it top to bottom.

**Frontmatter — explain each field:**

```yaml
---
name: save-task-list
description: Save current task list for reuse across sessions
disable-model-invocation: true           # <-- only user can trigger
hooks:
  Stop:
    - hooks:
        - type: prompt                   # <-- LLM checks the output
          prompt: |
            Verify:
            1. A task list ID was found and displayed
            2. A startup command was provided
            3. A task summary was shown
            Return {"ok": true} or {"ok": false, "reason": "..."}
          statusMessage: "Verifying task list was saved..."
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command                  # <-- shell script
          command: "jq -r '...' | head -1"
          statusMessage: "Logging tool use..."
          once: true                     # <-- fires once, then auto-removes
---
```

> **Explain**: "Three hook types exist — `command` (shell script), `prompt`
> (LLM evaluation), and `agent` (subagent). We'll see all three across
> the skills today. There's also `http` which we'll see in rulecheck."

> **Explain**: "Hooks defined here are **skill-scoped** — they activate when
> `/save-task-list` runs and clean up when it finishes. They don't affect
> other skills or the main session."

**Body — explain the dynamic context:**

```markdown
## Session Context

- **Session ID**: ${CLAUDE_SESSION_ID}
- **Active task directories**: !`ls -1t ~/.claude/tasks/ | head -5`
- **Current tasks in session**: !`ls ... | head -1 | xargs ...`
```

> **Explain**: "The `!`command`` syntax runs shell commands as preprocessing —
> before Claude sees the prompt. The output replaces the placeholder inline.
> Claude starts with real data, not instructions to go find it. This is not
> tool use — it happens at skill load time."

#### Step 2: Create tasks to save

Copy-paste this prompt:

```
Break this into tasks and track them:
1. Add rate limiting to the API routes
2. Write integration tests for the workflow executor
3. Update the CLI help text for the isolation commands
4. Fix the SSE reconnection logic in the web adapter
```

Wait for Claude to create the task list.

#### Step 3: Invoke the skill

```
/save-task-list
```

**Point out to the audience as it runs:**

- The `statusMessage` spinner: "Logging tool use..." (PostToolUse hook fires once)
- The `statusMessage` spinner: "Verifying task list was saved..." (Stop hook)
- Claude outputs the task list ID and startup command
- If Claude tries to stop without showing all three items, the prompt hook
  returns `{"ok": false}` and Claude self-corrects

#### Step 4: Show what the skill installed

```bash
# The session mapping log
cat .claude/archon/sessions/task-lists.jsonl
```

```bash
# The SessionStart hook in settings
cat .claude/settings.local.json
```

> **Explain**: "The skill installed a SessionStart hook into
> `.claude/settings.local.json`. This hook runs at the start of every
> future session — not just while the skill is active. That's two
> different hook lifetimes in one skill: skill-scoped during execution,
> settings-level across sessions."

#### Step 5: Show the hook verification script

```bash
cat .claude/skills/save-task-list/hooks/verify-task-list.sh
```

> **Explain**: "This script checks if `CLAUDE_CODE_TASK_LIST_ID` is set,
> verifies the directory exists, and returns a `systemMessage` JSON — which
> shows up as a system notification in Claude Code."

#### Step 6: (Optional) Show the restore flow

```bash
# Copy the startup command from the output
CLAUDE_CODE_TASK_LIST_ID=<id> claude
```

Point out: The "Checking for restored task list..." spinner appears immediately
from the SessionStart hook, then the task count confirmation.

### Key Talking Points

- "Hooks in skill frontmatter are scoped — they only live while the skill runs. No global side effects."
- "The prompt hook is an LLM checking another LLM's work. That's the quality gate pattern — costs pennies, catches real mistakes."
- "`once: true` prevents the hook from firing repeatedly — useful for one-time setup or logging."
- "Dynamic context injection means Claude starts with real data, not instructions to go find it."
- "This skill uses both hook lifetimes: skill-scoped during execution, settings-level across sessions."

---

## Feature 7: triage — Fork + Agent + Tool Restriction (10 min)

> **Deep dive**: [workshop-guide.md](../skills/triage/workshop-guide.md) —
> architecture diagram, agent type comparison table, detailed feature explanations.

### What It Is

A skill that triages GitHub issues by applying labels. Demonstrates the
**skill + agent separation pattern**: the skill defines *what* to do (scope,
arguments, context), the agent defines *how* to do it (persona, tools,
guardrails). Also shows context forking and tool restrictions.

### Features Covered

| # | Feature | Where |
|---|---------|-------|
| 1 | **`context: fork`** — isolated subagent context | Skill frontmatter |
| 2 | **`agent: triage-agent`** — custom agent delegation | Skill frontmatter |
| 3 | **Custom agent file** — `.claude/agents/triage-agent.md` | Agent file |
| 4 | **`allowed-tools`** + wildcards — `Bash(gh *)` | Skill frontmatter |
| 5 | **`type: prompt` hook in agent** — validates label completeness | Agent frontmatter |
| 6 | **`argument-hint`** — usage hint in `/help` and tab completion | Skill frontmatter |
| 7 | **`$ARGUMENTS`** — user input passed through | Skill body |
| 8 | **`!`command``** — injects repo name, issue count, labels | Skill body |
| 9 | **`model: sonnet`** — per-agent model override | Agent frontmatter |

### Live Demo

#### Step 1: Show both files side by side

Open `.claude/skills/triage/SKILL.md`:

```yaml
---
name: triage
description: |
  Triage GitHub issues by applying type, effort, priority, and area labels.
argument-hint: "[unlabeled|all|N|N-M]"
disable-model-invocation: true
context: fork          # <-- runs in isolated context
agent: triage-agent    # <-- delegates to custom agent
allowed-tools: Bash(gh *), Read, Glob, Grep   # <-- security boundary
---
```

> **Explain**: "Three key fields here. `context: fork` means it runs in an
> isolated context — all intermediate work is discarded, only the final summary
> returns. `agent: triage-agent` delegates to a custom agent with its own
> persona and hooks. `allowed-tools` restricts what tools the agent can use —
> only `gh` commands and read-only codebase access. No `rm`, no `Write`, no
> arbitrary shell."

Open `.claude/agents/triage-agent.md`:

```yaml
---
name: triage-agent
model: sonnet
tools: Bash, Read, Glob, Grep
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: prompt
          prompt: |
            If this was a `gh issue edit --add-label` command, verify:
            1. Exactly one type label
            2. Exactly one effort label
            3. Exactly one priority label
            4. At least one area label
            Return {"ok": true} if valid or not a label command.
            Return {"ok": false, "reason": "..."} if missing categories.
          statusMessage: "Validating label application..."
---
```

> **Explain**: "This is a prompt hook — an LLM guardrail. Every time the agent
> runs a `gh issue edit --add-label` command, a separate LLM call validates
> that all four label categories are present. If one is missing, it returns
> `{"ok": false}` and Claude self-corrects before moving to the next issue.
> For non-label commands like `gh issue list`, it just returns `{"ok": true}`."

> **Explain**: "Skills define *what* to do. Agents define *how* to do it.
> The same agent could be used by multiple skills — that's composability."

#### Step 2: Show the dynamic context injection

Point out the three `!`command`` blocks in the skill body:

```markdown
- **Current repo**: !`gh repo view --json nameWithOwner -q .nameWithOwner`
- **Open issues**: !`gh issue list --state open --json number --jq 'length'`
- **Existing labels**: !`gh label list --json name -q '.[].name' | head -20`
```

> **Explain**: "Before Claude sees the prompt, these commands run and inject
> the actual repo name, issue count, and label taxonomy. The agent starts
> with real context."

#### Step 3: Create a test issue (if all issues are already labeled)

```bash
gh issue create --title "chore: clean up unused utility functions in packages/core/src/utils/" --body "Several utility functions in the core utils module appear unused after recent refactoring. Should audit and remove dead code to reduce surface area."
```

Note the issue number that gets created.

#### Step 4: Invoke the skill

```
/triage <issue-number>
```

**Point out to the audience as it runs:**

- The main conversation stays clean — all intermediate work (fetching issues,
  reading code, applying labels) happens in the fork
- The `statusMessage` spinner: "Validating label application..."
- The agent reads the issue body, explores the codebase with Grep/Read, then applies labels

#### Step 5: Show the result

Only the structured triage summary returns to the main conversation:

```
## Triage Summary

| Issue | Title | Labels Applied | Reasoning |
|-------|-------|----------------|-----------|
| #528  | ...   | chore, effort/low, P3, area: utils | ... |
```

> **Explain**: "All the intermediate work — fetching issues, grepping code,
> reading files — is gone. Only the summary survives. That's context forking:
> information hygiene for your conversation."

#### Step 6: Verify on GitHub

```bash
gh issue view <issue-number> --json labels --jq '.labels[].name'
```

### Key Talking Points

- "Skills define *what* to do. Agents define *how* to do it. Separating them makes both composable."
- "`Bash(gh *)` is a security boundary — the agent can talk to GitHub but can't `rm -rf` or write files."
- "Context forking is information hygiene — 50K tokens of issue data stays in the fork."
- "The prompt hook catches incomplete label applications before they reach GitHub. Costs pennies per check."

---

## Feature 8: rulecheck — Full Autonomy (15 min)

> **Deep dive**: [workshop-guide.md](../skills/rulecheck/workshop-guide.md) —
> all 17 features explained individually with "What is it?" + "In this skill" format.

### What It Is

An autonomous code quality agent that scans the codebase for CLAUDE.md rule
violations, fixes the highest-impact group, validates, creates a PR, and
notifies Slack. Uses persistent memory to improve across runs. A meta-judge
evaluates each run.

This is the "kitchen sink" — every prior concept plus worktree isolation,
background execution, persistent memory, four hook types, and inter-hook
communication.

### Features Covered

| # | Feature | Where |
|---|---------|-------|
| 1 | **`agent: rulecheck-agent`** — skill delegates to autonomous agent | Skill frontmatter |
| 2 | **No `context: fork`** — skill orchestrates, agent runs autonomously | Skill design |
| 3 | **`isolation: worktree`** — agent works in its own git worktree | Agent frontmatter |
| 4 | **`background: true`** — agent runs while user keeps working | Agent frontmatter |
| 5 | **`memory: project`** — persistent memory across runs | Agent frontmatter |
| 6 | **`permissionMode: acceptEdits`** — auto-approve file edits | Agent frontmatter |
| 7 | **`maxTurns: 500`** — safety cap on API round-trips | Agent frontmatter |
| 8 | **`model: sonnet`** — per-agent model override | Agent frontmatter |
| 9 | **PreToolUse `type: command`** — block-dangerous.sh safety gate | Agent hooks |
| 10 | **PostToolUse `type: command`** — auto lint:fix after edits | Agent hooks |
| 11 | **Stop `type: command`** — slack-notify.sh reads summary file | Agent hooks |
| 12 | **Stop `type: http`** — POST event directly to Slack webhook | Agent hooks |
| 13 | **Stop `type: agent`** — meta-judge evaluates the run | Agent hooks |
| 14 | **Supporting files** — rules-guide.md (lazy-loaded) | Skill body |
| 15 | **Inter-hook communication** — summary JSON file shared between agent and hooks | Pattern |
| 16 | **`$ARGUMENTS`** — focus area passed through | Skill + agent |
| 17 | **`argument-hint`** — "[focus area]" shown in `/help` | Skill frontmatter |

### Architecture

```
User invokes /rulecheck [focus area]
        |
        v
+---------------------------+
|  SKILL.md                 |  agent: rulecheck-agent
|  (orchestrator)           |  disable-model-invocation: true
|                           |  NO context: fork (skill stays active)
|  Launches agent, reports  |
|  results when complete    |
+----------+----------------+
           | delegates to agent
           v
+---------------------------+
|  rulecheck-agent.md       |  isolation: worktree
|  (.claude/agents/)        |  background: true
|                           |  memory: project
|  model: sonnet            |  permissionMode: acceptEdits
|  maxTurns: 500            |
|                           |
|  hooks:                   |
|  +- PreToolUse [Bash]     |-> block-dangerous.sh (exit 2 = block)
|  +- PostToolUse [Edit]    |-> bun run lint:fix (auto-format)
|  +- Stop                  |
|     +- type: command      |-> slack-notify.sh (reads summary JSON)
|     +- type: http         |-> POST to Slack webhook URL
|     +- type: agent        |-> meta-judge (LLM evaluation)
+---------------------------+
           | works in worktree
           v
  1. Read memory (previous runs, meta-judge feedback)
  2. Read CLAUDE.md rules
  3. Deep scan packages/*/src/*.ts
  4. Group violations, pick one group
  5. Fix all instances
  6. bun run validate
  7. Commit, push, gh pr create
  8. Write summary JSON + update memory
```

### Live Demo

#### Step 1: Show the skill file

Open `.claude/skills/rulecheck/SKILL.md`:

```yaml
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
```

> **Explain**: "Notice there's no `context: fork` here — unlike triage.
> The skill acts as an orchestrator: it launches the agent and reports results.
> The agent itself handles all the autonomy via its own frontmatter."

#### Step 2: Show the agent file

Open `.claude/agents/rulecheck-agent.md` and walk through the frontmatter:

```yaml
---
name: rulecheck-agent
isolation: worktree        # <-- own git worktree
background: true           # <-- runs while you keep working
memory: project            # <-- remembers across runs
permissionMode: acceptEdits # <-- auto-approve file edits
maxTurns: 500              # <-- safety cap
model: sonnet              # <-- specific model
hooks:
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "bun run lint:fix --quiet 2>/dev/null || true"
          statusMessage: "Auto-fixing lint issues..."
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: ".claude/skills/rulecheck/hooks/block-dangerous.sh"
          statusMessage: "Checking command safety..."
  Stop:
    - hooks:
        - type: command
          command: ".claude/skills/rulecheck/hooks/slack-notify.sh"
          statusMessage: "Notifying Slack..."
        - type: http
          url: https://hooks.slack.com/services/...
          statusMessage: "Posting run event to Slack..."
        - type: agent
          prompt: |
            You are a meta-judge evaluating the rulecheck agent's execution...
          statusMessage: "Running meta-judge evaluation..."
---
```

**Walk through each hook:**

> **PreToolUse [Bash] — Safety Gate**: "Every Bash command the agent runs goes
> through `block-dangerous.sh` first. The script reads JSON from stdin, checks
> against a blocklist, and exits 2 to block. Force push, `git clean`, `rm -rf`,
> anything touching main — all blocked."

> **PostToolUse [Edit|Write] — Auto-Fix**: "After every file edit, `bun run
> lint:fix` runs automatically to correct formatting. Issues don't accumulate."

> **Stop hooks — Three types firing in sequence**:
> 1. `type: command` — `slack-notify.sh` reads the summary JSON the agent wrote
>    and sends a formatted Slack message. This is **inter-hook communication** —
>    the agent writes a file, the hook reads it.
> 2. `type: http` — POSTs the event directly to a Slack webhook URL. No script
>    needed. This is the **fourth hook type** — HTTP hooks for external services.
> 3. `type: agent` — A meta-judge subagent evaluates the rulecheck's execution.
>    Reviews what was fixed, assesses quality, and writes feedback to memory.
>    The agent reads this feedback on its next run.

#### Step 3: Test the safety hook live

```bash
# This should be BLOCKED (exit code 2):
echo '{"tool_input":{"command":"git push --force origin main"}}' | \
  .claude/skills/rulecheck/hooks/block-dangerous.sh
echo "Exit code: $?"
```

```bash
# This should be ALLOWED (exit code 0):
echo '{"tool_input":{"command":"bun run validate"}}' | \
  .claude/skills/rulecheck/hooks/block-dangerous.sh
echo "Exit code: $?"
```

> **Explain**: "That's the entire safety gate. A shell script that reads JSON,
> checks a blocklist, and exits with code 2 to block. No framework, no SDK,
> no dependencies. Exit 0 means allow, exit 2 means block with a message on
> stderr."

#### Step 4: Show the Slack notification hook

```bash
cat .claude/skills/rulecheck/hooks/slack-notify.sh
```

> **Explain**: "This reads `.claude/archon/rulecheck-last-run.json` — a summary
> file the agent writes before stopping. Extracts the fixed count, PR URL, and
> remaining opportunities, formats a Slack Block Kit message, and POSTs it.
> That's inter-hook communication: the agent produces data, the hook consumes it."

#### Step 5: Show the rules guide

```bash
head -30 .claude/skills/rulecheck/rules-guide.md
```

> **Explain**: "This is a supporting file linked from the skill body. The agent
> loads it lazily — only when it needs the rules reference. Keeps the initial
> prompt small."

#### Step 6: Invoke the rulecheck

```
/rulecheck error handling
```

**Point out to the audience:**

- The skill launches the agent and immediately returns control to you
- `background: true` means the agent runs in a separate worktree while you
  keep chatting in the main session
- Show the "Checking command safety..." spinner appearing on Bash calls
- Show the "Auto-fixing lint issues..." spinner after edits

> **Explain**: "The agent is now working in an isolated git worktree. It's
> scanning `packages/*/src/*.ts` for CLAUDE.md violations — things linters
> can't catch. Swallowed errors, silent fallbacks, wrong logger patterns,
> missing error context. When it's done, it'll create a PR and notify Slack."

#### Step 7: While the agent works, explain the memory system

```bash
# Show the memory directory (may be empty on first run)
ls -la .claude/agent-memory/rulecheck-agent/ 2>/dev/null || echo "First run — no memory yet"
```

> **Explain**: "`memory: project` gives the agent a persistent directory at
> `.claude/agent-memory/rulecheck-agent/`. It reads MEMORY.md at the start
> of each run — what was fixed last time, what's in the backlog, meta-judge
> feedback. Each run builds on the previous one."

#### Step 8: Show outputs (when agent completes)

```bash
# The summary JSON (read by the Slack hook)
cat .claude/archon/rulecheck-last-run.json

# The PR
gh pr list --head worktree-

# The memory file
cat .claude/agent-memory/rulecheck-agent/MEMORY.md

# Meta-judge feedback
cat .claude/agent-memory/rulecheck-agent/meta-judge-feedback.md
```

### Comparison: Before vs After

| | Advisory Code-Rulecheck | Autonomous Rulecheck Skill |
|---|---|---|
| Format | `.claude/agents/code-rulecheck.md` | Skill + agent + hooks |
| Execution | Inline, blocks conversation | Background, worktree-isolated |
| Output | Advisory report (no changes) | Actual fixes + PR |
| Isolation | None (reads in-place) | Git worktree |
| Safety | None | PreToolUse command blocklist |
| Validation | None | `bun run validate` |
| Notifications | None | Slack webhook (command + HTTP hooks) |
| Learning | None | Persistent memory + meta-judge |
| Autonomy | Reports findings only | Finds, fixes, validates, PRs |

### Key Talking Points

- "This is 17 features in one skill. Each is simple — the power is in composition."
- "The safety hook is a shell script. Reads JSON, checks a blocklist, exits 2 to block. No framework."
- "Memory makes the agent better over time. Each run builds on the last — it remembers the backlog."
- "The meta-judge is an LLM evaluating another LLM. It writes structured feedback the agent reads next run."
- "Worktree isolation means the agent can break things safely. Your working directory is untouched."
- "Four hook types in one agent: command (safety gate + lint + Slack script), HTTP (Slack webhook), agent (meta-judge). We saw prompt hooks in triage."
- "The old rulecheck was advisory. This one actually fixes things. Same domain, fundamentally different capability."

---

## Feature 9: Auto-Memory with `/memory` (2 min)

### What It Is

Claude auto-saves useful context (build commands, test conventions, debugging
patterns) to a persistent memory directory. Survives context compaction. Shared
across git worktrees of the same repo, so parallel agents benefit.

### Live Demo

#### Step 1: Connect to the rulecheck memory

The rulecheck agent just used `memory: project`. Show what it saved:

```bash
ls .claude/agent-memory/rulecheck-agent/
cat .claude/agent-memory/rulecheck-agent/MEMORY.md
```

#### Step 2: Show the global auto-memory

```
/memory
```

> **Explain**: "Claude learns your project across sessions without you
> maintaining CLAUDE.md manually. The rulecheck agent's `memory: project`
> is the same system — scoped to that agent. Both survive context compaction
> and are shared across worktrees."

### Key Talking Point

- "The agent remembers what it fixed, what's left to fix, and what the meta-judge said. Next run, it picks up where it left off."

---

## Closing (~2 min)

> "Part 1 was the platform: teams, worktrees, batch, remote control,
> teleportation. Part 2 was the extensibility layer: skills, agents, hooks,
> memory, safety gates."

> "Here's the key insight: every skill we built uses the same primitives
> the platform features are built on. `/batch` uses worktrees and background
> agents internally. Our rulecheck does the same thing — `isolation: worktree`,
> `background: true`. The platform isn't magic. It's composable building blocks
> that you can use too."

> "The paradigm shift: decompose, isolate, extend, review, learn."

---

## All Features Covered in Part 2

| # | Feature | Skill |
|---|---------|-------|
| 1 | Skills system (SKILL.md, frontmatter, slash menu) | All 3 |
| 2 | `disable-model-invocation: true` | All 3 |
| 3 | `!`command`` dynamic context injection | All 3 |
| 4 | `$ARGUMENTS` variable substitution | All 3 |
| 5 | `statusMessage` custom spinner text | All 3 |
| 6 | `${CLAUDE_SESSION_ID}` | save-task-list, rulecheck |
| 7 | `argument-hint` | triage, rulecheck |
| 8 | Hook `type: command` (shell scripts) | save-task-list, rulecheck |
| 9 | Hook `type: prompt` (LLM guardrail) | save-task-list, triage |
| 10 | Hook `type: agent` (subagent evaluator) | rulecheck |
| 11 | Hook `type: http` (external webhook) | rulecheck |
| 12 | `once: true` hook modifier | save-task-list |
| 13 | Hook scoping: skill-scoped | save-task-list |
| 14 | Hook scoping: agent-scoped | triage, rulecheck |
| 15 | Hook scoping: settings-level (SessionStart) | save-task-list |
| 16 | `context: fork` (isolated subagent context) | triage |
| 17 | `agent:` custom agent delegation | triage, rulecheck |
| 18 | Custom agent files (`.claude/agents/`) | triage, rulecheck |
| 19 | `allowed-tools` + wildcards | triage |
| 20 | `model:` per-agent override | triage, rulecheck |
| 21 | `isolation: worktree` | rulecheck |
| 22 | `background: true` | rulecheck |
| 23 | `memory: project` | rulecheck |
| 24 | `permissionMode: acceptEdits` | rulecheck |
| 25 | `maxTurns` safety cap | rulecheck |
| 26 | Supporting files (lazy-loaded markdown) | rulecheck |
| 27 | Inter-hook communication (summary file) | rulecheck |
| 28 | Auto-Memory (`/memory`) | rulecheck follow-up |

---

## Cleanup After Workshop

```bash
# Close any test issues created during the triage demo
gh issue close <number> --reason "not planned" --comment "Created for workshop demo"

# Clean up the SessionStart hook if you don't want it persisting
# (read .claude/settings.local.json and remove the SessionStart entry)

# Clean up any rulecheck worktrees still running
git worktree list
git worktree remove <path>   # if any remain

# Close any rulecheck PRs
gh pr list --head worktree-
gh pr close <number>
```
