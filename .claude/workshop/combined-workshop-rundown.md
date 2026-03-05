# Combined Workshop Rundown

**Host**: Rasmus (Thomas prepped the platform features section)
**Duration**: ~70 min + Q&A
**Required**: Claude Code v2.1.63+, Max plan, tmux, GitHub CLI (`gh`)

---

## Pre-Workshop Setup (both hosts)

```bash
claude --version          # Must be v2.1.63+
tmux -V                   # Required for split panes
gh auth status            # Required for triage + /batch
export IS_DEMO=1          # Hide email/org in UI
```

`~/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

---

## Part 1 — Platform Features (~33 min)

The "what Claude Code can do now" half. Shows the multi-agent orchestration
platform that shipped in Jan-Feb 2026. (Prepped by Thomas.)

### 1. Agent Teams (10 min)

**Features shown**: Split panes, shared task list, teammate messaging, delegate mode

- Start Claude in tmux, give a 3-teammate review task
- Show split panes (each teammate working independently)
- Show teammates messaging each other (not just reporting to lead)
- Demo Shift+Down (cycle), Ctrl+T (task list), Shift+Tab (delegate mode)
- Key point: "Subagents report up. Teammates talk to each other."

### 2. Native Git Worktrees (5 min)

**Features shown**: `--worktree` CLI flag, `--worktree + --tmux`, cleanup behavior

- `git worktree list` (before)
- `claude --worktree demo-feature`
- Make a change, prove isolation from main tree
- Exit, show auto-cleanup
- Key point: "Without worktrees, parallel agents are fragile. With worktrees, each agent owns the entire codebase."

### 3. /batch — Parallel Codebase-Wide Changes (8 min)

**Features shown**: Decomposition plan, approval gate, parallel execution, PR per unit

- Show a pattern to fix (`grep -r "console.log" src/`)
- `/batch replace all console.log with structured logger`
- Review the decomposition plan (audience sees the approval gate)
- Approve, watch parallel execution status table
- `gh pr list` to show results
- Key point: "A week-long migration, parallelized. Each PR is independently reviewable."

### 4. Remote Control (5 min)

**Features shown**: `/rc`, QR code, phone connection, architecture (code stays local)

- Start working on a task
- `/rc` — show QR code
- Scan from phone, type message from phone
- Key point: "Your code never leaves your machine. Only chat messages flow through the bridge."

### 5. Session Teleportation (5 min)

**Features shown**: `--remote` (local->cloud), `/tp` (cloud->local), plan+execute pattern

- `claude --remote "Add input validation to all API endpoints"`
- Show it running on claude.ai
- `/tp` to pull it back
- Key point: "Plan locally, execute remotely, teleport back when done."

---

## Transition (~2 min)

> "That was the platform — what Claude Code can do out of the box. Now let's
> look at how to build your own power on top of it — custom skills, agents,
> hooks, and autonomous workflows. Same building blocks, composed into
> something new."

---

## Part 2 — Extensibility: Skills, Agents & Hooks (~35 min)

The "how to extend Claude Code yourself" half. Three skills, progressive
complexity, each building on the previous. (Prepped by Rasmus.)

### 6. save-task-list — Hook Lifecycle (10 min)

**Complexity**: Simple. One skill, no custom agent, hooks in skill frontmatter.

**Features shown** (7):
- Skills system (SKILL.md format, slash menu, frontmatter)
- `disable-model-invocation: true`
- `!`command`` dynamic context injection
- `${CLAUDE_SESSION_ID}`
- Hooks in skill frontmatter (scoped lifetime — active only while skill runs)
- `type: prompt` hook (LLM evaluates completion quality)
- `once: true` hook modifier
- `statusMessage` (custom spinner text)
- SessionStart hook (installed into settings.local.json for cross-session use)

**Demo flow**:
1. Open SKILL.md — walk through frontmatter fields
2. Create some tasks first ("plan a refactor, break into tasks")
3. Invoke `/save-task-list`
4. Point out: statusMessage spinners, the Stop prompt hook catching incomplete output
5. Show the SessionStart hook installed in `.claude/settings.local.json`
6. Show the startup command: `CLAUDE_CODE_TASK_LIST_ID=<id> claude`
7. (Optional) Start new session to show SessionStart hook firing

**Key points**:
- "Hooks in skill frontmatter are scoped — they only live while the skill runs."
- "The prompt hook is an LLM checking another LLM's work. That's the quality gate pattern."
- "This skill installs its own SessionStart hook — a self-configuring workflow."

### 7. triage — Fork + Agent + Tool Restriction (10 min)

**Complexity**: Medium. Adds context forking, custom agent delegation, tool restrictions.

**Features shown** (6 new, building on previous):
- `context: fork` (isolated subagent context — only summary returns)
- `agent: triage-agent` (custom agent delegation)
- Custom agent file (`.claude/agents/triage-agent.md`)
- `allowed-tools: Bash(gh *), Read, Glob, Grep` (security boundary)
- `type: prompt` hook in agent frontmatter (validates label completeness)
- `argument-hint`
- `$ARGUMENTS` (skill arguments passed through)

**Demo flow**:
1. Open both files side by side: SKILL.md + `.claude/agents/triage-agent.md`
2. Trace the delegation chain: skill -> `context: fork` -> `agent: triage-agent`
3. Point out `allowed-tools` — "only `gh` commands, no arbitrary shell"
4. Invoke `/triage 42` (or a real issue number)
5. While running: point out the main conversation stays clean
6. Show the structured summary that returns (intermediate work discarded)
7. Show the prompt hook validation ("Validating label application...")

**Key points**:
- "Skills define *what* to do. Agents define *how* to do it. Separating them makes both composable."
- "`Bash(gh *)` is a security boundary — the agent can talk to GitHub but can't `rm -rf`."
- "Context forking is information hygiene — 50K tokens of issue data stays in the fork."

### 8. rulecheck — Full Autonomy (15 min)

**Complexity**: High. The "kitchen sink" — 16 features composed into one autonomous workflow.

**Features shown** (new on top of previous):
- `isolation: worktree` (agent works in temporary worktree)
- `background: true` (runs while user keeps working)
- `memory: project` (persistent memory across runs)
- `permissionMode: acceptEdits` (auto-approve file edits)
- `maxTurns: 50` (safety cap)
- `model: sonnet` per-agent
- PreToolUse hook: `type: command` (block-dangerous.sh — safety gate)
- PostToolUse hook: `type: command` (auto lint:fix after edits)
- Stop hook: `type: command` (slack-notify.sh — Slack webhook)
- Stop hook: `type: agent` (meta-judge — LLM evaluates LLM)
- Supporting files (rules-guide.md, lazy-loaded)
- Inter-hook communication (summary JSON file read by Slack hook)

**Demo flow**:
1. Open all files — show the architecture:
   - `.claude/skills/rulecheck/SKILL.md`
   - `.claude/agents/rulecheck-agent.md`
   - `.claude/skills/rulecheck/hooks/block-dangerous.sh`
   - `.claude/skills/rulecheck/hooks/slack-notify.sh`
   - `.claude/skills/rulecheck/rules-guide.md`
2. Trace the full chain: skill -> fork -> agent -> worktree -> background
3. Test the safety hook live:
   ```bash
   echo '{"tool_input":{"command":"git push --force"}}' | .claude/skills/rulecheck/hooks/block-dangerous.sh
   # Blocked!
   echo '{"tool_input":{"command":"bun run lint"}}' | .claude/skills/rulecheck/hooks/block-dangerous.sh
   # Allowed
   ```
4. Invoke `/rulecheck type safety`
5. Show: background execution, user can keep chatting
6. Show: agent scanning, fixing, validating in the worktree
7. Show outputs: PR on GitHub, Slack notification, memory file, meta-judge feedback
8. Compare before/after table (advisory vs autonomous)

**Key points**:
- "16 features, one skill. Each is simple — the power is in composition."
- "The safety hook is a shell script. Reads JSON, checks a blocklist, exits 2. No framework."
- "Memory makes the agent better over time. Each run builds on the last."
- "The meta-judge is an LLM evaluating another LLM. It writes feedback the agent reads next run."
- "Worktree isolation means the agent can break things safely. Your working directory is untouched."

### 9. Auto-Memory with `/memory` (2 min)

**Follows directly from rulecheck** — the agent just used `memory: project`.

**What it is**: Claude auto-saves useful context (build commands, test
conventions, debugging patterns) to a persistent memory directory. Survives
context compaction. Shared across git worktrees of the same repo, so parallel
agents benefit from the same learned context.

**Demo flow**:
1. After the rulecheck demo, point out the agent wrote to its memory
2. Run `/memory` to show what Claude has saved globally for this project
3. Show the auto-memory directory: `ls .claude/agent-memory/`

**Key point**:
- "Claude learns your project across sessions without you maintaining CLAUDE.md manually. The rulecheck agent's `memory: project` is the same system — scoped to that agent."

---

## Closing (~2 min)

> "Part 1 was the platform: teams, worktrees, batch, remote control,
> teleportation. Part 2 was the extensibility layer: skills, agents, hooks,
> memory, safety gates. Together, that's the full picture — use the platform,
> and extend it for your specific workflows."

> "The paradigm shift: decompose, isolate, extend, review, learn."

---

## Combined Feature Count

| Section | Features shown |
|---------|---------------|
| Thomas (platform) | ~8 major features |
| Rasmus (extensibility) | ~25 features across 3 skills |
| **Total unique features** | **~30** |
| Overlap | Worktree isolation (CLI vs agent frontmatter) |

---

## Quick Reference Card

```
# PLATFORM (Thomas)
  Agent Teams          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
  Shift+Down/Up        Cycle teammates
  Ctrl+T               Task list
  Shift+Tab            Delegate mode
  claude --worktree    Isolated session
  /batch <desc>        Parallel codebase change
  /rc                  Remote control
  /tp                  Teleport cloud -> local
  claude --remote      Local -> cloud

# EXTENSIBILITY (Rasmus)
  Skills               .claude/skills/<name>/SKILL.md
  Agents               .claude/agents/<name>.md
  Hooks (command)      type: command, exit 2 to block
  Hooks (prompt)       type: prompt, {"ok": false} to block
  Hooks (agent)        type: agent, subagent evaluator
  context: fork        Isolated execution, only summary returns
  isolation: worktree  Agent gets its own worktree
  background: true     Agent runs concurrently
  memory: project      Persistent across runs
  allowed-tools        Security boundary (e.g., Bash(gh *))
  once: true           Fire hook exactly once
  statusMessage        Custom spinner text
  !`command`           Dynamic context at load time
  $ARGUMENTS           User input passthrough
```
