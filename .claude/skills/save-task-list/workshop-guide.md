# Save Task List — Workshop Guide

## What This Skill Demonstrates

A simple command upgraded to a skill to showcase **five Claude Code extensibility features** in one file.

## Features to Walk Through

### 1. Skill-Scoped Hooks (frontmatter `hooks:`)

Open `SKILL.md` and point out the two hooks defined in YAML frontmatter:

- **Stop hook** (`type: "prompt"`) — An LLM evaluates whether Claude actually completed the task before it stops. If the task list ID or startup command is missing, Claude is told to keep working. This is AI evaluating AI as a quality gate.
- **PostToolUse hook** (`type: "command"`) — Reads the tool call JSON from stdin via `jq` and logs it. Shows how command hooks receive structured JSON on stdin.

Both hooks are **scoped to the skill** — they activate when `/save-task-list` is invoked and clean up when it finishes. They don't affect other skills or the main session.

### 2. `once: true`

The PostToolUse hook has `once: true` — it fires on the first Bash call, then removes itself for the rest of the session. Point out this is **skills-only** (not available in agent frontmatter).

### 3. `statusMessage`

Both hooks have custom spinner text (`"Verifying task list was saved..."`, `"Logging tool use..."`). Show the audience how this replaces the generic "Running hook..." message in the UI.

### 4. Dynamic Context Injection (`!`command``)

The skill body has three `!`command`` blocks that run **before Claude sees the prompt**:

```
- !`ls -1t ~/.claude/tasks/ ...`    → injects task directory listing
- !`ls ... | head -1 | xargs ...`   → injects current task files
```

Claude receives the output, not the commands. This is preprocessing, not tool use.

### 5. `${CLAUDE_SESSION_ID}`

Used in the skill body and in the JSONL log entry. Show how it gets substituted with the actual session ID at runtime.

### 6. `disable-model-invocation: true`

Only the user can invoke this skill — Claude never auto-triggers it. Explain: skills with side effects (writing files, calling APIs) should use this to prevent accidental invocation.

## Live Demo Steps

1. **Show the SKILL.md** — walk through the frontmatter, then the body
2. **Create some tasks first** so there's something to save:
   ```
   Help me plan a refactor of the auth module. Break it into tasks.
   ```
3. **Invoke the skill**: `/save-task-list`
4. **Point out to the audience**:
   - The `statusMessage` spinner text appearing during hook execution
   - The startup command output (`CLAUDE_CODE_TASK_LIST_ID=<id> claude`)
   - The JSONL log written to `.claude/archon/sessions/task-lists.jsonl`
5. **Show the Stop hook in action** — if Claude tried to finish without showing the task list ID, the prompt hook would catch it and force Claude to complete the work

## Comparison: Before vs After

| | Old Command | New Skill |
|---|---|---|
| Format | `.claude/commands/save-task-list.md` | `.claude/skills/save-task-list/SKILL.md` |
| Quality gates | None | Stop hook verifies output completeness |
| Observability | None | PostToolUse logs tool calls |
| Context | Static instructions | Dynamic `!`command`` injects live task state |
| Session tracking | None | `${CLAUDE_SESSION_ID}` in JSONL log |
| Invocation control | Anyone | `disable-model-invocation: true` |

## Talking Points

- "Hooks in skill frontmatter are scoped — they only live while the skill runs. No global side effects."
- "The prompt hook is an LLM checking another LLM's work. That's the quality gate pattern."
- "`once: true` prevents the hook from firing repeatedly — useful for one-time setup or logging."
- "Dynamic context injection means Claude starts with real data, not instructions to go find it."
