---
name: silo-orchestration
description: |
  Use when: Working on Eskerium platform features (frontend, backend, or cross-system).
  Triggers: "silo", "eskerium", "frontend", "backend", "full-stack", "harvest", "portal"
  Capability: Orchestrates Archon workflows across Eskerium frontend and backend repositories.
  Also helps customize and improve Archon workflows, commands, and skills for these repos.
argument-hint: [task description - specify frontend/backend/both if known]
---

# Silo Orchestration

Unified orchestration for the Eskerium platform. Use this skill when working on any Silo-related features or when customizing Archon behavior for these repos.

---

## YOUR ROLE AS ORCHESTRATOR (READ THIS FIRST)

**You are the orchestrator.** Your job is to:

1. **Listen** - User tells you what they want in plain English
2. **Understand** - Figure out what needs to happen (which repo, which workflow, what investigation is needed)
3. **Investigate** - If you don't know where a bug is or what's broken, use `archon-assist` to find out FIRST
4. **Plan** - Present your plan to the user for review before executing
5. **Execute** - Run the appropriate Archon CLI commands
6. **Report** - Summarize what happened

### CRITICAL RULES

❌ **NEVER edit target repo files directly.** You orchestrate via CLI. Archon agents do the actual coding.

❌ **NEVER guess which repo has a bug.** If you don't know, investigate first.

❌ **NEVER run implementation workflows without user approval.** Present your plan, get approval, then execute.

⚠️ **NO WORKTREES - ALWAYS USE `--no-worktree`**

This is non-negotiable right now. Worktrees add complexity we're not ready for.

```bash
# CORRECT - always include --no-worktree
bun run cli workflow run archon-idea-to-pr --cwd /path/to/repo --no-worktree "description"

# WRONG - do not use --branch, do not omit --no-worktree
bun run cli workflow run archon-idea-to-pr --cwd /path/to/repo --branch feature/x "description"
```

Every single CLI command MUST have `--no-worktree`. No exceptions. We will add worktree support later.

---

✅ **You ARE the expert.** User shouldn't have to tell you which workflow to use or which repo to target. That's YOUR job to figure out.

✅ **You RUN the CLI commands.** Translate user intent into `bun run cli workflow run ...` commands.

✅ **You ASK questions via `archon-assist`** when you need information from a codebase before deciding what to do.

---

## Workflow Selection

**NEVER use `archon-assist` for feature implementation.**

| Task | Workflow | Why |
|------|----------|-----|
| Implement a feature from description | `archon-idea-to-pr` | Creates plan, implements, validates, reviews |
| Execute an existing plan | `archon-plan-to-pr` | Implements from plan, validates, reviews |
| Quick question or debugging | `archon-assist` | One-off help only |
| Fix a GitHub issue | `archon-fix-github-issue` | Investigates, fixes, reviews |
| Review an existing PR | `archon-comprehensive-pr-review` | 5 parallel review agents |

### Decision Flow

```
User Request
    │
    ▼
Do you know WHICH REPO has the problem?
    │
    ├─ NO ──► INVESTIGATE FIRST
    │         Use `archon-assist` on the likely repo to ask questions.
    │         Example: "Does the machines API return data? What does the response look like?"
    │         Then return to this flow with your findings.
    │
    ▼ YES
    │
What type of work is this?
    │
    ├─ Have a detailed plan file? ──► `archon-plan-to-pr`
    ├─ Feature idea/description? ──► `archon-idea-to-pr`
    ├─ Bug with GitHub issue? ──► `archon-fix-github-issue`
    ├─ Quick question/exploration? ──► `archon-assist`
    │
    ▼
Present plan to user for approval
    │
    ▼
Execute CLI command(s)
```

**The key insight:** You cannot pick an implementation workflow until you know which repo to target. If you don't know, investigate first.

### WARNING: archon-assist Limitations

`archon-assist` is for **ONE-OFF help only**:
- Questions about the codebase
- Debugging specific issues
- Exploring code

**DO NOT use archon-assist for:**
- Feature implementation
- Multi-step changes
- Anything requiring planning or review

**If you catch yourself writing a long description for archon-assist, STOP.**
Use `archon-idea-to-pr` instead.

---

## Repository Configuration

### Frontend (Next.js)
- **Path:** `/Users/administrator/Software/eskerium/agent-orchestrator/apps/eskerium/web-frontend`
- **Base Branch:** `dev`
- **Tech Stack:** Next.js 15, React, Tailwind CSS, Shadcn UI, Zustand, CopilotKit, Mastra

