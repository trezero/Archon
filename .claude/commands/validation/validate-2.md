# Ultimate Validation Command (Updated January 2026)

Run comprehensive end-to-end validation of the Remote Agentic Coding Platform including Docker, Test Adapter, Database, GitHub integration, worktree isolation, and command workflows.

**Usage:**
```bash
/validation:validate-2 <ngrok-url>
```

**Example:**
```bash
/validation:validate-2 https://trinity-nonadverbial-enharmonically.ngrok-free.dev
```

**Prerequisites:**
- ngrok running and exposing port 3000 (for GitHub webhooks)
- `.env` file configured with all required credentials
- GitHub CLI (`gh`) authenticated
- Docker installed and running

**Updated for:**
- Bun runtime (not npm)
- Archon paths (`~/.archon/workspaces/owner/repo`)
- 6 database tables (codebases, conversations, sessions, command_templates, isolation_environments, workflow_runs)
- Worktree isolation with database tracking
- New commands (/repos, /repo, /worktree, /workflow, /templates)

---

## Phase 1: Foundation Validation

### 1.1 Type Checking
```bash
bun run type-check
```
**Expected:** Zero TypeScript errors

### 1.2 Linting
```bash
bun run lint
```
**Expected:** Zero ESLint errors (warnings acceptable)

### 1.3 Code Formatting
```bash
bun run format:check
```
**Expected:** All files pass Prettier checks

### 1.4 Unit Tests
```bash
bun test
```
**Expected:** All critical tests pass

### 1.5 Build
```bash
bun run build
```
**Expected:** Clean build to `dist/` directory

**If any step fails, STOP and report the issue immediately.**

---

## Phase 2: Environment Setup

### 2.0 Initialize Variables and Clean Workspace
```bash
# Load environment variables
source .env

# Store project root directory
PROJECT_ROOT="$(pwd)"
export PROJECT_ROOT

# Determine workspace path
if [ -n "$ARCHON_HOME" ]; then
  WORK_DIR="${ARCHON_HOME}/workspaces"
else
  WORK_DIR="${HOME}/.archon/workspaces"
fi

echo "Project root: ${PROJECT_ROOT}"
echo "Workspace directory: ${WORK_DIR}"

# Remove previous test repositories
rm -rf "${WORK_DIR}"/remote-coding-test-*
rm -rf "${HOME}/.archon/worktrees"/remote-coding-test-*

# Clean up test conversations from database
if command -v psql &> /dev/null; then
  echo "Cleaning database with psql..."
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_sessions WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%');" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%test%' OR workflow_id LIKE '%remote-coding-test%';" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_workflow_runs WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%');" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%';" 2>&1
  psql "$DATABASE_URL" -c "DELETE FROM remote_agent_codebases WHERE name LIKE 'remote-coding-test-%';" 2>&1
  echo "Database cleaned"
else
  echo "psql not found, using bun for cleanup..."
  bun -e "
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    async function cleanup() {
      await client.connect();
      await client.query(\"DELETE FROM remote_agent_sessions WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%')\");
      await client.query(\"DELETE FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%test%'\");
      await client.query(\"DELETE FROM remote_agent_workflow_runs WHERE conversation_id IN (SELECT id FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%')\");
      await client.query(\"DELETE FROM remote_agent_conversations WHERE platform_conversation_id LIKE 'test-%'\");
      await client.query(\"DELETE FROM remote_agent_codebases WHERE name LIKE 'remote-coding-test-%'\");
      await client.end();
      console.log('Database cleaned');
    }
    cleanup().catch(console.error);
  "
fi

export WORK_DIR
```

### 2.1 Store ngrok URL
```bash
NGROK_URL="$ARGUMENTS"
echo "Using ngrok URL: ${NGROK_URL}"

if [[ ! "$NGROK_URL" =~ ^https:// ]]; then
  echo "ERROR: Invalid ngrok URL format. Expected: https://..."
  exit 1
fi

export NGROK_URL
```

### 2.2 Generate Repository Name
```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_REPO_NAME="remote-coding-test-${TIMESTAMP}"
echo "Test repository: ${TEST_REPO_NAME}"

# Get GitHub username
GITHUB_USERNAME=$(gh api user --jq .login)
echo "GitHub user: ${GITHUB_USERNAME}"

export TEST_REPO_NAME
export GITHUB_USERNAME
```

