# Investigation: GitHub UX - Consolidate startup messages into single workflow start comment

**Issue**: #153 (https://github.com/dynamous-community/remote-coding-agent/issues/153)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T08:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | User experience improvement that reduces email notification spam (3 notifications → 1), labeled as medium priority, improves UX without changing functionality |
| Complexity | LOW | Only 2 files to modify (orchestrator.ts, executor.ts), changes are isolated to message sending logic, no integration risk, low risk of breaking existing functionality |
| Confidence | HIGH | Clear evidence of all three message locations found with specific line numbers, straightforward consolidation approach, no architectural changes required |

---

## Problem Statement

When a GitHub workflow is triggered via @mention, users receive three separate comments before any actual work output: (1) "Working in isolated branch `issue-XXX`", (2) "Archon is on the case...", and (3) "🚀 **Starting workflow**: ...". Each comment triggers an email notification, creating unnecessary noise. These should be consolidated into a single "Workflow Started" comment.

---

## Analysis

### Change Rationale

This is a UX enhancement to reduce notification spam for GitHub users. The three startup messages are sent sequentially but contain related information:
1. **Isolation context** - which branch/worktree is being used
2. **Activity indicator** - bot acknowledgment (redundant)
3. **Workflow details** - which workflow is running and what it does

All three can and should be combined into a single, informative startup comment that provides the same context with only one notification.

---

### Evidence Chain

**Current Flow:**

WHY: Users receive 3 separate comments at workflow start
↓ BECAUSE: Three separate `platform.sendMessage()` calls during startup sequence
  Evidence: See affected files below

↓ BECAUSE: Messages are sent at different points in the execution flow
  Evidence:
  - Message 1: `orchestrator.ts:246-249` - sent during isolation validation
  - Message 2: `orchestrator.ts:684` - sent before AI streaming (batch mode only)
  - Message 3: `executor.ts:714-719` - sent at workflow start

↓ ROOT CAUSE: No message buffering/batching mechanism for startup sequence
  Evidence: Each message is sent immediately without coordination between orchestrator and workflow executor

---

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/orchestrator/orchestrator.ts` | 246-249 | REMOVE | Remove immediate isolation message send |
| `src/orchestrator/orchestrator.ts` | 682-685 | REMOVE | Remove "Archon is on the case..." message |
| `src/orchestrator/orchestrator.ts` | 313-321 | UPDATE | Pass isolation context to workflow executor |
| `src/workflows/executor.ts` | 714-719 | UPDATE | Consolidate all startup info into single message |
| `src/workflows/executor.ts` | 650-680 | UPDATE | Update function signature to accept isolation context |

---

### Integration Points

**Orchestrator → Workflow Executor:**
- Line 313-321 in `orchestrator.ts`: Calls `executeWorkflow()`
- Line 656 in `executor.ts`: `executeWorkflow()` function definition
- Need to pass isolation context (branch name, is PR review) to executor

**Platform Adapter:**
- `platform.sendMessage()` is used throughout for all comment posting
- No changes needed to adapter layer
- GitHub adapter always uses batch mode (line 238 in `github.ts`)

**Workflow Routing:**
- Line 698+ in `orchestrator.ts`: Routes through workflow router
- Router calls `executeWorkflow()` at line 313-321
- Router needs to pass isolation context through

---

### Git History

- **"is on the case" introduced**: Commit `0ec36a9` (Add Discord platform adapter)
- **Last modified**: Commit `75df4fb` (Jan 2, 2026) - "Fix bot name in 'is on the case' message"
- **Implication**: Message was added for batch mode feedback, but creates redundancy with workflow start message

---

## Implementation Plan

### Step 1: Add isolation context parameter to executeWorkflow

**File**: `src/workflows/executor.ts`
**Lines**: 656-680
**Action**: UPDATE

**Current signature:**
```typescript
export async function executeWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId?: string,
  codebaseId?: string
): Promise<void>
```

**Required change:**
```typescript
export async function executeWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId?: string,
  codebaseId?: string,
  isolationContext?: {
    branchName?: string;
    isPrReview?: boolean;
    prSha?: string;
    prBranch?: string;
  }
): Promise<void>
```

**Why**: Need to pass isolation details from orchestrator to workflow executor for consolidated message

---

### Step 2: Update orchestrator to pass isolation context

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 313-321
**Action**: UPDATE

**Current code:**
```typescript
await executeWorkflow(
  ctx.platform,
  ctx.conversationId,
  ctx.cwd,
  workflow,
  ctx.originalMessage,
  ctx.conversationDbId,
  ctx.codebaseId
);
```

**Required change:**
```typescript
// Capture isolation context from conversation
const isolationContext = conversation.worktree_path
  ? {
      branchName: env.branch_name, // env from validateAndResolveIsolation
      isPrReview: isolationHints?.isPrReview,
      prSha: isolationHints?.prSha,
      prBranch: isolationHints?.prBranch,
    }
  : undefined;

