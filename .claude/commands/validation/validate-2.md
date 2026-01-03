# Ultimate Validation Command (Updated January 2026)

Run comprehensive validation covering all aspects of the Remote Coding Agent. This command validates code quality, type safety, functionality, and complete user workflows.

**Updated for:**
- Bun runtime (not npm)
- Archon paths (~/.archon/workspaces/owner/repo)
- 6 database tables (added: command_templates, isolation_environments, workflow_runs)
- New commands (/repos, /repo, /worktree, /init, /templates)
- Isolation provider abstraction

---

## Phase 1: Code Quality - Foundation Validation

### 1.1 Linting

Run ESLint with strict TypeScript rules:

```bash
bun run lint
```

**Expected:** Zero linting errors.

### 1.2 Type Checking

Run TypeScript compiler in check mode:

```bash
bun run type-check
```

**Expected:** Zero type errors with strict mode enabled.

### 1.3 Build

Build the project:

```bash
bun run build
```

**Expected:** Clean build to `dist/` directory.

### 1.4 Code Formatting

Check formatting compliance:

```bash
bun run format:check
```

**Expected:** All files pass Prettier checks.

### 1.5 Unit Tests

Run Bun test suite:

```bash
bun test
```

**Expected:** All unit tests pass.

---

## Phase 2: Environment Setup

### 2.0 Clean Workspace (Optional)

If starting fresh, clean previous test artifacts:

```bash
# Remove test workspaces (careful - this deletes repos!)
rm -rf ~/.archon/workspaces/test-*
rm -rf ~/.archon/worktrees/test-*

# Clean up any existing containers
docker compose down -v 2>/dev/null || true
```

### 2.1 Build and Start Docker

Build and start all services:

```bash
docker compose --profile with-db up -d --build
```

Wait for containers to be ready:

```bash
# Wait for postgres to be ready
sleep 10

# Check container status
docker compose ps
```

**Expected:** Both `postgres` and `app-with-db` containers running.

### 2.2 Verify Application Startup

Check application logs for successful startup:

```bash
docker compose logs app-with-db 2>&1 | tail -50
```

**Expected startup indicators:**
- `[Archon] Paths configured:`
- `[App] Adapters initialized`
- `[App] Server listening on port 3000`
- `[ConversationLock] Initialized`

### 2.3 Health Checks

Verify all health endpoints:

```bash
# Basic health
curl -s http://localhost:3000/health | jq

# Database connectivity
curl -s http://localhost:3000/health/db | jq

# Concurrency status
curl -s http://localhost:3000/health/concurrency | jq
```

**Expected:** All return `{"status":"ok",...}`

---

## Phase 3: Database Schema Validation

### 3.1 Verify All 6 Tables Exist

```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "\dt remote_agent_*"
```

**Expected tables:**
1. `remote_agent_codebases`
2. `remote_agent_conversations`
3. `remote_agent_sessions`
4. `remote_agent_command_templates`
5. `remote_agent_isolation_environments`
6. `remote_agent_workflow_runs`

### 3.2 Verify Codebases Table

```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "\d remote_agent_codebases"
```

**Required columns:** id, name, repository_url, default_cwd, ai_assistant_type, commands (JSONB)

### 3.3 Verify Conversations Table

```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "\d remote_agent_conversations"
```

**Required columns:** id, platform_type, platform_conversation_id, codebase_id, cwd, ai_assistant_type, isolation_env_id (UUID FK), last_activity_at

### 3.4 Verify Isolation Environments Table

```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "\d remote_agent_isolation_environments"
```

**Required columns:** id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, status, created_at, created_by_platform, metadata

### 3.5 Verify Workflow Runs Table

```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "\d remote_agent_workflow_runs"
```

**Required columns:** id, workflow_name, conversation_id, codebase_id, current_step_index, status, user_message, metadata, started_at, completed_at

### 3.6 Verify Foreign Keys

```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT conname, conrelid::regclass, confrelid::regclass
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      AND conrelid::regclass::text LIKE 'remote_agent_%';"
```

