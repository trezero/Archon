# Investigation: RouterContext not populated for non-slash commands on GitHub

**Issue**: #171 (https://github.com/dynamous-community/remote-coding-agent/issues/171)
**Type**: BUG
**Investigated**: 2026-01-13T08:31:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | LOW | Routing still works because full context is embedded in message text; the router prompt's improved rules catch most cases; impact is limited to less reliable structured context for routing decisions. |
| Complexity | LOW | Fix requires changes to 1 file (orchestrator.ts) with ~20 lines of code; no architectural changes; isolated to context extraction logic; existing patterns can be mirrored. |
| Confidence | HIGH | Root cause is definitively identified through code inspection; clear evidence chain from GitHub adapter through to orchestrator; PR #170 commit history confirms when issue was introduced; existing buildIssueContext/buildPRContext patterns provide clear fix path. |

---

## Problem Statement

The RouterContext is not being populated for non-slash commands on GitHub, resulting in missing metadata (isPullRequest, title, labels) that could improve workflow routing decisions. Slash commands receive properly populated RouterContext, but non-slash commands show only platformType with all other fields undefined.

---

## Analysis

### Root Cause

The orchestrator's RouterContext extraction logic only handles the slash command format where context is passed as the `issueContext` parameter. For non-slash commands, the GitHub adapter embeds context in the `message` parameter with markers like `[GitHub Issue Context]` or `[GitHub Pull Request Context]`, which the orchestrator doesn't parse.

### Evidence Chain

**WHY**: RouterContext not populated for non-slash commands
↓ **BECAUSE**: The orchestrator only extracts RouterContext fields when `issueContext` parameter is provided
  Evidence: `src/orchestrator/orchestrator.ts:556` - `if (issueContext) { ... }`

↓ **BECAUSE**: For non-slash commands, `issueContext` is undefined
  Evidence: `src/adapters/github.ts:708` - `let contextToAppend: string | undefined;` (stays undefined for non-slash commands)
  Evidence: `src/adapters/github.ts:750` - `contextToAppend` passed as undefined to orchestrator

↓ **BECAUSE**: GitHub adapter only sets `contextToAppend` for slash commands
  Evidence: `src/adapters/github.ts:718-729` - Sets `contextToAppend` for slash commands
  Evidence: `src/adapters/github.ts:732-740` - Embeds context in `finalMessage` for non-slash commands via `buildIssueContext()`/`buildPRContext()`

↓ **BECAUSE**: Slash commands need minimal context (one-liner), non-slash need rich context (full details)
  Evidence: `src/adapters/github.ts:710-715` - Comment explains: "Slash commands must be processed deterministically (not by AI)"