await executeWorkflow(
  ctx.platform,
  ctx.conversationId,
  ctx.cwd,
  workflow,
  ctx.originalMessage,
  ctx.conversationDbId,
  ctx.codebaseId,
  isolationContext
);
```

**Why**: Pass isolation details captured earlier in orchestrator flow to executor

**Note**: Need to capture `env` from `validateAndResolveIsolation` call (line 624-630) and make it available in routing context.

---

### Step 3: Remove isolation message from orchestrator

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 246-249
**Action**: REMOVE

**Current code:**
```typescript
await platform.sendMessage(
  conversationId,
  `Working in isolated branch \`${env.branch_name}\``
);
```

**Required change:**
Remove this entire block. The message will be included in the consolidated workflow start message.

**Why**: Eliminate first separate comment

**Note**: Also remove the PR review message at lines 241-244 for the same reason.

---

### Step 4: Remove "on the case" message from orchestrator

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 682-685
**Action**: REMOVE

**Current code:**
```typescript
if (mode === 'batch') {
  const botName = process.env.BOT_DISPLAY_NAME || 'Archon';
  await platform.sendMessage(conversationId, `${botName} is on the case...`);
}
```

**Required change:**
Remove this entire block. It's redundant with the workflow start message.

**Why**: Eliminate second separate comment

---

### Step 5: Consolidate messages in workflow executor

**File**: `src/workflows/executor.ts`
**Lines**: 710-719
**Action**: UPDATE

**Current code:**
```typescript
// Notify user - use type narrowing from discriminated union
const stepsInfo = workflow.steps
  ? `Steps: ${workflow.steps.map(s => `\`${s.command}\``).join(' -> ')}`
  : `Loop: until \`${workflow.loop.until}\` (max ${String(workflow.loop.max_iterations)} iterations)`;
await safeSendMessage(
  platform,
  conversationId,
  `🚀 **Starting workflow**: \`${workflow.name}\`\n\n${workflow.description}\n\n${stepsInfo}`,
  workflowContext
);
```

**Required change:**
```typescript
// Build consolidated startup message
let startupMessage = '';

// Add isolation context if provided
if (isolationContext) {
  if (isolationContext.isPrReview && isolationContext.prSha) {
    const shortSha = isolationContext.prSha.substring(0, 7);
    startupMessage += `Reviewing PR at commit \`${shortSha}\` (branch: \`${isolationContext.prBranch}\`)\n\n`;
  } else if (isolationContext.branchName) {
    // Extract repo name from cwd (last directory component)
    const repoName = cwd.split('/').pop() || 'repository';
    startupMessage += `📍 ${repoName} @ \`${isolationContext.branchName}\`\n\n`;
  }
}

// Add workflow start message
startupMessage += `🚀 **Starting workflow**: \`${workflow.name}\`\n\n> ${workflow.description}`;

// Add steps info
const stepsInfo = workflow.steps
  ? `\n\n**Steps**: ${workflow.steps.map(s => `\`${s.command}\``).join(' → ')}`
  : `\n\n**Loop**: until \`${workflow.loop.until}\` (max ${String(workflow.loop.max_iterations)} iterations)`;
startupMessage += stepsInfo;

