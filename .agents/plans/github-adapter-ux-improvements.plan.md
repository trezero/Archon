# Plan: GitHub Adapter UX Improvements

## Summary

This plan addresses a critical UX gap in the GitHub adapter: users currently receive NO feedback when worktree isolation is created for their issues/PRs. The worktree context is only appended to the AI prompt, not shown to users. This plan adds: (1) user-facing feedback when worktree isolation is created, (2) consistent terminology and messaging, and (3) establishes the UX pattern that will be mirrored by Phase 3B for Slack/Discord/Telegram adapters.

## Intent

Before implementing auto-isolation for Slack/Discord/Telegram (Phase 3), we should validate the UX pattern on GitHub first. GitHub has cleaner lifecycle events (issue/PR close), so it's the ideal testing ground. By fixing the GitHub adapter UX now, we:
1. Validate the feedback message format with real users
2. Ensure consistency before scaling to other platforms
3. Reduce risk by finding issues on the platform with explicit close events

## Persona

A developer who:
- Mentions `@remote-agent` on a GitHub issue to get help with a bug
- Expects the bot to respond with context about what it's doing
- May not understand git worktrees but should understand "working in isolated branch"
- Wants confirmation that their request is being processed before seeing AI output

## UX

### Before (Current)

```
User comments on Issue #42: @remote-agent fix this bug

GitHub Adapter (internal):
  ├── Creates worktree: /worktrees/repo/issue-42
  ├── console.log: "[GitHub] Created worktree: /worktrees/repo/issue-42"
  ├── Appends to AI prompt: "[Working in isolated branch: issue-42...]"
  └── Routes to AI

User sees:
  └── [AI response starts directly - no indication isolation happened]

User doesn't know:
  - A worktree was created
  - What branch they're on
  - That changes are isolated from main
```

### After (Proposed)

```
User comments on Issue #42: @remote-agent fix this bug

GitHub Adapter:
  ├── Creates worktree: /worktrees/repo/issue-42
  ├── Sends user message: "Working in isolated branch `issue-42`"
  ├── Appends to AI prompt: "[Working in isolated branch: issue-42...]"
  └── Routes to AI

User sees:
  └── Bot comment: "Working in isolated branch `issue-42`"
  └── [AI response follows]

For PRs, user sees:
  └── Bot comment: "Reviewing PR at commit `abc1234` (branch: `feature-x`)"
  └── [AI response follows]
```

### Message Format

| Scenario | Message |
|----------|---------|
| New issue worktree | `Working in isolated branch \`issue-42\`` |
| New PR worktree (with SHA) | `Reviewing PR at commit \`abc1234\` (branch: \`feature-x\`)` |
| New PR worktree (no SHA) | `Working in isolated branch \`pr-42\`` |
| Existing worktree (reuse) | *No message* (silent reuse) |
| Shared worktree (PR linked to issue) | *No message* (already shown on issue) |

### Key UX Decisions

1. **Only show on first creation** - Don't spam every @mention
2. **Keep it short** - Single line, no verbose explanations
3. **Use backticks for branch names** - Consistent with GitHub markdown
4. **Silent reuse** - No message when continuing in existing worktree
5. **Error messages already exist** - Line 718-721 handles errors

## External Research