**Expected FK relationships:**
- conversations.codebase_id → codebases.id
- conversations.isolation_env_id → isolation_environments.id
- sessions.conversation_id → conversations.id
- sessions.codebase_id → codebases.id
- isolation_environments.codebase_id → codebases.id
- workflow_runs.conversation_id → conversations.id
- workflow_runs.codebase_id → codebases.id

---

## Phase 4: Test Adapter E2E Tests

### 4.1 Basic Commands

```bash
# Clear test data
curl -X DELETE http://localhost:3000/test/messages/e2e-basic

# Test /help
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-basic","message":"/help"}'

sleep 2

# Verify help response contains new commands
HELP=$(curl -s http://localhost:3000/test/messages/e2e-basic | jq -r '.messages[0].message')
echo "$HELP" | grep -q "/repos" && echo "✅ /repos in help" || echo "❌ /repos missing"
echo "$HELP" | grep -q "/worktree" && echo "✅ /worktree in help" || echo "❌ /worktree missing"
echo "$HELP" | grep -q "/workflow" && echo "✅ /workflow in help" || echo "❌ /workflow missing"

# Test /status (no codebase)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-basic","message":"/status"}'

sleep 2

STATUS=$(curl -s http://localhost:3000/test/messages/e2e-basic | jq -r '.messages[-1].message')
echo "$STATUS" | grep -q "No codebase configured" && echo "✅ Status correct (no codebase)" || echo "❌ Status unexpected"

# Cleanup
curl -X DELETE http://localhost:3000/test/messages/e2e-basic
```

### 4.2 Repository Management

```bash
# Clear test data
curl -X DELETE http://localhost:3000/test/messages/e2e-repo

# Clone test repository
echo "Cloning repository..."
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-repo","message":"/clone https://github.com/anthropics/anthropic-sdk-typescript"}'

# Wait for clone (can take 30-60 seconds)
sleep 45

# Verify clone success
CLONE_MSG=$(curl -s http://localhost:3000/test/messages/e2e-repo | jq -r '.messages[-1].message')
echo "$CLONE_MSG" | grep -q "cloned successfully\|already cloned\|Linked to" && echo "✅ Clone succeeded" || echo "❌ Clone failed: $CLONE_MSG"

# Verify path is in new format (includes owner)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-repo","message":"/getcwd"}'

sleep 2

CWD=$(curl -s http://localhost:3000/test/messages/e2e-repo | jq -r '.messages[-1].message')
echo "$CWD" | grep -q "anthropics/anthropic-sdk-typescript\|anthropic-sdk-typescript" && echo "✅ CWD correct" || echo "❌ CWD wrong: $CWD"

# Test /repos command
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-repo","message":"/repos"}'

sleep 2

REPOS=$(curl -s http://localhost:3000/test/messages/e2e-repo | jq -r '.messages[-1].message')
echo "$REPOS" | grep -q "anthropic" && echo "✅ /repos lists cloned repo" || echo "❌ /repos failed"

# Cleanup
curl -X DELETE http://localhost:3000/test/messages/e2e-repo
```

### 4.3 Command Loading and Invocation

```bash
# Clear test data
curl -X DELETE http://localhost:3000/test/messages/e2e-cmd

# Setup: ensure repo is cloned
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-cmd","message":"/clone https://github.com/anthropics/anthropic-sdk-typescript"}'

sleep 30

# Test /commands (should auto-load or show none)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-cmd","message":"/commands"}'

sleep 2

# Test /templates (global templates)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-cmd","message":"/templates"}'

sleep 2

TEMPLATES=$(curl -s http://localhost:3000/test/messages/e2e-cmd | jq -r '.messages[-1].message')
echo "Templates response: $TEMPLATES"

# Cleanup
curl -X DELETE http://localhost:3000/test/messages/e2e-cmd
```

---

## Phase 5: Worktree/Isolation Tests

### 5.1 Create Worktree

