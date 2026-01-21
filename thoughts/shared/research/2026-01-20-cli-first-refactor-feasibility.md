---
date: 2026-01-20T07:55:31Z
researcher: Claude
git_commit: 7fb5fc0c0389e5696eaf6ea90f8faa30af72530c
branch: main
repository: remote-coding-agent
topic: 'CLI-First Architecture Refactor Feasibility Analysis'
tags: [research, architecture, cli, refactor, elysia, hono, express, sqlite, database]
status: complete
last_updated: 2026-01-20
last_updated_by: Claude
last_updated_note: 'Added SQLite strategy decision - database abstraction moved to Phase 3'
---

# Research: CLI-First Architecture Refactor Feasibility

**Date**: 2026-01-20T07:55:31Z
**Researcher**: Claude
**Git Commit**: 7fb5fc0c0389e5696eaf6ea90f8faa30af72530c
**Branch**: main
**Repository**: remote-coding-agent

## Research Question

Is it reasonably feasible to refactor this codebase to a CLI-first architecture with:

1. A thin API wrapper for webhooks and adapters
2. Potentially switching from Express to Elysia or Hono
3. Simple CLI commands to run YAML workflows directly
4. Making it easier for AI agents to work with via CLI skills

## Summary

**Yes, this refactor is feasible and architecturally sound.** The current codebase already has good separation between the HTTP layer and core business logic. The main effort would be:

1. **Extract core orchestration logic** into a CLI-invokable module (~2-3 days)
2. **Replace Express with Hono** (recommended) (~2-4 hours)
3. **Optionally migrate to SQLite** for simpler deployment (~2-3 days)

The current Express layer is already thin (~140 lines of actual HTTP code), and 95%+ of business logic lives in adapters/orchestrator/workflow modules that can be called directly.

## Detailed Findings

### Current Architecture Assessment

#### HTTP Layer Is Already Thin

The Express server in `src/index.ts` is minimal:

- **8 total endpoints** (1 webhook, 3 health, 4 test)
- **~140 lines** of HTTP-specific code
- **2 middleware** (express.raw, express.json)
- **No business logic** in HTTP handlers

Express responsibilities:

- GitHub webhook signature verification and dispatch
- Health checks (basic, database, concurrency)
- Test adapter endpoints (development only)

All business logic is delegated to:

- `GitHubAdapter.handleWebhook()` for webhook processing
- `handleMessage()` orchestrator function
- Workflow execution engine

#### Workflow Engine Independence

The workflow engine (`src/workflows/executor.ts`) has clear entry points:

```typescript
// Current: Called from orchestrator after AI routing
executeWorkflow(context: WorkflowExecutionContext): Promise<void>

// The engine needs:
// 1. Platform adapter (for sending messages)
// 2. Workflow definition (loaded from YAML)
// 3. User message/context
// 4. Database IDs (conversation, codebase)
// 5. Working directory
```

**Key finding**: The workflow engine doesn't depend on HTTP at all. It just needs:

- A way to send messages (platform adapter or stdout)
- Database access for state
- Filesystem access for YAML workflows

#### Adapter Architecture

Adapters implement `IPlatformAdapter` interface:

- `sendMessage(conversationId, message)`
- `ensureThread(conversationId, messageContext)`
- `getStreamingMode()`
- `getPlatformType()`
- `start()` / `stop()`

For CLI-first architecture, you'd create a **CLIAdapter** that:

- Prints messages to stdout
- Returns "cli" as platform type
- Uses "stream" mode (real-time output)

### Proposed CLI-First Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLI Entry Point                       │
│  archon workflow run <name> [args]                      │
│  archon workflow list                                    │
│  archon status                                          │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                   Core Library                           │
│  - Workflow Engine (executeWorkflow)                    │
│  - Orchestrator (handleMessage)                         │
│  - Database Operations                                   │
│  - Git Utilities                                         │
└─────────────────────┬───────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌─────────────────┐    ┌─────────────────────────────────┐
│   CLI Adapter    │    │        HTTP Server (Hono)       │
│  (stdout/stdin)  │    │  - GitHub Webhook Adapter       │
│                  │    │  - Telegram/Slack/Discord       │
│                  │    │  - Health checks                │
└─────────────────┘    └─────────────────────────────────┘
```

### Implementation Path

#### Phase 1: CLI Core (2-3 days)

1. **Create CLI adapter** (`src/adapters/cli.ts`):

```typescript
class CLIAdapter implements IPlatformAdapter {
  async sendMessage(conversationId: string, message: string): Promise<void> {
    console.log(message);
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'stream';
  }

  getPlatformType(): string {
    return 'cli';
  }
}
```

2. **Create CLI entry point** (`src/cli.ts`):

```typescript
#!/usr/bin/env bun
import { parseArgs } from 'util';
import { discoverWorkflows } from './workflows/loader';
import { executeWorkflow } from './workflows/executor';
import { CLIAdapter } from './adapters/cli';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    cwd: { type: 'string', default: process.cwd() },
  },
  allowPositionals: true,
});

// archon workflow run investigate-issue "Fix the login bug"
if (positionals[0] === 'workflow' && positionals[1] === 'run') {
  const workflowName = positionals[2];
  const userMessage = positionals.slice(3).join(' ');

  const workflows = await discoverWorkflows(values.cwd);
  const workflow = workflows.find(w => w.name === workflowName);

  await executeWorkflow({
    platform: new CLIAdapter(),
    conversationId: `cli-${Date.now()}`,
    cwd: values.cwd,
    workflow,
    userMessage,
    // ... database IDs
  });
}
```

3. **Add to package.json**:

```json
{
  "bin": {
    "archon": "./src/cli.ts"
  }
}
```

#### Phase 2: Replace Express with Hono (2-4 hours)

**Why Hono over Elysia:**

- 35x more downloads (lower risk)
- Easier migration from Express (90% pattern compatibility)
- Multi-runtime flexibility
- Sufficient for webhook handling

**Migration example:**

```typescript
// Before (Express)
import express from 'express';
const app = express();
app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  github.handleWebhook((req.body as Buffer).toString('utf-8'), signature);
  res.status(200).send('OK');
});

