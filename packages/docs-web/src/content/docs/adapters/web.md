---
title: Web UI
description: Built-in web interface for interacting with Archon -- no tokens or external services required.
category: adapters
area: adapters
audience: [user]
status: current
sidebar:
  order: 1
---

The Web UI is the built-in interface for interacting with Archon. It requires no tokens, API keys, or external services.

## Prerequisites

- Archon installed and dependencies resolved (`bun install`)

## Setup

No setup required. The Web UI is available automatically when you start the server.

**Development:**
```bash
bun run dev
# Web UI: http://localhost:5173
# API server: http://localhost:3090
```

**Production:**
```bash
bun run build    # Build the frontend
bun run start    # Server serves both API and Web UI on port 3090
```

## Features

- Real-time streaming of AI responses via Server-Sent Events (SSE)
- Tool call visualization with collapsible cards showing inputs/outputs
- Conversation management (create, switch, rename, delete, persist across sessions)
- Project/codebase browsing and management (clone, register, remove)
- Workflow invocation from UI with real-time progress tracking
- Approval gate UI with Approve/Reject buttons on workflow progress cards, allowing interactive control of workflows that require human review
- Visual Workflow Builder with drag-and-drop DAG canvas and loop node config; includes YAML code view (Visual/Split/Code toggle), tabbed node inspector, validation panel, undo/redo, and keyboard shortcuts
- Lock indicator showing when the agent is working
- Connected/disconnected status indicator
- Message history persistence across page refreshes

## Further Reading

- [Configuration](/getting-started/configuration/)