```bash
# Clear test data
curl -X DELETE http://localhost:3000/test/messages/e2e-worktree

# Setup: clone repo
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-worktree","message":"/clone https://github.com/anthropics/anthropic-sdk-typescript"}'

sleep 30

# Create worktree
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-worktree","message":"/worktree create test-branch-validation"}'

sleep 5

WT_CREATE=$(curl -s http://localhost:3000/test/messages/e2e-worktree | jq -r '.messages[-1].message')
echo "$WT_CREATE" | grep -q "Worktree created\|already exists\|Working in isolated" && echo "✅ Worktree created" || echo "❌ Worktree create failed: $WT_CREATE"

# Verify database entry
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, status FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%test-branch%';"
```

### 5.2 List Worktrees

```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-worktree","message":"/worktree list"}'

sleep 2

WT_LIST=$(curl -s http://localhost:3000/test/messages/e2e-worktree | jq -r '.messages[-1].message')
echo "$WT_LIST" | grep -q "Worktrees" && echo "✅ Worktree list works" || echo "❌ Worktree list failed"
```

### 5.3 Check Status with Worktree

```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-worktree","message":"/status"}'

sleep 2

STATUS_WT=$(curl -s http://localhost:3000/test/messages/e2e-worktree | jq -r '.messages[-1].message')
echo "$STATUS_WT" | grep -q "Worktree" && echo "✅ Status shows worktree" || echo "⚠️ Status may not show worktree"
echo "$STATUS_WT" | grep -q "Worktrees:" && echo "✅ Status shows worktree count" || echo "⚠️ Worktree count not shown"
```

### 5.4 Remove Worktree

```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-worktree","message":"/worktree remove"}'

sleep 3

WT_REMOVE=$(curl -s http://localhost:3000/test/messages/e2e-worktree | jq -r '.messages[-1].message')
echo "$WT_REMOVE" | grep -q "removed\|not using" && echo "✅ Worktree remove works" || echo "❌ Worktree remove failed: $WT_REMOVE"

# Cleanup
curl -X DELETE http://localhost:3000/test/messages/e2e-worktree
```

---

## Phase 6: Command Workflow Tests (Prime, Plan, Execute Pattern)

This tests the core command invocation pattern without the workflow engine routing.

### 6.0 Setup Test Repository with Commands

For this phase, we need a test repository with `.archon/commands/` containing prime, plan-feature, and execute commands.

**Option A: Use this project itself (if running locally)**

```bash
# Use the current project as the test repo
PROJECT_DIR=$(pwd)

# Start dev mode instead of Docker for local testing
# bun run dev
```

**Option B: Create a minimal test repo on GitHub**

Create a GitHub repo with `.archon/commands/` containing:
- `prime.md` - Simple context loading
- `plan-feature.md` - Planning with $ARGUMENTS
- `execute.md` - Execute plan

### 6.1 Clone and Load Commands

```bash
# Clear test data
curl -X DELETE http://localhost:3000/test/messages/e2e-workflow

# Clone repo with commands (use your test repo or this project)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-workflow","message":"/clone https://github.com/YOUR_ORG/YOUR_TEST_REPO"}'

sleep 30

# Load commands
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-workflow","message":"/load-commands .archon/commands"}'

sleep 3

# Verify commands loaded
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-workflow","message":"/commands"}'

sleep 2

CMDS=$(curl -s http://localhost:3000/test/messages/e2e-workflow | jq -r '.messages[-1].message')
echo "$CMDS" | grep -q "prime\|plan\|execute" && echo "✅ Commands loaded" || echo "⚠️ Commands may not include workflow commands"
```

### 6.2 Invoke Prime Command

```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-workflow","message":"/command-invoke prime"}'

# Prime can take a while as AI analyzes codebase
sleep 60

PRIME_RESULT=$(curl -s http://localhost:3000/test/messages/e2e-workflow | jq -r '.messages[-1].message')
echo "Prime result length: ${#PRIME_RESULT}"
[ ${#PRIME_RESULT} -gt 100 ] && echo "✅ Prime generated output" || echo "⚠️ Prime output may be short"
```