// Send consolidated message
await safeSendMessage(
  platform,
  conversationId,
  startupMessage,
  workflowContext
);
```

**Why**: Single comment with all startup context - location, workflow, and steps

---

### Step 6: Update routing context to include env

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 687-705
**Action**: UPDATE

**Current code:**
```typescript
// Build workflow routing context once
const routingCtx: WorkflowRoutingContext = {
  platform,
  conversationId,
  cwd,
  originalMessage: message,
  conversationDbId: conversation.id,
  codebaseId: conversation.codebase_id ?? undefined,
};
```

**Required change:**
```typescript
// Build workflow routing context once
const routingCtx: WorkflowRoutingContext = {
  platform,
  conversationId,
  cwd,
  originalMessage: message,
  conversationDbId: conversation.id,
  codebaseId: conversation.codebase_id ?? undefined,
  isolationEnv: { branch_name: env.branch_name }, // Add env from validateAndResolveIsolation
};
```

**Why**: Make isolation environment details available in routing context for passing to executor

**Note**: This requires updating the `WorkflowRoutingContext` type definition as well.

---

### Step 7: Update WorkflowRoutingContext type

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: ~40-50 (type definitions at top of file)
**Action**: UPDATE

**Required change:**
```typescript
interface WorkflowRoutingContext {
  platform: IPlatformAdapter;
  conversationId: string;
  cwd: string;
  originalMessage: string;
  conversationDbId: string;
  codebaseId?: string;
  isolationEnv?: {
    branch_name: string;
  };
}
```

**Why**: Type safety for new isolation context field

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/orchestrator/orchestrator.ts:241-244
// Pattern for PR review context message
const shortSha = hints.prSha.substring(0, 7);
await platform.sendMessage(
  conversationId,
  `Reviewing PR at commit \`${shortSha}\` (branch: \`${hints.prBranch}\`)`
);
```

```typescript
// SOURCE: src/workflows/executor.ts:711-713
// Pattern for building steps info with discriminated union
const stepsInfo = workflow.steps
  ? `Steps: ${workflow.steps.map(s => `\`${s.command}\``).join(' -> ')}`
  : `Loop: until \`${workflow.loop.until}\` (max ${String(workflow.loop.max_iterations)} iterations)`;
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Non-workflow AI messages | Only workflows call `executeWorkflow()`, so non-workflow messages won't be affected |
| Missing isolation context | Make `isolationContext` optional parameter, gracefully handle undefined |
| Repository name extraction | Use safe fallback to 'repository' if cwd parsing fails |
| PR review vs normal workflow | Check `isPrReview` flag to format message appropriately |
| Multi-step workflows | Keep separate step notifications (line 742-750 in executor.ts) - only consolidate startup |
| Telegram/Slack (stream mode) | "On the case" message is batch mode only, so no impact on stream mode |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test
bun run lint
```

### Manual Verification

1. **Test GitHub workflow trigger:**
   ```bash
   # Post comment on test issue: "@archon assist"
   # Verify only ONE startup comment is posted with:
   # - Repository @ branch
   # - 🚀 Starting workflow: assist
   # - Workflow description
   # - Steps info
   ```

2. **Test multi-step workflow:**
   ```bash
   # Post comment: "@archon fix this issue"
   # Verify consolidated startup shows "Steps: investigate-issue → implement-issue"
   # Verify step notifications still posted separately
   ```

3. **Test PR review workflow:**
   ```bash
   # Post comment on PR: "@archon review"
   # Verify startup shows "Reviewing PR at commit `abc1234` (branch: `feature-x`)"
   ```

4. **Test non-isolated workflow:**
   ```bash
   # Test in repo without worktree
   # Verify workflow start message works without isolation context
   ```

---

## Scope Boundaries

**IN SCOPE:**
- Consolidating three startup messages into one
- Passing isolation context to workflow executor
- Formatting consolidated message with all relevant info

**OUT OF SCOPE (do not touch):**
- Step notifications for multi-step workflows (keep separate)
- Artifact notifications (keep separate)
- Completion notifications (keep separate)
- Error messages during startup
- Stream mode behavior (Telegram/Slack)
- Platform adapter changes

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T08:00:00Z
- **Artifact**: `.archon/artifacts/issues/issue-153.md`
