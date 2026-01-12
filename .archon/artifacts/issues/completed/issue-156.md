# Investigation: GitHub UX: Use code formatting for workflow/command names

**Issue**: #156 (https://github.com/dynamous-community/remote-coding-agent/issues/156)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-07T20:24:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Improves visual clarity and consistency with existing code formatting patterns, but doesn't block functionality or affect core features. |
| Complexity | LOW | Simple string formatting changes (adding backticks) in 2 source files, with corresponding test updates - no logic changes or architectural decisions. |
| Confidence | HIGH | All affected code locations clearly identified through comprehensive exploration, change pattern is straightforward (wrap identifiers in backticks), existing backtick usage establishes the pattern. |

---

## Problem Statement

Workflow and command names in bot messages are currently shown in plain text or bold formatting, which doesn't visually distinguish them as code identifiers. This reduces readability and is inconsistent with how commands are shown elsewhere (e.g., `/help` uses backticks). Users have requested inline code formatting (backticks) for these identifiers to improve visual clarity and match established conventions.

---

## Analysis

### Change Rationale

This is a UX enhancement to improve message readability and consistency. Currently, workflow and command names appear as:
- `**Starting workflow**: assist`
- `**Step 1/2**: investigate-issue`

The proposed change wraps these identifiers in backticks:
- `**Starting workflow**: `assist``
- `**Step 1/2**: `investigate-issue``

This matches the pattern already used for technical identifiers in the codebase (commit hashes, branch names) and provides better visual distinction between descriptive text and code identifiers.

### Evidence Chain

WHY: Workflow/command names are hard to distinguish from prose
↓ BECAUSE: They use the same plain text formatting as descriptive text
  Evidence: `src/workflows/executor.ts:364` - `**Step ${stepIndex + 1}/${workflow.steps.length}**: ${commandName}`
  Evidence: `src/workflows/executor.ts:518` - `**Starting workflow**: ${workflow.name}`

↓ BECAUSE: No inline code formatting (backticks) is applied to these identifiers
  Evidence: All workflow message templates use plain string interpolation without backticks

↓ SOLUTION: Wrap workflow/command names in backticks to match existing code identifier patterns
  Evidence: `src/adapters/github.test.ts:541` - Shows established pattern: `` `abc1234` `` for commit hash, `` `feature-x` `` for branch name

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/workflows/executor.ts` | 364 | UPDATE | Wrap commandName in backticks for step notification |
| `src/workflows/executor.ts` | 518 | UPDATE | Wrap workflow.name and each step command in backticks for workflow start message |
| `src/workflows/executor.ts` | 552 | UPDATE | Wrap result.commandName in backticks for workflow failure message |
| `src/workflows/executor.ts` | 591 | UPDATE | Wrap workflow.name in backticks for workflow completion message |
| `src/handlers/command-handler.ts` | 1330 | UPDATE | Wrap workflow names and step commands in backticks for workflow list |
| `src/workflows/executor.test.ts` | 142 | UPDATE | Update test expectation for workflow start message |
| `src/workflows/executor.test.ts` | 144 | UPDATE | Update test expectation for steps list in start message |
| `src/workflows/executor.test.ts` | 162-163 | UPDATE | Update test expectations for step notifications |
| `src/workflows/executor.test.ts` | 242 | UPDATE | Update test expectation for workflow complete message |

### Integration Points

- `src/workflows/executor.ts` - Main workflow execution engine, sends all workflow-related messages
- `src/handlers/command-handler.ts` - Handles `/workflows` command, lists available workflows
- Test expectations in `src/workflows/executor.test.ts` validate message formats
- Platform adapters receive these messages and send to users (no changes needed - they just pass through text)

### Git History

```bash
# Recent commits touching executor.ts
b0edafc - 2026-01-07 - "Add investigate-issue and implement-issue commands for fix-github-issue workflow"
471ac59 - 2026-01-07 - "Improve error handling in workflow engine (#150)"
```

**Implication**: These are recently active message templates, change is purely cosmetic and doesn't affect any logic or error handling improvements.

---

## Implementation Plan

### Step 1: Update step notification message

**File**: `src/workflows/executor.ts`
**Lines**: 364
**Action**: UPDATE

**Current code:**
```typescript
`**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${commandName}`,
```

**Required change:**
```typescript
`**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: \`${commandName}\``,
```

**Why**: Wraps the command name in backticks to format it as inline code.

---

### Step 2: Update workflow start message

**File**: `src/workflows/executor.ts`
**Lines**: 518
**Action**: UPDATE

**Current code:**
```typescript
`**Starting workflow**: ${workflow.name}\n\n${workflow.description}\n\nSteps: ${workflow.steps.map(s => s.command).join(' -> ')}`,
```

**Required change:**
```typescript
`**Starting workflow**: \`${workflow.name}\`\n\n${workflow.description}\n\nSteps: ${workflow.steps.map(s => `\`${s.command}\``).join(' -> ')}`,
```

