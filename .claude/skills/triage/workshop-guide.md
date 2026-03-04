# Triage — Workshop Guide

## What This Skill Demonstrates

A command upgraded to a skill + custom agent pair, showcasing **context forking**,
**custom agent delegation**, **prompt hooks as guardrails**, and **restricted toolsets**.

## Architecture

```
User invokes /triage 42
        │
        ▼
┌─────────────────────┐
│  SKILL.md           │  context: fork + agent: triage-agent
│  (entry point)      │  Injects repo context via !`command`
│  allowed-tools:     │  Restricts tools to gh CLI + read-only
│    Bash(gh *)       │
│    Read, Glob, Grep │
└────────┬────────────┘
         │ forks into isolated context
         ▼
┌─────────────────────┐
│  triage-agent.md    │  Custom agent with PostToolUse hook
│  (.claude/agents/)  │  Hook: type "prompt" validates every
│                     │  gh issue edit command to ensure
│  model: sonnet      │  all 4 label categories are present
│  hooks: PostToolUse │
└─────────────────────┘
         │
         ▼
   Summary returned to main conversation
   (intermediate tool calls discarded)
```

## Features to Walk Through

### 1. `context: fork` — Isolated Execution

The skill runs in a **separate context window**. All the issue details, label
fetching, and codebase exploration happen in isolation. Only the final triage
summary returns to the main conversation.

**Why this matters**: Triaging 20 issues could consume 50K+ tokens of context.
Without forking, your main conversation would be polluted with issue bodies,
label lists, and grep results you'll never reference again.

### 2. `agent: triage-agent` — Custom Agent Delegation

Instead of `agent: general-purpose`, this skill delegates to a **custom agent**
defined in `.claude/agents/triage-agent.md`. The agent has:
- Its own system prompt (triage specialist persona)
- Its own tool restrictions
- Its own scoped hooks

**Teaching moment**: Skills can delegate to built-in agents (`Explore`, `Plan`,
`general-purpose`) or to custom agents you define. Custom agents let you embed
domain expertise (label taxonomy, classification rules) in the agent itself,
keeping the skill focused on scope and context.

### 3. `type: "prompt"` Hook as Guardrail

The triage agent has a PostToolUse hook that fires on every Bash call. When it
detects a `gh issue edit --add-label` command, it sends the command to an LLM
that verifies all four label categories are present.

**What happens if validation fails**: The LLM returns `{"ok": false, "reason": "Missing effort label"}`,
and Claude receives that feedback. It can then fix the label application
before moving to the next issue.

**Smart filtering**: The prompt hook checks if the command was actually a label
command. For `gh issue list` or `gh label list`, it returns `{"ok": true}`
immediately — no false positives.

### 4. `allowed-tools: Bash(gh *)` — Restricted Toolset

The skill restricts Bash to only `gh` subcommands. The agent can't run arbitrary
shell commands — only GitHub CLI operations. Combined with `Read`, `Glob`, `Grep`
for codebase exploration.

### 5. `disable-model-invocation: true`

Triage modifies GitHub issues (side effects). Only the user should trigger it.

### 6. Dynamic Context Injection

Three `!`command`` blocks inject live repo data before the agent sees the prompt:
- Current repository name
- Open issue count
- Existing label taxonomy

The agent starts with real context, not instructions to go fetch it.

## Live Demo Steps

1. **Show the architecture** — open both files side by side:
   - `.claude/skills/triage/SKILL.md` (the skill entry point)
   - `.claude/agents/triage-agent.md` (the specialist agent)

2. **Point out the delegation chain**: skill → `context: fork` → `agent: triage-agent`

3. **Invoke on a single issue**: `/triage 42`
   - Show the `statusMessage` spinner: "Validating label application..."
   - Point out: the main conversation stays clean while triage happens in the fork

4. **Show the summary** that returns to the main conversation
   - All the intermediate work (fetching issues, reading code, applying labels) is gone
   - Only the structured summary survives

5. **Show the hook validation** — if a label application was incomplete, the prompt
   hook would have caught it and Claude would have self-corrected

## Comparison: Before vs After

| | Old Command | New Skill + Agent |
|---|---|---|
| Format | `.claude/commands/archon/triage.md` | Skill + `.claude/agents/triage-agent.md` |
| Execution | Inline (pollutes main context) | Forked (isolated context window) |
| Validation | None | Prompt hook validates every label application |
| Tool access | All Bash commands | `Bash(gh *)` only — no arbitrary shell |
| Agent persona | Generic | Specialized triage agent with domain knowledge |
| Context cost | All issue data stays in conversation | Only summary returns |

## Talking Points

- "Context forking is about information hygiene — the triage work happens in a disposable context."
- "Custom agents let you embed domain expertise. The triage rules live in the agent, the scope lives in the skill."
- "The prompt hook is an LLM guardrail — it catches incomplete label applications before they reach GitHub."
- "`Bash(gh *)` is a security boundary — the agent can interact with GitHub but can't run arbitrary commands."
- "This pattern — skill as entry point, custom agent as specialist — is how you build composable workflows."
