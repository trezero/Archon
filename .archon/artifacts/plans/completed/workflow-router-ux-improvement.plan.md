# Feature: Workflow Router UX Improvement

## Summary

Improve the natural language routing system so that all user requests are handled through defined processes (workflows), with a catch-all "assist" workflow for conversational/one-off tasks. The router will ALWAYS invoke a workflow - never leave users with an explanatory text message that does nothing. Commands remain primitives; single-command tasks get lightweight workflow wrappers.

## User Story

As a user talking to Archon via GitHub/Slack/Telegram
I want my natural language requests to always result in action
So that I get actual help instead of explanations about what the bot can't do

## Problem Statement

**Current State**: When the router AI decides no workflow matches a user request, it outputs a brief conversational message (e.g., "This is a debugging task, not a workflow invocation"). This message is sent to the user but NO ACTUAL WORK HAPPENS. Users get explanations of why the bot can't help, not actual help.

**Root Causes**:
1. Router prompt tells AI "DO NOT use tools" and "ONLY output a routing decision"
2. When no workflow matches, router outputs text that gets forwarded to user
3. No fallback workflow exists to handle conversational/one-off requests
4. Workflow descriptions don't give the router enough information to route correctly

## Solution Statement

1. **Create an "assist" workflow** as the catch-all fallback
2. **Update router prompt** so AI MUST pick a workflow (no text-only responses)
3. **Enhance workflow descriptions** to serve as routing instructions
4. **Fix $ARGUMENTS substitution** so commands receive the user's actual request
5. **Create single-step workflow wrappers** for common commands (review-pr, etc.)

## Metadata

| Field | Value |
|-------|-------|
| Type | ENHANCEMENT |
| Complexity | MEDIUM |
| Systems Affected | workflows/router.ts, workflows/executor.ts, .archon/workflows/, .archon/commands/ |
| Dependencies | None (uses existing infrastructure) |
| Estimated Tasks | 7 |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐            ║
║   │   User:     │ ──────► │   Router    │ ──────► │   Result    │            ║
║   │  "@archon   │         │   decides   │         │             │            ║
║   │  check CI"  │         │   no match  │         │  Text only  │            ║
║   └─────────────┘         └─────────────┘         │  "This is   │            ║
║                                                   │  a debug    │            ║
║                                                   │  task..."   │            ║
║                                                   └─────────────┘            ║
║                                                                               ║
║   USER_FLOW:                                                                  ║
║   1. User mentions bot with request                                          ║
║   2. Router AI sees: fix-github-issue, feature-development                   ║
║   3. Neither matches → AI outputs conversational text                        ║
║   4. Text sent to user                                                        ║
║   5. NO WORK DONE                                                             ║
║                                                                               ║
║   PAIN_POINT: User gets an explanation, not help                              ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐            ║
║   │   User:     │ ──────► │   Router    │ ──────► │   Workflow  │            ║
║   │  "@archon   │         │   MUST pick │         │   Executed  │            ║
║   │  check CI"  │         │   workflow  │         │             │            ║
║   └─────────────┘         └─────────────┘         └──────┬──────┘            ║
║                                                          │                    ║
║                           Routing Decision:              │                    ║
║                           ├── fix-github-issue? No      │                    ║
║                           ├── review-pr? No             ▼                    ║
║                           ├── feature-dev? No    ┌─────────────┐            ║
║                           └── assist? YES ────►  │   Claude    │            ║
║                                                  │   does the  │            ║
║                                                  │   work!     │            ║
║                                                  └─────────────┘            ║
║                                                                               ║
║   USER_FLOW:                                                                  ║
║   1. User mentions bot with request                                          ║
║   2. Router sees: fix-github-issue, review-pr, feature-dev, assist           ║
║   3. "check CI" → doesn't match specific workflows → matches "assist"        ║
║   4. Assist workflow executes with full Claude Code capability               ║
║   5. ACTUAL WORK DONE                                                         ║
║                                                                               ║
║   VALUE_ADD: Every request gets action, not explanation                       ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Router AI response | Text explaining no match | Always `/invoke-workflow X` | Action instead of explanation |
| No-match scenario | User gets "can't help" text | Assist workflow runs | One-off tasks get handled |
| Single commands | No way to route | Workflow wrappers exist | `review this PR` works |
| Workflow descriptions | Brief summaries | Routing instructions | Better AI decisions |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/workflows/router.ts` | 10-51 | Current router prompt to UPDATE |
| P0 | `src/workflows/executor.ts` | 254-262 | Variable substitution to FIX |
| P1 | `.archon/workflows/fix-github-issue.yaml` | all | Workflow structure to MIRROR |
| P1 | `.claude/commands/exp-piv-loop/plan.md` | 1-30 | Command structure to MIRROR |
| P2 | `src/orchestrator/orchestrator.ts` | 507-554 | Routing integration context |

---

## Patterns to Mirror

**WORKFLOW_STRUCTURE:**
```yaml
# SOURCE: .archon/workflows/fix-github-issue.yaml
# COPY THIS PATTERN for new workflow wrappers:
name: fix-github-issue
description: Investigate and fix a GitHub issue end-to-end. Composable workflow using reusable commands.

