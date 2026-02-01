# Archon Customization Reference

Deep dive on creating and modifying Archon workflows, commands, and skills.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ARCHON SYSTEM                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   remote-coding-agent (Archon Server)                              │
│   ├── .archon/                                                     │
│   │   ├── workflows/defaults/    ← Bundled workflows (8 files)    │
│   │   └── commands/defaults/     ← Bundled commands (16 files)    │
│   └── .claude/skills/            ← Claude Code skills              │
│                                                                     │
│   target-repo (Your Project)                                       │
│   ├── .archon/                                                     │
│   │   ├── config.yaml            ← Required: repo config           │
│   │   ├── workflows/             ← Optional: override/add workflows│
│   │   ├── commands/              ← Optional: override/add commands │
│   │   └── artifacts/             ← Auto-created: outputs           │
│   ├── .claude/                                                     │
│   │   ├── settings.json          ← Optional: Claude settings       │
│   │   └── skills/                ← Optional: repo-specific skills  │
│   └── CLAUDE.md                  ← Highly recommended: AI context  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Loading Order & Overrides

### Workflows
1. Bundled defaults loaded from remote-coding-agent
2. Target repo `.archon/workflows/` files loaded
3. **Exact filename match = override** (e.g., `archon-assist.yaml`)
4. New filenames = additions to available workflows

### Commands
1. Bundled defaults loaded from remote-coding-agent
2. Target repo `.archon/commands/` files loaded
3. **Exact filename match = override** (e.g., `archon-assist.md`)
4. New filenames = additions to available commands

### Config
1. Built-in defaults (hardcoded)
2. Global config (`~/.archon/config.yaml`)
3. Repo config (`.archon/config.yaml`) ← **most commonly edited**

---

## Bundled Workflows (Defaults)

| Workflow | Steps | Purpose |
|----------|-------|---------|
| `archon-assist` | 1 | General help, catch-all |
| `archon-fix-github-issue` | 9 | Full issue → PR pipeline |
| `archon-comprehensive-pr-review` | 7 | 5 parallel review agents |
| `archon-feature-development` | 3 | Implement from plan |
| `archon-resolve-conflicts` | 3 | Auto-resolve merge conflicts |
| `archon-ralph-fresh` | loop | PRD iteration (fresh context) |
| `archon-ralph-stateful` | loop | PRD iteration (persistent) |
| `archon-test-loop` | loop | Test infrastructure |

### archon-fix-github-issue Pipeline

```
┌────────────────┐
│ PHASE 1        │
│ INVESTIGATE    │
├────────────────┤
│ archon-        │
│ investigate-   │
│ issue          │
└───────┬────────┘
        │ clearContext
        ▼
┌────────────────┐
│ PHASE 2        │
│ IMPLEMENT      │
├────────────────┤
│ archon-        │
│ implement-     │
│ issue          │
└───────┬────────┘
        │ clearContext
        ▼
┌────────────────┐
│ PHASE 3        │
│ REVIEW SETUP   │
├────────────────┤
│ pr-review-scope│
│ sync-pr-main   │
└───────┬────────┘
        │
        ▼
┌──────────────────────────────────────────┐
│ PARALLEL REVIEW (5 agents)               │
├──────────────────────────────────────────┤
│ code-review │ error-handling │ test-     │
│ agent       │ agent          │ coverage  │
│             │                │ agent     │
│ comment-    │ docs-impact    │           │
│ quality     │ agent          │           │
└──────────────────────────────────────────┘
        │
        ▼
┌────────────────┐
│ PHASE 4        │
│ FIX ISSUES     │
├────────────────┤
│ implement-     │
│ review-fixes   │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│ PHASE 5        │
│ SUMMARY        │
├────────────────┤
│ workflow-      │
│ summary        │
└────────────────┘
```

---

## Bundled Commands (Defaults)

| Command | Description |
|---------|-------------|
| `archon-assist` | General help, catch-all |
| `archon-investigate-issue` | Deep issue analysis, creates plan |
| `archon-implement-issue` | Implements from investigation artifact |
| `archon-implement` | General implementation from plan |
| `archon-create-pr` | Creates pull request |
| `archon-pr-review-scope` | Determines review scope |
| `archon-sync-pr-with-main` | Rebases PR onto main |
| `archon-code-review-agent` | Style, patterns, bugs |
| `archon-error-handling-agent` | Catch blocks, silent failures |
| `archon-test-coverage-agent` | Missing tests, edge cases |
| `archon-comment-quality-agent` | Documentation accuracy |
| `archon-docs-impact-agent` | README, CLAUDE.md updates |
| `archon-synthesize-review` | Combines all review findings |
| `archon-implement-review-fixes` | Auto-fixes CRITICAL/HIGH issues |
| `archon-resolve-merge-conflicts` | Conflict resolution logic |
| `archon-ralph-prd` | PRD iteration logic |

---

## Creating Custom Workflows

### Step-Based Workflow

```yaml
# .archon/workflows/my-workflow.yaml
name: my-workflow
description: |
  Use when: [when to trigger - be specific]
  Triggers: "keyword1", "keyword2"
  Does: [what it accomplishes]
  NOT for: [what it shouldn't be used for]

model: sonnet  # sonnet, opus, or haiku

steps:
  # First step - usually investigation/analysis
  - command: archon-investigate-issue

  # Second step - clear context to avoid bloat
  - command: my-custom-implementation
    clearContext: true

  # Parallel steps - run simultaneously
  - parallel:
      - command: review-agent-1
      - command: review-agent-2

  # Final step
  - command: summarize-results
    clearContext: true
```

