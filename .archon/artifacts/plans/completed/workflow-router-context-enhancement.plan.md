# Feature: Workflow Router Context Enhancement

## Summary

Improve the workflow router's decision-making by providing it with richer context from all platform adapters. Currently, the router only sees the user's message and workflow descriptions. By passing platform context (GitHub issue/PR info, Slack/Discord thread history, etc.), the router can make smarter decisions about which workflow to invoke - distinguishing between "fix CI failures" (should use `assist`) and "fix this GitHub issue" (should use `fix-github-issue`).

## User Story

As a user interacting with Archon via GitHub, Slack, Discord, or Telegram
I want the workflow router to understand the full context of my request
So that it picks the right workflow without me having to be overly explicit

## Problem Statement

The workflow router currently misroutes requests because it lacks context:
1. **PR #134 Example**: User said "fix the ci failures" on a PR → Router picked `fix-github-issue` instead of `assist`
2. **Root cause**: Router only sees user message text, not:
   - Whether we're on an issue vs PR
   - Previous comments in the thread (which explained CI failures were a rebase issue)
   - Platform-specific metadata (labels, PR status, etc.)
3. **Impact**: Users get wrong workflows, wasted time, confusing results

## Solution Statement

Enhance `buildRouterPrompt()` to accept optional context and improve the prompt to:
1. **Accept context parameter** with platform type, thread history, issue/PR metadata
2. **Improve prompt instructions** to emphasize understanding context before deciding
3. **Platform-agnostic design**: Works for GitHub (issue/PR context), Slack/Discord (thread history), Telegram (minimal)
4. **Low latency**: Pass context upfront rather than having router invoke tools

## Metadata

