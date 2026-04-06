# GitLab Webhooks Setup

Connect Archon to a GitLab instance (gitlab.com or self-hosted) so you can interact with your AI coding assistant from issues and merge requests.

## Prerequisites

- Archon server running (see [Getting Started](../getting-started.md))
- GitLab project with issues and merge requests enabled
- GitLab Personal Access Token or Project Access Token with `api` scope
- Public endpoint for webhooks (see ngrok setup below for local development)

## Step 1: Create a GitLab Access Token

### Personal Access Token (recommended for getting started)

1. Go to **GitLab → User Settings → Access Tokens**
2. Create a token with:
   - **Name**: `archon`
   - **Scopes**: `api`
   - **Expiration**: Set as needed
3. Copy the token (starts with `glpat-`)

### Project Access Token (recommended for production)

1. Go to **Project → Settings → Access Tokens**
2. Create a token with:
   - **Role**: Developer or Maintainer
   - **Scopes**: `api`
3. This creates a bot user scoped to the project

## Step 2: Generate Webhook Secret

On Linux/Mac:
```bash
openssl rand -hex 32
```

On Windows (PowerShell):
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Save this secret — you'll need it for steps 3 and 4.

## Step 3: Expose Local Server (Development Only)

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3090

# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
```

Keep this terminal open while testing.

**For production deployments**, use your deployed server URL (no tunnel needed).

## Step 4: Configure GitLab Webhook

Go to your project settings:
- Navigate to: **Project → Settings → Webhooks**
- Click "Add new webhook"

**Webhook Configuration:**

| Field | Value |
|-------|-------|
| **URL** | Local: `https://abc123.ngrok-free.app/webhooks/gitlab`<br>Production: `https://your-domain.com/webhooks/gitlab` |
| **Secret token** | Paste the secret from Step 2 |
| **Trigger** | Enable: `Comments`, `Issues events`, `Merge request events` |
| **SSL verification** | Enable (recommended) |

Click "Add webhook" and use **Test → Note events** to verify delivery.

**Note**: GitLab uses a plain secret token in the `X-Gitlab-Token` header (not HMAC like GitHub). The token you enter here must match your `GITLAB_WEBHOOK_SECRET` exactly.

## Step 5: Set Environment Variables

Add to your `.env` file:

```env
GITLAB_URL=https://gitlab.com              # Or your self-hosted URL
GITLAB_TOKEN=glpat-your-token-here         # From Step 1
GITLAB_WEBHOOK_SECRET=your-secret-here     # From Step 2 (must match GitLab config)
```

**Optional:**

```env
GITLAB_ALLOWED_USERS=alice,bob             # Comma-separated usernames (empty = open access)
GITLAB_BOT_MENTION=archon                  # @mention name (default: BOT_DISPLAY_NAME)
```

## Usage

Interact by @mentioning your bot name in issues or merge requests:

```
@archon can you analyze this bug?
@archon /status
@archon review this implementation
```

**First mention behavior:**
- Automatically clones the repository to `~/.archon/workspaces/<group>/<project>`
- Detects and loads commands from `.archon/commands/` if present
- Injects full issue/MR context for the AI assistant

**Subsequent mentions:**
- Resumes existing conversation
- Maintains full context across comments

## Conversation ID Format

| Type | Format | Example |
|------|--------|---------|
| Issue | `group/project#iid` | `myteam/api#42` |
| Merge Request | `group/project!iid` | `myteam/api!15` |
| Nested group | `group/subgroup/project#iid` | `org/team/api#7` |

## Supported Events

| GitLab Event | Action |
|-------------|--------|
| **Note Hook** (comment with @mention) | Triggers AI conversation |
| **Issue Hook** (close) | Cleans up isolation environment |
| **MR Hook** (close/merge) | Cleans up isolation environment |
| Issue/MR opened | Ignored (descriptions are not commands) |

## Adding Additional Projects

Add the same webhook to other projects using the same secret:

```bash
# Via glab CLI
glab api projects/<PROJECT_ID>/hooks \
  --method POST \
  -f url="https://YOUR_DOMAIN/webhooks/gitlab" \
  -f token="YOUR_WEBHOOK_SECRET" \
  -f note_events=true \
  -f issues_events=true \
  -f merge_requests_events=true
```

Or via GitLab UI: **Project → Settings → Webhooks → Add webhook** with the same secret.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `gitlab.invalid_webhook_token` | Secret mismatch | Ensure `GITLAB_WEBHOOK_SECRET` matches the webhook config exactly |
| Clone hangs | macOS Keychain credential helper | The adapter disables it automatically (`-c credential.helper=`) |
| `404 Project Not Found` | Token lacks access | Ensure token has `api` scope and access to the project |
| `403 You are not allowed` | Insufficient permissions | Use a token with Developer role or higher |
| No webhook delivery | ngrok URL changed | Update the webhook URL in GitLab after restarting ngrok |
| Webhook auto-disabled | 4+ consecutive failures | Fix the issue, then send a test event from GitLab to re-enable |

## glab CLI Reference

The AI agent uses `glab` CLI commands in its context. Ensure `glab` is installed and authenticated:

```bash
brew install glab          # macOS
glab auth login             # authenticate
```

| Command | Purpose |
|---------|---------|
| `glab issue view <IID>` | View issue details |
| `glab issue note <IID> -m "..."` | Comment on issue |
| `glab mr view <IID>` | View merge request |
| `glab mr diff <IID>` | View MR diff |
| `glab mr note <IID> -m "..."` | Comment on MR |
| `glab mr create --title "..." --description "..."` | Create MR |

## Further Reading

- [Advanced Configuration](../configuration.md)
- [Community Forge Adapter README](../../packages/adapters/src/community/forge/README.md)
