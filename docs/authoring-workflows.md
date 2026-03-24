# Authoring Workflows for Archon

This guide explains how to create workflows that orchestrate multiple commands into automated pipelines. Read [Authoring Commands](./authoring-commands.md) first - workflows are built from commands.

## What is a Workflow?

A workflow is a **YAML file** that defines a sequence of commands to execute. Workflows enable:

- **Multi-step automation**: Chain multiple AI agents together
- **Artifact passing**: Output from step 1 becomes input for step 2
- **Autonomous loops**: Iterate until a condition is met

```yaml
name: fix-github-issue
description: Investigate and fix a GitHub issue end-to-end
steps:
  - command: investigate-issue
  - command: implement-issue
    clearContext: true
```

---

## File Location

Workflows live in `.archon/workflows/` relative to the working directory:

```
.archon/
├── workflows/
│   ├── my-workflow.yaml
│   └── review/
│       └── full-review.yaml    # Subdirectories work
└── commands/
    └── [commands used by workflows]
```

Archon discovers workflows recursively - subdirectories are fine. If a workflow file fails to load (syntax error, validation failure), it's skipped and the error is reported via `/workflow list`.

> **CLI vs Server:** The CLI reads workflow files from wherever you run it (sees uncommitted changes). The server reads from the workspace clone at `~/.archon/workspaces/owner/repo/`, which only syncs from the remote before worktree creation. If you edit a workflow locally but don't push, the server won't see it.

---

## Three Workflow Types

### 1. Step-Based Workflows

Execute commands in sequence:

```yaml
name: feature-development
description: Plan, implement, and create PR for a feature

steps:
  - command: create-plan
  - command: implement-plan
    clearContext: true
  - command: create-pr
    clearContext: true
```

### 2. Loop-Based Workflows

Iterate until completion signal:

```yaml
name: autonomous-implementation
description: Keep iterating until all tests pass

loop:
  until: COMPLETE
  max_iterations: 10
  fresh_context: false

prompt: |
  Read the plan and implement the next incomplete item.
  Run tests after each change.

  When ALL items pass validation, output:
  <promise>COMPLETE</promise>
```

### 3. DAG-Based Workflows (nodes:)

Execute nodes in dependency order with parallel layers and conditional branching:

```yaml
name: classify-and-fix
description: Classify issue type, then run the appropriate fix path

nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success
```

Nodes without `depends_on` run immediately. Nodes in the same topological layer run concurrently via `Promise.allSettled`. Skipped nodes (failed `when:` condition or `trigger_rule`) propagate their skipped state to dependants.

---

## Step-Based Workflow Schema

```yaml
# Required
name: workflow-name              # Unique identifier (kebab-case)
description: |                   # Multi-line description
  What this workflow does.
  When to use it.
  What it produces.

# Optional
provider: claude                 # 'claude' or 'codex' (default: from config)
model: sonnet                    # Model override (default: from config)
modelReasoningEffort: medium     # Codex only: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
webSearchMode: live              # Codex only: 'disabled' | 'cached' | 'live'
additionalDirectories:           # Codex only: Additional directories to include
  - /absolute/path/to/other/repo

# Required for step-based
steps:
  - command: step-one            # References .archon/commands/step-one.md

  - command: step-two
    clearContext: true           # Start fresh AI session (default: false)

  - parallel:                    # Run multiple commands concurrently
      - command: review-code
      - command: review-comments
      - command: review-tests
```