**Why**: Wraps workflow name in backticks and wraps each command in the steps list in backticks (e.g., `` `plan` -> `implement` -> `commit` ``).

---

### Step 3: Update workflow failure message

**File**: `src/workflows/executor.ts`
**Lines**: 552
**Action**: UPDATE

**Current code:**
```typescript
`**Workflow failed** at step: ${result.commandName}\n\nError: ${result.error}`,
```

**Required change:**
```typescript
`**Workflow failed** at step: \`${result.commandName}\`\n\nError: ${result.error}`,
```

**Why**: Wraps the failed command name in backticks for consistency.

---

### Step 4: Update workflow completion message

**File**: `src/workflows/executor.ts`
**Lines**: 591
**Action**: UPDATE

**Current code:**
```typescript
`**Workflow complete**: ${workflow.name}`,
```

**Required change:**
```typescript
`**Workflow complete**: \`${workflow.name}\``,
```

**Why**: Wraps workflow name in backticks to match the start message pattern.

---

### Step 5: Update workflow list in command handler

**File**: `src/handlers/command-handler.ts`
**Lines**: 1330
**Action**: UPDATE

**Current code:**
```typescript
msg += `**${w.name}**\n  ${w.description}\n  Steps: ${w.steps.map(s => s.command).join(' -> ')}\n\n`;
```

**Required change:**
```typescript
msg += `**\`${w.name}\`**\n  ${w.description}\n  Steps: ${w.steps.map(s => `\`${s.command}\``).join(' -> ')}\n\n`;
```

**Why**: Wraps workflow name and each step command in backticks (inside the bold formatting for the name). Results in: **`workflow-name`** with steps formatted as `` `step1` -> `step2` ``.

---

### Step 6: Update test expectations for workflow start

**File**: `src/workflows/executor.test.ts`
**Lines**: 142, 144
**Action**: UPDATE

**Current code:**
```typescript
expect(calls[0][1]).toContain('**Starting workflow**: test-workflow');
// ...
expect(calls[0][1]).toContain('command-one -> command-two');
```

**Required change:**
```typescript
expect(calls[0][1]).toContain('**Starting workflow**: `test-workflow`');
// ...
expect(calls[0][1]).toContain('`command-one` -> `command-two`');
```

**Why**: Update test expectations to match the new backtick formatting.

---

### Step 7: Update test expectations for step notifications

**File**: `src/workflows/executor.test.ts`
**Lines**: 162-163
**Action**: UPDATE

**Current code:**
```typescript
expect(messages.some((m: string) => m.includes('**Step 1/2**: command-one'))).toBe(true);
expect(messages.some((m: string) => m.includes('**Step 2/2**: command-two'))).toBe(true);
```

**Required change:**
```typescript
expect(messages.some((m: string) => m.includes('**Step 1/2**: `command-one`'))).toBe(true);
expect(messages.some((m: string) => m.includes('**Step 2/2**: `command-two`'))).toBe(true);
```

