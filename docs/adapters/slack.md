# Slack Setup

Connect Archon to Slack so you can interact with your AI coding assistant from any Slack workspace.

## Prerequisites

- Archon server running (see [Getting Started](../getting-started-cli.md))
- A Slack workspace where you have permission to install apps

## Quick Setup

Slack uses **Socket Mode** — no public URL or webhooks needed. Works behind firewalls.

For the full step-by-step guide (app creation, permissions, token generation), see the [detailed Slack setup guide](../slack-setup.md).

## Set Environment Variables

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

## Configure User Whitelist (Optional)

To restrict bot access to specific users:
1. In Slack, go to a user's profile > click "..." > "Copy member ID"
2. Add to environment:

```env
SLACK_ALLOWED_USER_IDS=U01ABC123,U02DEF456
```

When set, only listed user IDs can interact with the bot. When empty/unset, the bot responds to all users.

## Configure Streaming Mode (Optional)

```env
SLACK_STREAMING_MODE=batch  # batch (default) | stream
```

For streaming mode details, see [Advanced Configuration](../configuration.md).

## Further Reading

- [Detailed Slack Setup Guide](../slack-setup.md)
- [Advanced Configuration](../configuration.md)