### 2.3 Create Test Repository Structure
```bash
mkdir -p "${WORK_DIR}/${GITHUB_USERNAME}"
cd "${WORK_DIR}/${GITHUB_USERNAME}"
mkdir ${TEST_REPO_NAME}
cd ${TEST_REPO_NAME}

# Initialize git
git init
git config user.email "test@example.com"
git config user.name "Test User"

# Create README
cat > README.md << 'EOF'
# Remote Coding Test Repository

This is a test repository for automated validation of the Remote Agentic Coding Platform.

## Purpose

Used for E2E testing of:
- Command invocation (prime, plan-feature, execute)
- GitHub webhook integration
- Worktree isolation
- AI-assisted development workflows
EOF

# Create .gitignore
cat > .gitignore << 'EOF'
node_modules
.next
.env*.local
EOF

# Create .archon/commands directory with test commands
mkdir -p .archon/commands

# Copy commands from main project
cp "${PROJECT_ROOT}/.archon/commands/prime.md" .archon/commands/ 2>/dev/null || \
cp "${PROJECT_ROOT}/.claude/commands/core_piv_loop/prime.md" .archon/commands/prime.md 2>/dev/null || \
cat > .archon/commands/prime.md << 'CMDEOF'
# Prime Command

Analyze this codebase and provide a brief summary of:
1. What this project does
2. Key files and their purposes
3. Main technologies used

Keep your response concise.
CMDEOF

cp "${PROJECT_ROOT}/.archon/commands/plan.md" .archon/commands/plan-feature.md 2>/dev/null || \
cp "${PROJECT_ROOT}/.claude/commands/core_piv_loop/plan-feature.md" .archon/commands/plan-feature.md 2>/dev/null || \
cat > .archon/commands/plan-feature.md << 'CMDEOF'
# Plan Feature Command

Create a simple implementation plan for:

$ARGUMENTS

Include:
1. Files to modify
2. Implementation steps
3. Validation approach
CMDEOF

cp "${PROJECT_ROOT}/.archon/commands/execute.md" .archon/commands/ 2>/dev/null || \
cat > .archon/commands/execute.md << 'CMDEOF'
# Execute Command

Implement the changes based on the previous plan.
If no plan exists, respond with: "No plan found. Run /command-invoke plan-feature first."
CMDEOF

# Commit
git add .
git commit -m "Initial test repository setup with archon commands"

echo "Repository structure created"
```

### 2.4 Push to GitHub (Personal Account)
```bash
# Create private repo in personal account (no org prefix)
gh repo create ${TEST_REPO_NAME} --private --source=. --push

TEST_REPO_URL=$(gh repo view --json url -q .url)
echo "Repository created: ${TEST_REPO_URL}"

export TEST_REPO_URL
```

### 2.5 Configure GitHub Webhook
```bash
cd "${PROJECT_ROOT}"
source .env

# Create webhook pointing to ngrok URL
gh api repos/${GITHUB_USERNAME}/${TEST_REPO_NAME}/hooks \
  -X POST \
  --input - <<EOF
{
  "name": "web",
  "active": true,
  "events": [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review_comment"
  ],
  "config": {
    "url": "${NGROK_URL}/webhooks/github",
    "content_type": "json",
    "secret": "${WEBHOOK_SECRET}",
    "insecure_ssl": "0"
  }
}
EOF

echo "Webhook configured: ${NGROK_URL}/webhooks/github"

# Verify webhook
gh api repos/${GITHUB_USERNAME}/${TEST_REPO_NAME}/hooks | jq '.[0] | {id, url: .config.url, events, active}'
```

---

## Phase 3: Docker Container Setup

### 3.1 Rebuild and Start Containers
```bash
cd "${PROJECT_ROOT}"
docker compose --profile with-db down 2>/dev/null || true
docker compose --profile with-db up -d --build
```

### 3.2 Wait for Startup
```bash
echo "Waiting for containers to start..."
sleep 15
docker compose ps
```

### 3.3 Verify Application Logs
```bash
docker compose logs app-with-db 2>&1 | tail -30
```

**Check for:**
- `[Archon] Paths configured:`
- `[App] Adapters initialized`
- `[App] Server listening on port 3000`
- `[ConversationLock] Initialized`

### 3.4 Health Checks
```bash
curl -s http://localhost:3000/health | jq
curl -s http://localhost:3000/health/db | jq
curl -s http://localhost:3000/health/concurrency | jq
```

