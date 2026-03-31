# Approval Nodes

DAG workflow nodes support an `approval` field that pauses workflow execution
until a human approves or rejects the gate. Use approval nodes to insert human
review steps between AI-driven nodes — for example, reviewing a generated plan
before committing to expensive implementation work.

## Quick Start

> **Web UI users:** Add `interactive: true` at the workflow level. Without it, the
> workflow dispatches to a background worker and approval gate messages won't appear
> in your chat window. See [Web Execution Mode](./authoring-workflows.md#web-execution-mode).

```yaml
name: plan-approve-implement
description: Plan, get approval, then implement
interactive: true   # Required for Web UI: ensures approval gates appear in chat

nodes:
  - id: plan
    prompt: |
      Analyze the codebase and create a detailed implementation plan.
      $USER_MESSAGE

  - id: review-gate
    approval:
      message: "Review the plan above before proceeding with implementation."
    depends_on: [plan]

  - id: implement
    command: implement
    depends_on: [review-gate]
```

When execution reaches `review-gate`, the workflow pauses and sends a message
to the user on whatever platform they're using (CLI, Slack, GitHub, etc.). On the
**Web UI**, `interactive: true` is required for the message to appear in your chat.

## How It Works

1. **Pause**: The executor sets the workflow run status to `paused` and stores
   the approval context (node ID and message) in the run's metadata.
2. **Notify**: A message is sent to the user with the approval prompt and
   instructions for approving or rejecting.
3. **Wait**: The workflow stays paused until the user takes action. Paused runs
   block the worktree path guard (no other workflow can start on the same path).
4. **Approve**: The user approves, which writes a `node_completed` event for
   the approval node and transitions the run to resumable. The CLI
   auto-resumes immediately; the API and chat commands transition the run
   so it resumes on the next workflow invocation.
5. **Reject**: The user rejects, which cancels the workflow.

## YAML Schema

```yaml
- id: gate-name
  approval:
    message: "Human-readable prompt shown to the user"
  depends_on: [upstream-node]  # optional
  when: "$plan.output != ''"   # optional condition
  trigger_rule: all_success    # optional (default: all_success)
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `approval.message` | string | Yes | The message shown to the user when the workflow pauses |

Approval nodes do not support AI-specific fields (`model`, `provider`, `context`,
`output_format`, `allowed_tools`, `denied_tools`, `hooks`, `mcp`, `skills`,
`idle_timeout`) since they don't invoke an AI agent.

Standard DAG fields (`id`, `depends_on`, `when`, `trigger_rule`, `retry`) work
as expected.

## Approving and Rejecting

### CLI

```bash
# Approve (resumes the workflow immediately)
bun run cli workflow approve <run-id>
bun run cli workflow approve <run-id> --comment "Looks good, proceed"

# Reject (cancels the workflow)
bun run cli workflow reject <run-id>
bun run cli workflow reject <run-id> --reason "Plan needs more test coverage"
```

### Chat Commands (Slack, Telegram, etc.)

```
/workflow approve <run-id> looks good
/workflow reject <run-id> needs changes
```

### Web UI

Paused workflows show an amber pulsing badge on the dashboard. Click **Approve**
or **Reject** directly on the workflow card.

### REST API

```bash
# Approve
curl -X POST http://localhost:3090/api/workflows/runs/<run-id>/approve \
  -H "Content-Type: application/json" \
  -d '{"comment": "Approved"}'

# Reject
curl -X POST http://localhost:3090/api/workflows/runs/<run-id>/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Needs revision"}'
```

## Downstream Output

The user's approval comment is available as `$<node-id>.output` in downstream
nodes. If no comment is provided, it defaults to `"Approved"`.

```yaml
nodes:
  - id: gate
    approval:
      message: "Any special instructions for implementation?"
    depends_on: [plan]

  - id: implement
    prompt: |
      Implement the plan. User feedback: $gate.output
    depends_on: [gate]
```

## Edge Cases

- **Multiple approval nodes**: Supported. Each pauses the workflow independently.
- **Approval in parallel layer**: Other nodes in the same layer complete normally;
  the workflow pauses at the layer boundary.
- **Server restart while paused**: The run persists in the database. The user can
  still approve or reject after restart.
- **Abandoning a paused run**: Use `/workflow abandon <id>` or the Abandon button
  on the dashboard.

## Design Notes

Approval nodes reuse the existing resume infrastructure (from workflow lifecycle
PR #871). When approved, the run transitions through `failed` status briefly so
that `findResumableRun` picks it up — this avoids duplicating resume logic. The
`metadata.approval_response` field distinguishes approved-then-resumed from
genuinely-failed runs.