### Backend (Django)
- **Path:** `/Users/administrator/Software/eskerium/agent-orchestrator/apps/eskerium/silo-backend`
- **Base Branch:** `development`
- **Tech Stack:** Django 4.2, DRF 3.15, PostgreSQL 13.14, Redis, Django Channels

## Decision Matrix: Which Repo to Target

| Task Type | Target Repo | Examples |
|-----------|-------------|----------|
| UI/UX changes | Frontend | "Add button", "Fix modal", "Update styles" |
| API endpoints | Backend | "Create endpoint", "Add field to API" |
| Data models | Backend | "Add database field", "New model" |
| State management | Frontend | "Add Zustand store", "Fix state bug" |
| Authentication | Both | Login flows touch both systems |
| New feature | Both | Usually needs API + UI |
| Bug fix | **INVESTIGATE FIRST** | See below |

### Bug Fix Investigation Process

When something is broken and you don't know if it's frontend or backend:

1. **Use `archon-assist` to investigate the likely culprit:**
   ```bash
   bun run cli workflow run archon-assist \
     --cwd /path/to/likely-repo \
     --no-worktree \
     "Quick investigation: [describe what you need to know]"
   ```

2. **Common investigation questions:**
   - Backend: "Does the /api/extraction/machines/ endpoint return data? What's the response format?"
   - Frontend: "How does the component fetch machines? What does the API call look like?"

3. **Based on findings, determine:**
   - Is the data missing from the database?
   - Is the API not returning data correctly?
   - Is the frontend not handling the response?

4. **THEN pick the implementation workflow for the correct repo(s).**

**Example:** User says "machine dropdown is empty"
- ❌ WRONG: Assume it's frontend, run `archon-idea-to-pr` on frontend
- ✅ RIGHT: First run `archon-assist` on backend to check if machines exist and API returns them. Based on findings, target the correct repo.

---

## CRITICAL: Cross-Repo Feature Implementation

**When a feature requires BOTH backend AND frontend changes, you MUST follow this sequence:**

### Step 1: Backend First (BLOCKING)

Run the backend workflow FIRST and wait for it to complete:

```bash
bun run cli workflow run archon-idea-to-pr \
  --cwd /Users/administrator/Software/eskerium/agent-orchestrator/apps/eskerium/silo-backend \
  --no-worktree \
  "Backend: [feature description with API contract details]"
```

**Wait for the workflow to complete.** Do not proceed until you have:
- The PR created
- The actual API response format documented

### Step 2: Analyze Backend Output (REQUIRED)

Before starting frontend, you MUST:

1. **Read the actual backend code** to see what the API returns
2. **Document the exact response structure** including:
   - Field names (exact spelling)
   - Data types
   - Nested object structure
3. **Compare against the original plan** - note any deviations

Example verification:
```bash
# Check the actual serializer/view output
grep -A 50 "return Response" /path/to/views.py
```

### Step 3: Frontend Second (Uses Actual Contract)

Only AFTER verifying the backend contract, run frontend:

```bash
bun run cli workflow run archon-idea-to-pr \
  --cwd /Users/administrator/Software/eskerium/agent-orchestrator/apps/eskerium/web-frontend \
  --no-worktree \
  "Frontend: [feature description]

IMPORTANT - Use these EXACT field names from the backend API:
- [field1]: [type]
- [field2]: [type]
- ...

The backend returns this structure:
[paste actual response structure from Step 2]"
```

### Why This Order Matters

- Backend defines the API contract (source of truth)
- Frontend must consume what backend provides
- Running in parallel causes contract mismatches
- The frontend prompt MUST include the actual backend response format

### NEVER Do This

❌ Run frontend and backend workflows in parallel
❌ Assume the plan's field names will match implementation
❌ Start frontend before verifying backend API response
❌ Use different field names between frontend types and backend serializers

---

## Archon CLI Commands

### IMPORTANT: Default Mode (No Worktrees)

**ALWAYS use `--no-worktree` unless explicitly told otherwise.** Changes go directly to the current branch in the existing directory.

### Feature Implementation (RECOMMENDED)

Use `archon-idea-to-pr` for implementing features:

**Frontend work:**
```bash
bun run cli workflow run archon-idea-to-pr \
  --cwd /Users/administrator/Software/eskerium/agent-orchestrator/apps/eskerium/web-frontend \
  --no-worktree \
  "Full feature description with all requirements"
```

**Backend work:**
```bash
bun run cli workflow run archon-idea-to-pr \
  --cwd /Users/administrator/Software/eskerium/agent-orchestrator/apps/eskerium/silo-backend \
  --no-worktree \
  "Full feature description with all requirements"
```

### Executing an Existing Plan

Use `archon-plan-to-pr` when you already have a plan:

```bash
bun run cli workflow run archon-plan-to-pr \
  --cwd /path/to/repo \
  --no-worktree \
  "/path/to/plan.md"
```

### Questions and Debugging ONLY

Use `archon-assist` **ONLY** for quick questions or debugging (NOT for feature implementation):

```bash
bun run cli workflow run archon-assist \
  --cwd /path/to/repo \
  --no-worktree \
  "Quick question or debug help"
```

### Worktree Isolation (DISABLED - DO NOT USE)

**Worktrees are NOT supported right now.** Do not use `--branch`. Always use `--no-worktree`.

This will be enabled in a future update. For now, ignore any worktree-related options.

### Available Workflows

| Workflow | Use For | NOT For |
|----------|---------|---------|
| `archon-idea-to-pr` | Feature implementation from description | Quick fixes, questions |
| `archon-plan-to-pr` | Execute existing plan | Creating plans |
| `archon-fix-github-issue` | Bug fixes from GitHub issues | Features |
| `archon-comprehensive-pr-review` | PR code review | Implementation |
| `archon-assist` | Questions, debugging **ONLY** | Feature implementation |
| `archon-ralph-fresh` | PRD-based development (stateless) | Ad-hoc features |
| `archon-ralph-stateful` | PRD-based development (stateful) | Long PRDs |
| `archon-resolve-conflicts` | Auto-resolve merge conflicts | Complex conflicts |

---

## Customizing Archon for Target Repos

**Reference:** See `docs/target-repo-setup.md` for complete setup guide.

### Override Hierarchy

Archon loads configuration in this order (later overrides earlier):

```
1. Bundled Defaults (.archon/workflows/defaults/ in remote-coding-agent)
2. Target Repo Files (.archon/workflows/ in target repo)
3. Target Repo Config (.archon/config.yaml)
```

**Key insight:** To customize behavior for a specific repo, add files to that repo's `.archon/` folder - don't modify the remote-coding-agent defaults unless the change should apply everywhere.

### When to Create Local Overrides

| Scenario | Location | What to Create |
|----------|----------|----------------|
| Repo-specific workflow behavior | Target repo `.archon/workflows/` | Custom workflow YAML |
| Repo-specific command prompts | Target repo `.archon/commands/` | Custom command MD |
| Repo-specific AI skills | Target repo `.claude/skills/` | SKILL.md + supporting files |
| Universal improvement | remote-coding-agent | Update bundled defaults |

### Creating a Custom Workflow (Target Repo)

1. Create the workflow file:
```yaml
# target-repo/.archon/workflows/my-custom-workflow.yaml
name: my-custom-workflow
description: |
  Use when: [describe trigger conditions]
  Does: [describe what it accomplishes]

model: sonnet

steps:
  - command: archon-investigate-issue
  - command: my-custom-command
    clearContext: true
```

2. Create supporting commands if needed:
```markdown
<!-- target-repo/.archon/commands/my-custom-command.md -->
---
description: Custom command for this specific repo
argument-hint: <input>
---

# My Custom Command

**Input**: $ARGUMENTS

[Custom instructions for this repo's patterns]
```

### Overriding a Default Workflow

To modify how `archon-fix-github-issue` works for a specific repo:

1. Copy the default from remote-coding-agent:
   ```
   .archon/workflows/defaults/archon-fix-github-issue.yaml
   ```

2. Place in target repo (EXACT same filename):
   ```
   target-repo/.archon/workflows/archon-fix-github-issue.yaml
   ```

3. Modify as needed - this version will be used instead of the default.

### Overriding a Default Command

Same pattern - create a file with the EXACT same name:

```markdown
<!-- target-repo/.archon/commands/archon-assist.md -->
---
description: Customized assist for this repo
argument-hint: <any request>
---

# Assist Mode (Customized for This Project)

**Request**: $ARGUMENTS

## Project-Specific Context

This is a [describe project type] project using [tech stack].

Key patterns to follow:
1. [Pattern 1]
2. [Pattern 2]

## Instructions

[Custom instructions]
```