// After (Hono)
import { Hono } from 'hono';
const app = new Hono();
app.post('/webhooks/github', async c => {
  const signature = c.req.header('x-hub-signature-256');
  const body = await c.req.text();
  github.handleWebhook(body, signature);
  return c.text('OK', 200);
});
```

#### Phase 3 (Optional): SQLite Migration (2-3 days)

If you want simpler deployment:

**PostgreSQL-specific features used:**

- JSONB operators (`metadata || $1::jsonb`, `metadata->'key' ? $2`)
- UUID generation (`gen_random_uuid()`)
- Timezone-aware timestamps

**Migration approach:**

1. Create adapter layer: `src/db/adapters/{postgres,sqlite}.ts`
2. Replace JSONB operations with `json_patch()` (SQLite JSON1)
3. Generate UUIDs in application: `crypto.randomUUID()`
4. Store timestamps as ISO 8601 strings

### Database Considerations

**Current state**: All state is in PostgreSQL:

- Conversations (platform mappings, cwd)
- Sessions (AI session IDs for resumption)
- Codebases (repo URLs, commands)
- Workflows (execution state)
- Isolation environments (worktrees)

**For CLI usage**, you have options:

1. **Keep PostgreSQL**: Just use same database from CLI
2. **SQLite**: Single file at `~/.archon/archon.db`
3. **Hybrid**: SQLite for CLI-only, PostgreSQL when server running

**Recommendation**: Start with option 1 (keep PostgreSQL). The CLI can connect to the same database as the server. This maintains state consistency and avoids migration effort.

### Framework Comparison

| Factor               | Hono                  | Elysia                  | Winner for You |
| -------------------- | --------------------- | ----------------------- | -------------- |
| Migration difficulty | Easy (2-4h)           | Moderate (4-8h)         | **Hono**       |
| Community size       | 9.3M weekly downloads | 266K weekly downloads   | **Hono**       |
| Express similarity   | 90% pattern match     | Different patterns      | **Hono**       |
| Type safety          | Good                  | Excellent (Eden Treaty) | Elysia         |
| WebSocket support    | Helper-based          | Native, better API      | Elysia         |
| Raw performance      | Fast                  | Slightly faster (+7%)   | Negligible     |

**Recommendation**: **Hono** for your use case (thin webhook layer).

### Benefits of CLI-First Architecture

1. **AI Agent Integration**: Skills can invoke `archon workflow run plan "task"` directly
2. **Faster Local Development**: No server needed for local workflows
3. **Simpler Testing**: Test workflows without platform adapters
4. **Composability**: Chain with other CLI tools (`archon workflow run plan | pbcopy`)
5. **Scripting**: Easy to automate in bash/scripts

### Risk Assessment

| Risk                        | Likelihood | Impact | Mitigation                             |
| --------------------------- | ---------- | ------ | -------------------------------------- |
| Database state conflicts    | Low        | Medium | Single source of truth, transactions   |
| Session resumption in CLI   | Low        | Low    | Same session system, different adapter |
| Breaking webhook handlers   | Low        | High   | Gradual migration, test coverage       |
| SQLite migration complexity | Medium     | Medium | Keep PostgreSQL initially              |

## Code References

### Express Layer

- `src/index.ts:262-388` - Express server setup and routes
- `src/index.ts:268-302` - GitHub webhook handler

### Workflow Engine

- `src/workflows/executor.ts:910` - `executeWorkflow()` entry point
- `src/workflows/loader.ts:237` - `discoverWorkflows()` function
- `src/workflows/types.ts:64-91` - Workflow YAML structure

### Adapters

- `src/types/index.ts:114-149` - `IPlatformAdapter` interface
- `src/adapters/github.ts:700-941` - Webhook processing
- `src/adapters/telegram.ts`, `slack.ts`, `discord.ts` - Polling adapters

### Database

- `src/db/connection.ts` - PostgreSQL pool
- `src/db/workflows.ts` - Workflow run persistence
- `migrations/` - Schema definitions

## Architecture Documentation

### Current Patterns

1. **Adapter Pattern**: All platforms implement `IPlatformAdapter`
2. **Fire-and-Forget Webhooks**: Return 200 immediately, process async
3. **Callback Registration**: Adapters expose `onMessage(handler)`
4. **Lock-Based Concurrency**: One message per conversation at a time
5. **Session Continuity**: AI sessions survive restarts via database

### Why This Refactor Works

1. **Clean separation exists**: HTTP layer is already thin
2. **Core logic is framework-agnostic**: Orchestrator/workflow engine don't depend on Express
3. **Adapter abstraction ready**: Just need a CLI adapter implementing same interface
4. **Database layer is modular**: Query functions are isolated

## Conclusion

This refactor is **definitely feasible** and the architecture already supports it well. The main work is:

1. Creating a CLI adapter and entry point
2. Extracting server startup to a separate file
3. Optionally swapping Express for Hono

The fact that everything goes through `handleMessage()` orchestrator and `executeWorkflow()` engine means the core logic is already CLI-ready - you just need a different adapter.

**Recommended approach:**

1. Start with CLI entry point calling existing code
2. Create CLIAdapter for stdout output
3. Test with existing database
4. Optionally migrate Express → Hono
5. Consider SQLite only if deployment simplicity is critical

## Follow-up Research: Distribution, Isolation Providers, and Dashboard

### CLI Distribution Strategy

**Goal**: Install CLI independently of server, via Homebrew/curl/npm.

**Bun Compile** creates standalone executables:

```bash
bun build --compile --target=bun-darwin-arm64 ./src/cli.ts --outfile archon-macos-arm64
bun build --compile --target=bun-linux-x64 ./src/cli.ts --outfile archon-linux-x64
bun build --compile --target=bun-windows-x64 ./src/cli.ts --outfile archon-windows-x64.exe
```

**Supported targets**:

- macOS: `bun-darwin-arm64`, `bun-darwin-x64`
- Linux: `bun-linux-x64`, `bun-linux-arm64`
- Windows: `bun-windows-x64`

**Binary size**: ~50-100MB (includes JavaScriptCore runtime)

**Distribution channels**:

1. **Homebrew** (macOS/Linux):
   - Create tap repo: `homebrew-archon`
   - Host binaries on GitHub Releases
   - Formula detects platform and downloads correct binary
   - User: `brew tap you/archon && brew install archon`

2. **curl install script** (universal):
   - Script detects OS/arch, downloads correct binary
   - User: `curl -fsSL https://get.archon.dev | bash`

