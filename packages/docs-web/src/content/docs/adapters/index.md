---
title: Platform Adapters
description: Overview of all platform adapters available for connecting to Archon.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 0
---

Archon supports multiple platform adapters. Each adapter connects Archon to a different communication channel, letting you trigger workflows and interact with AI agents from wherever you work.

## Available Adapters

| Adapter | Transport | Auth Required | Setup |
|---------|-----------|---------------|-------|
| [**Web UI**](/adapters/web/) | SSE streaming | None | Built-in |
| [**Slack**](/adapters/slack/) | Socket Mode | Bot + App tokens | [Setup guide](/adapters/slack/) |
| [**Telegram**](/adapters/telegram/) | Bot API polling | Bot token | [Setup guide](/adapters/telegram/) |
| [**GitHub**](/adapters/github/) | Webhooks | Token + webhook secret | [Setup guide](/adapters/github/) |
| [**Discord**](/adapters/discord/) | WebSocket | Bot token | [Setup guide](/adapters/discord/) |

The **CLI** adapter (`stdout`) is also built-in and requires no setup. See the [CLI usage guide](/getting-started/) for details.

## How Adapters Work

All adapters implement the `IPlatformAdapter` interface. They handle:

- **Message ingestion** -- receiving messages from the platform and forwarding them to Archon's orchestrator
- **Response delivery** -- streaming or batching AI responses back to the platform
- **Authorization** -- optional user whitelists to restrict access
- **Conversation tracking** -- mapping platform-specific identifiers (thread IDs, chat IDs, issue numbers) to Archon conversations

## Choosing an Adapter

- **Web UI** is the fastest way to get started -- no tokens or external services needed.
- **Slack** and **Telegram** are ideal for mobile access and team collaboration.
- **GitHub** integrates directly into your issue and PR workflow.
- **Discord** works well for community or team servers.

You can run multiple adapters simultaneously. Any adapter with the required environment variables set will start automatically when you launch the server.