---

## Improving Archon Workflows

When troubleshooting or improving workflows, consider:

### Where to Make Changes

| Issue Type | Where to Fix |
|------------|--------------|
| Workflow step order/logic | `.archon/workflows/*.yaml` |
| Command prompt/instructions | `.archon/commands/*.md` |
| AI behavior/skills | `.claude/skills/` |
| Config (base branch, copyFiles) | `.archon/config.yaml` |
| SDK settings | `.claude/settings.json` |

### Workflow Structure

```yaml
name: workflow-name
description: |
  Use when: [trigger conditions]
  Does: [what it accomplishes]

model: sonnet  # or opus, haiku

steps:
  # Sequential step
  - command: command-name
    clearContext: true  # Optional: start fresh context

  # Parallel steps (run simultaneously)
  - parallel:
      - command: agent-1
      - command: agent-2
      - command: agent-3
```

### Command Structure

```markdown
---
description: Brief description for workflow router
argument-hint: <expected input format>
---

# Command Title

**Input**: $ARGUMENTS

---

## Phase 1: [Phase Name]

### 1.1 [Step]
[Instructions...]

### 1.2 [Step]
[Instructions...]

## Phase 2: [Phase Name]

[More structured instructions...]

## Output

[What the command should produce]
```

### Variable Substitution

| Variable | Expands To |
|----------|------------|
| `$ARGUMENTS` | User's input message |
| `$1`, `$2`, etc. | Positional arguments |
| `$PLAN` | Previous plan from session |
| `$USER_MESSAGE` | Raw user message (in loops) |

---

## Troubleshooting Workflows

### Common Issues

**Workflow not found:**
- Check exact filename matches (including extension)
- Verify file is in `.archon/workflows/` (not nested deeper)
- Run `bun run cli workflow list` to see what's loaded

**Command not found:**
- Check the command name in workflow matches filename (minus `.md`)
- Commands must be in `.archon/commands/` or bundled defaults

**Context issues between steps:**
- Use `clearContext: true` to start fresh
- Without it, context accumulates (can cause bloat)

**Wrong behavior:**
- Check if repo override exists (takes precedence)
- Read the command file to see actual instructions
- Check for outdated defaults in repo (delete `.archon/workflows/defaults/` to use updated app defaults)

### Debugging Workflow Execution

```bash
# Watch the workflow output
tail -f /private/tmp/claude-501/*/tasks/*.output

# Check what workflows are loaded
bun run cli workflow list --cwd /path/to/repo

# See active worktrees
bun run cli isolation list
```

---

## Reference Knowledge

For detailed patterns and conventions, read these files:
- `frontend-knowledge.md` - Complete frontend patterns, API integration, UI guidelines
- `backend-knowledge.md` - Django patterns, database safety, testing requirements
- `archon-customization.md` - Deep dive on workflow/command creation

---

## Quick Reference

### Frontend Key Patterns
- Auth: POST `/api/auth/login/` with `grant_type: 'otp'`
- Profile fields: Use `phone_number` not `phone`, `business_name` not `company`
- UI: Neo-glassmorphism with `bg-black/40 backdrop-blur-xl`
- Colors: Gold gradient (`from-yellow-400 to-orange-500`) for CTAs

### Backend Key Commands
```bash
# Start services
docker-compose up

# Run migrations
docker-compose exec web python manage.py migrate

# Run ALL tests (required before completion)
docker-compose exec web python manage.py test

# Check for issues
docker-compose exec web python manage.py check
```

### Archon Key Commands
```bash
# List workflows
bun run cli workflow list

# FEATURE IMPLEMENTATION (use this for features!)
bun run cli workflow run archon-idea-to-pr \
  --cwd /path/to/repo \
  --no-worktree \
  "feature description"

# EXECUTE EXISTING PLAN
bun run cli workflow run archon-plan-to-pr \
  --cwd /path/to/repo \
  --no-worktree \
  "/path/to/plan.md"

# QUESTIONS/DEBUGGING/INVESTIGATION ONLY
bun run cli workflow run archon-assist \
  --cwd /path/to/repo \
  --no-worktree \
  "quick question"
```

**REMEMBER: Every command MUST include `--no-worktree`. No exceptions.**