provider: claude
model: sonnet

steps:
  - command: investigate-issue
  - command: implement-issue
    clearContext: true
```

**COMMAND_STRUCTURE:**
```markdown
# SOURCE: .claude/commands/exp-piv-loop/commit.md:1-10
# COPY THIS PATTERN for assist command:
---
description: Quick commit with natural language file targeting
argument-hint: <files or description> "<commit message>"
---

# Quick Commit

**Target**: $ARGUMENTS
```

**VARIABLE_SUBSTITUTION:**
```typescript
// SOURCE: src/utils/variable-substitution.ts:14-27
// PATTERN for $ARGUMENTS:
result = result.replace(/\$ARGUMENTS/g, args.join(' '));
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/workflows/router.ts` | UPDATE | New router prompt that MUST pick workflow |
| `src/workflows/executor.ts` | UPDATE | Add $ARGUMENTS substitution |
| `.archon/workflows/assist.yaml` | CREATE | Catch-all fallback workflow |
| `.archon/commands/assist.md` | CREATE | Base agent command for assist workflow |
| `.archon/workflows/review-pr.yaml` | CREATE | Single-step wrapper for review-pr command |
| `.archon/workflows/fix-github-issue.yaml` | UPDATE | Enhanced description for routing |
| `.archon/workflows/feature-development.yaml` | UPDATE | Enhanced description for routing |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **Orchestrator agent** - Future feature where AI plans multi-step work conversationally. Out of scope for now.
- **Command-level routing** - Router only routes to workflows, not directly to commands. Commands are primitives wrapped by workflows.
- **Dynamic workflow generation** - Workflows are static YAML files, not generated on-the-fly.
- **More single-step wrappers** - Only creating `review-pr` and `assist`. Others can be added later.

---

## Principles

These principles guide the implementation:

1. **Commands are primitives** - Atomic, reusable, single-responsibility
2. **Workflows compose commands** - Single or multi-step, define processes
3. **Router dispatches to workflows only** - Never to commands directly
4. **Descriptions are instructions** - They tell the router WHEN to use each workflow
5. **Assist is the fallback** - Catches everything that doesn't match specific workflows
6. **Every request gets action** - No text-only responses from router

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: UPDATE `src/workflows/executor.ts` - Fix $ARGUMENTS substitution

**ACTION**: Add `$ARGUMENTS` support to `substituteWorkflowVariables()`

**IMPLEMENT**:
```typescript
function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string
): string {
  let result = prompt;
  result = result.replace(/\$WORKFLOW_ID/g, workflowId);
  result = result.replace(/\$USER_MESSAGE/g, userMessage);
  result = result.replace(/\$ARGUMENTS/g, userMessage);  // ADD THIS LINE
  return result;
}
```

**MIRROR**: `src/utils/variable-substitution.ts:27` - uses same pattern

**GOTCHA**: Commands use `$ARGUMENTS` but workflow executor only substituted `$WORKFLOW_ID` and `$USER_MESSAGE`. This is why commands receive literal `$ARGUMENTS` text.

**VALIDATE**: `bun run type-check`

---

### Task 2: CREATE `.archon/commands/assist.md` - Base agent command

**ACTION**: Create the assist command that handles one-off requests

**IMPLEMENT**:
```markdown
---
description: General assistance - questions, debugging, one-off tasks, exploration
argument-hint: <any request>
---