### Step Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | required | Command name (without `.md`) |
| `clearContext` | boolean | `false` | Start fresh session for this step |
| `allowed_tools` | string[] | — | Whitelist of built-in tools available to this step. `[]` disables all built-in tools. Claude only — Codex steps emit a warning and ignore this field |
| `denied_tools` | string[] | — | Blacklist of built-in tools to remove from this step. Claude only — Codex steps emit a warning and ignore this field |
| `retry` | object | — | Per-step retry configuration. See [Retry Configuration](#retry-configuration). Omit to use the automatic default (2 retries, 3 s base delay, transient errors only) |

### When to Use `clearContext: true`

Use fresh context when:
- The previous step produced an artifact the next step should read
- You want to avoid context pollution
- The next step has a completely different focus

```yaml
steps:
  - command: investigate-issue    # Explores codebase, writes artifact
  - command: implement-issue      # Reads artifact, implements fix
    clearContext: true            # Fresh start - works from artifact only
```

---

## Loop-Based Workflow Schema

```yaml
name: autonomous-loop
description: |
  Iterate until completion signal detected.
  Good for: PRD implementation, test-fix cycles, iterative refinement.

# Optional (same as step-based workflows)
provider: claude                 # 'claude' or 'codex' (default: from config)
model: sonnet                    # Model override (default: from config)
modelReasoningEffort: medium     # Codex only
webSearchMode: live              # Codex only
additionalDirectories:           # Codex only
  - /absolute/path/to/other/repo

# Required for loop-based
loop:
  until: COMPLETE                # Signal to detect in AI output
  max_iterations: 10             # Safety limit (fails if exceeded)
  fresh_context: false           # true = fresh session each iteration

# Required for loop-based
prompt: |
  Your instructions here.

  Variables available:
  - $WORKFLOW_ID - unique run identifier
  - $USER_MESSAGE - original trigger
  - $ARGUMENTS - same as $USER_MESSAGE
  - $BASE_BRANCH - base branch (auto-detected from git; optional config: worktree.baseBranch)
  - $CONTEXT - GitHub issue/PR context (if available)

  When done, output: <promise>COMPLETE</promise>
```

### Loop Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `until` | string | required | Completion signal to detect |
| `max_iterations` | number | required | Safety limit |
| `fresh_context` | boolean | `false` | Fresh session each iteration |

### Completion Signal Detection

The AI signals completion by outputting:

```
<promise>COMPLETE</promise>
```

Or (simpler but less reliable):
```
COMPLETE
```

The `<promise>` tags are recommended - they're case-insensitive and harder to accidentally trigger.

### When to Use `fresh_context`

| Setting | Use When | Tradeoff |
|---------|----------|----------|
| `false` | Short loops (<5 iterations), need memory | Context grows each iteration |
| `true` | Long loops, stateless work | Must track state in files |

**Stateful example** (memory preserved):
```yaml
loop:
  fresh_context: false  # AI remembers previous iterations
```

**Stateless example** (progress in files):
```yaml
loop:
  fresh_context: true   # AI starts fresh, reads progress from disk

prompt: |
  Read progress from .archon/progress.json
  Implement the next incomplete item.
  Update progress file.
  When all complete: <promise>COMPLETE</promise>
```

---

## DAG-Based Workflow Schema

```yaml
# Required
name: workflow-name
description: |
  What this workflow does.

# Optional (same as step/loop workflows)
provider: claude
model: sonnet
modelReasoningEffort: medium     # Codex only
webSearchMode: live              # Codex only

# Required for DAG-based
nodes:
  - id: classify                 # Unique node ID (used for dependency refs and $id.output)
    command: classify-issue      # Loads from .archon/commands/classify-issue.md
    output_format:               # Optional: enforce structured JSON output (Claude + Codex)
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]       # Wait for classify to complete
    when: "$classify.output.type == 'BUG'"  # Skip if condition is false

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success  # Run if at least one dep succeeded

  - id: inline-node
    prompt: "Summarize the changes made in $implement.output"  # Inline prompt (no command file)
    depends_on: [implement]
    context: fresh               # Force fresh session for this node
    provider: claude             # Per-node provider override
    model: haiku                 # Per-node model override
    # hooks:                     # Optional: per-node SDK hook callbacks (Claude only) — see docs/hooks.md
    # mcp: .archon/mcp/servers.json  # Optional: per-node MCP servers (Claude only)
    # skills: [remotion-best-practices]  # Optional: per-node skills (Claude only) — see docs/skills.md
```

### Node Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Unique node identifier. Used in `depends_on`, `when:`, and `$id.output` substitution |
| `command` | string | — | Command name to load from `.archon/commands/`. Mutually exclusive with `prompt` |
| `prompt` | string | — | Inline prompt string. Mutually exclusive with `command` |
| `depends_on` | string[] | `[]` | Node IDs that must complete before this node runs |
| `when` | string | — | Condition expression. Node is skipped if false |
| `trigger_rule` | string | `all_success` | Join semantics when multiple upstreams exist |
| `output_format` | object | — | JSON Schema for structured output. Supported for Claude and Codex nodes |
| `context` | `'fresh'` | — | Force a fresh AI session for this node |
| `provider` | `'claude'` \| `'codex'` | inherited | Per-node provider override |
| `model` | string | inherited | Per-node model override |
| `allowed_tools` | string[] | — | Whitelist of built-in tools for this node. `[]` disables all built-in tools (MCP-only mode). Claude only — Codex nodes emit a warning and ignore this field |
| `denied_tools` | string[] | — | Blacklist of built-in tools to remove from this node. Applied after `allowed_tools` if both are set. Claude only — Codex nodes emit a warning and ignore this field |
| `retry` | object | — | Per-node retry configuration. See [Retry Configuration](#retry-configuration). Omit to use the automatic default (2 retries, 3 s base delay, transient errors only) |
| `hooks` | object | — | Per-node SDK hook callbacks. Claude only — Codex nodes emit a warning and ignore this field. See [docs/hooks.md](./hooks.md) |
| `mcp` | string | — | Path to MCP server config JSON file (relative to cwd or absolute). Environment variables (`$VAR_NAME`) in `env`/`headers` values are expanded from `process.env` at execution time. Claude only — Codex nodes emit a warning and ignore this field. See [docs/mcp-servers.md](./mcp-servers.md) |
| `skills` | string[] | — | Skill names to preload into this node's agent context. Skills must be installed in `.claude/skills/`. The node is wrapped in an AgentDefinition with these skills + `Skill` auto-added to allowedTools. Claude only — Codex nodes emit a warning and ignore this field. See [docs/skills.md](./skills.md) |

### `trigger_rule` Values

| Value | Behavior |
|-------|----------|
| `all_success` | Run only if all upstream deps completed successfully (default) |
| `one_success` | Run if at least one upstream dep completed successfully |
| `none_failed_min_one_success` | Run if no deps failed AND at least one succeeded (skipped deps are ok) |
| `all_done` | Run when all deps are in a terminal state (completed, failed, or skipped) |

### `when:` Condition Syntax

Conditions use string equality against upstream node outputs:

```yaml
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"
when: "$nodeId.output.field == 'VALUE'"    # JSON dot notation for output_format nodes
```

- Uses `$nodeId.output` to reference the full output string of a completed node
- Use `$nodeId.output.field` to access a JSON field (for `output_format` nodes)
- Invalid expressions default to `true` (fail open — node runs rather than silently skipping)
- Skipped nodes propagate their skipped state to dependants

### `$node_id.output` Substitution

In node prompts and commands, reference the output of any upstream node:

```yaml
nodes:
  - id: classify
    command: classify-issue

  - id: fix
    command: implement-fix
    depends_on: [classify]
    # The command file can use $classify.output or $classify.output.field
```

Variable substitution order:
1. Standard variables (`$WORKFLOW_ID`, `$USER_MESSAGE`, `$ARTIFACTS_DIR`, etc.)
2. Node output references (`$nodeId.output`, `$nodeId.output.field`)

### `output_format` for Structured JSON

Use `output_format` to enforce JSON output from an AI node. For Claude, the schema is passed via the SDK's `outputFormat` option and `structured_output` is used directly. For Codex (v0.116.0+), the schema is passed via `TurnOptions.outputSchema` and the agent's inline JSON response is used. Both ensure clean JSON for `when:` conditions and `$nodeId.output` substitution:

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
        severity:
          type: string
          enum: [low, medium, high]
      required: [type]
```

- The output is captured as a JSON string and available via `$classify.output` (full JSON) or `$classify.output.type` (field access)
- Use `output_format` when downstream nodes need to branch on specific values via `when:`

### `allowed_tools` and `denied_tools` for Tool Restrictions

Restrict which built-in tools a node or step can use without relying on prompt instructions. Restrictions are enforced at the Claude SDK level.

```yaml
nodes:
  - id: review
    command: code-review
    allowed_tools: [Read, Grep, Glob]   # whitelist — only these tools available

  - id: implement
    command: implement-feature
    denied_tools: [WebSearch, WebFetch] # blacklist — remove these tools

  - id: mcp-only
    command: mcp-command
    allowed_tools: []                   # empty list = disable all built-in tools
```

The same fields work on sequential steps:

```yaml
steps:
  - command: read-only-analysis
    allowed_tools: [Read, Grep, Glob]
  - command: implement
    denied_tools: [WebSearch]
```

- `allowed_tools: []` disables all built-in tools (useful for MCP-only nodes). Use the `mcp` field on a node to attach per-node MCP servers — see [Node Fields](#node-fields)
- If both are set, `denied_tools` is applied after `allowed_tools`
- `undefined` (field absent) and `[]` have different semantics — absent means use default tool set, `[]` means no tools
- Claude only — Codex nodes/steps emit a warning and continue (Codex doesn't support per-call tool restrictions)

---

## Retry Configuration

Every step and DAG node automatically retries on **transient** errors (SDK subprocess crashes, rate limits, network timeouts) using a default configuration: **2 retries**, **3 s base delay** with exponential backoff. You will see a platform notification before each retry attempt.

To opt out or customise, add a `retry:` block:

```yaml
# Step-based workflow
steps:
  - command: flaky-step
    retry:
      max_attempts: 3      # Total attempts including the first (1–5)
      delay_ms: 5000       # Base delay before first retry in ms (1000–60000, default: 3000)
      on_error: transient  # 'transient' (default) | 'all'

  - command: no-retry-step
    retry:
      max_attempts: 1      # Effectively disables retry
```

```yaml
# DAG-based workflow
nodes:
  - id: flaky-node
    command: flaky-command
    retry:
      max_attempts: 3
      delay_ms: 5000
      on_error: transient

  - id: aggressive-retry
    prompt: "Summarise the output"
    retry:
      max_attempts: 4
      on_error: all        # Retry even non-transient errors (use with caution)
```

### Retry Fields

| Field | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `max_attempts` | number | `3` | 1–5 | Total attempts including the first. `1` disables retry |
| `delay_ms` | number | `3000` | 1000–60000 | Base delay in ms before the first retry. Doubles each attempt (exponential backoff) |
| `on_error` | `'transient'` \| `'all'` | `'transient'` | — | Which errors trigger a retry. `'transient'` = SDK crashes, rate limits, network timeouts only. `'all'` = any error including unknown errors (FATAL errors such as auth failures are never retried regardless) |

### Error Classification

Archon classifies errors into three buckets before deciding whether to retry:

| Class | Examples | Retried by default? |
|-------|----------|---------------------|
| **FATAL** | Auth failure, permission denied, credit balance exhausted | ❌ Never (even with `on_error: all`) |
| **TRANSIENT** | Process crashed (`exited with code`), rate limit, network timeout | ✅ Yes |
| **UNKNOWN** | Unrecognised error messages | ❌ No (unless `on_error: all`) |

### Retry Notifications

Before each retry the platform receives a message like:

```
⚠️ Step `step-name` failed with transient error (attempt 1/3). Retrying in 3s...
```

### Two-Layer Retry Stack

Archon uses two independent retry layers:

```
SDK subprocess retry (claude.ts)  — 3 total attempts, 2 s base backoff
    ↓ only if all SDK retries exhausted
Step/node retry (executor / dag-executor)  — default 2 retries, 3 s base backoff
    ↓ only if all step retries exhausted
Workflow fails → steps: user can --resume | nodes: next invocation auto-resumes
```

This means a single transient crash may trigger up to **3 SDK retries** before a single step retry attempt is consumed.

> **DAG resume**: For `nodes:` (DAG) workflows, resume is automatic — the next invocation detects the prior failed run and skips already-completed nodes. No `--resume` flag is needed. See [DAG Resume on Failure](#dag-resume-on-failure) below.

---

## DAG Resume on Failure

When a `nodes:` (DAG) workflow fails, the next invocation automatically resumes from where it left off — no `--resume` flag required.

**How it works:**

1. On each invocation, Archon checks for a prior failed run of the same workflow in the same conversation.
2. If found, it loads the `node_completed` events from that run to determine which nodes finished successfully.
3. Completed nodes are skipped; only failed and not-yet-run nodes are executed.
4. You receive a platform message like: `▶️ Resuming DAG workflow — skipping 3 already-completed node(s).`

**Known limitation**: AI session context from prior nodes is not restored. If a downstream node relies on in-context knowledge from a prior run's session (rather than artifacts), it may need to re-read those artifacts explicitly.

**Fresh start**: If zero nodes completed in the prior run, Archon starts fresh (no nodes to skip).

**Contrast with `steps:` workflows**: Sequential (`steps:`) workflows use the `--resume` flag to restart from a specific step. DAG workflows handle this automatically at the node level.

---

## Parallel Execution

Run multiple commands concurrently within a step:

```yaml
steps:
  - command: setup-scope          # Creates shared context

  - parallel:                     # These run at the same time
      - command: review-code
      - command: review-comments
      - command: review-security

  - command: synthesize-reviews   # Combines all review artifacts
    clearContext: true
```

### Parallel Execution Rules

1. **Each parallel command gets a fresh session** - no context sharing
2. **All commands must complete** before workflow continues
3. **All failures are reported** - not just the first one
4. **Shared state via artifacts** - commands read/write to known paths

### Pattern: Coordinator + Parallel Agents

```yaml
name: comprehensive-review
steps:
  # Step 1: Coordinator creates scope artifact
  - command: create-review-scope

  # Step 2: Parallel agents read scope, write findings
  - parallel:
      - command: code-review-agent
      - command: comment-quality-agent
      - command: test-coverage-agent

  # Step 3: Synthesizer reads all findings, posts summary
  - command: synthesize-review
    clearContext: true
```

The coordinator writes to `.archon/artifacts/reviews/pr-{n}/scope.md`.
Each agent reads scope, writes to `{category}-findings.md`.
The synthesizer reads all findings and produces final output.

---

## The Artifact Chain

Workflows work because **artifacts pass data between steps**:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Step 1          │     │ Step 2          │     │ Step 3          │
│ investigate     │     │ implement       │     │ create-pr       │
│                 │     │                 │     │                 │
│ Reads: input    │     │ Reads: artifact │     │ Reads: git diff │
│ Writes: artifact│────▶│ Writes: code    │────▶│ Writes: PR      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
  .archon/artifacts/      src/feature.ts
  issues/issue-123.md     src/feature.test.ts
```

### Designing Artifact Flow

When creating a workflow, plan the artifact chain:

| Step | Reads | Writes |
|------|-------|--------|
| `investigate-issue` | GitHub issue via `gh` | `.archon/artifacts/issues/issue-{n}.md` |
| `implement-issue` | Artifact from step 1 | Code files, tests |
| `create-pr` | Git diff | GitHub PR |

Each command must know:
- Where to find its input
- Where to write its output
- What format to use

---

## Model Configuration

Workflows can configure AI models and provider-specific options at the workflow level.

### Configuration Priority

Model and options are resolved in this order:

1. **Workflow-level** - Explicit settings in the workflow YAML
2. **Config defaults** - `assistants.*` in `.archon/config.yaml`
3. **SDK defaults** - Built-in defaults from Claude/Codex SDKs

### Provider and Model

```yaml
name: my-workflow
provider: claude     # 'claude' or 'codex' (default: from config)
model: sonnet        # Model override (default: from config assistants.claude.model)
```

**Claude models:**
- `sonnet` - Fast, balanced (recommended)
- `opus` - Powerful, expensive
- `haiku` - Fast, lightweight
- `claude-*` - Full model IDs (e.g., `claude-3-5-sonnet-20241022`)
- `inherit` - Use model from previous session

**Codex models:**
- Any OpenAI model ID (e.g., `gpt-5.3-codex`, `o5-pro`)
- Cannot use Claude model aliases

### Codex-Specific Options

```yaml
name: my-workflow
provider: codex
model: gpt-5.3-codex
modelReasoningEffort: medium    # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
webSearchMode: live             # 'disabled' | 'cached' | 'live'
additionalDirectories:
  - /absolute/path/to/other/repo
  - /path/to/shared/library
```

**Model reasoning effort:**
- `minimal`, `low` - Fast, cheaper
- `medium` - Balanced (default)
- `high`, `xhigh` - More thorough, expensive

**Web search mode:**
- `disabled` - No web access (default)
- `cached` - Use cached search results
- `live` - Real-time web search

**Additional directories:**
- Codex can access files outside the codebase
- Useful for shared libraries, documentation repos
- Must be absolute paths

### Model Validation

Workflows are validated at load time:
- Provider/model compatibility checked
- Invalid combinations fail with clear error messages
- Validation errors shown in `/workflow list`

Example validation error:
```
Model "sonnet" is not compatible with provider "codex"
```

### Example: Config Defaults + Workflow Override

**`.archon/config.yaml`:**
```yaml
assistants:
  claude:
    model: haiku  # Fast model for most tasks
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: low
    webSearchMode: disabled
```

**Workflow with override:**
```yaml
name: complex-analysis
description: Deep code analysis requiring powerful model
provider: claude
model: opus  # Override config default (haiku) for this workflow
steps:
  - command: analyze-architecture
  - command: generate-report
```

The workflow uses `opus` instead of the config default `haiku`, but other settings inherit from config.

---

## Workflow Description Best Practices

Write descriptions that help with routing and user understanding:

```yaml
description: |
  Investigate and fix a GitHub issue end-to-end.

  **Use when**: User provides a GitHub issue number or URL
  **NOT for**: Feature requests, refactoring, documentation

  **Produces**:
  - Investigation artifact
  - Code changes
  - Pull request linked to issue

  **Steps**:
  1. Investigate root cause
  2. Implement fix with tests
  3. Create PR
```

Good descriptions include:
- What the workflow does
- When to use it (and when NOT to)
- What it produces
- High-level steps

---

## Variable Substitution

All workflow types (steps, loop, nodes) support these variables in prompts and commands:

| Variable | Description |
|----------|-------------|
| `$WORKFLOW_ID` | Unique ID for this workflow run |
| `$USER_MESSAGE` | Original message that triggered workflow |
| `$ARGUMENTS` | Same as `$USER_MESSAGE` |
| `$ARTIFACTS_DIR` | Pre-created artifacts directory for this workflow run |
| `$BASE_BRANCH` | Base branch; auto-detected from git when `worktree.baseBranch` is not set. Fails only if referenced and detection fails |
| `$CONTEXT` | GitHub issue/PR context (if available) |
| `$EXTERNAL_CONTEXT` | Same as `$CONTEXT` |
| `$ISSUE_CONTEXT` | Same as `$CONTEXT` |
| `$nodeId.output` | Output of a completed upstream DAG node (DAG workflows only) |
| `$nodeId.output.field` | JSON field from a structured upstream node output (DAG workflows only) |

Example:
```yaml
prompt: |
  Workflow: $WORKFLOW_ID
  Original request: $USER_MESSAGE

  GitHub context:
  $CONTEXT

  [Instructions...]
```

---

## Example Workflows

### Simple Two-Step

```yaml
name: quick-fix
description: |
  Fast bug fix without full investigation.
  Use when: Simple, obvious bugs.
  NOT for: Complex issues needing root cause analysis.

steps:
  - command: analyze-and-fix
  - command: create-pr
    clearContext: true
```

### Investigation Pipeline

```yaml
name: fix-github-issue
description: |
  Full investigation and fix for GitHub issues.

  Use when: User provides issue number/URL
  Produces: Investigation artifact, code fix, PR

steps:
  - command: investigate-issue    # Creates .archon/artifacts/issues/issue-{n}.md
  - command: implement-issue      # Reads artifact, implements fix
    clearContext: true
```

### Parallel Review

```yaml
name: comprehensive-pr-review
description: |
  Multi-agent PR review covering code, comments, tests, and security.

  Use when: Reviewing PRs before merge
  Produces: Review findings, synthesized summary

steps:
  - command: create-review-scope

  - parallel:
      - command: code-review-agent
      - command: comment-quality-agent
      - command: test-coverage-agent
      - command: security-review-agent

  - command: synthesize-reviews
    clearContext: true
```

### Autonomous Loop

```yaml
name: implement-prd
description: |
  Autonomously implement a PRD, iterating until all stories pass.

  Use when: Full PRD implementation
  Requires: PRD file at .archon/prd.md

loop:
  until: COMPLETE
  max_iterations: 15
  fresh_context: true       # Progress tracked in files

prompt: |
  # PRD Implementation Loop

  Workflow: $WORKFLOW_ID

  ## Instructions

  1. Read PRD from `.archon/prd.md`
  2. Read progress from `.archon/progress.json`
  3. Find the next incomplete story
  4. Implement it with tests
  5. Run validation: `bun run validate`
  6. Update progress file
  7. If ALL stories complete and validated:
     Output: <promise>COMPLETE</promise>

  ## Progress File Format

  ```json
  {
    "stories": [
      {"id": 1, "status": "complete", "validated": true},
      {"id": 2, "status": "in_progress", "validated": false}
    ]
  }
  ```

  ## Important

  - Implement ONE story per iteration
  - Always run validation after changes
  - Update progress file before ending iteration
```

### DAG: Classify and Route

```yaml
name: classify-and-fix
description: |
  Classify issue type and run the appropriate path in parallel.

  Use when: User reports a bug or requests a feature
  Produces: Code fix (bug path) or feature plan (feature path), then PR

nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success

  - id: create-pr
    command: create-pr
    depends_on: [implement]
    context: fresh
```

### Test-Fix Loop

```yaml
name: fix-until-green
description: |
  Keep fixing until all tests pass.
  Use when: Tests are failing and need automated fixing.

loop:
  until: ALL_TESTS_PASS
  max_iterations: 5
  fresh_context: false      # Remember what we've tried

prompt: |
  # Fix Until Green

  ## Instructions

  1. Run tests: `bun test`
  2. If all pass: <promise>ALL_TESTS_PASS</promise>
  3. If failures:
     - Analyze the failure
     - Fix the code (not the test, unless test is wrong)
     - Run tests again

  ## Rules

  - Don't skip or delete failing tests
  - Don't modify test expectations unless they're wrong
  - Each iteration should fix at least one failure
```

---

## Common Patterns

### Pattern: Gated Execution

Run different paths based on conditions:

```yaml
name: smart-fix
description: Route to appropriate fix strategy based on issue complexity

steps:
  - command: analyze-complexity   # Writes complexity assessment
  - command: route-to-strategy    # Reads assessment, invokes appropriate workflow
    clearContext: true
```

The `route-to-strategy` command reads the complexity artifact and can invoke sub-workflows.

### Pattern: Checkpoint and Resume

For long workflows, save checkpoints:

```yaml
name: large-migration
description: Multi-file migration with checkpoint recovery

steps:
  - command: create-migration-plan    # Writes plan artifact
  - command: migrate-batch-1          # Checkpoints after each batch
    clearContext: true
  - command: migrate-batch-2
    clearContext: true
  - command: validate-migration
    clearContext: true
```

Each batch command saves progress to an artifact, allowing recovery if the workflow fails mid-way.

### Pattern: Human-in-the-Loop

Pause for human approval:

```yaml
name: careful-refactor
description: Refactor with human approval at each stage

steps:
  - command: propose-refactor         # Creates proposal artifact
  # Workflow pauses here - human reviews proposal
  # Human triggers next workflow to continue:
```

Then a separate workflow to continue:
```yaml
name: execute-refactor
steps:
  - command: execute-approved-refactor
  - command: create-pr
    clearContext: true
```

---

## Debugging Workflows

### Check Workflow Discovery

```bash
bun run cli workflow list
```

### Run with Verbose Output

```bash
bun run cli workflow run {name} "test input"
```

Watch the streaming output to see each step.

### Check Artifacts

After a workflow runs, check the artifacts:

```bash
ls -la .archon/artifacts/
cat .archon/artifacts/issues/issue-*.md
```

### Check Logs

Workflow execution logs to:
```
.archon/logs/{workflow-id}.jsonl
```

Each line is a JSON event (step start, AI response, tool call, etc.).

---

## Workflow Validation

Before deploying a workflow:

1. **Test each command individually**
   ```bash
   bun run cli workflow run {workflow} "test input"
   ```

2. **Verify artifact flow**
   - Does step 1 produce what step 2 expects?
   - Are paths correct?
   - Is the format complete?

3. **Test edge cases**
   - What if the input is invalid?
   - What if a step fails?
   - What if an artifact is missing?

4. **Check iteration limits** (for loops)
   - Is `max_iterations` reasonable?
   - What happens when limit is hit?

---

## Summary

1. **Workflows orchestrate commands** - YAML files that define execution order
2. **Three types**: Step-based (sequential), loop-based (iterative), and DAG-based (dependency graph)
3. **Artifacts are the glue** - Commands communicate via files, not memory
4. **`clearContext: true`** - Fresh session for a step, works from artifacts
5. **Parallel execution** - Step `parallel:` blocks and DAG nodes in the same layer both run concurrently
6. **Loops need signals** - Use `<promise>COMPLETE</promise>` to exit
7. **DAG branching** - `when:` conditions and `trigger_rule` control which nodes run
8. **`output_format`** - Enforce structured JSON output from AI nodes for reliable branching
9. **`allowed_tools` / `denied_tools`** - Restrict which tools a node or step can use (Claude only, enforced at SDK level)
10. **`retry:`** - All steps/nodes auto-retry transient errors (default: 2 retries, 3 s backoff); configure per-step with `retry:` block
11. **`hooks`** — Attach static SDK hook callbacks to individual Claude nodes for tool control and context injection (see [docs/hooks.md](./hooks.md))
12. **`mcp:`** — Attach per-node MCP servers via a JSON config file path (Claude only; env vars expanded at execution time); use with `allowed_tools: []` for MCP-only nodes
13. **`skills:`** — Preload named skills into individual Claude nodes for domain expertise (Claude only; see [docs/skills.md](./skills.md))
14. **Test thoroughly** - Each command, the artifact flow, and edge cases
