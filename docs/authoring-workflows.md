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

Archon discovers workflows recursively - subdirectories are fine.

> **CLI vs Server:** The CLI reads workflow files from wherever you run it (sees uncommitted changes). The server reads from the workspace clone at `~/.archon/workspaces/owner/repo/`, which only syncs from the remote before worktree creation. If you edit a workflow locally but don't push, the server won't see it.

---

## Two Workflow Types

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
model: sonnet                    # 'sonnet' or 'opus' (default: from config)

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
  - $BASE_BRANCH - base branch (config or auto-detected)
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

## Variable Substitution in Loops

Loop prompts support these variables:

| Variable | Description |
|----------|-------------|
| `$WORKFLOW_ID` | Unique ID for this workflow run |
| `$USER_MESSAGE` | Original message that triggered workflow |
| `$ARGUMENTS` | Same as `$USER_MESSAGE` |
| `$BASE_BRANCH` | Base branch from config or auto-detected from repo |
| `$CONTEXT` | GitHub issue/PR context (if available) |
| `$EXTERNAL_CONTEXT` | Same as `$CONTEXT` |
| `$ISSUE_CONTEXT` | Same as `$CONTEXT` |

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
2. **Two types**: Step-based (sequential) and loop-based (iterative)
3. **Artifacts are the glue** - Commands communicate via files, not memory
4. **`clearContext: true`** - Fresh session, works from artifacts
5. **Parallel execution** - Multiple agents, fresh sessions, shared artifacts
6. **Loops need signals** - Use `<promise>COMPLETE</promise>` to exit
7. **Test thoroughly** - Each command, the artifact flow, and edge cases