3. **npm package** (optional):
   - Use optional dependencies pattern (like esbuild)
   - Platform-specific binaries in scoped packages
   - Wrapper script selects correct binary
   - User: `npm install -g archon`

**Recommended multi-channel approach**:

- GitHub Releases (all platforms) - direct download
- Homebrew (macOS/Linux developers) - easiest
- curl script (quick setup) - one-liner for docs

---

### Pluggable Isolation Providers

**Goal**: Abstract isolation so worktrees today, Docker/Dagger/VMs later.

**Common interface pattern** (from Modal, E2B, DevPod, Dagger Container-Use):

```typescript
interface IsolationProvider {
  readonly name: string;
  readonly type: 'worktree' | 'docker' | 'dagger' | 'firecracker' | 'cloud';

  create(config: IsolationConfig): Promise<IsolationEnvironment>;
  destroy(envId: string): Promise<void>;
  list(): Promise<IsolationEnvironment[]>;
  get(envId: string): Promise<IsolationEnvironment | null>;
}

interface IsolationEnvironment {
  readonly id: string;
  readonly status: 'creating' | 'running' | 'stopped' | 'destroyed';

  exec(command: string[]): Promise<ProcessHandle>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;

  start(): Promise<void>;
  stop(): Promise<void>;
  terminate(): Promise<void>;
}

interface IsolationConfig {
  name?: string;
  workingDirectory: string;
  repository?: { url: string; branch?: string };
  image?: string; // For container-based providers
  resources?: { cpu?: number; memory?: string };
  timeout?: number;
}
```

**Provider implementations**:

| Provider               | Use Case                  | Startup Time | Isolation Level     |
| ---------------------- | ------------------------- | ------------ | ------------------- |
| `WorktreeProvider`     | Local dev, fast iteration | ms           | Filesystem only     |
| `DockerProvider`       | Dependency isolation      | seconds      | Container           |
| `DaggerProvider`       | CI/CD pipelines           | seconds      | Container + caching |
| `FirecrackerProvider`  | Untrusted code            | ~125ms       | MicroVM             |
| `CloudSandboxProvider` | Remote execution          | seconds      | Full VM             |

**Dagger Container-Use** is particularly relevant - combines git worktrees with containerization for AI coding agents. Each agent gets:

- Fresh git worktree (branch isolation)
- Containerized environment (dependency isolation)
- MCP server for tool access

**Implementation roadmap**:

1. Define `IsolationProvider` interface
2. Refactor current worktree code into `WorktreeProvider`
3. Add provider registry/factory
4. Implement `DockerProvider` (most requested)
5. Add config-based provider selection

---

### Web Dashboard: Hono vs Separate Service

**Question**: Can Hono scale to a web dashboard for stats/settings?

**Hono's capabilities**:

- ✅ JSX server-side rendering
- ✅ Cookie/session management (signed cookies, JWT)
- ✅ Static file serving
- ✅ Authentication middleware (Basic, Bearer, OAuth)

**Hono's limitations for dashboards**:

- ❌ No HMR for development
- ❌ Limited client-side interactivity patterns
- ❌ No built-in state management
- ❌ Smaller ecosystem than Next.js/Remix

**Recommendation: Separate frontend service (Svelte 5 / SvelteKit)**

```
archon/
├── packages/
│   ├── cli/           # CLI binary (standalone)
│   ├── core/          # Shared business logic
│   ├── server/        # Hono API + webhooks
│   └── dashboard/     # Svelte 5 / SvelteKit frontend
```

**Why separate**:

1. Hono excels at APIs, not full-stack dashboards
2. Get modern DX (HMR, dev tools, rich ecosystem)
3. Dashboard can scale independently
4. Use Hono RPC for type-safe API calls

**Why Svelte 5**:

- Excellent DX with runes (reactive primitives)
- Great for interactive UIs (drag-and-drop workflow builder)
- Smaller bundle size than React
- SvelteKit provides routing, SSR if needed

**Hono RPC pattern** (type-safe frontend communication):

```typescript
// Server (Hono)
const app = new Hono()
  .get('/api/stats', c => c.json({ workflows: 42 }))
  .get('/api/workflows', c => c.json({ workflows }))
  .post('/api/workflows', async c => {
    const yaml = await c.req.text();
    // Save workflow YAML to filesystem
    return c.json({ success: true });
  });
export type AppType = typeof app;

// Frontend (Svelte 5)
import { hc } from 'hono/client';
import type { AppType } from '@archon/server';
const client = hc<AppType>('http://localhost:3000');
const { data } = await client.api.workflows.$get(); // Fully typed!
```

**When to use Hono SSR instead**:

- Simple admin pages (login, settings)
- Server-rendered content (docs)
- Edge deployment (Cloudflare Workers)

---

### Visual Workflow Builder (Dashboard Feature)

**Goal**: Drag-and-drop workflow builder that outputs YAML files.

**Architecture**:

```
┌─────────────────────────────────────────────────────────┐
│              Svelte 5 Dashboard                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │         Visual Workflow Builder                  │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐         │   │
│  │  │ Step 1  │──│ Step 2  │──│ Step 3  │         │   │
│  │  │ (plan)  │  │(execute)│  │(commit) │         │   │
│  │  └─────────┘  └─────────┘  └─────────┘         │   │
│  │                                                  │   │
│  │  [Save Workflow] → generates YAML               │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────┘
                         │ POST /api/workflows
                         ▼
              ┌──────────────────────┐
              │    Hono API Server    │
              │  - Save YAML to disk  │
              │  - Trigger execution  │
              └──────────────────────┘
```

**Workflow builder → YAML flow**:

1. User drags steps in visual builder
2. Configures each step (name, prompt, commands, validations)
3. Clicks "Save Workflow"
4. Frontend generates YAML from state
5. POST to `/api/workflows` with YAML content
6. Server saves to `.archon/workflows/<name>.yaml`
7. Optionally trigger immediate execution