| Field | Value |
|-------|-------|
| Type | ENHANCEMENT |
| Complexity | LOW |
| Systems Affected | `src/workflows/router.ts`, `src/orchestrator/orchestrator.ts` |
| Dependencies | None (uses existing context already passed to orchestrator) |
| Estimated Tasks | 4 |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐║
║   │  User Comment   │ ──────► │   Router AI     │ ──────► │ Wrong Workflow  │║
║   │ "fix CI fails"  │         │ (sees only msg) │         │ fix-github-issue│║
║   └─────────────────┘         └─────────────────┘         └─────────────────┘║
║                                                                               ║
║   USER_FLOW:                                                                   ║
║   1. User comments "@archon fix the ci failures" on PR #134                   ║
║   2. GitHub adapter builds context (PR title, body, labels)                   ║
║   3. Orchestrator receives context but passes only message to router          ║
║   4. Router sees: "fix the ci failures" + workflow descriptions               ║
║   5. Router picks fix-github-issue (keyword "fix" triggers it)                ║
║   6. Wrong workflow runs: investigate-issue -> implement-issue                ║
║                                                                               ║
║   PAIN_POINT: Router has no way to know this is a CI failure (assist)         ║
║               vs an actual GitHub issue to fix (fix-github-issue)             ║
║                                                                               ║
║   DATA_FLOW:                                                                   ║
║   Adapter ──[issueContext, threadContext]──► handleMessage                    ║
║                                                   │                            ║
║                                     buildRouterPrompt(message, workflows)     ║
║                                                   │                            ║
║                             Context discarded! ◄──┘                           ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐║
║   │  User Comment   │ ──────► │   Router AI     │ ──────► │ Right Workflow  │║
║   │ "fix CI fails"  │         │ (sees context!) │         │     assist      │║
║   │  + PR Context   │         │                 │         │                 │║
║   │  + Thread Hist  │         │                 │         │                 │║
║   └─────────────────┘         └─────────────────┘         └─────────────────┘║
║                                                                               ║
║   USER_FLOW:                                                                   ║
║   1. User comments "@archon fix the ci failures" on PR #134                   ║
║   2. GitHub adapter builds context (PR title, body, labels)                   ║
║   3. Orchestrator passes FULL context to router                               ║
║   4. Router sees:                                                              ║
║      - Platform: github (PR)                                                   ║
║      - PR Title: "fix: add cloud deployment support..."                       ║
║      - User message: "fix the ci failures"                                    ║
║      - Thread history (previous comments show investigation)                  ║
║   5. Router understands: "CI failure" ≠ "GitHub issue to implement"           ║
║   6. Router picks assist (correct!)                                           ║
║                                                                               ║
║   VALUE_ADD: Router makes informed decisions with full context                ║
║                                                                               ║
║   DATA_FLOW:                                                                   ║
║   Adapter ──[issueContext, threadContext]──► handleMessage                    ║
║                                                   │                            ║
║                     buildRouterPrompt(message, workflows, context) ◄──────────║
║                                                   │                            ║
║                                  Context used for routing!                     ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| GitHub PR comment | Router sees only comment text | Router sees PR title, body, labels, thread history | Correct workflow selection for CI failures vs issue fixes |
| Slack thread | Router sees only current message | Router sees thread history | Understands conversation context |
| Discord thread | Router sees only current message | Router sees thread history | Understands conversation context |
| Telegram | Router sees only message | Router sees platform type | Minimal change (no thread context available) |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/workflows/router.ts` | 1-103 | Core file to modify - understand current implementation |
| P0 | `src/orchestrator/orchestrator.ts` | 344-352 | Function signature with all available context |
| P0 | `src/orchestrator/orchestrator.ts` | 545-566 | Where router is called - must pass new context |
| P1 | `src/workflows/router.test.ts` | 1-253 | Test patterns to MIRROR for new tests |
| P1 | `src/types/index.ts` | 22-37 | `IsolationHints` interface for reference |
| P2 | `src/adapters/github.ts` | 553-594 | How GitHub builds context (`buildIssueContext`, `buildPRContext`) |
| P2 | `src/adapters/slack.ts` | 198-227 | How Slack fetches thread history |

---

## Patterns to Mirror

**NAMING_CONVENTION:**
```typescript
// SOURCE: src/workflows/router.ts:10-14
// COPY THIS PATTERN:
export function buildRouterPrompt(userMessage: string, workflows: WorkflowDefinition[]): string {
  if (workflows.length === 0) {
    // No workflows - just respond conversationally
    return userMessage;
  }
```

**TYPE_DEFINITION:**
```typescript
// SOURCE: src/types/index.ts:22-37
// COPY THIS PATTERN for optional context interface:
export interface IsolationHints {
  workflowType?: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  workflowId?: string;
  prBranch?: string;
  // ...
}
```

**TEST_STRUCTURE:**
```typescript
// SOURCE: src/workflows/router.test.ts:25-45
// COPY THIS PATTERN:
describe('buildRouterPrompt', () => {
  it('should return plain message when no workflows provided', () => {
    const result = buildRouterPrompt('Help me fix this bug', []);
    expect(result).toBe('Help me fix this bug');
  });

  it('should include workflow list when workflows are provided', () => {
    const result = buildRouterPrompt('Help me fix this bug', testWorkflows);
    expect(result).toContain('# Workflow Router');
    // ...
  });
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/workflows/router.ts` | UPDATE | Add optional context parameter to `buildRouterPrompt`, improve prompt |
| `src/orchestrator/orchestrator.ts` | UPDATE | Pass context to `buildRouterPrompt` call |
| `src/workflows/router.test.ts` | UPDATE | Add tests for new context parameter |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **NOT fetching additional data**: We use context already available in orchestrator, not new API calls
- **NOT adding tools to router**: Router stays tool-free for low latency; context is passed upfront
- **NOT changing adapter interfaces**: Adapters already provide context to orchestrator
- **NOT platform-specific router logic**: Router prompt is generic; adapters format their own context
- **NOT making context required**: Context is optional - backward compatible with existing callers

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: UPDATE `src/workflows/router.ts` - Add RouterContext interface

- **ACTION**: Add new `RouterContext` interface and update `buildRouterPrompt` signature
- **IMPLEMENT**:
  ```typescript
  /**
   * Optional context for router to make informed decisions
   */
  export interface RouterContext {
    /** Platform type: github, slack, discord, telegram */
    platformType?: string;
    /** Whether this is a PR (vs issue) - GitHub specific */
    isPullRequest?: boolean;
    /** Issue/PR title - helps understand what we're working on */
    title?: string;
    /** Issue/PR labels - useful for categorization */
    labels?: string[];
    /** Thread/comment history - previous messages for context */
    threadHistory?: string;
    /** Workflow type hint from adapter */
    workflowType?: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  }
  ```
- **MIRROR**: `src/types/index.ts:22-37` - follow `IsolationHints` pattern for optional interface
- **IMPORTS**: No new imports needed
- **GOTCHA**: All fields optional for backward compatibility
- **VALIDATE**: `bun run type-check`

### Task 2: UPDATE `src/workflows/router.ts` - Enhance buildRouterPrompt

- **ACTION**: Update `buildRouterPrompt` to accept and use context
- **IMPLEMENT**:
  - Add third parameter: `context?: RouterContext`
  - Build context section if provided
  - Improve prompt instructions to emphasize reading context
  - Key prompt improvements:
    1. Add `## Context` section with platform, title, labels, thread history
    2. Update rules to say "Read the context FIRST to understand the situation"
    3. Add specific guidance: "CI failures, test failures, build errors → use assist, NOT fix-github-issue"
    4. Add: "fix-github-issue is ONLY for implementing solutions to GitHub issues, not for debugging"
- **MIRROR**: Current prompt structure at lines 24-48
- **IMPORTS**: Use new `RouterContext` interface
- **GOTCHA**: Keep prompt concise - don't add too much text that increases latency
- **VALIDATE**: `bun run type-check && bun test src/workflows/router.test.ts`

**Prompt template to implement:**
```typescript
return `# Workflow Router

You are a router. Your job is to pick the best workflow for the user's request.

## Context
${contextSection}

## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Rules

1. Read the CONTEXT section FIRST to understand the situation
2. Read each workflow's description - especially the "NOT for" and "Use when" sections
3. Pick the workflow that best matches the user's intent given the full context
4. IMPORTANT distinctions:
   - CI failures, test failures, build errors → use "assist" (debugging help)
   - "Fix this GitHub issue" (implement a solution) → use "fix-github-issue"
   - Questions, exploration, explanations → use "assist"
5. If unsure, prefer "assist" (the catch-all)
6. You MUST pick a workflow - never respond with just text

## Response Format

Respond with EXACTLY this format, nothing else:
/invoke-workflow {workflow-name}

Pick now:`;
```

### Task 3: UPDATE `src/orchestrator/orchestrator.ts` - Pass context to router

- **ACTION**: Build and pass `RouterContext` to `buildRouterPrompt`
- **IMPLEMENT**:
  - At line ~545-548, build context from available data:
    ```typescript
    const routerContext: RouterContext = {
      platformType: platform.getPlatformType(),
      threadHistory: threadContext,
    };

    // Extract GitHub-specific context from issueContext if present
    if (issueContext) {
      // Parse title from issueContext (format: "[GitHub Issue/PR Context]\nIssue #N: "Title"")
      const titleMatch = issueContext.match(/(?:Issue|PR) #\d+: "([^"]+)"/);
      if (titleMatch) routerContext.title = titleMatch[1];

      // Detect if it's a PR vs issue
      routerContext.isPullRequest = issueContext.includes('[GitHub Pull Request Context]');

      // Extract labels if present
      const labelsMatch = issueContext.match(/Labels: ([^\n]+)/);
      if (labelsMatch && labelsMatch[1].trim()) {
        routerContext.labels = labelsMatch[1].split(',').map(l => l.trim());
      }
    }

    // Add workflow type from isolation hints
    if (isolationHints?.workflowType) {
      routerContext.workflowType = isolationHints.workflowType;
    }

    promptToSend = buildRouterPrompt(message, availableWorkflows, routerContext);
    ```
- **MIRROR**: Current call pattern at line 548
- **IMPORTS**: Add `RouterContext` import from `../workflows/router`
- **GOTCHA**: Keep regex simple - don't over-engineer parsing
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE `src/workflows/router.test.ts` - Add context tests

- **ACTION**: Add tests for new context parameter
- **IMPLEMENT**:
  ```typescript
  describe('buildRouterPrompt with context', () => {
    it('should include context section when context provided', () => {
      const context: RouterContext = {
        platformType: 'github',
        isPullRequest: true,
        title: 'fix: add cloud deployment support',
        labels: ['bug', 'ci'],
      };
      const result = buildRouterPrompt('fix the ci failures', testWorkflows, context);

      expect(result).toContain('## Context');
      expect(result).toContain('Platform: github');
      expect(result).toContain('Type: Pull Request');
      expect(result).toContain('Title: fix: add cloud deployment support');
      expect(result).toContain('Labels: bug, ci');
    });

    it('should include thread history when provided', () => {
      const context: RouterContext = {
        platformType: 'slack',
        threadHistory: '[Bot]: Archon is on the case...\n<@user>: check the CI',
      };
      const result = buildRouterPrompt('what is happening?', testWorkflows, context);

      expect(result).toContain('## Context');
      expect(result).toContain('Thread History:');
      expect(result).toContain('Archon is on the case');
    });

    it('should work without context (backward compatible)', () => {
      const result = buildRouterPrompt('help me', testWorkflows);

      expect(result).toContain('## Available Workflows');
      expect(result).not.toContain('## Context');
    });

    it('should skip empty context', () => {
      const result = buildRouterPrompt('help me', testWorkflows, {});

      expect(result).not.toContain('## Context');
    });
  });
  ```
- **MIRROR**: `src/workflows/router.test.ts:25-93` for test structure
- **IMPORTS**: Add `RouterContext` import
- **GOTCHA**: Test backward compatibility (no context = old behavior)
- **VALIDATE**: `bun test src/workflows/router.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `src/workflows/router.test.ts` | Context inclusion, backward compat, empty context | `buildRouterPrompt` changes |

### Edge Cases Checklist

- [x] No context provided (backward compatible)
- [x] Empty context object `{}`
- [x] Only platformType provided
- [x] Full context with all fields
- [x] Thread history with newlines
- [x] Labels array empty vs populated
- [x] isPullRequest true vs false vs undefined

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run type-check && bun run lint
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
bun test src/workflows/router.test.ts
```

**EXPECT**: All tests pass including new context tests

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

1. Start the app: `bun run dev`
2. Test via test adapter:
   ```bash
   # Simulate a GitHub PR comment
   curl -X POST http://localhost:3000/test/message \
     -H "Content-Type: application/json" \
     -d '{"conversationId":"test-router","message":"fix the ci failures"}'
   ```
3. Check logs for `[Orchestrator] Using workflow-aware router prompt` and verify context is included
4. Verify correct workflow is selected in response

---

## Acceptance Criteria

- [ ] `buildRouterPrompt` accepts optional `RouterContext` parameter
- [ ] Context is formatted and included in router prompt when provided
- [ ] Orchestrator passes context to router (platform type, thread history, GitHub metadata)
- [ ] Backward compatible - works without context
- [ ] New tests cover context functionality
- [ ] All existing tests pass
- [ ] Type-check and lint pass

---

## Completion Checklist

- [ ] Task 1: RouterContext interface added
- [ ] Task 2: buildRouterPrompt enhanced with context section
- [ ] Task 3: Orchestrator passes context to router
- [ ] Task 4: Tests added for context functionality
- [ ] Level 1: `bun run type-check && bun run lint` passes
- [ ] Level 2: `bun test src/workflows/router.test.ts` passes
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Increased prompt length → slower routing | LOW | LOW | Context section is concise; only include relevant fields |
| Regex parsing of issueContext fails | LOW | LOW | Graceful fallback - if parsing fails, field is just undefined |
| Breaking existing callers | LOW | HIGH | Context is optional; default behavior unchanged |

---

## Notes

### Design Decisions

1. **Optional context vs required**: Made optional for backward compatibility and because not all platforms have rich context (Telegram has minimal)

2. **Parse issueContext string vs change adapter interface**: Chose to parse the existing string rather than change adapter interfaces. This is simpler and keeps changes minimal. Future enhancement could add structured context to adapter interface.

3. **Prompt improvements**: Added specific guidance about CI failures vs GitHub issues because this was the exact misrouting case in PR #134.

4. **Thread history included as-is**: Rather than summarizing thread history, we include it directly. The AI can extract relevant context.

### Future Enhancements (NOT in this PR)

- Add structured context interface to adapters (instead of parsing string)
- Allow router to request more context via tools (if accuracy still insufficient)
- Add metrics to track routing accuracy