↓ **ROOT CAUSE**: RouterContext extraction (PR #170) was designed for slash command format without considering existing dual-context pattern
  Evidence: Commit `860b712` (2026-01-12) added RouterContext extraction that only parses `issueContext` parameter, not the embedded format in `message`

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/orchestrator/orchestrator.ts` | 555-577 | UPDATE | Add fallback extraction from `message` when `issueContext` is undefined |

### Integration Points

- `src/adapters/github.ts:746-754` - Calls `handleMessage()` with `contextToAppend` (undefined for non-slash commands)
- `src/adapters/github.ts:553-569` - `buildIssueContext()` creates `[GitHub Issue Context]` format
- `src/adapters/github.ts:574-594` - `buildPRContext()` creates `[GitHub Pull Request Context]` format
- `src/workflows/router.ts:31-59` - `buildContextSection()` uses RouterContext fields for routing prompt
- `src/workflows/router.ts:11-24` - RouterContext type definition

### Git History

- **Introduced**: 860b712 - 2026-01-12 - "feat: enhance workflow router with platform context (#170)"
- **Last modified**: 860b712 - 2026-01-12
- **Implication**: Recent regression introduced by RouterContext feature; extraction logic didn't account for non-slash command context format

---

## Implementation Plan

### Step 1: Add fallback extraction from message parameter

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 555-577
**Action**: UPDATE

**Current code:**
```typescript
// Extract GitHub-specific context from issueContext if present
if (issueContext) {
  // Parse title from issueContext (format: "Issue #N: "Title"" or "PR #N: "Title"")
  const titlePattern = /(?:Issue|PR) #\d+: "([^"]+)"/;
  const titleMatch = titlePattern.exec(issueContext);
  if (titleMatch?.[1]) {
    routerContext.title = titleMatch[1];
  } else {
    console.log('[Orchestrator] Could not extract title from issueContext (format mismatch)');
  }

  // Detect if it's a PR vs issue
  routerContext.isPullRequest = issueContext.includes('[GitHub Pull Request Context]');

  // Extract labels if present
  const labelsPattern = /Labels: ([^\n]+)/;
  const labelsMatch = labelsPattern.exec(issueContext);
  if (labelsMatch?.[1]?.trim()) {
    routerContext.labels = labelsMatch[1].split(',').map(l => l.trim());
  } else {
    console.log('[Orchestrator] No labels found in issueContext');
  }
}
```

**Required change:**
```typescript
// Extract GitHub-specific context from issueContext OR message if present
// For slash commands: context is in issueContext parameter
// For non-slash commands: context is embedded in message with markers
const contextSource = issueContext || message;

if (contextSource) {
  // Parse title from context (format: "Issue #N: "Title"" or "PR #N: "Title"")
  const titlePattern = /(?:Issue|PR) #\d+: "([^"]+)"/;
  const titleMatch = titlePattern.exec(contextSource);
  if (titleMatch?.[1]) {
    routerContext.title = titleMatch[1];
  } else {
    console.log('[Orchestrator] Could not extract title from context (format mismatch)');
  }

  // Detect if it's a PR vs issue
  routerContext.isPullRequest = contextSource.includes('[GitHub Pull Request Context]');

  // Extract labels if present
  const labelsPattern = /Labels: ([^\n]+)/;
  const labelsMatch = labelsPattern.exec(contextSource);
  if (labelsMatch?.[1]?.trim()) {
    routerContext.labels = labelsMatch[1].split(',').map(l => l.trim());
  } else {
    console.log('[Orchestrator] No labels found in context');
  }
}
```

**Why**: This allows the orchestrator to extract RouterContext fields from either the `issueContext` parameter (slash commands) or the `message` parameter (non-slash commands), unifying both code paths.

---

### Step 2: Update debug logging to distinguish context sources

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 585-592
**Action**: UPDATE

**Current code:**
```typescript
console.log('[Orchestrator] Router context:', {
  platformType: routerContext.platformType,
  isPullRequest: routerContext.isPullRequest,
  hasTitle: !!routerContext.title,
  hasLabels: !!(routerContext.labels && routerContext.labels.length > 0),
  hasThreadHistory: !!routerContext.threadHistory,
  hasIssueContext: !!issueContext, // Helps distinguish "no context" vs "extraction failed"
});
```

**Required change:**
```typescript
console.log('[Orchestrator] Router context:', {
  platformType: routerContext.platformType,
  isPullRequest: routerContext.isPullRequest,
  hasTitle: !!routerContext.title,
  hasLabels: !!(routerContext.labels && routerContext.labels.length > 0),
  hasThreadHistory: !!routerContext.threadHistory,
  contextSource: issueContext ? 'issueContext' : (message.includes('[GitHub') ? 'message' : 'none'),
});
```

**Why**: Improved debugging to show where context was extracted from (issueContext parameter vs message parameter), helping diagnose future routing issues.

---

### Step 3: Add test for non-slash command context extraction

**File**: `src/orchestrator/orchestrator.test.ts`
**Action**: UPDATE

**Test case to add:**
```typescript
describe('RouterContext extraction', () => {
  // ... existing tests ...

  it('should extract context from message when issueContext is undefined (non-slash command)', async () => {
    const mockPlatform: IPlatformAdapter = {
      getPlatformType: () => 'github',
      sendMessage: jest.fn(),
      close: jest.fn(),
    };

    const message = `[GitHub Issue Context]
Issue #42: "Bug in router"
Author: user
Labels: bug, priority: high
Status: open

Description:
The router is broken.

---

Please fix this`;

    // Call handleMessage with message containing context, but no issueContext parameter
    await handleMessage(mockPlatform, 'test-conv', message, undefined);

    // Verify RouterContext was extracted from message
    // (This test would verify the extraction logic works by checking logs or mocking buildRouterPrompt)
  });

  it('should prioritize issueContext over message when both are present', async () => {
    const mockPlatform: IPlatformAdapter = {
      getPlatformType: () => 'github',
      sendMessage: jest.fn(),
      close: jest.fn(),
    };

    const message = `[GitHub Issue Context]
Issue #42: "Wrong Title"
Author: user
Labels: wrong
Status: open

Description:
Wrong description

---

/help`;

    const issueContext = `GitHub Issue #42: "Correct Title"
Labels: correct`;

    // Call handleMessage with both message and issueContext
    await handleMessage(mockPlatform, 'test-conv', message, issueContext);

    // Verify RouterContext was extracted from issueContext (not message)
    // Title should be "Correct Title", labels should be ["correct"]
  });
});
```

**Why**: Ensures the fix works for both non-slash commands (context in message) and slash commands (context in issueContext), and that issueContext takes precedence when both are present.

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/orchestrator/orchestrator.ts:556-577
// Pattern for extracting GitHub context with regex
if (issueContext) {
  const titlePattern = /(?:Issue|PR) #\d+: "([^"]+)"/;
  const titleMatch = titlePattern.exec(issueContext);
  if (titleMatch?.[1]) {
    routerContext.title = titleMatch[1];
  }

  routerContext.isPullRequest = issueContext.includes('[GitHub Pull Request Context]');

  const labelsPattern = /Labels: ([^\n]+)/;
  const labelsMatch = labelsPattern.exec(issueContext);
  if (labelsMatch?.[1]?.trim()) {
    routerContext.labels = labelsMatch[1].split(',').map(l => l.trim());
  }
}
```

**Reuse this pattern but apply to `contextSource` (issueContext OR message) instead of just `issueContext`.**

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Message contains GitHub context markers for unrelated reasons | Low risk - markers are specific (`[GitHub Issue Context]`, `[GitHub Pull Request Context]`); only appear at start of message from buildIssueContext/buildPRContext |
| Both issueContext and message contain context (shouldn't happen currently) | Use issueContext first (existing parameter), fallback to message only if issueContext is undefined; maintains backward compatibility |
| Performance impact from parsing message | Negligible - regex extraction is O(n) on message length; only runs when workflows are available and platformType is GitHub |
| Title/labels not found in message format | Same error handling as current code - log warning and continue with partial context; routing still works without these fields |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/orchestrator/orchestrator.test.ts
bun run lint
```

### Manual Verification

1. **Test non-slash command on GitHub issue:**
   - Comment `@archon help me with this` on a GitHub issue
   - Check logs for: `[Orchestrator] Router context:` should show `isPullRequest: false`, `hasTitle: true`, `hasLabels: true`, `contextSource: 'message'`

2. **Test slash command on GitHub PR:**
   - Comment `/assist` on a GitHub PR
   - Check logs for: `[Orchestrator] Router context:` should show `isPullRequest: true`, `hasTitle: true`, `contextSource: 'issueContext'`

3. **Test workflow routing with populated context:**
   - Comment `fix the CI failures` on a PR with labels `ci, tests`
   - Verify router uses label context to make better routing decisions
   - Should route to `assist` workflow (not `fix-github-issue`)

---

## Scope Boundaries

**IN SCOPE:**
- Update orchestrator to extract RouterContext from message when issueContext is undefined
- Add debug logging to show context source
- Add tests for non-slash command context extraction
- Ensure both slash and non-slash commands populate RouterContext correctly

**OUT OF SCOPE (do not touch):**
- Changing GitHub adapter's dual-context approach (slash vs non-slash)
- Modifying buildIssueContext/buildPRContext format
- Changing RouterContext type definition
- Modifying workflow router prompt or routing logic
- Adding context extraction for other platforms (Slack, Telegram)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T08:31:00Z
- **Artifact**: `.archon/artifacts/issues/issue-171.md`