**Example generated YAML**:

```yaml
name: my-custom-workflow
description: Built in visual editor
triggers:
  - pattern: 'build my feature'
steps:
  - name: plan
    type: ai
    prompt: |
      Analyze the request and create a plan...
  - name: execute
    type: ai
    prompt: |
      Implement the plan...
```

**Technical considerations**:

- Use Svelte 5 runes for reactive workflow state
- Consider `@svelte-put/drag-and-drop` or custom DnD
- YAML generation via `yaml` npm package (stringify)
- Validate YAML against workflow schema before saving

---

### CLI Isolation Orchestration

**Goal**: Isolation (worktrees by default) is a core part of the CLI, not an optional add-on.

**Default behavior**: Running a workflow from CLI automatically creates/uses a worktree.

**CLI interface**:

```bash
# Run workflow on new branch (creates worktree automatically)
archon workflow run investigate-issue --branch fix/login-bug "Fix the login bug"

# Run workflow on existing branch (uses existing worktree or creates one)
archon workflow run implement --branch feature/dark-mode "Add dark mode"

# Run workflow without isolation (escape hatch)
archon workflow run quick-fix --no-worktree "Fix typo in readme"

# List active worktrees/isolation environments
archon isolation list

# Cleanup completed worktrees
archon isolation cleanup
```

**Orchestration flow**:

```
User runs: archon workflow run plan --branch fix/bug-123 "Fix bug"
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │     CLI Isolation Orchestrator     │
                    │                                   │
                    │  1. Parse --branch flag           │
                    │  2. Check if branch exists        │
                    │     - Yes: Find/create worktree   │
                    │     - No: Create branch + worktree│
                    │  3. Set cwd to worktree path      │
                    │  4. Execute workflow              │
                    └───────────────────────────────────┘
                                    │
                                    ▼
              ┌──────────────────────────────────────────────┐
              │              Isolation Provider               │
              │  (WorktreeProvider by default)               │
              │                                              │
              │  - Sync workspace with origin                │
              │  - Create worktree at ~/.archon/worktrees/   │
              │  - Track in database                         │
              │  - Return environment with cwd               │
              └──────────────────────────────────────────────┘
                                    │
                                    ▼
              ┌──────────────────────────────────────────────┐
              │              Workflow Execution               │
              │                                              │
              │  - cwd = worktree path                       │
              │  - Agent has access to gh CLI                │
              │  - Agent can commit, push, create PR         │
              │  - Artifacts stored in worktree              │
              └──────────────────────────────────────────────┘
```

**Parity with GitHub/Slack adapters**:

The CLI should behave identically to how isolation works in adapters today:

| Behavior              | GitHub Adapter              | Slack Adapter               | CLI                         |
| --------------------- | --------------------------- | --------------------------- | --------------------------- |
| Auto-create worktree  | ✅ On issue/PR              | ✅ On `/clone`              | ✅ On `--branch`            |
| Branch naming         | `issue-123`                 | User-specified              | User-specified              |
| Workspace sync        | ✅ Before worktree          | ✅ Before worktree          | ✅ Before worktree          |
| Track in database     | ✅ `isolation_environments` | ✅ `isolation_environments` | ✅ `isolation_environments` |
| Agent has `gh` access | ✅                          | ✅                          | ✅                          |
| PR creation           | ✅ Via agent                | ✅ Via agent                | ✅ Via agent                |

**Key implementation points**:

1. **Extract isolation logic from adapters** into `core/isolation/orchestrator.ts`
   - Currently lives in `src/isolation/` - good foundation
   - Move to shared core so CLI can use it

2. **Branch resolution logic**:

   ```typescript
   async function resolveIsolation(options: {
     branch?: string;
     noWorktree?: boolean;
     repository: string;
   }): Promise<{ cwd: string; isolationEnv?: IsolationEnvironment }> {
     if (options.noWorktree) {
       // Run in current directory
       return { cwd: process.cwd() };
     }

     const provider = getIsolationProvider(); // Default: WorktreeProvider

     if (options.branch) {
       // Check if branch exists remotely
       const branchExists = await checkBranchExists(options.repository, options.branch);

       if (branchExists) {
         // Find or create worktree for existing branch
         const env = await provider.getOrCreate({
           repository: options.repository,
           branch: options.branch,
         });
         return { cwd: env.workingDirectory, isolationEnv: env };
       } else {
         // Create new branch and worktree
         const env = await provider.create({
           repository: options.repository,
           newBranch: options.branch,
           baseBranch: 'main',
         });
         return { cwd: env.workingDirectory, isolationEnv: env };
       }
     }

     // No branch specified - use current directory
     return { cwd: process.cwd() };
   }
   ```

3. **Database tracking**: Same `isolation_environments` table as adapters
   - Enables `archon isolation list` to show all environments
   - Cleanup commands work across CLI and adapter-created worktrees

4. **No-GitHub option** (future):
   - `--no-github` flag for fully local workflow
   - Artifacts stored locally, no PR creation
   - Useful for experimentation before pushing

**Complexity assessment**:

This adds moderate complexity to the CLI refactor:

- Need to extract isolation logic from adapters (~1-2 days)
- CLI argument parsing for `--branch`, `--no-worktree` (~0.5 day)
- Testing isolation flow end-to-end (~1 day)

**Total additional effort**: ~2-3 days on top of base CLI work.

---

## Updated Architecture Vision