# Assist Mode

**Request**: $ARGUMENTS

---

You are helping with a request that didn't match a specific workflow.

## Instructions

1. **Understand the request** - What is the user actually asking for?
2. **Take action** - Use your full Claude Code capabilities to help
3. **Be helpful** - Answer questions, debug issues, explore code, make changes
4. **Note the gap** - If this should have been a specific workflow, mention it:
   "Note: Using assist mode. Consider creating a workflow for this use case."

## Capabilities

You have full Claude Code capabilities:
- Read and write files
- Run commands
- Search the codebase
- Make code changes
- Answer questions

## Request

$ARGUMENTS
```

**MIRROR**: `.claude/commands/exp-piv-loop/commit.md` - same frontmatter structure

**VALIDATE**: File exists at correct path

---

### Task 3: CREATE `.archon/workflows/assist.yaml` - Fallback workflow

**ACTION**: Create the catch-all assist workflow

**IMPLEMENT**:
```yaml
name: assist
description: |
  Use when: No other workflow matches the request.
  Handles: Questions, debugging, exploration, one-off tasks, explanations, CI failures, general help.
  Capability: Full Claude Code agent with all tools available.
  Note: Will inform user when assist mode is used for tracking.

provider: claude
model: sonnet

steps:
  - command: assist
```

**MIRROR**: `.archon/workflows/fix-github-issue.yaml` - same structure

**GOTCHA**: Description is INSTRUCTION to the router, not documentation

**VALIDATE**: `ls .archon/workflows/assist.yaml`

---

### Task 4: CREATE `.archon/workflows/review-pr.yaml` - Single-step wrapper

**ACTION**: Create workflow wrapper for review-pr command

**IMPLEMENT**:
```yaml
name: review-pr
description: |
  Use when: User wants a code review of a pull request.
  Triggers: "review this PR", "check the code", "review PR #123", "code review".
  Does: Comprehensive code review following project standards.

provider: claude
model: sonnet

steps:
  - command: review-pr
```

**MIRROR**: `.archon/workflows/fix-github-issue.yaml` - same structure

**VALIDATE**: `ls .archon/workflows/review-pr.yaml`

---

### Task 5: UPDATE `.archon/workflows/fix-github-issue.yaml` - Enhanced description

**ACTION**: Update description to be a routing instruction

**IMPLEMENT**:
```yaml
name: fix-github-issue
description: |
  Use when: User wants to FIX, RESOLVE, or IMPLEMENT a solution for a GitHub issue.
  Triggers: "fix this issue", "implement issue #123", "resolve this bug", "fix it".
  NOT for: Questions about issues, CI failures, PR reviews, general exploration.
  Does: Investigates root cause → creates implementation plan → makes code changes → creates PR.

provider: claude
model: sonnet

steps:
  - command: investigate-issue

  - command: implement-issue
    clearContext: true
```

**GOTCHA**: Keep same structure, only change description

**VALIDATE**: `cat .archon/workflows/fix-github-issue.yaml`

---

### Task 6: UPDATE `.archon/workflows/feature-development.yaml` - Enhanced description

**ACTION**: Update description to be a routing instruction

**IMPLEMENT**:
```yaml
name: feature-development
description: |
  Use when: User wants to BUILD or ADD new functionality from scratch.
  Triggers: "add dark mode", "implement authentication", "build a feature", "create new endpoint".
  NOT for: Bug fixes, issue resolution, code reviews, questions.
  Does: Creates implementation plan → implements code → creates pull request.

provider: claude
model: sonnet

steps:
  - command: plan

  - command: implement
    clearContext: true

  - command: create-pr