### Loop-Based Workflow (Ralph-style)

```yaml
# .archon/workflows/my-loop-workflow.yaml
name: my-loop-workflow
description: |
  Use when: [iterative task description]
  Requires: [required files/setup]

loop:
  until: COMPLETE          # Signal to stop
  max_iterations: 10       # Safety limit
  fresh_context: true      # true = stateless, false = persistent

prompt: |
  # My Loop Agent

  You are executing iteration $ITERATION of $MAX_ITERATIONS.

  **User message**: $USER_MESSAGE

  ## Step 1: Check State
  [Read progress files...]

  ## Step 2: Do One Task
  [Execute single task...]

  ## Step 3: Update Tracking
  [Update progress files...]

  ## Step 4: Decide
  - If more work: continue
  - If done: output `<promise>COMPLETE</promise>`
```

---

## Creating Custom Commands

### Command Template

```markdown
<!-- .archon/commands/my-command.md -->
---
description: Brief description for workflow router AI
argument-hint: <expected-input-format>
---

# Command Name

**Input**: $ARGUMENTS

---

## Your Mission

[Clear statement of what this command accomplishes]

---

## Phase 1: UNDERSTAND

### 1.1 Parse Input
[How to interpret the input...]

### 1.2 Gather Context
[What to read/check...]

---

## Phase 2: EXECUTE

### 2.1 [Action Name]
[Detailed instructions...]

### 2.2 [Action Name]
[More instructions...]

---

## Phase 3: OUTPUT

### Artifact Creation
Save results to: `.archon/artifacts/[category]/[name].md`

### Format
\`\`\`markdown
# [Title]

## Summary
[Key findings...]

## Details
[Full analysis...]

## Recommendations
[Next steps...]
\`\`\`

---

## Checkpoints

- [ ] Input understood
- [ ] Context gathered
- [ ] Action completed
- [ ] Artifact saved
```

### Variable Substitution

| Variable | Source | Example |
|----------|--------|---------|
| `$ARGUMENTS` | User's full input | "Fix issue #42 in auth module" |
| `$1` | First word | "Fix" |
| `$2` | Second word | "issue" |
| `$USER_MESSAGE` | Raw message (loops) | Same as $ARGUMENTS |
| `$PLAN` | Session metadata | Previous plan content |

---

## Creating Skills (Claude Code)

Skills go in `.claude/skills/` and are loaded by Claude Code.

### Skill Structure

```
.claude/skills/my-skill/
├── SKILL.md           # Required: main skill (UPPERCASE!)
├── reference-1.md     # Optional: supporting docs
└── reference-2.md     # Optional: more docs
```

### SKILL.md Format

```markdown
---
name: my-skill
description: |
  Use when: [trigger conditions]
  Triggers: "keyword1", "keyword2", "phrase"
  Capability: [what it does]
argument-hint: [expected input]
---

# My Skill

[Skill content - instructions for Claude Code]

## When to Use
[Detailed trigger conditions...]

## How to Use
[Step-by-step guidance...]

## Reference Files
For detailed information, read:
- `reference-1.md` - [description]
- `reference-2.md` - [description]
```

---

## Artifacts System

Workflows produce artifacts in `.archon/artifacts/`:

```
.archon/artifacts/
├── issues/
│   └── issue-123.md        # Investigation results
├── plans/
│   └── feature-x.plan.md   # Implementation plans
├── reviews/
│   └── pr-456/
│       ├── code-review.md
│       ├── error-handling.md
│       └── synthesis.md
└── reports/
    └── workflow-summary.md
```

### Reading Artifacts in Commands

```markdown
## Load Previous Artifacts

Read the investigation artifact:
\`\`\`bash
cat .archon/artifacts/issues/issue-$ISSUE_NUMBER.md
\`\`\`

This contains:
- Root cause analysis
- Implementation plan
- Out of scope items
```

---

## Best Practices

### Workflow Design

1. **Single Responsibility** - Each step does one thing well
2. **Clear Context** - Use `clearContext: true` between major phases
3. **Parallel When Possible** - Independent reviews can run simultaneously
4. **Explicit Handoffs** - Artifacts bridge steps

### Command Design

1. **Phased Structure** - Understand → Execute → Output
2. **Checkpoints** - Verify progress before continuing
3. **Artifact Output** - Always save results to `.archon/artifacts/`
4. **Explicit Instructions** - Don't assume, specify exactly

### Skill Design

1. **Clear Triggers** - Be specific about when to use
2. **Reference Files** - Keep SKILL.md focused, details in references
3. **Actionable** - Skills should enable action, not just inform

---

## Troubleshooting Customizations

### Override Not Taking Effect

```bash
# Check what's loaded
bun run cli workflow list --cwd /path/to/repo

# Look for "override" messages in output
# Ensure exact filename match (case-sensitive!)
```

### Command Not Found

1. Check filename matches command reference (minus `.md`)
2. Ensure file is in `.archon/commands/` (not nested)
3. Check for YAML syntax errors in frontmatter

### Workflow Fails Mid-Execution

1. Check command exists for each step
2. Verify `clearContext` usage (too much = lost state, too little = bloat)
3. Read Claude's stderr output for errors

### Skill Not Invoked

1. Verify SKILL.md is uppercase
2. Check skill is in `.claude/skills/[name]/` structure
3. Verify description triggers match user language