**Why**: Update test expectations to match the new backtick formatting.

---

### Step 8: Update test expectations for workflow completion

**File**: `src/workflows/executor.test.ts`
**Lines**: 242
**Action**: UPDATE

**Current code:**
```typescript
expect(lastMessage).toContain('**Workflow complete**: test-workflow');
```

**Required change:**
```typescript
expect(lastMessage).toContain('**Workflow complete**: `test-workflow`');
```

**Why**: Update test expectation to match the new backtick formatting.

---

### Step 9: Verify no other occurrences

**Action**: VERIFY

**Check**: Grep for other potential locations where workflow/command names might be displayed:
```bash
grep -r "Starting workflow" src/
grep -r "Workflow complete" src/
grep -r "Workflow failed" src/
grep -r "Step.*:" src/ | grep -v test
```

**Expected**: Should only find the locations already covered above. If any additional locations are found, apply the same pattern (wrap identifiers in backticks).

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/adapters/github.test.ts:541
// Pattern for inline code formatting of technical identifiers
const prMessage = 'Reviewing PR at commit `abc1234` (branch: `feature-x`)';
```

This demonstrates the established convention: wrap technical identifiers (commit hashes, branch names, command names, workflow names) in backticks for inline code formatting.

**Template string escaping:**
```typescript
// In JavaScript template strings, use backtick inside the string by escaping with backslash
`**Starting workflow**: \`${workflow.name}\``
//                       ^                   ^
//                       These backticks format the workflow name as code
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Workflow/command names containing special characters | Backticks handle special characters safely - they don't require escaping in markdown |
| Nested backticks in workflow names | Workflow names are filesystem-safe identifiers (no backticks allowed), so this can't occur |
| Platform-specific markdown rendering | All platforms (GitHub, Slack, Telegram) support inline code with backticks - this is standard markdown |
| Breaking test expectations | All test expectations are updated in the same commit to maintain green tests |
| Message length with added formatting | Adding 2 backticks per identifier adds negligible length (4-6 extra chars per message) |

---

## Validation

### Automated Checks

```bash
# Type checking
bun run type-check

# Run all workflow executor tests
bun test src/workflows/executor.test.ts

# Run all tests
bun test

# Lint check
bun run lint
```

### Manual Verification

1. **Test workflow execution** - Run a workflow and verify messages display with backticks:
   - Start message: `**Starting workflow**: `test-workflow``
   - Step messages: `**Step 1/2**: `command-one``
   - Complete message: `**Workflow complete**: `test-workflow``

2. **Test workflow list** - Run `/workflows` command and verify:
   - Workflow names: **`workflow-name`**
   - Steps list: `` `step1` -> `step2` -> `step3` ``

3. **Test failure case** - Trigger a workflow failure and verify:
   - Failure message: `**Workflow failed** at step: `command-name``

4. **Check rendering** - Verify backtick formatting renders correctly in:
   - GitHub comments (where testing occurs)
   - Slack messages (if Slack adapter is configured)
   - Telegram messages (if Telegram adapter is configured)

---

## Scope Boundaries

**IN SCOPE:**
- Workflow execution messages (start, step, complete, failed)
- Workflow list output from `/workflows` command
- Step command names in the steps list
- Test expectations for these messages

**OUT OF SCOPE (do not touch):**
- Slash command formatting (already uses backticks, e.g., `/help`)
- Error messages not related to workflows
- Command handler messages beyond `/workflows`
- Platform adapter code (they just pass through text)
- Logging output (internal, not user-facing)
- Other bot messages unrelated to workflow execution

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-07T20:24:00Z
- **Artifact**: `.archon/artifacts/issues/issue-156.md`
- **Confidence**: HIGH (all locations identified, pattern is clear and established)
- **Estimated Impact**: Low risk, high visual clarity improvement
