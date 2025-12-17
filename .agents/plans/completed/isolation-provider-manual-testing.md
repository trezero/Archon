# Isolation Provider Manual Testing Guide

## Prerequisites

### 1. Start the Application
```bash
# Terminal 1: Start postgres
docker-compose --profile with-db up -d postgres

# Terminal 2: Run app with hot reload
bun run dev
```

### 2. Apply Database Migration
```bash
psql $DATABASE_URL < migrations/005_isolation_abstraction.sql
```

### 3. Verify App is Running
```bash
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

---

## Test Adapter (curl)

Use for quick validation without Slack/GitHub setup.

### Setup
```bash
# Clone a test repo
curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/clone https://github.com/anthropics/anthropic-cookbook"}'

# Wait for clone to complete (~10s)
sleep 10

# Check status
curl http://localhost:3090/test/messages/test-worktree | jq '.messages[-1].message'
```

### Test Worktree Create
```bash
curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree create my-feature"}'

sleep 2
curl http://localhost:3090/test/messages/test-worktree | jq -r '.messages[-1].message'
```
**Expected:**
```
Worktree created!

Branch: task-my-feature
Path: /Users/.../worktrees/anthropic-cookbook/task-my-feature

This conversation now works in isolation.
Run dependency install if needed (e.g., bun install).
```

### Test Worktree List
```bash
curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree list"}'

sleep 1
curl http://localhost:3090/test/messages/test-worktree | jq -r '.messages[-1].message'
```
**Expected:** Shows worktree with `<- active` marker

### Test Worktree Remove
```bash
curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree remove"}'

sleep 2
curl http://localhost:3090/test/messages/test-worktree | jq -r '.messages[-1].message'
```
**Expected:** "Worktree removed... Switched back to main repo."

### Verify Database
```bash
psql $DATABASE_URL -c "
  SELECT platform_conversation_id,
         COALESCE(worktree_path, 'NULL') as worktree_path,
         COALESCE(isolation_env_id, 'NULL') as isolation_env_id,
         COALESCE(isolation_provider, 'NULL') as isolation_provider
  FROM remote_agent_conversations
  WHERE platform_conversation_id = 'test-worktree';"
```

### Cleanup
```bash
curl -X DELETE http://localhost:3090/test/messages/test-worktree
```

---

## Slack Testing

### Prerequisites
- Bot configured with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
- Bot added to a test channel
- Bot mention name: `@Dylan` (or your configured name)

### Test 1: Setup Repository

In any Slack channel or thread:
```
@Dylan /clone https://github.com/anthropics/anthropic-cookbook
```
**Expected:** "Repository cloned successfully!"

### Test 2: Create Worktree
```
@Dylan /worktree create slack-feature-test
```
**Expected:**
```
Worktree created!

Branch: task-slack-feature-test
Path: .../worktrees/anthropic-cookbook/task-slack-feature-test

This conversation now works in isolation.
Run dependency install if needed (e.g., bun install).
```

### Test 3: Verify Isolation
```
@Dylan /status
```
**Expected:** Shows current working directory as the worktree path

### Test 4: List Worktrees
```
@Dylan /worktree list
```
**Expected:** Shows all worktrees with `<- active` marker on current one

### Test 5: Work in Isolation
```
@Dylan /command-invoke prime
```
**Expected:** AI works within the isolated worktree

### Test 6: Remove Worktree
```
@Dylan /worktree remove
```
**Expected:** "Worktree removed... Switched back to main repo."

### Test 7: Verify Cleanup
```
@Dylan /status
```
**Expected:** CWD back to main repository path

---

## GitHub Testing

### Prerequisites
- GitHub App or webhook configured
- `GITHUB_TOKEN` set for CLI operations
- Bot mention: `@Dylan` (configured via `GITHUB_BOT_MENTION`)

### Test 1: Issue Workflow - Auto Worktree Creation

1. **Create a new issue** in your test repository

2. **Trigger the bot** by commenting:
```
@Dylan /command-invoke plan
```

3. **Expected behavior:**
   - Bot creates worktree `issue-{number}`
   - Bot responds with plan in isolated environment
   - Check logs: `[GitHub] Created worktree: .../issue-{number}`

4. **Verify isolation:**
```
@Dylan /status
```
**Expected:** Shows worktree path like `/worktrees/repo/issue-42`

5. **Close the issue**

6. **Expected cleanup:**
   - Worktree automatically removed
   - Check logs: `[GitHub] Removed worktree: ...`

### Test 2: PR Workflow - SHA-based Review

1. **Create a PR** (or use existing)

2. **Trigger review:**
```
@Dylan /command-invoke review
```

3. **Expected behavior:**
   - Bot fetches PR head SHA
   - Creates worktree at exact commit: `pr-{number}-review`
   - Bot can review the exact code state

4. **Check the worktree:**
```
@Dylan /worktree list
```
**Expected:** Shows `pr-{number}-review` as active

5. **Merge or close the PR**

6. **Expected cleanup:** Worktree removed automatically

### Test 3: Linked Issue/PR Worktree Sharing

1. **Create issue #X**

2. **Start work on issue:**
```
@Dylan /command-invoke plan
```
**Expected:** Creates worktree `issue-X`

3. **Note the worktree path** from the response or logs

4. **Create a PR** with description containing `Fixes #X` or `Closes #X`