**Expected:** All return `{"status":"ok",...}`

---

## Phase 4: Database Schema Validation

### 4.1 Verify All 6 Tables Exist
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

### 4.2 Verify Foreign Keys
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT conname, conrelid::regclass, confrelid::regclass
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      AND conrelid::regclass::text LIKE 'remote_agent_%';"
```

**Expected:** 7 foreign key relationships

---

## Phase 5: Test Adapter E2E Tests

### 5.1 Basic Commands
```bash
curl -X DELETE http://localhost:3000/test/messages/test-basic

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-basic","message":"/help"}'

sleep 2

HELP=$(curl -s http://localhost:3000/test/messages/test-basic | jq -r '.messages[0].message')
echo "$HELP" | grep -q "/repos" && echo "✅ /repos in help" || echo "❌ /repos missing"
echo "$HELP" | grep -q "/worktree" && echo "✅ /worktree in help" || echo "❌ /worktree missing"
```

### 5.2 Clone Test Repository
```bash
curl -X DELETE http://localhost:3000/test/messages/test-clone

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"test-clone\",\"message\":\"/clone https://github.com/${GITHUB_USERNAME}/${TEST_REPO_NAME}\"}"

echo "Waiting for clone..."
sleep 30

CLONE_MSG=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$CLONE_MSG" | grep -q "cloned successfully\|Linked to\|Loaded" && echo "✅ Clone succeeded" || echo "❌ Clone failed: $CLONE_MSG"
```

### 5.3 Verify Commands Auto-Loaded
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/commands"}'

sleep 2

CMDS=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$CMDS" | grep -q "prime" && echo "✅ prime command loaded" || echo "❌ prime missing"
echo "$CMDS" | grep -q "plan-feature" && echo "✅ plan-feature command loaded" || echo "❌ plan-feature missing"
echo "$CMDS" | grep -q "execute" && echo "✅ execute command loaded" || echo "❌ execute missing"
```

---

## Phase 6: Worktree Isolation Tests

### 6.1 Create Worktree via Test Adapter
```bash
curl -X DELETE http://localhost:3000/test/messages/test-worktree

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"test-worktree\",\"message\":\"/clone https://github.com/${GITHUB_USERNAME}/${TEST_REPO_NAME}\"}"

sleep 15

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree create test-validation-branch"}'

sleep 5

WT_MSG=$(curl -s http://localhost:3000/test/messages/test-worktree | jq -r '.messages[-1].message')
echo "$WT_MSG" | grep -q "Worktree created\|Working in isolated" && echo "✅ Worktree created" || echo "❌ Worktree failed: $WT_MSG"
```

### 6.2 Verify Database Entry
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, branch_name, status, created_by_platform
      FROM remote_agent_isolation_environments
      WHERE workflow_id LIKE '%test-validation%'
      ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** Row with `workflow_type=task`, `status=active`, `created_by_platform=test`

### 6.3 List and Remove Worktree
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree list"}'

sleep 2

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-worktree","message":"/worktree remove"}'

sleep 3

WT_REMOVE=$(curl -s http://localhost:3000/test/messages/test-worktree | jq -r '.messages[-1].message')
echo "$WT_REMOVE" | grep -q "removed\|Switched back" && echo "✅ Worktree removed" || echo "❌ Remove failed"

# Verify status updated
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT status FROM remote_agent_isolation_environments
      WHERE workflow_id LIKE '%test-validation%'
      ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** `status=destroyed`

---

## Phase 7: Command Workflow Tests (Test Adapter)

### 7.1 Invoke Prime Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/command-invoke prime"}'

echo "Waiting for prime (60 seconds)..."
sleep 60

PRIME=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
PRIME_LEN=${#PRIME}
echo "Prime response length: $PRIME_LEN"
[ $PRIME_LEN -gt 100 ] && echo "✅ Prime generated output" || echo "❌ Prime too short"
```

### 7.2 Invoke Plan-Feature Command
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/command-invoke plan-feature \"Add a Contributing section to README\""}'

echo "Waiting for plan (90 seconds)..."
sleep 90

PLAN=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
PLAN_LEN=${#PLAN}
echo "Plan response length: $PLAN_LEN"
[ $PLAN_LEN -gt 200 ] && echo "✅ Plan generated" || echo "❌ Plan too short"
```

### 7.3 Verify Session State
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-clone","message":"/status"}'

sleep 2

STATUS=$(curl -s http://localhost:3000/test/messages/test-clone | jq -r '.messages[-1].message')
echo "$STATUS" | grep -q "Active Session" && echo "✅ Session active" || echo "❌ No active session"
echo "$STATUS" | grep -q "Worktree" && echo "✅ Worktree auto-created" || echo "⚠️ May not show worktree"
```

---

## Phase 8: GitHub Webhook Integration

### 8.1 Create GitHub Issue with @remote-agent Mention
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

ISSUE_URL=$(gh issue create \
  --title "Test Issue: Add Validation Section" \
  --body "Add a 'Validation' section to README.md explaining the testing process.

@remote-agent please analyze this issue and confirm you received it." \
  | grep -o 'https://.*')

ISSUE_NUMBER=$(echo $ISSUE_URL | grep -o '[0-9]*$')
echo "Issue created: ${ISSUE_URL}"
echo "Issue number: ${ISSUE_NUMBER}"

export ISSUE_NUMBER
export ISSUE_URL

cd "${PROJECT_ROOT}"
```

### 8.2 Monitor Webhook Processing
```bash
echo "Waiting for webhook processing (30 seconds)..."
sleep 30

docker compose logs app-with-db 2>&1 | grep -E "GitHub.*Processing|Worktree created|issue-${ISSUE_NUMBER}" | tail -10
```

**Check for:**
- `[GitHub] Processing issue: ${GITHUB_USERNAME}/${TEST_REPO_NAME}#${ISSUE_NUMBER}`
- Worktree creation for issue
- `[Claude] Starting new session in /.archon/worktrees/.../issue-${ISSUE_NUMBER}`

### 8.3 Verify GitHub Worktree Auto-Creation
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, branch_name, status, created_by_platform
      FROM remote_agent_isolation_environments
      WHERE workflow_type = 'issue'
      ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** Row with `workflow_type=issue`, `workflow_id=${ISSUE_NUMBER}`, `created_by_platform=github`

### 8.4 Verify Bot Response on Issue
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

echo "Waiting for bot response (60 seconds)..."
sleep 60

gh issue view ${ISSUE_NUMBER} --comments | tail -30

cd "${PROJECT_ROOT}"
```

**Expected:**
- Bot comment confirming isolation branch
- Analysis or response to the issue

---

## Phase 9: GitHub PR Integration

### 9.1 Create Pull Request
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# Create a branch with changes
git checkout -b test-pr-branch
echo -e "\n## Test Section\n\nThis is a test PR." >> README.md
git add README.md
git commit -m "test: Add test section"
git push -u origin test-pr-branch

# Create PR
PR_URL=$(gh pr create \
  --title "Test PR: Add Test Section" \
  --body "This is a test pull request.

@remote-agent please review this PR." \
  | grep -o 'https://.*')

PR_NUMBER=$(echo $PR_URL | grep -o '[0-9]*$')
echo "PR created: ${PR_URL}"
echo "PR number: ${PR_NUMBER}"

export PR_NUMBER
export PR_URL

cd "${PROJECT_ROOT}"
```

### 9.2 Monitor PR Webhook
```bash
echo "Waiting for PR webhook (30 seconds)..."
sleep 30

docker compose logs app-with-db 2>&1 | grep -E "GitHub.*pull_request|pr-${PR_NUMBER}" | tail -10
```

### 9.3 Verify PR Worktree
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, branch_name, status
      FROM remote_agent_isolation_environments
      WHERE workflow_type = 'pr'
      ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** Row with `workflow_type=pr`, `workflow_id=${PR_NUMBER}`

### 9.4 Check PR Comments
```bash
cd "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

echo "Waiting for bot response (60 seconds)..."
sleep 60

gh pr view ${PR_NUMBER} --comments | tail -20

cd "${PROJECT_ROOT}"
```

---

## Phase 10: Concurrency Tests

```bash
echo "Testing concurrent message handling..."

for i in 1 2 3; do
  curl -X POST http://localhost:3000/test/message \
    -H "Content-Type: application/json" \
    -d "{\"conversationId\":\"concurrent-${i}\",\"message\":\"/help\"}" &
done

wait
sleep 5

SUCCESS=0
for i in 1 2 3; do
  RESP=$(curl -s http://localhost:3000/test/messages/concurrent-${i} | jq -r '.messages[0].message // empty')
  if echo "$RESP" | grep -q "Available Commands"; then
    ((SUCCESS++))
  fi
done

echo "Concurrent messages processed: $SUCCESS/3"
[ $SUCCESS -eq 3 ] && echo "✅ Concurrency works" || echo "❌ Some failed"

curl -s http://localhost:3000/health/concurrency | jq
```

---

## Phase 11: Error Handling Tests

### 11.1 Invalid Command
```bash
curl -X DELETE http://localhost:3000/test/messages/test-error

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-error","message":"/nonexistent-command"}'

sleep 2

ERR=$(curl -s http://localhost:3000/test/messages/test-error | jq -r '.messages[0].message')
echo "$ERR" | grep -qi "unknown\|not found" && echo "✅ Invalid command handled" || echo "⚠️ Error unclear"
```

### 11.2 Invalid Clone
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-error","message":"/clone https://github.com/nonexistent-user-xyz/fake-repo"}'

sleep 15

CLONE_ERR=$(curl -s http://localhost:3000/test/messages/test-error | jq -r '.messages[-1].message')
echo "$CLONE_ERR" | grep -qi "failed\|error\|not found" && echo "✅ Invalid clone handled" || echo "⚠️ Error unclear"
```

---

## Phase 12: Final Validation Summary

```bash
echo "========================================"
echo "VALIDATION SUMMARY"
echo "========================================"
echo ""
echo "Test Repository: ${TEST_REPO_URL}"
echo "Issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
echo "PR #${PR_NUMBER}: ${PR_URL}"
echo ""

# Docker status
echo "Docker Status:"
docker compose ps --format "table {{.Name}}\t{{.Status}}"
echo ""

# Database tables
echo "Database Tables:"
TABLE_COUNT=$(docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'remote_agent_%';")
echo "Tables: $TABLE_COUNT (expected: 6)"
echo ""

# Isolation environments
echo "Isolation Environments Created:"
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "SELECT workflow_type, workflow_id, status, created_by_platform
      FROM remote_agent_isolation_environments
      ORDER BY created_at DESC LIMIT 5;"
echo ""

# Health checks
echo "Health Checks:"
curl -s http://localhost:3000/health | jq -r '.status'
curl -s http://localhost:3000/health/db | jq -r '.status'
echo ""

# Error count
ERROR_COUNT=$(docker compose logs app-with-db 2>&1 | grep -c -E "ERROR|Error:" || echo "0")
echo "Errors in logs: ${ERROR_COUNT}"
echo ""

echo "========================================"
echo "VALIDATION COMPLETE"
echo "========================================"
```

---

## Phase 13: Cleanup

**Test repository is preserved for manual inspection.**

When ready to clean up:
```bash
# Delete GitHub repository
gh repo delete ${GITHUB_USERNAME}/${TEST_REPO_NAME} --yes

# Remove local files
rm -rf "${WORK_DIR}/${GITHUB_USERNAME}/${TEST_REPO_NAME}"
rm -rf "${HOME}/.archon/worktrees/${GITHUB_USERNAME}/${TEST_REPO_NAME}"

# Clean database
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "DELETE FROM remote_agent_isolation_environments WHERE workflow_id LIKE '%${TEST_REPO_NAME}%';"
docker compose exec postgres psql -U postgres -d remote_coding_agent \
  -c "DELETE FROM remote_agent_codebases WHERE name = '${TEST_REPO_NAME}';"
```

---

## Success Criteria

| Phase | Criteria |
|-------|----------|
| 1.x | Type-check, lint, format, build pass |
| 2.x | Test repo created with webhook configured |
| 3.x | Docker containers running, health checks pass |
| 4.x | All 6 database tables exist with FKs |
| 5.x | Test adapter commands work |
| 6.x | Worktree create/list/remove work with DB tracking |
| 7.x | Command invocation works (prime, plan-feature) |
| 8.x | GitHub issue webhook creates worktree automatically |
| 9.x | GitHub PR webhook creates worktree automatically |
| 10.x | Concurrent requests handled correctly |
| 11.x | Error handling is graceful |

**If ALL phases pass, the Remote Coding Agent is production-ready.**

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Webhook not triggering | Verify ngrok is running, check URL matches |
| Worktree creation fails | Check git permissions, disk space |
| Database errors | Run migrations: `psql $DATABASE_URL < migrations/000_combined.sql` |
| Clone fails | Check GITHUB_TOKEN in .env |
| Bot not responding | Check docker logs for errors |
