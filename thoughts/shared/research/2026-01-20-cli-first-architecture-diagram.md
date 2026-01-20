---
date: 2026-01-20
topic: 'CLI-First Architecture - Complete System Diagram'
tags: [architecture, diagram, cli-first]
related: [2026-01-20-cli-first-refactor-feasibility.md]
---

# CLI-First Architecture - Complete System Diagram

This document provides comprehensive ASCII diagrams of the target architecture after the CLI-first refactor.

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    USER INTERFACES                                       │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────────────────────┐   │
│  │   CLI Binary    │   │   API Server    │   │         Dashboard (Svelte 5)        │   │
│  │   (standalone)  │   │     (Hono)      │   │                                     │   │
│  │                 │   │                 │   │  ┌─────────────────────────────┐    │   │
│  │  archon workflow│   │  /webhooks/*    │   │  │   Visual Workflow Builder   │    │   │
│  │  archon isolate │   │  /api/*         │   │  │   (drag-drop → YAML)        │    │   │
│  │                 │   │  /health        │   │  └─────────────────────────────┘    │   │
│  └────────┬────────┘   └────────┬────────┘   └──────────────────┬──────────────────┘   │
│           │                     │                               │                       │
│           │                     │            Hono RPC           │                       │
│           └──────────┬──────────┴───────────────────────────────┘                       │
│                      │                                                                  │
└──────────────────────┼──────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                     @archon/core                                         │
│                                  (Shared Library)                                        │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │   Workflow   │  │ Orchestrator │  │   Database   │  │   Isolation  │               │
│  │    Engine    │  │              │  │    Layer     │  │ Orchestrator │               │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘               │
│                                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                                  │
│  │  AI Clients  │  │     Git      │  │    Types     │                                  │
│  │ (Claude/Codex)│  │   Utilities  │  │  & Interfaces│                                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                                  │
│                                                                                         │
└─────────────────────────────────────────┬───────────────────────────────────────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
                    ▼                     ▼                     ▼
┌───────────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│   Platform Adapters       │ │  Isolation Providers │ │    AI SDK Clients   │
│   (IPlatformAdapter)      │ │ (IIsolationProvider) │ │  (IAssistantClient) │
└───────────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

---

## Core Package Structure (@archon/core)

```
@archon/core
├─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         WORKFLOW ENGINE                              │   │
│  │                                                                      │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │  │   Loader    │  │  Executor   │  │  Validator  │                  │   │
│  │  │             │  │             │  │             │                  │   │
│  │  │ discover()  │  │ execute()   │  │ validate()  │                  │   │
│  │  │ parse()     │  │ runStep()   │  │ schema()    │                  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  │                                                                      │   │
│  │  Input: YAML files from .archon/workflows/                          │   │
│  │  Output: Workflow execution with AI steps                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         ORCHESTRATOR                                 │   │
│  │                                                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │                    handleMessage()                           │    │   │
│  │  │                                                              │    │   │
│  │  │  1. Parse incoming message                                   │    │   │
│  │  │  2. Load conversation context                                │    │   │
│  │  │  3. Route to workflow or direct AI                           │    │   │
│  │  │  4. Execute and stream response                              │    │   │
│  │  │  5. Persist session state                                    │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      ISOLATION ORCHESTRATOR                          │   │
│  │                                                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │                  resolveIsolation()                          │    │   │
│  │  │                                                              │    │   │
│  │  │  Input:  { branch?, noWorktree?, repository }                │    │   │
│  │  │  Output: { cwd, isolationEnv? }                              │    │   │
│  │  │                                                              │    │   │
│  │  │  Logic:                                                      │    │   │
│  │  │  ├─ --no-worktree? → return cwd = process.cwd()              │    │   │
│  │  │  ├─ --branch exists? → getOrCreate worktree                  │    │   │
│  │  │  ├─ --branch new? → create branch + worktree                 │    │   │
│  │  │  └─ no flags? → return cwd = process.cwd()                   │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        DATABASE LAYER                                │   │
│  │                                                                      │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐  │   │
│  │  │conversations │ │  sessions    │ │  codebases   │ │ isolation  │  │   │
│  │  │              │ │              │ │              │ │environments│  │   │
│  │  │ - platform   │ │ - session_id │ │ - repo_url   │ │ - env_id   │  │   │
│  │  │ - conv_id    │ │ - provider   │ │ - commands   │ │ - type     │  │   │
│  │  │ - cwd        │ │ - metadata   │ │ - path       │ │ - path     │  │   │
│  │  │ - codebase_id│ │ - status     │ │              │ │ - branch   │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └────────────┘  │   │
│  │                                                                      │   │
│  │  ┌──────────────┐ ┌──────────────┐                                  │   │
│  │  │workflow_runs │ │  templates   │                                  │   │
│  │  │              │ │              │                                  │   │
│  │  │ - workflow   │ │ - name       │                                  │   │
│  │  │ - status     │ │ - content    │                                  │   │
│  │  │ - artifacts  │ │ - global     │                                  │   │
│  │  └──────────────┘ └──────────────┘                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Interface Contracts

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              INTERFACES                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                        IPlatformAdapter                                │ │
│  │                                                                        │ │
│  │  interface IPlatformAdapter {                                          │ │
│  │    // Core messaging                                                   │ │
│  │    sendMessage(conversationId: string, message: string): Promise<void> │ │
│  │    sendMessageContext(convId: string, msg: MessageContext): Promise<?>│ │
│  │                                                                        │ │
│  │    // Thread management                                                │ │
│  │    ensureThread(convId: string, ctx?: MessageContext): Promise<string> │ │
│  │                                                                        │ │
│  │    // Configuration                                                    │ │
│  │    getStreamingMode(): 'stream' | 'batch'                              │ │
│  │    getPlatformType(): string                                           │ │
│  │                                                                        │ │
│  │    // Lifecycle                                                        │ │
│  │    start(): Promise<void>                                              │ │
│  │    stop(): Promise<void>                                               │ │
│  │  }                                                                     │ │
│  │                                                                        │ │
│  │  Implementations:                                                      │ │
│  │  ├── CLIAdapter      (stdout/stdin)                                    │ │
│  │  ├── GitHubAdapter   (webhooks + gh CLI)                               │ │
│  │  ├── TelegramAdapter (Bot API polling)                                 │ │
│  │  ├── SlackAdapter    (Socket Mode)                                     │ │
│  │  ├── DiscordAdapter  (WebSocket)                                       │ │
│  │  └── TestAdapter     (in-memory, HTTP endpoints)                       │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                       IIsolationProvider                               │ │
│  │                                                                        │ │
│  │  interface IIsolationProvider {                                        │ │
│  │    readonly name: string                                               │ │
│  │    readonly type: 'worktree' | 'docker' | 'dagger' | 'cloud'          │ │
│  │                                                                        │ │
│  │    // Lifecycle                                                        │ │
│  │    create(config: IsolationConfig): Promise<IsolationEnvironment>      │ │
│  │    getOrCreate(config: IsolationConfig): Promise<IsolationEnvironment> │ │
│  │    destroy(envId: string): Promise<void>                               │ │
│  │                                                                        │ │
│  │    // Discovery                                                        │ │
│  │    list(): Promise<IsolationEnvironment[]>                             │ │
│  │    get(envId: string): Promise<IsolationEnvironment | null>            │ │
│  │  }                                                                     │ │
│  │                                                                        │ │
│  │  interface IsolationEnvironment {                                      │ │
│  │    readonly id: string                                                 │ │
│  │    readonly workingDirectory: string                                   │ │
│  │    readonly branch: string                                             │ │
│  │    readonly status: 'creating' | 'running' | 'stopped' | 'destroyed'  │ │
│  │                                                                        │ │
│  │    exec(command: string[]): Promise<ProcessHandle>                     │ │
│  │    terminate(): Promise<void>                                          │ │
│  │  }                                                                     │ │
│  │                                                                        │ │
│  │  Implementations:                                                      │ │
│  │  ├── WorktreeProvider   (git worktrees - default)                      │ │
│  │  ├── DockerProvider     (containers - future)                          │ │
│  │  ├── DaggerProvider     (Dagger containers - future)                   │ │
│  │  └── CloudProvider      (remote VMs - future)                          │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                        IAssistantClient                                │ │
│  │                                                                        │ │
│  │  interface IAssistantClient {                                          │ │
│  │    // Session management                                               │ │
│  │    createSession(config: SessionConfig): Promise<Session>              │ │
│  │    resumeSession(sessionId: string): Promise<Session>                  │ │
│  │                                                                        │ │
│  │    // Messaging                                                        │ │
│  │    sendMessage(session: Session, message: string): AsyncIterable<Event>│ │
│  │                                                                        │ │
│  │    // Configuration                                                    │ │
│  │    getProviderName(): string                                           │ │
│  │  }                                                                     │ │
│  │                                                                        │ │
│  │  Implementations:                                                      │ │
│  │  ├── ClaudeClient  (@anthropic-ai/claude-agent-sdk)                    │ │
│  │  └── CodexClient   (@openai/codex-sdk)                                 │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Platform Adapters Detail

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PLATFORM ADAPTERS                                  │
│                        (implements IPlatformAdapter)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                          CLIAdapter                                  │   │
│  │                       packages/cli/src/adapters/                     │   │
│  │                                                                      │   │
│  │  ┌─────────────┐                                                     │   │
│  │  │   stdout    │◄──── sendMessage() ────► console.log(message)       │   │
│  │  └─────────────┘                                                     │   │
│  │  ┌─────────────┐                                                     │   │
│  │  │   stdin     │◄──── (future interactive mode)                      │   │
│  │  └─────────────┘                                                     │   │
│  │                                                                      │   │
│  │  streamingMode: 'stream'  (real-time output)                         │   │
│  │  platformType: 'cli'                                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         GitHubAdapter                                │   │
│  │                     packages/server/src/adapters/                    │   │
│  │                                                                      │   │
│  │  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐          │   │
│  │  │  Webhooks   │ ──►  │  Handler    │ ──►  │   gh CLI    │          │   │
│  │  │             │      │             │      │             │          │   │
│  │  │ issue_comment      │ handleWebhook()    │ gh issue    │          │   │
│  │  │ pull_request│      │ verifySignature()  │ gh pr       │          │   │
│  │  │ issues      │      │              │     │ gh api      │          │   │
│  │  └─────────────┘      └─────────────┘      └─────────────┘          │   │
│  │                                                                      │   │
│  │  conversationId: "owner/repo#123"                                    │   │
│  │  streamingMode: 'batch' (single comment)                             │   │
│  │  platformType: 'github'                                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        TelegramAdapter                               │   │
│  │                     packages/server/src/adapters/                    │   │
│  │                                                                      │   │
│  │  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐          │   │
│  │  │  Polling    │ ──►  │  Handler    │ ──►  │  Bot API    │          │   │
│  │  │             │      │             │      │             │          │   │
│  │  │ getUpdates()│      │ onMessage() │      │ sendMessage │          │   │
│  │  │             │      │ auth check  │      │ editMessage │          │   │
│  │  └─────────────┘      └─────────────┘      └─────────────┘          │   │
│  │                                                                      │   │
│  │  conversationId: chat_id (number as string)                          │   │
│  │  streamingMode: 'stream' (edits message)                             │   │
│  │  platformType: 'telegram'                                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         SlackAdapter                                 │   │
│  │                     packages/server/src/adapters/                    │   │
│  │                                                                      │   │
│  │  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐          │   │
│  │  │ Socket Mode │ ──►  │  Handler    │ ──►  │  Slack API  │          │   │
│  │  │             │      │             │      │             │          │   │
│  │  │ app_mention │      │ onMessage() │      │ chat.post   │          │   │
│  │  │ message     │      │ auth check  │      │ chat.update │          │   │
│  │  └─────────────┘      └─────────────┘      └─────────────┘          │   │
│  │                                                                      │   │
│  │  conversationId: thread_ts                                           │   │
│  │  streamingMode: 'batch' (thread reply)                               │   │
│  │  platformType: 'slack'                                               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        DiscordAdapter                                │   │
│  │                     packages/server/src/adapters/                    │   │
│  │                                                                      │   │
│  │  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐          │   │
│  │  │  WebSocket  │ ──►  │  Handler    │ ──►  │ Discord API │          │   │
│  │  │             │      │             │      │             │          │   │
│  │  │ messageCreate      │ onMessage() │      │ channel.send│          │   │
│  │  │             │      │ auth check  │      │             │          │   │
│  │  └─────────────┘      └─────────────┘      └─────────────┘          │   │
│  │                                                                      │   │
│  │  conversationId: channel_id                                          │   │
│  │  streamingMode: 'batch'                                              │   │
│  │  platformType: 'discord'                                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Isolation Providers Detail

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ISOLATION PROVIDERS                                 │
│                      (implements IIsolationProvider)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      WorktreeProvider (Default)                      │   │
│  │                                                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │                    ~/.archon/                                │    │   │
│  │  │  ├── workspaces/           (cloned repos)                    │    │   │
│  │  │  │   └── owner/repo/       (main workspace, synced)          │    │   │
│  │  │  │                                                           │    │   │
│  │  │  └── worktrees/            (isolated environments)           │    │   │
│  │  │      └── repo-name/                                          │    │   │
│  │  │          ├── issue-123/    (branch: issue-123)               │    │   │
│  │  │          ├── pr-456/       (branch: pr-456)                  │    │   │
│  │  │          └── fix-bug/      (branch: fix/bug)                 │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  │                                                                      │   │
│  │  Startup: milliseconds                                               │   │
│  │  Isolation: filesystem only (shared OS, processes)                   │   │
│  │  Use case: Local development, fast iteration                         │   │
│  │                                                                      │   │
│  │  Operations:                                                         │   │
│  │  ├── create()     → git worktree add                                 │   │
│  │  ├── destroy()    → git worktree remove                              │   │
│  │  ├── list()       → git worktree list + database                     │   │
│  │  └── getOrCreate()→ find existing or create new                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      DockerProvider (Future)                         │   │
│  │                                                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │              Docker Container                                │    │   │
│  │  │  ┌─────────────────────────────────────────────────────┐    │    │   │
│  │  │  │  /workspace (mounted from worktree)                  │    │    │   │
│  │  │  │  ├── .git                                            │    │    │   │
│  │  │  │  └── <project files>                                 │    │    │   │
│  │  │  │                                                      │    │    │   │
│  │  │  │  Isolated: dependencies, processes, network          │    │    │   │
│  │  │  └─────────────────────────────────────────────────────┘    │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  │                                                                      │   │
│  │  Startup: seconds                                                    │   │
│  │  Isolation: container (shared kernel)                                │   │
│  │  Use case: Dependency isolation, reproducible builds                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      DaggerProvider (Future)                         │   │
│  │                                                                      │   │
│  │  Same as Docker but with:                                            │   │
│  │  ├── Dagger pipeline caching                                         │   │
│  │  ├── Reproducible builds                                             │   │
│  │  └── CI/CD integration                                               │   │
│  │                                                                      │   │
│  │  Startup: seconds (cached: milliseconds)                             │   │
│  │  Isolation: container + cache layers                                 │   │
│  │  Use case: CI/CD pipelines, cached builds                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      CloudProvider (Future)                          │   │
│  │                                                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │              Remote VM / Sandbox                             │    │   │
│  │  │                                                              │    │   │
│  │  │  Providers: Modal, E2B, Firecracker, etc.                    │    │   │
│  │  │                                                              │    │   │
│  │  │  Communication via:                                          │    │   │
│  │  │  ├── SSH / exec                                              │    │   │
│  │  │  ├── MCP server                                              │    │   │
│  │  │  └── HTTP API                                                │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  │                                                                      │   │
│  │  Startup: seconds                                                    │   │
│  │  Isolation: full VM (separate kernel)                                │   │
│  │  Use case: Untrusted code, full isolation                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## AI SDK Clients Detail

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            AI SDK CLIENTS                                    │
│                       (implements IAssistantClient)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         ClaudeClient                                 │   │
│  │                  @anthropic-ai/claude-agent-sdk                      │   │
│  │                                                                      │   │
│  │  ┌───────────────────────────────────────────────────────────────┐  │   │
│  │  │                     Claude Code Agent                          │  │   │
│  │  │                                                                │  │   │
│  │  │  Capabilities:                                                 │  │   │
│  │  │  ├── File read/write/edit                                      │  │   │
│  │  │  ├── Bash command execution                                    │  │   │
│  │  │  ├── Web search & fetch                                        │  │   │
│  │  │  ├── Git operations                                            │  │   │
│  │  │  └── Multi-turn conversations                                  │  │   │
│  │  │                                                                │  │   │
│  │  │  Session persistence via session ID                            │  │   │
│  │  │  Streaming responses via AsyncIterable                         │  │   │
│  │  └───────────────────────────────────────────────────────────────┘  │   │
│  │                                                                      │   │
│  │  Auth: CLAUDE_CODE_OAUTH_TOKEN or global auth                        │   │
│  │  Model: claude-sonnet-4-20250514 (configurable)                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         CodexClient                                  │   │
│  │                        @openai/codex-sdk                             │   │
│  │                                                                      │   │
│  │  ┌───────────────────────────────────────────────────────────────┐  │   │
│  │  │                     OpenAI Codex Agent                         │  │   │
│  │  │                                                                │  │   │
│  │  │  Capabilities:                                                 │  │   │
│  │  │  ├── Code generation                                           │  │   │
│  │  │  ├── File operations                                           │  │   │
│  │  │  ├── Command execution                                         │  │   │
│  │  │  └── Multi-turn conversations                                  │  │   │
│  │  │                                                                │  │   │
│  │  │  Session persistence via conversation ID                       │  │   │
│  │  └───────────────────────────────────────────────────────────────┘  │   │
│  │                                                                      │   │
│  │  Auth: CODEX_ACCESS_TOKEN, CODEX_ID_TOKEN, CODEX_REFRESH_TOKEN       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## CLI Binary Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLI BINARY                                        │
│                          packages/cli/                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                          Entry Point                                 │   │
│  │                          src/cli.ts                                  │   │
│  │                                                                      │   │
│  │  #!/usr/bin/env bun                                                  │   │
│  │                                                                      │   │
│  │  archon <command> [subcommand] [options] [arguments]                 │   │
│  │                                                                      │   │
│  │  Commands:                                                           │   │
│  │  ├── workflow                                                        │   │
│  │  │   ├── list                    List available workflows            │   │
│  │  │   ├── run <name> [message]    Execute a workflow                  │   │
│  │  │   └── status [id]             Check workflow status               │   │
│  │  │                                                                   │   │
│  │  ├── isolation                                                       │   │
│  │  │   ├── list                    List all environments               │   │
│  │  │   ├── cleanup                 Remove stale environments           │   │
│  │  │   └── destroy <id>            Remove specific environment         │   │
│  │  │                                                                   │   │
│  │  └── version                     Show version info                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Global Options                                │   │
│  │                                                                      │   │
│  │  --branch <name>      Run in isolated worktree for branch            │   │
│  │  --no-worktree        Run in current directory (no isolation)        │   │
│  │  --cwd <path>         Override working directory                     │   │
│  │  --repo <url>         Specify repository (for new clones)            │   │
│  │  --provider <name>    AI provider: claude | codex                    │   │
│  │  --verbose            Show detailed output                           │   │
│  │  --quiet              Suppress non-essential output                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Example Invocations                             │   │
│  │                                                                      │   │
│  │  # List workflows in current repo                                    │   │
│  │  archon workflow list                                                │   │
│  │                                                                      │   │
│  │  # Run workflow with isolation (creates worktree)                    │   │
│  │  archon workflow run investigate-issue --branch fix/bug-123 \        │   │
│  │    "Fix the login timeout bug"                                       │   │
│  │                                                                      │   │
│  │  # Run workflow without isolation                                    │   │
│  │  archon workflow run assist --no-worktree "Explain this code"        │   │
│  │                                                                      │   │
│  │  # Check active isolation environments                               │   │
│  │  archon isolation list                                               │   │
│  │                                                                      │   │
│  │  # Cleanup merged worktrees                                          │   │
│  │  archon isolation cleanup                                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Distribution                                    │   │
│  │                                                                      │   │
│  │  Binary compilation:                                                 │   │
│  │  bun build --compile --target=<platform> ./src/cli.ts               │   │
│  │                                                                      │   │
│  │  Targets:                                                            │   │
│  │  ├── bun-darwin-arm64   (macOS Apple Silicon)                        │   │
│  │  ├── bun-darwin-x64     (macOS Intel)                                │   │
│  │  ├── bun-linux-x64      (Linux x64)                                  │   │
│  │  ├── bun-linux-arm64    (Linux ARM)                                  │   │
│  │  └── bun-windows-x64    (Windows)                                    │   │
│  │                                                                      │   │
│  │  Installation:                                                       │   │
│  │  ├── brew install archon          (Homebrew)                         │   │
│  │  ├── curl -fsSL get.archon.dev | bash                                │   │
│  │  └── npm install -g archon        (optional)                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Server Architecture (Hono)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API SERVER                                         │
│                        packages/server/                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Hono Application                             │   │
│  │                          src/index.ts                                │   │
│  │                                                                      │   │
│  │  const app = new Hono()                                              │   │
│  │                                                                      │   │
│  │  Routes:                                                             │   │
│  │  ├── POST /webhooks/github     GitHub webhook handler                │   │
│  │  │                                                                   │   │
│  │  ├── GET  /health              Basic health check                    │   │
│  │  ├── GET  /health/db           Database connectivity                 │   │
│  │  ├── GET  /health/concurrency  Active conversations                  │   │
│  │  │                                                                   │   │
│  │  ├── GET  /api/workflows       List workflows (for dashboard)        │   │
│  │  ├── POST /api/workflows       Save workflow YAML                    │   │
│  │  ├── POST /api/workflows/:id/run  Trigger workflow execution         │   │
│  │  │                                                                   │   │
│  │  ├── GET  /api/stats           Dashboard statistics                  │   │
│  │  ├── GET  /api/isolation       List isolation environments           │   │
│  │  │                                                                   │   │
│  │  └── (Test adapter endpoints - development only)                     │   │
│  │      ├── POST /test/message                                          │   │
│  │      ├── GET  /test/messages/:id                                     │   │
│  │      └── DELETE /test/messages/:id                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Adapter Lifecycle                               │   │
│  │                                                                      │   │
│  │  On startup:                                                         │   │
│  │  ├── Initialize database connection                                  │   │
│  │  ├── Start enabled adapters (based on env vars)                      │   │
│  │  │   ├── telegram.start()  (if TELEGRAM_BOT_TOKEN)                   │   │
│  │  │   ├── slack.start()     (if SLACK_BOT_TOKEN)                      │   │
│  │  │   ├── discord.start()   (if DISCORD_BOT_TOKEN)                    │   │
│  │  │   └── github (webhook-based, no start needed)                     │   │
│  │  └── Start Hono server on PORT                                       │   │
│  │                                                                      │   │
│  │  On shutdown:                                                        │   │
│  │  ├── Stop all adapters gracefully                                    │   │
│  │  ├── Close database connections                                      │   │
│  │  └── Exit process                                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Type Export for RPC                             │   │
│  │                                                                      │   │
│  │  // Export app type for Hono RPC                                     │   │
│  │  export type AppType = typeof app                                    │   │
│  │                                                                      │   │
│  │  // Dashboard uses:                                                  │   │
│  │  import { hc } from 'hono/client'                                    │   │
│  │  import type { AppType } from '@archon/server'                       │   │
│  │  const client = hc<AppType>('http://localhost:3000')                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Dashboard Architecture (Svelte 5)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DASHBOARD                                          │
│                       packages/dashboard/                                    │
│                        (Svelte 5 / SvelteKit)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                          Routes                                      │   │
│  │                                                                      │   │
│  │  /                         Dashboard home (stats overview)           │   │
│  │  /workflows                Workflow list + builder                   │   │
│  │  /workflows/[id]           Workflow detail / editor                  │   │
│  │  /workflows/new            Visual workflow builder                   │   │
│  │  /isolation                Active environments                       │   │
│  │  /runs                     Workflow run history                      │   │
│  │  /runs/[id]                Run detail + logs                         │   │
│  │  /settings                 Configuration                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Visual Workflow Builder                           │   │
│  │                                                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │                                                              │    │   │
│  │  │  ┌──────────┐    ┌──────────┐    ┌──────────┐              │    │   │
│  │  │  │  Step 1  │───►│  Step 2  │───►│  Step 3  │              │    │   │
│  │  │  │          │    │          │    │          │              │    │   │
│  │  │  │ [AI]     │    │ [AI]     │    │ [Shell]  │              │    │   │
│  │  │  │ plan     │    │ execute  │    │ validate │              │    │   │
│  │  │  └──────────┘    └──────────┘    └──────────┘              │    │   │
│  │  │       │                                                     │    │   │
│  │  │       ▼                                                     │    │   │
│  │  │  ┌────────────────────────────────────────────────────┐    │    │   │
│  │  │  │  Step Editor                                        │    │    │   │
│  │  │  │                                                     │    │    │   │
│  │  │  │  Name: [plan                    ]                   │    │    │   │
│  │  │  │  Type: [AI     ▼]                                   │    │    │   │
│  │  │  │  Prompt:                                            │    │    │   │
│  │  │  │  ┌─────────────────────────────────────────────┐   │    │    │   │
│  │  │  │  │ Analyze the request and create a detailed   │   │    │    │   │
│  │  │  │  │ implementation plan...                      │   │    │    │   │
│  │  │  │  └─────────────────────────────────────────────┘   │    │    │   │
│  │  │  └────────────────────────────────────────────────────┘    │    │   │
│  │  │                                                             │    │   │
│  │  │  [+ Add Step]                      [Save Workflow]          │    │   │
│  │  │                                                             │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  │                                                                      │   │
│  │  Save workflow:                                                      │   │
│  │  1. Convert state to YAML                                            │   │
│  │  2. POST /api/workflows                                              │   │
│  │  3. Server saves to .archon/workflows/<name>.yaml                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      API Client (Hono RPC)                           │   │
│  │                                                                      │   │
│  │  // lib/api.ts                                                       │   │
│  │  import { hc } from 'hono/client'                                    │   │
│  │  import type { AppType } from '@archon/server'                       │   │
│  │                                                                      │   │
│  │  export const api = hc<AppType>(import.meta.env.VITE_API_URL)        │   │
│  │                                                                      │   │
│  │  // Usage in components:                                             │   │
│  │  const workflows = await api.api.workflows.$get()                    │   │
│  │  const stats = await api.api.stats.$get()                            │   │
│  │  await api.api.workflows.$post({ body: yamlContent })                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          COMPLETE DATA FLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  USER INPUT                                                                 │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│  CLI:      archon workflow run plan --branch fix/bug "Fix the login bug"   │
│  GitHub:   @archon fix the login bug (issue comment)                        │
│  Telegram: Fix the login bug (message)                                      │
│  Slack:    @archon fix the login bug (mention)                              │
│  Dashboard: [Run Workflow] button click                                     │
│                                                                             │
│            │                   │                   │                        │
│            ▼                   ▼                   ▼                        │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐               │
│  │   CLIAdapter    │ │  GitHubAdapter  │ │ TelegramAdapter │  ...          │
│  │                 │ │                 │ │                 │               │
│  │ parseArgs()     │ │ handleWebhook() │ │ onMessage()     │               │
│  └────────┬────────┘ └────────┬────────┘ └────────┬────────┘               │
│           │                   │                   │                        │
│           └───────────────────┼───────────────────┘                        │
│                               │                                            │
│                               ▼                                            │
│  ISOLATION                                                                  │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│                    ┌────────────────────────┐                               │
│                    │  resolveIsolation()    │                               │
│                    │                        │                               │
│                    │  --branch fix/bug?     │                               │
│                    │  ├─ Yes: create/get    │                               │
│                    │  │   worktree          │                               │
│                    │  └─ No: use cwd        │                               │
│                    └───────────┬────────────┘                               │
│                                │                                            │
│                                ▼                                            │
│                    ┌────────────────────────┐                               │
│                    │  WorktreeProvider      │                               │
│                    │                        │                               │
│                    │  git worktree add      │                               │
│                    │  → ~/.archon/worktrees/│                               │
│                    │     repo/fix-bug/      │                               │
│                    └───────────┬────────────┘                               │
│                                │                                            │
│                                ▼                                            │
│  ORCHESTRATION                                                              │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│                    ┌────────────────────────┐                               │
│                    │    handleMessage()     │                               │
│                    │                        │                               │
│                    │  1. Load conversation  │                               │
│                    │  2. Load codebase      │                               │
│                    │  3. Discover workflows │                               │
│                    │  4. Route to workflow  │                               │
│                    │     or direct AI       │                               │
│                    └───────────┬────────────┘                               │
│                                │                                            │
│                                ▼                                            │
│  WORKFLOW EXECUTION                                                         │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│                    ┌────────────────────────┐                               │
│                    │   executeWorkflow()    │                               │
│                    │                        │                               │
│                    │  For each step:        │                               │
│                    │  ├─ AI step: call      │                               │
│                    │  │   ClaudeClient      │                               │
│                    │  ├─ Shell step: exec   │                               │
│                    │  │   command           │                               │
│                    │  └─ Stream output to   │                               │
│                    │      platform adapter  │                               │
│                    └───────────┬────────────┘                               │
│                                │                                            │
│                                ▼                                            │
│  AI EXECUTION                                                               │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│                    ┌────────────────────────┐                               │
│                    │     ClaudeClient       │                               │
│                    │                        │                               │
│                    │  sendMessage()         │                               │
│                    │  ├─ cwd: worktree path │                               │
│                    │  ├─ prompt: from YAML  │                               │
│                    │  └─ tools: file, bash, │                               │
│                    │     git, web           │                               │
│                    └───────────┬────────────┘                               │
│                                │                                            │
│                    ┌───────────┴───────────┐                                │
│                    │                       │                                │
│                    ▼                       ▼                                │
│           ┌──────────────┐        ┌──────────────┐                          │
│           │  Tool Calls  │        │   Response   │                          │
│           │              │        │   Streaming  │                          │
│           │  Edit file   │        │              │                          │
│           │  Run bash    │        │  for await   │                          │
│           │  Git commit  │        │  (event)     │                          │
│           └──────────────┘        └──────┬───────┘                          │
│                                          │                                  │
│                                          ▼                                  │
│  OUTPUT                                                                     │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│                    ┌────────────────────────┐                               │
│                    │   Platform Adapter     │                               │
│                    │   sendMessage()        │                               │
│                    └───────────┬────────────┘                               │
│                                │                                            │
│           ┌────────────────────┼────────────────────┐                       │
│           │                    │                    │                       │
│           ▼                    ▼                    ▼                       │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐               │
│  │     stdout      │ │  GitHub Comment │ │ Telegram Message│               │
│  │                 │ │                 │ │                 │               │
│  │  (CLI output)   │ │  (gh issue      │ │  (Bot API       │               │
│  │                 │ │   comment)      │ │   sendMessage)  │               │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Package Dependencies

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PACKAGE DEPENDENCIES                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  @archon/core (no external package dependencies on other @archon/*)         │
│  ├── @anthropic-ai/claude-agent-sdk                                         │
│  ├── @openai/codex-sdk                                                      │
│  ├── pg (PostgreSQL)                                                        │
│  ├── (YAML via Bun.YAML.parse() - no package needed)                        │
│  └── (shared types, no platform-specific code)                              │
│                                                                             │
│  @archon/cli                                                                │
│  ├── @archon/core                                                           │
│  └── (minimal - just CLI parsing)                                           │
│                                                                             │
│  @archon/server                                                             │
│  ├── @archon/core                                                           │
│  ├── hono                                                                   │
│  ├── @slack/bolt                                                            │
│  ├── telegraf                                                               │
│  ├── discord.js                                                             │
│  └── @octokit/webhooks                                                      │
│                                                                             │
│  @archon/dashboard                                                          │
│  ├── hono/client (RPC client only)                                          │
│  ├── svelte                                                                 │
│  ├── @sveltejs/kit                                                          │
│  └── (YAML via Bun.YAML - no package needed for workflow builder)           │
│                                                                             │
│                                                                             │
│  Dependency Graph:                                                          │
│                                                                             │
│                    ┌──────────────┐                                         │
│                    │ @archon/core │                                         │
│                    └──────┬───────┘                                         │
│                           │                                                 │
│          ┌────────────────┼────────────────┐                                │
│          │                │                │                                │
│          ▼                ▼                ▼                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                        │
│  │ @archon/cli  │ │@archon/server│ │  @archon/    │                        │
│  │              │ │              │ │  dashboard   │                        │
│  └──────────────┘ └──────────────┘ └──────────────┘                        │
│                           │                │                                │
│                           └────────────────┘                                │
│                                   │                                         │
│                           (Hono RPC types)                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File System Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FILE SYSTEM LAYOUT                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Repository Structure (after refactor):                                     │
│                                                                             │
│  archon/                                                                    │
│  ├── packages/                                                              │
│  │   ├── core/                                                              │
│  │   │   ├── src/                                                           │
│  │   │   │   ├── workflows/                                                 │
│  │   │   │   │   ├── loader.ts                                              │
│  │   │   │   │   ├── executor.ts                                            │
│  │   │   │   │   ├── validator.ts                                           │
│  │   │   │   │   └── types.ts                                               │
│  │   │   │   ├── orchestrator/                                              │
│  │   │   │   │   └── index.ts                                               │
│  │   │   │   ├── isolation/                                                 │
│  │   │   │   │   ├── orchestrator.ts                                        │
│  │   │   │   │   ├── providers/                                             │
│  │   │   │   │   │   ├── worktree.ts                                        │
│  │   │   │   │   │   ├── docker.ts      (future)                            │
│  │   │   │   │   │   └── index.ts                                           │
│  │   │   │   │   └── types.ts                                               │
│  │   │   │   ├── db/                                                        │
│  │   │   │   │   ├── connection.ts                                          │
│  │   │   │   │   ├── conversations.ts                                       │
│  │   │   │   │   ├── sessions.ts                                            │
│  │   │   │   │   ├── codebases.ts                                           │
│  │   │   │   │   └── isolation.ts                                           │
│  │   │   │   ├── clients/                                                   │
│  │   │   │   │   ├── claude.ts                                              │
│  │   │   │   │   ├── codex.ts                                               │
│  │   │   │   │   └── types.ts                                               │
│  │   │   │   ├── utils/                                                     │
│  │   │   │   │   ├── git.ts                                                 │
│  │   │   │   │   ├── variable-substitution.ts                               │
│  │   │   │   │   └── archon-paths.ts                                        │
│  │   │   │   ├── types/                                                     │
│  │   │   │   │   └── index.ts                                               │
│  │   │   │   └── index.ts              (exports all)                        │
│  │   │   ├── package.json                                                   │
│  │   │   └── tsconfig.json                                                  │
│  │   │                                                                      │
│  │   ├── cli/                                                               │
│  │   │   ├── src/                                                           │
│  │   │   │   ├── cli.ts                (entry point)                        │
│  │   │   │   ├── commands/                                                  │
│  │   │   │   │   ├── workflow.ts                                            │
│  │   │   │   │   ├── isolation.ts                                           │
│  │   │   │   │   └── version.ts                                             │
│  │   │   │   └── adapters/                                                  │
│  │   │   │       └── cli-adapter.ts                                         │
│  │   │   ├── package.json                                                   │
│  │   │   └── tsconfig.json                                                  │
│  │   │                                                                      │
│  │   ├── server/                                                            │
│  │   │   ├── src/                                                           │
│  │   │   │   ├── index.ts              (Hono server)                        │
│  │   │   │   └── adapters/                                                  │
│  │   │   │       ├── github.ts                                              │
│  │   │   │       ├── telegram.ts                                            │
│  │   │   │       ├── slack.ts                                               │
│  │   │   │       ├── discord.ts                                             │
│  │   │   │       └── test.ts                                                │
│  │   │   ├── package.json                                                   │
│  │   │   └── tsconfig.json                                                  │
│  │   │                                                                      │
│  │   └── dashboard/                    (future)                             │
│  │       ├── src/                                                           │
│  │       │   ├── routes/                                                    │
│  │       │   ├── lib/                                                       │
│  │       │   └── components/                                                │
│  │       ├── package.json                                                   │
│  │       └── svelte.config.js                                               │
│  │                                                                          │
│  ├── migrations/                                                            │
│  ├── docker-compose.yml                                                     │
│  ├── package.json                      (workspace root)                     │
│  └── README.md                                                              │
│                                                                             │
│                                                                             │
│  User's Machine (~/.archon/):                                               │
│                                                                             │
│  ~/.archon/                                                                 │
│  ├── workspaces/                       (cloned repositories)                │
│  │   └── owner/                                                             │
│  │       └── repo/                     (synced with origin)                 │
│  │           ├── .git/                                                      │
│  │           ├── .archon/                                                   │
│  │           │   ├── commands/                                              │
│  │           │   ├── workflows/                                             │
│  │           │   └── config.yaml                                            │
│  │           └── <project files>                                            │
│  │                                                                          │
│  ├── worktrees/                        (isolated environments)              │
│  │   └── repo/                                                              │
│  │       ├── issue-123/                                                     │
│  │       ├── pr-456/                                                        │
│  │       └── fix-bug/                                                       │
│  │                                                                          │
│  └── config.yaml                       (global configuration)               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