### Documentation
- [GitHub Actions Comment Progress](https://github.com/marketplace/actions/comment-progress) - Pattern for progress updates in same comment
- [Create or Update Comment Action](https://github.com/marketplace/actions/create-or-update-comment) - Sticky/updatable comments pattern

### Best Practices from Research
- **Use sticky comments** to avoid spam - but our case is single message per worktree creation
- **Include status indicators** - We use backticks for branch names
- **Keep messages short** - Single line is ideal for non-intrusive feedback
- **Don't duplicate existing patterns** - GitHub bots like Netlify show brief status

### Git Worktree UX (from [lazygit discussion](https://github.com/jesseduffield/lazygit/discussions/2803))
- Users want simple mental model: "one worktree per branch"
- Branch naming should be obvious (issue-42, pr-42)
- Progress feedback reduces confusion

## Patterns to Mirror

### Existing User Message Pattern (Error Case)
```typescript
// FROM: src/adapters/github.ts:718-721
// This is how we currently send user-facing messages on error:
await this.sendMessage(
  conversationId,
  `Failed to create isolated worktree for branch \`${branchName}\`. This may be due to a branch name conflict or filesystem issue.\n\nError: ${err.message}\n\nPlease resolve the issue and try again.`
);
```

### Status Command Output Pattern
```typescript
// FROM: src/handlers/command-handler.ts:169-174
// This shows how we format isolation info with short paths:
const activeIsolation = conversation.isolation_env_id ?? conversation.worktree_path;
if (activeIsolation) {
  const repoRoot = codebase?.default_cwd;
  const shortPath = shortenPath(activeIsolation, repoRoot);
  msg += `\nWorktree: ${shortPath}`;
}
```

### Context Append Pattern (AI-Only Message)
```typescript
// FROM: src/adapters/github.ts:793-799
// This is the AI-only context we already append:
worktreeContext = `\n\n[Working in isolated worktree at commit ${shortSha} (PR #${String(number)} branch: ${branchName}). This is the exact commit that triggered the review for reproducibility.]`;
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/adapters/github.ts` | UPDATE | Add user feedback on worktree creation (after line 704) |
| `src/adapters/github.test.ts` | UPDATE | Add test for user feedback message |

## NOT Building

- **No changes to other adapters** - That's Phase 3's job
- **No sticky/updatable comments** - Single creation message is sufficient
- **No progress indicators** - We're not tracking multi-step progress
- **No changes to AI context** - The `contextToAppend` logic stays the same
- **No changes to error handling** - Already works correctly

## Tasks

### Task 1: Add user feedback message after worktree creation

**Why**: Users currently get no indication that a worktree was created. This adds a single-line confirmation message.

**Mirror**: `src/adapters/github.ts:718-721` (existing sendMessage pattern on error)

**Do**:

After line 704 (after `console.log(`[GitHub] Created worktree: ${worktreePath}`);`), add user feedback:

```typescript
          worktreePath = env.workingPath;
          console.log(`[GitHub] Created worktree: ${worktreePath}`);

          // Send user feedback about isolation (single line, not verbose)
          if (isPR && prHeadBranch && prHeadSha) {
            const shortSha = prHeadSha.substring(0, 7);
            await this.sendMessage(
              conversationId,
              `Reviewing PR at commit \`${shortSha}\` (branch: \`${prHeadBranch}\`)`
            );
          } else {
            const branchName = isPR ? `pr-${String(number)}` : `issue-${String(number)}`;
            await this.sendMessage(
              conversationId,
              `Working in isolated branch \`${branchName}\``
            );
          }

          // Update conversation with isolation info...
```

**Don't**:
- Don't add message for reused worktrees (line 725-728 case)
- Don't add message for shared worktrees (line 648-662 case)
- Don't modify the AI context (contextToAppend) - that stays as-is

**Verify**: `bun run type-check && bun test src/adapters/github.test.ts`

---

### Task 2: Add test for user feedback message

**Why**: Verify that the new user-facing message is sent on worktree creation.

**Mirror**: Existing test patterns in `src/adapters/github.test.ts`

**Do**:

Add a test that verifies the feedback message:

```typescript
describe('worktree creation feedback', () => {
  test('sends user message when creating issue worktree', async () => {
    // Setup: Mock issue webhook, no existing worktree
    // Action: Process webhook
    // Assert: sendMessage called with "Working in isolated branch `issue-42`"
  });

  test('sends user message with SHA when creating PR worktree', async () => {
    // Setup: Mock PR webhook with head SHA
    // Action: Process webhook
    // Assert: sendMessage called with "Reviewing PR at commit `abc1234`..."
  });

  test('does not send message when reusing existing worktree', async () => {
    // Setup: Conversation already has isolation_env_id
    // Action: Process webhook
    // Assert: sendMessage NOT called (only AI response)
  });
});
```

**Don't**:
- Don't test the full end-to-end flow - just the feedback message logic

**Verify**: `bun test src/adapters/github.test.ts`

---

## Validation Strategy

### Automated Checks

- [ ] `bun run type-check` - Types valid
- [ ] `bun run lint` - No lint errors
- [ ] `bun test src/adapters/github.test.ts` - All GitHub adapter tests pass

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `github.test.ts` | "sends user message when creating issue worktree" | Issue worktree feedback shown |
| `github.test.ts` | "sends user message with SHA when creating PR worktree" | PR worktree feedback with commit SHA |
| `github.test.ts` | "does not send message when reusing existing worktree" | No spam on subsequent @mentions |

### Manual/E2E Validation

**Test new issue worktree:**
1. Create a new GitHub issue in a test repo
2. Comment: `@remote-agent help me fix this`
3. Expected: Bot comments "Working in isolated branch `issue-X`"
4. Expected: AI response follows

**Test new PR worktree:**
1. Create a PR in test repo
2. Comment: `@remote-agent review this`
3. Expected: Bot comments "Reviewing PR at commit `abc1234` (branch: `feature-x`)"
4. Expected: AI response follows

**Test reuse (no spam):**
1. On same issue from step 1
2. Comment: `@remote-agent now do something else`
3. Expected: NO "Working in..." message (just AI response)

### Edge Cases

- [ ] **PR without head SHA** - Falls back to "Working in isolated branch `pr-X`"
- [ ] **Shared worktree (PR linked to issue)** - No message (issue already showed it)
- [ ] **Worktree creation fails** - Error message shown (already implemented)
- [ ] **Multiple @mentions same issue** - Only first one shows feedback

### Regression Check

- [ ] Existing error handling still works (line 718-721)
- [ ] AI context still gets appended (contextToAppend unchanged)
- [ ] Cleanup on issue/PR close still works
- [ ] `/status` command still shows worktree path

## Risks

1. **Comment spam potential** - Mitigated by only showing on FIRST creation
2. **Rate limits** - Adding one extra comment per worktree creation is minimal
3. **Message timing** - User sees feedback BEFORE AI response (correct order)
4. **Failure mid-send** - If sendMessage fails, we still proceed (non-fatal)

## Success Criteria

After implementation:
1. Users see brief feedback when worktree is created
2. Message is single line, uses backticks for branch/commit
3. No message spam on subsequent @mentions
4. This pattern validates the UX for Phase 3B to mirror