```
                    ┌─────────────────────────────────────────┐
                    │         Dashboard (Svelte 5)             │
                    │   stats, settings, workflow builder      │
                    │                                         │
                    │  ┌─────────────────────────────────┐    │
                    │  │    Visual Workflow Builder       │    │
                    │  │    (drag-drop → YAML output)     │    │
                    │  └─────────────────────────────────┘    │
                    └────────────────────┬────────────────────┘
                                         │ Hono RPC
┌───────────────┐    ┌───────────────────┴───────────────────┐
│   CLI Binary   │    │              API Server (Hono)         │
│   (standalone) │    │  webhooks, adapters, health checks    │
│                │    │                                       │
│  --branch X    │    │  POST /api/workflows (save YAML)      │
│  --no-worktree │    │  POST /api/workflows/:id/run          │
└───────┬───────┘    └───────────────────┬───────────────────┘
        │                                │
        └────────────────┬───────────────┘
                         │
              ┌──────────┴──────────┐
              │     Core Library     │
              │                      │
              │  - Workflow Engine   │
              │  - Orchestrator      │
              │  - Database Layer    │
              │                      │
              │  ┌────────────────┐  │
              │  │   Isolation    │  │
              │  │  Orchestrator  │  │
              │  │                │  │
              │  │ resolveIsolation()│
              │  │ --branch logic │  │
              │  └────────────────┘  │
              └──────────┬──────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│   Worktree    │ │    Docker     │ │    Cloud      │
│   Provider    │ │   Provider    │ │   Provider    │
│   (default)   │ │   (future)    │ │   (future)    │
└───────────────┘ └───────────────┘ └───────────────┘
```

---

## Sources (Follow-up Research)

**CLI Distribution**:

- [Bun Single-file executables](https://bun.com/docs/bundler/executables)
- [Bun cross-compilation](https://bun.sh/blog/bun-v1.1.5)
- [Homebrew tap documentation](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)
- [esbuild optional dependencies pattern](https://esbuild.github.io/getting-started/)

**Isolation Providers**:

- [Modal Sandbox API](https://modal.com/docs/guide/sandboxes)
- [Dagger Container-Use](https://github.com/dagger/container-use)
- [DevPod provider architecture](https://devpod.sh/)
- [E2B sandbox](https://e2b.dev/docs)
- [Firecracker MicroVMs](https://firecracker-microvm.github.io/)

**Hono Dashboard**:

- [Hono JSX Guide](https://hono.dev/guides/jsx)
- [Hono RPC Guide](https://hono.dev/docs/guides/rpc)
- [Hono examples repository](https://github.com/honojs/examples)

## Related Research

- None yet (first research document on this topic)

## Open Questions

### Resolved

- **Dashboard framework**: Svelte 5 / SvelteKit (decided)
- **CLI isolation**: Worktrees by default with `--branch` flag, `--no-worktree` escape hatch (decided)
- **HTTP framework**: Hono (decided)
- **Package structure**: Monorepo with `@archon/core`, `@archon/cli`, `@archon/server` (implemented in Phase 1)
- **Conversation IDs for CLI**: Timestamp-based format `cli-{timestamp}-{random}` (implemented in Phase 2)
- **Database for CLI-only**: SQLite with auto-detection (decided - see detailed analysis below)

### Still Open

1. **Session persistence**: Should CLI sessions resume across invocations?
2. **Concurrent CLI + Server**: How to handle both accessing same database?
3. **Authentication**: Should CLI require any auth for multi-user scenarios?
4. **Workflow builder storage**: Where do dashboard-created workflows get saved? User's repo? Central location?
5. **Default branch behavior**: If no `--branch` specified, should CLI run in cwd or require explicit flag?

---

## Database Strategy Decision: SQLite for Standalone CLI

### The Problem

The CLI currently requires `DATABASE_URL` to be set, pointing to a PostgreSQL database. This creates friction for standalone CLI usage:

1. Users must have PostgreSQL running (or a cloud database)
2. `brew install archon` won't "just work" - requires additional setup
3. Defeats the purpose of a lightweight, portable CLI tool

### Decision: Embedded SQLite with Auto-Detection

**The CLI will use SQLite by default**, with automatic PostgreSQL detection:

```
CLI Startup
    │
    ▼
┌─────────────────┐
│  DATABASE_URL   │
│     set?        │
└────────┬────────┘
         │
    ┌────┴────┐
    │ Yes     │ No
    ▼         ▼
┌─────────┐  ┌──────────────────┐
│PostgreSQL│  │ SQLite           │
│(shared   │  │ ~/.archon/       │
│ w/server)│  │ archon.db        │
└─────────┘  └──────────────────┘
```

**Why this approach:**

- **Zero config for CLI users** - `archon workflow run` works immediately
- **Power users can share state** - Set `DATABASE_URL` to use server's PostgreSQL
- **No sync complexity** - User chooses one database, not both
- **Bun has SQLite built-in** - `bun:sqlite` requires no external dependencies

### Why Phase 3, Not Phase 5

**Original thinking**: SQLite was listed as "optional" for Phase 5 (binary distribution).

**Problem with that approach**:

1. Phase 3 adds isolation (`--branch`, `--no-worktree`) which requires database tracking
2. Phase 5 is about **compiling and distributing** the binary, not adding features
3. If we wait until Phase 5, we'd have built Phase 3 and 4 all assuming PostgreSQL-only
4. Retrofitting database abstraction after building more features = more rework

**Phase 3 is the natural place** because:

1. It's where CLI becomes "serious" (isolation, worktree management)
2. It's where database becomes mandatory for CLI (tracking isolation environments)
3. It's before Phase 5, so the binary distribution gets SQLite "for free"
4. It keeps Phase 5 focused on distribution mechanics, not feature development

### Current Database Layer Analysis

**6 database modules** in `packages/core/src/db/`:

- `connection.ts` - PostgreSQL pool (22 lines)
- `conversations.ts` - Conversation CRUD (~150 lines)
- `sessions.ts` - Session management (~100 lines)
- `codebases.ts` - Codebase/repo tracking (~95 lines)
- `workflows.ts` - Workflow run tracking (~180 lines)
- `isolation-environments.ts` - Worktree tracking (~200 lines)
- `command-templates.ts` - Global templates (~60 lines)

**PostgreSQL-specific features used:**
| Feature | Usage | SQLite Equivalent |
|---------|-------|-------------------|
| `::jsonb` cast | Metadata merging | `json()` function |
| `NOW()` | Timestamps | `datetime('now')` |
| `gen_random_uuid()` | Schema UUIDs | `crypto.randomUUID()` in app |
| `metadata \|\| $1::jsonb` | JSON merge | `json_patch()` |
| `INTERVAL` | Date arithmetic | Manual calculation |
| `EXTRACT(EPOCH FROM ...)` | Time calculations | `strftime('%s', ...)` |

**Estimated migration effort**: 2-3 days (included in Phase 3)

### Implementation Approach

1. **Create `IDatabase` interface:**

```typescript
interface IDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
```

2. **Adapter implementations:**

- `packages/core/src/db/adapters/postgres.ts` - Wraps existing `pg` Pool
- `packages/core/src/db/adapters/sqlite.ts` - Uses `bun:sqlite`

3. **Auto-detection in connection.ts:**

```typescript
export function getDatabase(): IDatabase {
  if (process.env.DATABASE_URL) {
    return new PostgresAdapter(process.env.DATABASE_URL);
  }
  const dbPath = join(getArchonHome(), 'archon.db');
  return new SqliteAdapter(dbPath);
}
```

4. **Schema parity:**

- Same table names and structures
- SQLite schema in `migrations/sqlite/`
- Auto-create tables on first run

### What This Means for Each Consumer

| Consumer          | Database         | Notes                            |
| ----------------- | ---------------- | -------------------------------- |
| CLI (standalone)  | SQLite           | Zero config, works immediately   |
| CLI (with server) | PostgreSQL       | Set `DATABASE_URL`, shares state |
| Server            | PostgreSQL       | Always (production workload)     |
| Tests             | SQLite in-memory | Fast, isolated                   |

---

## Implementation Phases

The refactor is broken into focused phases. Each phase:

- Can be implemented by an agent running `/implement`
- Leaves the system in a working state
- Has clear success criteria
- Builds on previous phases

### Phase Overview

```
Phase 1: Monorepo Structure + Core Package        [COMPLETE]
         ↓
Phase 2: CLI Entry Point + Basic Commands         [COMPLETE]
         ↓
Phase 3: Database Abstraction + CLI Isolation     [COMPLETE]
         ├── Part A: Database adapter layer (SQLite + PostgreSQL)
         └── Part B: CLI isolation (--branch, --no-worktree)
         ↓
Phase 4: Express → Hono Migration                 [COMPLETE]
         ↓
Phase 5: CLI Binary Distribution                  ← Distribution only, no features
         ↓
Phase 6: CLI Auto-Update Command                  ← Self-update capability
         ↓
Phase 7: Svelte 5 Dashboard (future)
         ↓
Phase 8: Visual Workflow Builder (future)
```

**Key insight**: Database abstraction (SQLite) is in Phase 3, NOT Phase 5.
Phase 5 is purely about compiling and distributing the binary - all features
including SQLite support are complete before we get there.

---

### Phase 1: Monorepo Structure + Core Package Extraction

**Goal**: Restructure the codebase into a monorepo with a shared `core` package that both CLI and server can use.

**Why this first**: Everything else depends on having a clean separation between core logic and entry points. We can't build a CLI until the core is extractable.

**Scope**:

1. Set up monorepo structure with workspaces:

   ```
   archon/
   ├── packages/
   │   ├── core/           # Extracted from current src/
   │   │   ├── src/
   │   │   │   ├── workflows/      # Workflow engine
   │   │   │   ├── orchestrator/   # Message handling
   │   │   │   ├── isolation/      # Isolation providers
   │   │   │   ├── db/             # Database layer
   │   │   │   ├── clients/        # AI clients (Claude, Codex)
   │   │   │   └── utils/          # Shared utilities
   │   │   └── package.json
   │   └── server/         # Current src/index.ts + adapters
   │       ├── src/
   │       │   ├── adapters/       # Platform adapters
   │       │   └── index.ts        # Express server
   │       └── package.json
   ├── package.json        # Workspace root
   └── bun.lockb
   ```

2. Move shared code to `@archon/core`:
   - `src/workflows/` → `packages/core/src/workflows/`
   - `src/orchestrator/` → `packages/core/src/orchestrator/`
   - `src/isolation/` → `packages/core/src/isolation/`
   - `src/db/` → `packages/core/src/db/`
   - `src/clients/` → `packages/core/src/clients/`
   - `src/utils/` → `packages/core/src/utils/`
   - `src/types/` → `packages/core/src/types/`

3. Keep adapters and server in `@archon/server`:
   - `src/adapters/` → `packages/server/src/adapters/`
   - `src/index.ts` → `packages/server/src/index.ts`

4. Update imports throughout to use `@archon/core`

5. Ensure `bun run dev` still works from server package

**Success criteria**:

- `bun test` passes from workspace root
- `bun run dev` in `packages/server` starts the server
- All existing functionality works (adapters, workflows, webhooks)
- Clean package boundaries (core has no adapter dependencies)

**Estimated effort**: 2-3 days

---

### Phase 2: CLI Entry Point + Basic Commands

**Goal**: Create a working CLI that can run workflows directly.

**Why this second**: Once core is extracted, we can build the CLI entry point. This is the core value proposition of the refactor.

**Scope**:

1. Create `packages/cli/` structure:

   ```
   packages/cli/
   ├── src/
   │   ├── cli.ts              # Entry point
   │   ├── commands/
   │   │   ├── workflow.ts     # workflow run, list, status
   │   │   ├── isolation.ts    # isolation list, cleanup
   │   │   └── version.ts      # version info
   │   └── adapters/
   │       └── cli-adapter.ts  # IPlatformAdapter for stdout
   └── package.json
   ```

2. Implement CLI adapter:

   ```typescript
   class CLIAdapter implements IPlatformAdapter {
     async sendMessage(conversationId: string, message: string): Promise<void> {
       console.log(message);
     }
     getStreamingMode(): 'stream' | 'batch' {
       return 'stream';
     }
     getPlatformType(): string {
       return 'cli';
     }
     // ... other methods
   }
   ```

3. Implement basic commands:
   - `archon workflow list` - List available workflows in cwd
   - `archon workflow run <name> [message]` - Run a workflow (no isolation yet)
   - `archon version` - Show version info

4. Add `bin` entry to package.json for local testing

**Success criteria**:

- `bun run packages/cli/src/cli.ts workflow list` shows workflows
- `bun run packages/cli/src/cli.ts workflow run assist "Hello"` executes workflow
- Output streams to stdout in real-time
- Database connection works (uses same PostgreSQL)

**Estimated effort**: 2-3 days

---

### Phase 3: Database Abstraction + CLI Isolation

**Goal**: Add SQLite support for standalone CLI usage AND add `--branch`/`--no-worktree` flags for isolation management.

**Why this third**:

1. Isolation requires database tracking (`isolation_environments` table)
2. For standalone CLI distribution (Phase 5), we can't require PostgreSQL
3. This is the right time to abstract the database layer - before building more features on top
4. Combining these keeps Phase 3 focused on "making CLI production-ready"

**Why database abstraction belongs here, not Phase 5**:

- Phase 5 is about **compiling and distributing** binaries, not adding features
- If we wait until Phase 5, we'd retrofit database abstraction after building Phase 3 and 4
- The binary won't "just work" without SQLite - it would still require PostgreSQL
- Phase 3 isolation features need database tracking anyway - perfect time to make it flexible

**Scope**:

#### Part A: Database Abstraction Layer (2-3 days)

1. Create database adapter interface:

   ```typescript
   // packages/core/src/db/types.ts
   interface IDatabase {
     query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
     close(): Promise<void>;
   }
   ```

2. Extract PostgreSQL adapter:
   - `packages/core/src/db/adapters/postgres.ts`
   - Wraps existing `pg` Pool
   - Same behavior as current `connection.ts`

3. Create SQLite adapter:
   - `packages/core/src/db/adapters/sqlite.ts`
   - Uses `bun:sqlite` (built into Bun, zero dependencies)
   - Auto-creates `~/.archon/archon.db` on first use
   - Auto-runs migrations to create tables

4. Update `connection.ts` with auto-detection:

   ```typescript
   export function getDatabase(): IDatabase {
     if (process.env.DATABASE_URL) {
       return new PostgresAdapter(process.env.DATABASE_URL);
     }
     return new SqliteAdapter(join(getArchonHome(), 'archon.db'));
   }
   ```

5. Create SQLite-compatible schema:
   - `migrations/sqlite/001_initial_schema.sql`
   - Same tables, SQLite syntax
   - Replace `gen_random_uuid()` with app-generated UUIDs
   - Replace `NOW()` with `datetime('now')`
   - Replace `::jsonb` with `json()` function

6. Update all database modules to use adapter:
   - `conversations.ts`, `sessions.ts`, `codebases.ts`, etc.
   - Replace direct `pool.query()` with `db.query()`
   - Handle SQL dialect differences (NOW() vs datetime('now'))

#### Part B: CLI Isolation Orchestration (2-3 days)

1. Extract isolation orchestration to `@archon/core`:
   - Create `packages/core/src/isolation/orchestrator.ts`
   - Implement `resolveIsolation({ branch, noWorktree, repository })`
   - Move worktree provider logic from adapters

2. Add CLI flags:

   ```bash
   archon workflow run plan --branch fix/bug-123 "Fix the bug"
   archon workflow run plan --no-worktree "Quick fix"
   ```

3. Implement branch resolution:
   - Check if branch exists (local or remote)
   - Find existing worktree or create new one
   - Track in `isolation_environments` table

4. Add isolation commands:
   - `archon isolation list` - Show all worktrees
   - `archon isolation cleanup` - Remove merged/stale worktrees

5. Update adapters to use shared isolation orchestrator

**Success criteria**:

Database Abstraction:

- `bun run cli workflow list` works **without** `DATABASE_URL` set (uses SQLite)
- `bun run cli workflow list` works **with** `DATABASE_URL` set (uses PostgreSQL)
- All existing tests pass with both adapters
- Server continues to work with PostgreSQL (no behavior change)

CLI Isolation:

- `archon workflow run plan --branch test-branch "Test"` creates worktree
- Worktree appears in `archon isolation list`
- Same worktree is reused for subsequent runs on same branch
- Adapters (GitHub, Slack) still work with shared isolation code

**Estimated effort**: 4-6 days total (can be split into two sub-PRs)

**Risk mitigation**:

- Implement database abstraction first, then isolation features
- Run full test suite after each major change
- Keep PostgreSQL as the "known good" path, add SQLite incrementally

---

### Phase 4: Express → Hono Migration

**Goal**: Replace Express with Hono in the server package.

**Why this fourth**: Now that CLI works independently, we can safely migrate the HTTP layer. The server becomes a thin wrapper.

**Scope**:

1. Add Hono dependency, remove Express:

   ```bash
   bun add hono
   bun remove express @types/express
   ```

2. Migrate endpoints:
   - `POST /webhooks/github` - Webhook handler
   - `GET /health` - Basic health check
   - `GET /health/db` - Database health check
   - `GET /health/concurrency` - Concurrency info
   - Test adapter endpoints (if keeping)

3. Update middleware:
   - Body parsing (Hono has built-in)
   - Raw body for webhook signature verification

4. Update Docker/deployment configs if needed

**Success criteria**:

- All endpoints respond correctly
- GitHub webhooks work (signature verification)
- Health checks pass
- Adapters (Telegram, Slack, Discord) still work
- `bun run dev` starts Hono server

**Estimated effort**: 2-4 hours (Express is already thin)

---

### Phase 5: CLI Binary Distribution

**Goal**: Create standalone binary and distribution channels.

**Why this fifth**: CLI is feature-complete (including SQLite support from Phase 3), now make it distributable.

**Prerequisites from Phase 3**:

- SQLite adapter implemented (zero external database dependencies)
- Auto-detection working (DATABASE_URL → PostgreSQL, else → SQLite)
- CLI works standalone without any setup

**Scope**:

1. Set up Bun compile:

   ```bash
   bun build --compile --target=bun-darwin-arm64 ./packages/cli/src/cli.ts
   bun build --compile --target=bun-linux-x64 ./packages/cli/src/cli.ts
   ```

2. Create GitHub Actions workflow for releases:
   - Build binaries for all platforms on tag
   - Upload to GitHub Releases
   - Generate checksums

3. Create Homebrew tap:
   - Set up `homebrew-archon` repository
   - Create formula that downloads correct binary

4. Create curl install script:

   ```bash
   curl -fsSL https://get.archon.dev | bash
   ```

5. Update README with installation instructions

**Success criteria**:

- `brew install archon` works on macOS
- curl script works on Linux/macOS
- Binary runs without Bun installed
- Binary runs without PostgreSQL (uses embedded SQLite)
- `archon workflow list` works immediately after install (zero config)
- Version command shows correct version

**Estimated effort**: 1-2 days

**Note**: This phase is purely about distribution mechanics. All database and feature work is done in Phase 3.

---

### Phase 6: CLI Auto-Update Command

**Goal**: Add `archon update` command that allows the CLI to update itself to the latest version.

**Why this after Phase 5**: Once binary distribution is working, users need an easy way to update without re-running the install script manually.

**How updates work without this**:

- Users must manually re-run: `curl -fsSL https://.../install.sh | bash`
- No notification when new versions are available
- No way to check current vs latest version

**Scope**:

1. Add `archon update` command:

   ```bash
   archon update           # Update to latest version
   archon update --check   # Check for updates without installing
   ```

2. Implementation:

   ```typescript
   // packages/cli/src/commands/update.ts
   export async function updateCommand(options: { check?: boolean }): Promise<void> {
     const currentVersion = getVersion();
     const latestVersion = await fetchLatestVersion(); // GitHub API

     if (currentVersion === latestVersion) {
       console.log(`Already up to date (v${currentVersion})`);
       return;
     }

     console.log(`Update available: v${currentVersion} → v${latestVersion}`);

     if (options.check) {
       return; // Just checking, don't install
     }

     // Download and replace binary
     const platform = detectPlatform(); // darwin-arm64, linux-x64, etc.
     const binaryUrl = `https://github.com/.../releases/download/v${latestVersion}/archon-${platform}`;

     await downloadAndReplace(binaryUrl);
     console.log(`Updated to v${latestVersion}`);
   }
   ```

3. Self-replacement strategy:
   - Download new binary to temp location
   - Verify checksum
   - Replace current binary (may need sudo on some systems)
   - Verify new binary works before completing

4. Optional: Version check on startup (non-blocking)
   - Check for updates in background on `archon` invocation
   - Show subtle message if update available: `(update available: v0.4.0)`
   - Don't block or slow down CLI startup

**Success criteria**:

- `archon update --check` shows if update is available
- `archon update` downloads and installs latest version
- Update works on macOS and Linux
- Handles permission errors gracefully (prompts for sudo if needed)
- Verifies download integrity before replacing

**Estimated effort**: 1-2 days

**Reference implementations**:

- `gh` (GitHub CLI): `gh upgrade`
- `rustup`: `rustup update`
- `brew`: `brew upgrade`

---

### Phase 7: Svelte 5 Dashboard (Future)

**Goal**: Create a web dashboard for stats, settings, and monitoring.

**Why this later**: CLI is the priority. Dashboard is a nice-to-have for visibility.

**Scope**:

1. Create `packages/dashboard/` with SvelteKit
2. Add Hono RPC endpoints in server for dashboard data
3. Implement basic pages:
   - Workflow runs history
   - Active isolation environments
   - Settings/configuration
4. Add authentication (if needed)

**Estimated effort**: 3-5 days

---

### Phase 8: Visual Workflow Builder (Future)

**Goal**: Drag-and-drop workflow editor that outputs YAML.

**Why this last**: Requires dashboard to exist. Enhances UX but not required for core functionality.

**Scope**:

1. Add workflow builder components to dashboard
2. Implement drag-and-drop step editor
3. YAML generation from visual state
4. Workflow save/load via API
5. Optional: Live preview of workflow execution

**Estimated effort**: 5-7 days

---

## Phase Dependencies

```
                    ┌──────────────────┐
                    │     Phase 1      │
                    │ Monorepo + Core  │ [COMPLETE]
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────────┐ ┌────────────┐ ┌────────────┐
     │    Phase 2     │ │  Phase 4   │ │  (future)  │
     │  CLI Entry     │ │  Hono      │ │  Phase 7   │
     │  [COMPLETE]    │ │ [COMPLETE] │ │  Dashboard │
     └───────┬────────┘ └────────────┘ └─────┬──────┘
             │                               │
             ▼                               ▼
     ┌────────────────┐              ┌────────────┐
     │    Phase 3     │              │  Phase 8   │
     │  DB Abstraction│              │  Workflow  │
     │  + Isolation   │              │  Builder   │
     │  [COMPLETE]    │              └────────────┘
     └───────┬────────┘
             │
             ▼
     ┌────────────────┐
     │    Phase 5     │
     │  Distribution  │
     │  (binary only) │
     └───────┬────────┘
             │
             ▼
     ┌────────────────┐
     │    Phase 6     │
     │  Auto-Update   │
     │ (archon update)│
     └────────────────┘
```

**Notes**:

- **Phases 1-4 are complete** - Core CLI functionality is working
- Phase 5 is about distribution (binaries, install scripts, Homebrew)
- Phase 6 adds self-update capability (`archon update`)
- Phase 7/8 (Dashboard, Workflow Builder) are independent and can start earlier if desired
- Each phase can be a separate PR for easier review

---

## Implementation Recommendations

1. **Phases 1-4 are complete** - The foundation is solid.

2. **Phase 5 is next** - Binary distribution makes the CLI accessible to users without Bun installed.

3. **Phase 6 follows Phase 5** - Auto-update requires distribution to be working first.

4. **Phases 7-8 are optional** - CLI-first means CLI is the primary interface. Dashboard is secondary.

---

## Risk Mitigation

| Phase | Key Risk                           | Mitigation                                                       |
| ----- | ---------------------------------- | ---------------------------------------------------------------- |
| 1     | Breaking imports during extraction | Incremental moves, run tests after each                          |
| 2     | Database connection from CLI       | Same connection code as server, test early                       |
| 3a    | SQL dialect differences            | Abstract queries, test both adapters, keep PostgreSQL as primary |
| 3a    | SQLite missing features            | Use json() instead of JSONB, app-generated UUIDs                 |
| 3b    | Isolation state conflicts          | Use same `isolation_environments` table, transactions            |
| 4     | Webhook signature verification     | Test with real GitHub webhooks before merging                    |
| 5     | Binary size too large              | Accept ~50-100MB, Bun runtime is included                        |
| 6     | Self-replacement permissions       | Detect and prompt for sudo; verify binary before replacing       |
| 7-8   | Scope creep                        | Keep MVP focused, iterate later                                  |