```

**GOTCHA**: Keep same structure, only change description

**VALIDATE**: `cat .archon/workflows/feature-development.yaml`

---

### Task 7: UPDATE `src/workflows/router.ts` - New router prompt

**ACTION**: Rewrite `buildRouterPrompt()` to REQUIRE workflow selection

**IMPLEMENT**:
```typescript
export function buildRouterPrompt(
  userMessage: string,
  workflows: WorkflowDefinition[]
): string {
  if (workflows.length === 0) {
    // No workflows - just respond conversationally
    return userMessage;
  }

  const workflowList = workflows
    .map(w => {
      // Format description, handling multi-line descriptions
      const desc = w.description.trim().replace(/\n/g, '\n  ');
      return `**${w.name}**\n  ${desc}`;
    })
    .join('\n\n');

  return `# Workflow Router

You are a router. Your ONLY job is to pick which workflow to invoke.

## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Rules

1. Read each workflow's description carefully - it tells you WHEN to use that workflow
2. Pick the workflow that best matches the user's intent
3. If no specific workflow matches, use "assist" (the catch-all)
4. You MUST pick a workflow - never respond with just text

## Response Format

Respond with EXACTLY this format, nothing else:
/invoke-workflow {workflow-name}

Pick now:`;
}
```

**MIRROR**: Current implementation at `router.ts:10-51`, same function signature

**KEY CHANGES**:
1. Descriptions formatted with newlines preserved (multi-line YAML)
2. "You MUST pick a workflow" - no text-only responses
3. "assist" mentioned as the catch-all
4. Simpler, more directive prompt

**VALIDATE**: `bun run type-check && bun test src/workflows/router.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `src/workflows/executor.test.ts` | $ARGUMENTS substitution | Variable substitution fix |
| `src/workflows/router.test.ts` | Multi-line descriptions | Router prompt formatting |

### Edge Cases Checklist

- [ ] Empty user message → should still pick assist
- [ ] Very long user message → should not break prompt
- [ ] Workflow with multi-line description → should format correctly
- [ ] User explicitly asks for workflow → router should match
- [ ] Ambiguous request → should pick closest or assist
- [ ] Request that sounds like workflow but isn't exact → should still match

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run type-check && bun run lint
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
bun test src/workflows/
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

Test via test adapter:

```bash
# Start app
bun run dev

# Test assist workflow (should trigger for unmatched requests)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-123","message":"what is this codebase about?"}'

# Test specific workflow matching
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-456","message":"review this PR"}'

# Check responses
curl http://localhost:3000/test/messages/test-123 | jq
curl http://localhost:3000/test/messages/test-456 | jq
```

**EXPECT**:
- "what is this codebase about?" → triggers assist workflow
- "review this PR" → triggers review-pr workflow

---

## Acceptance Criteria

- [ ] Router prompt requires workflow selection (no text-only responses)
- [ ] $ARGUMENTS is substituted in workflow command execution
- [ ] Assist workflow exists and catches unmatched requests
- [ ] Review-pr workflow wrapper exists
- [ ] Workflow descriptions serve as routing instructions
- [ ] All validation commands pass
- [ ] Test adapter confirms correct routing

---

## Completion Checklist

- [ ] Task 1: $ARGUMENTS substitution fixed in executor.ts
- [ ] Task 2: assist.md command created
- [ ] Task 3: assist.yaml workflow created
- [ ] Task 4: review-pr.yaml workflow created
- [ ] Task 5: fix-github-issue.yaml description enhanced
- [ ] Task 6: feature-development.yaml description enhanced
- [ ] Task 7: Router prompt updated
- [ ] Level 1: `bun run type-check && bun run lint` passes
- [ ] Level 2: `bun test src/workflows/` passes
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] Level 4: Manual validation with test adapter succeeds

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Router still outputs text instead of workflow | LOW | HIGH | Prompt explicitly says "MUST pick" and "never respond with just text" |
| Assist becomes a crutch (everything goes there) | MEDIUM | LOW | Descriptions are detailed; router will match specific workflows when appropriate |
| Multi-line descriptions break prompt formatting | LOW | MEDIUM | Using proper string formatting with newline handling |
| Existing tests fail | LOW | MEDIUM | Router tests may need updates for new prompt format |

---

## Notes

**Future Enhancements** (not in scope):
- Orchestrator agent for conversational planning before workflow invocation
- More single-step workflow wrappers (investigate, commit, etc.)
- Workflow analytics to track which workflows are used most
- User feedback mechanism when assist is used (to identify gaps)

**Design Decision - Why workflows wrap commands**:
Commands are primitives that can be composed. Even single-command tasks benefit from workflow wrapping because:
1. Router only knows workflows (simpler mental model)
2. Workflow descriptions guide routing decisions
3. Future: can add pre/post steps without changing router

**Design Decision - Why "assist" not "default"**:
"Assist" communicates capability ("I'll help you"). "Default" implies fallback/failure. UX matters.