### 6.3 Invoke Plan Command

```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-workflow","message":"/command-invoke plan-feature \"Add a simple hello world endpoint\""}'

# Plan generation takes time
sleep 90

PLAN_RESULT=$(curl -s http://localhost:3000/test/messages/e2e-workflow | jq -r '.messages[-1].message')
echo "Plan result length: ${#PLAN_RESULT}"
[ ${#PLAN_RESULT} -gt 200 ] && echo "✅ Plan generated" || echo "⚠️ Plan may be short"
```

### 6.4 Check Session State

```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-workflow","message":"/status"}'

sleep 2

STATUS_SESSION=$(curl -s http://localhost:3000/test/messages/e2e-workflow | jq -r '.messages[-1].message')
echo "$STATUS_SESSION" | grep -q "Active Session" && echo "✅ Session active after commands" || echo "❌ No active session"

# Cleanup
curl -X DELETE http://localhost:3000/test/messages/e2e-workflow
```

---

## Phase 7: GitHub Adapter Tests

### 7.1 GitHub CLI Verification

```bash
# Verify GitHub CLI installed in container
docker compose exec app-with-db which gh && echo "✅ GitHub CLI installed" || echo "❌ GitHub CLI not found"

# Verify gh version
docker compose exec app-with-db gh --version

# Test GitHub authentication
docker compose exec app-with-db gh auth status 2>&1 | grep -q "Logged in" && echo "✅ GitHub authenticated" || echo "⚠️ GitHub not authenticated"
```

### 7.2 Create Test GitHub Issue

This requires a test repository you control.

```bash
# Set your test repo
TEST_REPO="YOUR_ORG/YOUR_TEST_REPO"

# Create a test issue
gh issue create --repo "$TEST_REPO" \
  --title "Validation Test Issue $(date +%s)" \
  --body "@archon please analyze this test issue and respond with a summary."

# Note the issue number for webhook testing
```

### 7.3 Verify Webhook Endpoint

```bash
# Check webhook endpoint responds
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/webhooks/github

# Should return 400 (bad request without signature) or 401
```

### 7.4 Simulate GitHub Webhook (Manual)

If you have ngrok or similar:

```bash
# Start ngrok tunnel
ngrok http 3000

# Configure webhook in GitHub repo settings:
# - Payload URL: https://YOUR_NGROK.ngrok.io/webhooks/github
# - Content type: application/json
# - Secret: (value from WEBHOOK_SECRET in .env)
# - Events: Issues, Issue comments, Pull requests

# Then comment on an issue with @archon mention
# Check application logs for webhook processing
docker compose logs -f app-with-db
```

---

## Phase 8: Error Handling Tests

### 8.1 Invalid Commands

```bash
curl -X DELETE http://localhost:3000/test/messages/e2e-error

# Test invalid command
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-error","message":"/nonexistent-command"}'

sleep 2

ERR=$(curl -s http://localhost:3000/test/messages/e2e-error | jq -r '.messages[0].message')
echo "$ERR" | grep -qi "unknown\|not found" && echo "✅ Invalid command handled" || echo "⚠️ Error message unclear"
```

### 8.2 Invalid Clone

```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-error","message":"/clone https://github.com/nonexistent-user-12345/nonexistent-repo-67890"}'

sleep 15

CLONE_ERR=$(curl -s http://localhost:3000/test/messages/e2e-error | jq -r '.messages[-1].message')
echo "$CLONE_ERR" | grep -qi "failed\|error\|not found" && echo "✅ Invalid clone handled" || echo "⚠️ Clone error unclear"
```

### 8.3 Command Without Codebase

```bash
curl -X DELETE http://localhost:3000/test/messages/e2e-error-2

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-error-2","message":"/command-invoke prime"}'

sleep 2

NO_CB=$(curl -s http://localhost:3000/test/messages/e2e-error-2 | jq -r '.messages[0].message')
echo "$NO_CB" | grep -qi "no codebase\|not configured" && echo "✅ No codebase error handled" || echo "⚠️ Error message unclear"

# Cleanup
curl -X DELETE http://localhost:3000/test/messages/e2e-error
curl -X DELETE http://localhost:3000/test/messages/e2e-error-2
```