5. **Comment on the PR:**
```
@Dylan /status
```

6. **Expected:** PR uses the SAME worktree as the linked issue
   - Check logs: `[GitHub] PR #Y linked to issue #X, sharing worktree: ...`

7. **Close the issue** (PR still open)

8. **Expected:** Worktree NOT removed (PR still using it)

9. **Merge/close the PR**

10. **Expected:** Worktree removed (no more references)

### Test 4: Fork PR Handling

1. **Have someone create a PR from a fork**

2. **Comment:**
```
@Dylan /command-invoke review
```

3. **Expected:**
   - Uses GitHub PR refs (`pull/{number}/head`) to fetch fork code
   - Creates worktree successfully even though branch is from fork
   - Check logs for: `fetch origin pull/{number}/head`

---

## Database Verification Commands

### Check All Active Worktrees
```bash
psql $DATABASE_URL -c "
  SELECT platform_type,
         platform_conversation_id,
         worktree_path,
         isolation_env_id,
         isolation_provider
  FROM remote_agent_conversations
  WHERE isolation_env_id IS NOT NULL
     OR worktree_path IS NOT NULL
  ORDER BY updated_at DESC;"
```

### Verify Both Fields Populated
```bash
psql $DATABASE_URL -c "
  SELECT
    COUNT(*) as total_with_isolation,
    COUNT(worktree_path) as has_worktree_path,
    COUNT(isolation_env_id) as has_isolation_env_id,
    COUNT(isolation_provider) as has_isolation_provider
  FROM remote_agent_conversations
  WHERE worktree_path IS NOT NULL
     OR isolation_env_id IS NOT NULL;"
```
**Expected:** All three counts should be equal (both fields populated)

### Check Specific Conversation
```bash
psql $DATABASE_URL -c "
  SELECT * FROM remote_agent_conversations
  WHERE platform_conversation_id = 'owner/repo#42';"
```

---

## Expected Branch Naming

| Workflow | Branch Name |
|----------|-------------|
| Issue #42 | `issue-42` |
| PR #42 (no existing branch) | `pr-42` |
| PR #42 review (with SHA) | `pr-42-review` |
| Manual `/worktree create foo` | `task-foo` |
| Slack/Discord thread (future) | `thread-{8-char-hash}` |

---

## Troubleshooting

### Worktree Creation Fails
```
Failed to create isolated worktree for branch `issue-42`
```
**Causes:**
- Branch already exists: Try with different issue number
- Git repo not clean: Check for uncommitted changes in main repo
- Permission issues: Check filesystem permissions

**Fix:**
```bash
# List existing worktrees
git -C /path/to/repo worktree list

# Remove stale worktree
git -C /path/to/repo worktree remove /path/to/worktree --force
```

### Database Column Missing
```
column "isolation_env_id" does not exist
```
**Fix:** Apply migration
```bash
psql $DATABASE_URL < migrations/005_isolation_abstraction.sql
```

### Worktree Not Cleaned Up on Close
Check server logs for errors. Common issues:
- Uncommitted changes in worktree (won't force-delete)
- Another conversation still references the worktree

**Manual cleanup:**
```bash
git -C /path/to/main/repo worktree remove /path/to/worktree --force
```

---

## Server Log Messages to Watch

### Successful Creation
```
[GitHub] PR #42 head branch: feature/auth, SHA: abc123
[GitHub] Created worktree: /path/to/worktrees/repo/pr-42-review
```

### Worktree Adoption (Skill Symbiosis)
```
[WorktreeProvider] Adopting existing worktree: /path/to/worktrees/repo/feature-auth
```

### Linked Issue Sharing
```
[GitHub] PR #43 linked to issue #42, sharing worktree: /path/to/worktrees/repo/issue-42
```

### Cleanup
```
[GitHub] Deactivated session abc123 for worktree cleanup
[GitHub] Removed worktree: /path/to/worktrees/repo/issue-42
[GitHub] Cleanup complete for owner/repo#42
```

### Shared Worktree Preserved
```
[GitHub] Keeping worktree /path/..., still used by owner/repo#43
```
