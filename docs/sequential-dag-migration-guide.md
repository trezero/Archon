# Sequential-to-DAG Workflow Migration

The sequential `steps:` format has been removed. All workflows now use `nodes:` (DAG) format exclusively. Sequential workflows still work conceptually — you write them as linear DAG chains using `depends_on`.

## Pattern 1: Single step

Before:
```yaml
name: my-workflow
description: Does a thing
steps:
  - command: my-command
```

After:
```yaml
name: my-workflow
description: Does a thing
nodes:
  - id: my-command
    command: my-command
```

Each node needs a unique `id` (typically the same as the command name).

## Pattern 2: Sequential chain with clearContext

Before:
```yaml
steps:
  - command: investigate
  - command: implement
    clearContext: true
  - command: create-pr
    clearContext: true
```

After:
```yaml
nodes:
  - id: investigate
    command: investigate
  - id: implement
    command: implement
    depends_on: [investigate]
    context: fresh
  - id: create-pr
    command: create-pr
    depends_on: [implement]
    context: fresh
```

- `clearContext: true` becomes `context: fresh`
- The first node needs no `depends_on`
- Each subsequent node depends on the previous one

## Pattern 3: Parallel block

Before:
```yaml
steps:
  - command: setup
  - parallel:
      - command: agent-a
      - command: agent-b
      - command: agent-c
  - command: synthesize
```

After:
```yaml
nodes:
  - id: setup
    command: setup
  - id: agent-a
    command: agent-a
    depends_on: [setup]
  - id: agent-b
    command: agent-b
    depends_on: [setup]
  - id: agent-c
    command: agent-c
    depends_on: [setup]
  - id: synthesize
    command: synthesize
    depends_on: [agent-a, agent-b, agent-c]
```

All parallel agents depend on the same upstream node. The downstream node depends on all of them. By default (`trigger_rule: all_success`), `synthesize` runs only when all upstream agents succeed. Use `trigger_rule: one_success` if some upstream nodes may be skipped via `when:` conditions.

## Quick rules

- `steps:` becomes `nodes:`
- Each node needs a unique `id`
- `clearContext: true` becomes `context: fresh`
- Sequential order becomes explicit `depends_on: [previous-node-id]`
- `parallel:` block becomes multiple nodes sharing the same `depends_on`
- `allowed_tools`, `denied_tools`, `idle_timeout`, `retry` carry over unchanged

## Migrating with Claude Code

Run this in your terminal:

```
claude "Read docs/sequential-dag-migration-guide.md then convert all .archon/workflows/*.yaml files from steps: to nodes: format"
```