---

## Phase 9: Concurrency Tests

```bash
echo "Testing concurrent message handling..."

# Send 5 concurrent /help commands
for i in {1..5}; do
  curl -X POST http://localhost:3000/test/message \
    -H "Content-Type: application/json" \
    -d "{\"conversationId\":\"concurrent-$i\",\"message\":\"/help\"}" &
done

wait
sleep 5

# Verify all processed
SUCCESS=0
for i in {1..5}; do
  RESP=$(curl -s http://localhost:3000/test/messages/concurrent-$i | jq -r '.messages[0].message // empty')
  if echo "$RESP" | grep -q "Available Commands"; then
    ((SUCCESS++))
  fi
done

echo "Concurrent messages processed: $SUCCESS/5"
[ $SUCCESS -eq 5 ] && echo "✅ Concurrency handling works" || echo "❌ Some messages failed"

# Check lock status
curl -s http://localhost:3000/health/concurrency | jq

# Cleanup
for i in {1..5}; do
  curl -X DELETE http://localhost:3000/test/messages/concurrent-$i
done
```

---

## Phase 10: Final Validation Summary

```bash
echo "================================"
echo "📊 VALIDATION SUMMARY"
echo "================================"

# Container status
echo ""
echo "🐳 Docker Status:"
docker compose ps --format "table {{.Name}}\t{{.Status}}"

# Database status
echo ""
echo "🗄️ Database:"
TABLE_COUNT=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'remote_agent_%';")
echo "Tables: $TABLE_COUNT (expected: 6)"

# Health checks
echo ""
echo "🏥 Health Checks:"
curl -s http://localhost:3000/health | jq -r '.status'
curl -s http://localhost:3000/health/db | jq -r '.status'

# Source files
echo ""
echo "📁 Source Files:"
TS_FILES=$(find src -name "*.ts" -type f ! -name "*.test.ts" 2>/dev/null | wc -l)
TEST_FILES=$(find src -name "*.test.ts" -type f 2>/dev/null | wc -l)
echo "TypeScript files: $TS_FILES"
echo "Test files: $TEST_FILES"

echo ""
echo "================================"
echo "✅ Validation Complete"
echo "================================"
```

---

## Cleanup

After validation, clean up test data:

```bash
# Remove test conversations from database
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "DELETE FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'e2e-%' OR platform_conversation_id LIKE 'concurrent-%';"

# Remove test isolation environments
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "DELETE FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%test%';"

# Optionally stop containers
# docker compose down
```

---

## Success Criteria

| Phase | Criteria |
|-------|----------|
| 1.1 | Zero ESLint errors |
| 1.2 | Zero TypeScript errors |
| 1.3 | Build succeeds |
| 1.4 | All files formatted |
| 1.5 | All unit tests pass |
| 2.x | Docker containers running, health checks pass |
| 3.x | All 6 database tables exist with correct schema |
| 4.x | Test adapter commands work (/help, /status, /clone, /repos) |
| 5.x | Worktree create/list/remove work |
| 6.x | Command invocation pattern works (prime, plan-feature) |
| 7.x | GitHub CLI available, auth working |
| 8.x | Error handling is graceful |
| 9.x | Concurrent requests handled correctly |

**If ALL phases pass, the Remote Coding Agent is production-ready.**

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Linting errors | `bun run lint:fix` |
| Type errors | Check `tsconfig.json`, fix annotations |
| Format errors | `bun run format` |
| Test failures | Check test output, fix implementation |
| Container issues | `docker compose down && docker compose --profile with-db up -d --build` |
| Database errors | Check migrations: `docker compose exec postgres psql -U postgres -d remote_coding_agent -c "\dt"` |
| Clone failures | Check GH_TOKEN in .env, network connectivity |
| Worktree errors | Check git permissions, disk space |
