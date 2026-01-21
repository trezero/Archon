# Phase 3: Database Abstraction + CLI Isolation

## Overview

Phase 3 makes the CLI production-ready by:

1. **Part A**: Adding SQLite support so the CLI works without PostgreSQL (zero-config install)
2. **Part B**: Adding `--branch` and `--no-worktree` flags for isolation management

These are combined because:

- Isolation requires database tracking (`isolation_environments` table)
- For standalone CLI distribution (Phase 5), we can't require PostgreSQL
- Both are needed before CLI is ready for wider distribution

## Prerequisites

- [x] Phase 1 complete: Monorepo structure with `@archon/core` extracted
- [x] Phase 2 complete: CLI entry point and basic commands working

## Current State

After Phase 2:

```
packages/
├── core/           # @archon/core - business logic
│   └── src/
│       ├── db/
│       │   ├── connection.ts      # PostgreSQL pool (hard-coded)
│       │   ├── conversations.ts   # Uses pool directly
│       │   ├── sessions.ts        # Uses pool directly
│       │   ├── codebases.ts       # Uses pool directly
│       │   ├── workflows.ts       # Uses pool directly
│       │   ├── isolation-environments.ts  # Uses pool directly
│       │   └── command-templates.ts       # Uses pool directly
│       └── isolation/
│           ├── types.ts           # IIsolationProvider interface
│           ├── index.ts           # Provider factory (returns WorktreeProvider)
│           └── providers/
│               └── worktree.ts    # WorktreeProvider implementation
├── server/         # @archon/server - Express + adapters
└── cli/            # @archon/cli - CLI entry point
    └── src/
        ├── cli.ts                 # Entry point (no isolation flags)
        └── commands/
            └── workflow.ts        # No isolation integration
```

## Desired End State

```
packages/
├── core/
│   └── src/
│       ├── db/
│       │   ├── adapters/
│       │   │   ├── types.ts       # IDatabase interface
│       │   │   ├── postgres.ts    # PostgreSQL adapter
│       │   │   └── sqlite.ts      # SQLite adapter (bun:sqlite)
│       │   ├── connection.ts      # Auto-detection logic
│       │   ├── conversations.ts   # Uses adapter abstraction
│       │   └── ...                # All modules use adapter
│       └── isolation/             # Unchanged
├── server/                        # Unchanged
└── cli/
    └── src/
        ├── cli.ts                 # With --branch, --no-worktree flags
        └── commands/
            └── workflow.ts        # Isolation integration
```

## What We're NOT Doing

- NOT changing the server to use SQLite (always PostgreSQL for production)
- NOT implementing interactive mode
- NOT adding Docker/VM isolation providers (future phases)
- NOT changing the isolation provider interface
- NOT adding `archon setup` wizard (Phase 5)

---

## Part A: Database Abstraction Layer

### Design Decisions

#### 1. Database Interface

A minimal interface that both PostgreSQL and SQLite can implement:

```typescript
// packages/core/src/db/adapters/types.ts
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface IDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}
```

This matches the `pg` Pool interface signature, minimizing changes to existing modules.

#### 2. Auto-Detection Strategy

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
│          │  │ ~/.archon/       │
│          │  │ archon.db        │
└─────────┘  └──────────────────┘
```

#### 3. SQL Dialect Handling

Rather than abstracting SQL, we'll maintain dialect-specific SQL strings where needed:

| PostgreSQL Feature        | SQLite Equivalent                                           | Where Used                               |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `gen_random_uuid()`       | App-generated `crypto.randomUUID()`                         | All INSERT queries                       |
| `NOW()`                   | `datetime('now')`                                           | All timestamp operations                 |
| `metadata \|\| $1::jsonb` | `json_patch(metadata, $1)`                                  | Session/isolation metadata merge         |
| `metadata->'key' ? $2`    | `json_extract(metadata, '$.key') LIKE '%' \|\| $2 \|\| '%'` | Related issue lookup                     |
| `INTERVAL`                | Manual date arithmetic                                      | Stale environment detection              |
| `EXTRACT(EPOCH FROM ...)` | `strftime('%s', ...)`                                       | Age calculations                         |
| Recursive CTE             | Recursive CTE                                               | Session chain (SQLite supports this)     |
| `ON CONFLICT`             | `ON CONFLICT`                                               | Command templates (SQLite supports this) |
| `RETURNING *`             | Separate SELECT                                             | INSERT operations                        |

#### 4. Schema Parity

Same table names and structures in both databases. SQLite schema auto-created on first run.

---

### Sub-Phase 3.1: Create Database Adapter Interface

#### 3.1.1 Create types file

**File**: `packages/core/src/db/adapters/types.ts`
**Changes**: New file

```typescript
/**
 * Database adapter interface for PostgreSQL/SQLite abstraction
 */

/**
 * Result from a database query
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal database interface that both PostgreSQL and SQLite implement
 */
export interface IDatabase {
  /**
   * Execute a SQL query with parameters
   * @param sql - SQL query string with $1, $2, etc. placeholders
   * @param params - Parameter values (order matches placeholders)
   * @returns Query result with rows and affected row count
   */
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;

  /**
   * Get the database type for dialect-specific SQL
   */
  readonly dialect: 'postgres' | 'sqlite';
}

/**
 * SQL dialect helpers for building queries
 */
export interface SqlDialect {
  /**
   * Generate a UUID (called for each INSERT)
   */
  generateUuid(): string;

  /**
   * SQL expression for current timestamp
   */
  now(): string;

  /**
   * SQL expression for JSON merge (existing || new)
   * @param column - Column name
   * @param paramIndex - Parameter placeholder index
   */
  jsonMerge(column: string, paramIndex: number): string;

  /**
   * SQL expression to check if JSON array contains value
   * @param column - Column name containing JSON
   * @param path - JSON path to array (e.g., 'related_issues')
   * @param paramIndex - Parameter placeholder index for value
   */
  jsonArrayContains(column: string, path: string, paramIndex: number): string;

  /**
   * SQL expression for interval subtraction from now
   * @param paramIndex - Parameter placeholder index for days
   */
  nowMinusDays(paramIndex: number): string;

  /**
   * SQL expression for days since timestamp
   * @param column - Timestamp column name
   */
  daysSince(column: string): string;
}
```

#### 3.1.2 Create PostgreSQL adapter

**File**: `packages/core/src/db/adapters/postgres.ts`
**Changes**: New file

```typescript
/**
 * PostgreSQL adapter using pg Pool
 */
import { Pool } from 'pg';
import type { IDatabase, QueryResult, SqlDialect } from './types';

export class PostgresAdapter implements IDatabase {
  private pool: Pool;
  readonly dialect = 'postgres' as const;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 10000,
    });

    this.pool.on('error', err => {
      console.error('[PostgreSQL] Pool error:', err.message);
    });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.pool.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * PostgreSQL SQL dialect helpers
 */
export const postgresDialect: SqlDialect = {
  generateUuid(): string {
    return crypto.randomUUID();
  },

  now(): string {
    return 'NOW()';
  },

  jsonMerge(column: string, paramIndex: number): string {
    return `${column} || $${String(paramIndex)}::jsonb`;
  },

  jsonArrayContains(column: string, path: string, paramIndex: number): string {
    return `${column}->'${path}' ? $${String(paramIndex)}`;
  },

  nowMinusDays(paramIndex: number): string {
    return `NOW() - ($${String(paramIndex)} || ' days')::INTERVAL`;
  },

  daysSince(column: string): string {
    return `EXTRACT(EPOCH FROM (NOW() - ${column})) / 86400`;
  },
};
```

#### 3.1.3 Create SQLite adapter

**File**: `packages/core/src/db/adapters/sqlite.ts`
**Changes**: New file

```typescript
/**
 * SQLite adapter using bun:sqlite
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { IDatabase, QueryResult, SqlDialect } from './types';

export class SqliteAdapter implements IDatabase {
  private db: Database;
  readonly dialect = 'sqlite' as const;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.exec('PRAGMA journal_mode = WAL');

    // Enable foreign keys
    this.db.exec('PRAGMA foreign_keys = ON');

    // Initialize schema if needed
    this.initSchema();
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Convert $1, $2, etc. to ? placeholders
    const convertedSql = this.convertPlaceholders(sql);

    try {
      // Determine if this is a SELECT or mutation
      const isSelect =
        sql.trim().toUpperCase().startsWith('SELECT') ||
        sql.trim().toUpperCase().startsWith('WITH');

      if (isSelect) {
        const stmt = this.db.prepare(convertedSql);
        const rows = stmt.all(...(params ?? [])) as T[];
        return { rows, rowCount: rows.length };
      } else {
        // For INSERT/UPDATE/DELETE
        const stmt = this.db.prepare(convertedSql);
        const result = stmt.run(...(params ?? []));

        // Handle RETURNING clause (SQLite doesn't support it natively)
        if (sql.toUpperCase().includes('RETURNING')) {
          // Execute a SELECT to get the returned rows
          const lastId = result.lastInsertRowid;
          if (sql.toUpperCase().includes('INSERT')) {
            const table = this.extractTableName(sql, 'INSERT');
            const selectStmt = this.db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`);
            const rows = [selectStmt.get(lastId)] as T[];
            return { rows, rowCount: result.changes };
          }
        }

        return { rows: [], rowCount: result.changes };
      }
    } catch (error) {
      const err = error as Error;
      console.error('[SQLite] Query error:', err.message);
      console.error('[SQLite] SQL:', convertedSql);
      console.error('[SQLite] Params:', params);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Convert PostgreSQL $1, $2 placeholders to SQLite ? placeholders
   */
  private convertPlaceholders(sql: string): string {
    // Replace $1, $2, etc. with ?
    // Also handle ::jsonb casts (remove them for SQLite)
    return sql
      .replace(/\$\d+/g, '?')
      .replace(/::jsonb/g, '')
      .replace(/::INTERVAL/g, '');
  }

  /**
   * Extract table name from SQL statement
   */
  private extractTableName(sql: string, type: 'INSERT' | 'UPDATE'): string {
    if (type === 'INSERT') {
      const match = sql.match(/INSERT\s+INTO\s+(\w+)/i);
      return match?.[1] ?? '';
    }
    const match = sql.match(/UPDATE\s+(\w+)/i);
    return match?.[1] ?? '';
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    const schemaExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='remote_agent_codebases'"
      )
      .get();

    if (!schemaExists) {
      console.log('[SQLite] Initializing database schema...');
      this.createSchema();
    }
  }

  /**
   * Create all tables
   */
  private createSchema(): void {
    this.db.exec(`
      -- Codebases table
      CREATE TABLE IF NOT EXISTS remote_agent_codebases (
        id TEXT PRIMARY KEY,
        repo_url TEXT,
        default_cwd TEXT NOT NULL,
        default_branch TEXT DEFAULT 'main',
        commands TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Conversations table
      CREATE TABLE IF NOT EXISTS remote_agent_conversations (
        id TEXT PRIMARY KEY,
        platform_type TEXT NOT NULL,
        platform_conversation_id TEXT NOT NULL,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        cwd TEXT,
        isolation_env_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_activity_at TEXT DEFAULT (datetime('now')),
        UNIQUE(platform_type, platform_conversation_id)
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS remote_agent_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'claude',
        provider_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT DEFAULT '{}',
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        parent_session_id TEXT REFERENCES remote_agent_sessions(id),
        transition_reason TEXT
      );

      -- Command templates table
      CREATE TABLE IF NOT EXISTS remote_agent_command_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Isolation environments table
      CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
        id TEXT PRIMARY KEY,
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        workflow_type TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'worktree',
        working_path TEXT NOT NULL,
        branch_name TEXT,
        created_by_platform TEXT,
        metadata TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(codebase_id, workflow_type, workflow_id)
      );

      -- Workflow runs table
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        last_activity_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_conversations_platform ON remote_agent_conversations(platform_type, platform_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON remote_agent_sessions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON remote_agent_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_isolation_codebase ON remote_agent_isolation_environments(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_isolation_workflow ON remote_agent_isolation_environments(workflow_type, workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation ON remote_agent_workflow_runs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON remote_agent_workflow_runs(status);
    `);
    console.log('[SQLite] Schema initialized successfully');
  }
}

/**
 * SQLite SQL dialect helpers
 */
export const sqliteDialect: SqlDialect = {
  generateUuid(): string {
    return crypto.randomUUID();
  },

  now(): string {
    return "datetime('now')";
  },

  jsonMerge(column: string, paramIndex: number): string {
    // SQLite json_patch: merges two JSON objects
    return `json_patch(${column}, ?)`;
  },

  jsonArrayContains(column: string, path: string, paramIndex: number): string {
    // SQLite: check if JSON array contains value using instr
    return `instr(json_extract(${column}, '$.${path}'), ?) > 0`;
  },

  nowMinusDays(paramIndex: number): string {
    return `datetime('now', '-' || ? || ' days')`;
  },

  daysSince(column: string): string {
    return `(julianday('now') - julianday(${column}))`;
  },
};
```

### Success Criteria (Sub-Phase 3.1):

#### Automated Verification:

- [x] Type check passes: `bun run type-check`
- [x] Files exist: `ls packages/core/src/db/adapters/types.ts packages/core/src/db/adapters/postgres.ts packages/core/src/db/adapters/sqlite.ts`

#### Manual Verification:

- [x] None for this sub-phase

---

### Sub-Phase 3.2: Update Connection Module

#### 3.2.1 Update connection.ts with auto-detection

**File**: `packages/core/src/db/connection.ts`
**Changes**: Replace PostgreSQL-only pool with auto-detecting factory

```typescript
/**
 * Database connection management with auto-detection
 *
 * Strategy:
 * - If DATABASE_URL is set: Use PostgreSQL (shared with server)
 * - Otherwise: Use SQLite at ~/.archon/archon.db (standalone CLI)
 */
import { join } from 'path';
import { getArchonHome } from '../utils/archon-paths';
import type { IDatabase, SqlDialect } from './adapters/types';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

// Singleton database instance
let database: IDatabase | null = null;
let dialect: SqlDialect | null = null;

/**
 * Get or create the database connection
 * Auto-detects PostgreSQL vs SQLite based on DATABASE_URL
 */
export function getDatabase(): IDatabase {
  if (database) {
    return database;
  }

  if (process.env.DATABASE_URL) {
    console.log('[Database] Using PostgreSQL');
    database = new PostgresAdapter(process.env.DATABASE_URL);
    dialect = postgresDialect;
  } else {
    const dbPath = join(getArchonHome(), 'archon.db');
    console.log(`[Database] Using SQLite at ${dbPath}`);
    database = new SqliteAdapter(dbPath);
    dialect = sqliteDialect;
  }

  return database;
}

/**
 * Get the SQL dialect for the current database
 */
export function getDialect(): SqlDialect {
  if (!dialect) {
    // Initialize database to set dialect
    getDatabase();
  }
  return dialect!;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.close();
    database = null;
    dialect = null;
  }
}

/**
 * Reset database for testing
 */
export function resetDatabase(): void {
  database = null;
  dialect = null;
}

// Legacy export for backward compatibility during migration
// TODO: Remove after all modules are updated
export { getDatabase as pool };
```

### Success Criteria (Sub-Phase 3.2):

#### Automated Verification:

- [x] Type check passes: `bun run type-check`
- [x] File updated: `grep 'getDatabase' packages/core/src/db/connection.ts`

#### Manual Verification:

- [x] None for this sub-phase

---

### Sub-Phase 3.3: Update Database Modules

Update each database module to use the adapter abstraction. The key changes:

1. Import `getDatabase()` and `getDialect()` instead of `pool`
2. Use dialect helpers for SQL generation
3. Generate UUIDs in application code for INSERT

#### 3.3.1 Update conversations.ts

**File**: `packages/core/src/db/conversations.ts`
**Changes**: Replace `pool` with adapter pattern

Key changes:

- Replace `import { pool }` with `import { getDatabase, getDialect }`
- Replace `pool.query` with `getDatabase().query`
- Replace `NOW()` with `${getDialect().now()}`
- Generate UUID for INSERT: `const id = getDialect().generateUuid()`
- Handle RETURNING clause differently based on dialect

#### 3.3.2 Update sessions.ts

**File**: `packages/core/src/db/sessions.ts`
**Changes**: Same pattern as conversations

Additional changes:

- Recursive CTE syntax is the same in both databases (no change needed)
- JSONB merge uses dialect helper

#### 3.3.3 Update codebases.ts

**File**: `packages/core/src/db/codebases.ts`
**Changes**: Same pattern

#### 3.3.4 Update workflows.ts

**File**: `packages/core/src/db/workflows.ts`
**Changes**: Same pattern

#### 3.3.5 Update isolation-environments.ts

**File**: `packages/core/src/db/isolation-environments.ts`
**Changes**: Same pattern

Additional changes:

- `findByRelatedIssue()` uses `getDialect().jsonArrayContains()`
- `findStaleEnvironments()` uses `getDialect().nowMinusDays()`
- Age calculation uses `getDialect().daysSince()`

#### 3.3.6 Update command-templates.ts

**File**: `packages/core/src/db/command-templates.ts`
**Changes**: Same pattern

### Success Criteria (Sub-Phase 3.3):

#### Automated Verification:

- [x] Type check passes: `bun run type-check`
- [x] All tests pass: `bun test`
- [x] No direct `pool` imports: `grep -r "from './connection'" packages/core/src/db/*.ts | grep -v connection.ts` should show `getDatabase` imports (Note: backward-compatible pool export still works)

#### Manual Verification:

- [x] None for this sub-phase

---

### Sub-Phase 3.4: Update Exports and CLI Integration

#### 3.4.1 Update db/index.ts exports

**File**: `packages/core/src/db/index.ts`
**Changes**: Export new functions

```typescript
// Connection management
export { getDatabase, getDialect, closeDatabase, resetDatabase } from './connection';
export type { IDatabase, SqlDialect, QueryResult } from './adapters/types';

// Existing exports...
```

#### 3.4.2 Update core/index.ts exports

**File**: `packages/core/src/index.ts`
**Changes**: Add new database exports

```typescript
export { getDatabase, getDialect, closeDatabase, resetDatabase } from './db';
export type { IDatabase, SqlDialect } from './db';
```

#### 3.4.3 Update CLI to use closeDatabase

**File**: `packages/cli/src/cli.ts`
**Changes**: Replace `pool.end()` with `closeDatabase()`

```typescript
import { closeDatabase } from '@archon/core';

// In finally block:
await closeDatabase();
```

### Success Criteria (Sub-Phase 3.4):

#### Automated Verification:

- [x] Type check passes: `bun run type-check`
- [x] CLI runs with SQLite: `DATABASE_URL= bun run cli workflow list`
- [x] CLI runs with PostgreSQL: `bun run cli workflow list`

#### Manual Verification:

- [x] SQLite file created at `~/.archon/archon.db`
- [x] Tables exist in SQLite: `sqlite3 ~/.archon/archon.db ".tables"`

---

### Sub-Phase 3.5: Smart Credential Loading

#### 3.5.1 Update CLI environment loading

**File**: `packages/cli/src/cli.ts`
**Changes**: Add smart credential defaults

After environment loading, add:

```typescript
// Smart defaults for Claude auth
// If no explicit tokens, default to global auth from `claude /login`
if (!process.env.CLAUDE_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  if (process.env.CLAUDE_USE_GLOBAL_AUTH === undefined) {
    process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
    console.log('[CLI] Using Claude global auth (from claude /login)');
  }
}

// DATABASE_URL is no longer required - SQLite will be used
```

#### 3.5.2 Remove DATABASE_URL requirement

**File**: `packages/cli/src/cli.ts`
**Changes**: Remove or soften the DATABASE_URL validation

The current warning at lines 36-38 can be removed since SQLite is now the default.

### Success Criteria (Sub-Phase 3.5):

#### Automated Verification:

- [x] CLI starts without DATABASE_URL: `DATABASE_URL= bun run cli --help`
- [x] CLI uses SQLite when DATABASE_URL not set

#### Manual Verification:

- [x] Run `bun run cli workflow list` without DATABASE_URL - should use SQLite
- [x] Run `bun run cli workflow list` with DATABASE_URL - should use PostgreSQL

---

## Part B: CLI Isolation Integration

### Design Decisions

#### 1. Flag Behavior

| Flags                      | Behavior                                |
| -------------------------- | --------------------------------------- |
| (none)                     | Run in current directory, no isolation  |
| `--branch <name>`          | Create/reuse worktree for branch        |
| `--no-worktree`            | Run on branch directly without worktree |
| `--branch X --no-worktree` | Checkout branch X in cwd, run there     |

#### 2. Workflow Type for CLI

CLI-created worktrees use `workflowType: 'task'` with `identifier` as the branch name.

#### 3. Database Tracking

CLI isolation environments are tracked in `isolation_environments` with:

- `created_by_platform: 'cli'`
- `workflow_type: 'task'`
- `workflow_id: <branch-name>`

---

### Sub-Phase 3.6: Add CLI Isolation Flags

#### 3.6.1 Update argument parsing

**File**: `packages/cli/src/cli.ts`
**Changes**: Add `--branch` and `--no-worktree` flags

In `parseArgs` options (around line 112):

```typescript
parsedArgs = parseArgs({
  args,
  options: {
    cwd: { type: 'string', default: process.cwd() },
    help: { type: 'boolean', short: 'h' },
    branch: { type: 'string', short: 'b' },
    'no-worktree': { type: 'boolean' },
  },
  allowPositionals: true,
  strict: false,
});
```

After flag extraction (around line 128):

```typescript
const { values, positionals } = parsedArgs;
const cwd = resolve(String(values.cwd ?? process.cwd()));
const branchName = values.branch as string | undefined;
const noWorktree = values['no-worktree'] as boolean | undefined;
```

#### 3.6.2 Update help text

**File**: `packages/cli/src/cli.ts`
**Changes**: Document new flags in `printUsage()`

```typescript
function printUsage(): void {
  console.log(`
Archon CLI - Run AI workflows from the command line

Usage:
  archon <command> [subcommand] [options] [arguments]

Commands:
  workflow list              List available workflows in current directory
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show status of running workflows
  version                    Show version info
  help                       Show this help message

Options:
  --cwd <path>               Override working directory (default: current directory)
  --branch, -b <name>        Create worktree for branch (or reuse existing)
  --no-worktree              Run on branch directly without worktree isolation

Examples:
  archon workflow list
  archon workflow run assist "What files are in this directory?"
  archon workflow run plan --cwd /path/to/repo "Add dark mode"
  archon workflow run implement --branch feature-auth "Implement auth"
  archon workflow run quick-fix --no-worktree "Fix typo"
`);
}
```

#### 3.6.3 Pass flags to workflow command

**File**: `packages/cli/src/cli.ts`
**Changes**: Update `workflow run` dispatch

```typescript
case 'run': {
  const workflowName = positionals[2];
  if (!workflowName) {
    console.error('Usage: archon workflow run <name> [message]');
    return 1;
  }
  const userMessage = positionals.slice(3).join(' ') || '';
  await workflowRunCommand(cwd, workflowName, userMessage, {
    branchName,
    noWorktree,
  });
  break;
}
```

### Success Criteria (Sub-Phase 3.6):

#### Automated Verification:

- [x] Type check passes: `bun run type-check`
- [x] Help shows new flags: `bun run cli --help | grep branch`

#### Manual Verification:

- [x] None for this sub-phase

---

### Sub-Phase 3.7: Implement Isolation in Workflow Command

#### 3.7.1 Update workflow command signature

**File**: `packages/cli/src/commands/workflow.ts`
**Changes**: Add isolation options parameter

```typescript
export interface WorkflowRunOptions {
  branchName?: string;
  noWorktree?: boolean;
}

export async function workflowRunCommand(
  cwd: string,
  workflowName: string,
  userMessage: string,
  options: WorkflowRunOptions = {}
): Promise<void>;
```

#### 3.7.2 Implement isolation logic

**File**: `packages/cli/src/commands/workflow.ts`
**Changes**: Add isolation creation between conversation update and workflow execution

```typescript
import { getIsolationProvider } from '@archon/core/isolation';
import * as isolationDb from '@archon/core/db/isolation-environments';
import * as git from '@archon/core/utils/git';

// After conversation creation and codebase detection:

let workingCwd = cwd;
let isolationEnvId: string | undefined;

if (options.branchName) {
  if (!codebase) {
    // Need a codebase for isolation
    // Try to auto-detect from cwd
    const repoRoot = await git.findRepoRoot(cwd);
    if (!repoRoot) {
      console.error('Cannot create worktree: Not in a git repository');
      console.error('Either run from a git repo or use /clone first');
      process.exit(1);
    }

    // Auto-register as codebase
    codebase = await codebaseDb.createCodebase({
      repo_url: await git.getRemoteUrl(repoRoot),
      default_cwd: repoRoot,
    });
    console.log(`[CLI] Auto-registered codebase: ${codebase.repo_url}`);
  }

  if (options.noWorktree) {
    // Checkout branch in cwd, no worktree
    console.log(`[CLI] Checking out branch: ${options.branchName}`);
    await git.checkout(cwd, options.branchName);
    workingCwd = cwd;
  } else {
    // Create or reuse worktree
    const provider = getIsolationProvider();

    // Check for existing worktree
    const existingEnv = await isolationDb.findByWorkflow(codebase.id, 'task', options.branchName);

    if (existingEnv && (await provider.healthCheck(existingEnv.working_path))) {
      console.log(`[CLI] Reusing existing worktree: ${existingEnv.working_path}`);
      workingCwd = existingEnv.working_path;
      isolationEnvId = existingEnv.id;
    } else {
      // Create new worktree
      console.log(`[CLI] Creating worktree for branch: ${options.branchName}`);

      const isolatedEnv = await provider.create({
        workflowType: 'task',
        identifier: options.branchName,
        codebaseId: codebase.id,
        canonicalRepoPath: codebase.default_cwd,
        description: `CLI workflow: ${workflowName}`,
      });

      // Track in database
      const envRecord = await isolationDb.createEnvironment({
        codebase_id: codebase.id,
        workflow_type: 'task',
        workflow_id: options.branchName,
        provider: 'worktree',
        working_path: isolatedEnv.path,
        branch_name: isolatedEnv.branchName,
        created_by_platform: 'cli',
        metadata: {},
      });

      workingCwd = isolatedEnv.path;
      isolationEnvId = envRecord.id;
      console.log(`[CLI] Worktree created: ${workingCwd}`);
    }
  }
}

// Update conversation with isolation info
await conversationDb.updateConversation(conversation.id, {
  cwd: workingCwd,
  codebase_id: codebase?.id ?? null,
  isolation_env_id: isolationEnvId ?? null,
});

// Execute workflow with workingCwd (may be worktree path)
await executeWorkflow(
  adapter,
  conversationId,
  workingCwd,
  workflow,
  userMessage,
  conversation.id,
  codebase?.id
);
```

### Success Criteria (Sub-Phase 3.7):

#### Automated Verification:

- [x] Type check passes: `bun run type-check`
- [x] Tests pass: `bun test`

#### Manual Verification:

- [ ] Create worktree: `bun run cli workflow run assist --branch test-branch "Hello"`
- [ ] Verify worktree exists: `ls ~/.archon/worktrees/`
- [ ] Reuse worktree: Run same command again, should reuse
- [ ] No worktree: `bun run cli workflow run assist --branch main --no-worktree "Hello"` runs in cwd

---

### Sub-Phase 3.8: Add Isolation List/Cleanup Commands

#### 3.8.1 Create isolation command file

**File**: `packages/cli/src/commands/isolation.ts`
**Changes**: New file

```typescript
/**
 * Isolation commands - list and cleanup worktrees
 */
import * as isolationDb from '@archon/core/db/isolation-environments';
import * as codebaseDb from '@archon/core/db/codebases';
import { getIsolationProvider } from '@archon/core/isolation';

/**
 * List all active isolation environments
 */
export async function isolationListCommand(): Promise<void> {
  const codebases = await codebaseDb.getCodebases();

  if (codebases.length === 0) {
    console.log('No codebases registered.');
    console.log('Use /clone or --branch to create worktrees.');
    return;
  }

  let totalEnvs = 0;

  for (const codebase of codebases) {
    const envs = await isolationDb.listByCodebaseWithAge(codebase.id);

    if (envs.length === 0) continue;

    console.log(`\n${codebase.repo_url ?? codebase.default_cwd}:`);

    for (const env of envs) {
      const age =
        env.days_since_activity !== null
          ? `${Math.floor(env.days_since_activity)}d ago`
          : 'unknown';
      const platform = env.created_by_platform ?? 'unknown';

      console.log(`  ${env.branch_name ?? env.workflow_id}`);
      console.log(`    Path: ${env.working_path}`);
      console.log(`    Type: ${env.workflow_type} | Platform: ${platform} | Last activity: ${age}`);
    }

    totalEnvs += envs.length;
  }

  if (totalEnvs === 0) {
    console.log('No active isolation environments.');
  } else {
    console.log(`\nTotal: ${String(totalEnvs)} environment(s)`);
  }
}

/**
 * Cleanup stale isolation environments
 */
export async function isolationCleanupCommand(daysStale: number = 7): Promise<void> {
  console.log(`Finding environments with no activity for ${String(daysStale)}+ days...`);

  const staleEnvs = await isolationDb.findStaleEnvironments(daysStale);

  if (staleEnvs.length === 0) {
    console.log('No stale environments found.');
    return;
  }

  console.log(`Found ${String(staleEnvs.length)} stale environment(s):`);

  const provider = getIsolationProvider();
  let cleaned = 0;
  let failed = 0;

  for (const env of staleEnvs) {
    console.log(`\nCleaning: ${env.branch_name ?? env.workflow_id}`);
    console.log(`  Path: ${env.working_path}`);

    try {
      await provider.destroy(env.working_path, {
        branchName: env.branch_name ?? undefined,
        canonicalRepoPath: env.codebase_default_cwd,
      });

      await isolationDb.markDestroyed(env.id);
      console.log('  Status: Cleaned');
      cleaned++;
    } catch (error) {
      const err = error as Error;
      console.error(`  Status: Failed - ${err.message}`);
      failed++;
    }
  }

  console.log(`\nCleanup complete: ${String(cleaned)} cleaned, ${String(failed)} failed`);
}
```

#### 3.8.2 Add isolation commands to CLI router

**File**: `packages/cli/src/cli.ts`
**Changes**: Add `isolation` command routing

```typescript
import { isolationListCommand, isolationCleanupCommand } from './commands/isolation';

// In command switch:
case 'isolation':
  switch (subcommand) {
    case 'list':
      await isolationListCommand();
      break;

    case 'cleanup': {
      const days = parseInt(positionals[2] ?? '7', 10);
      await isolationCleanupCommand(days);
      break;
    }

    default:
      console.error(`Unknown isolation subcommand: ${String(subcommand)}`);
      console.error('Available: list, cleanup');
      return 1;
  }
  break;
```

#### 3.8.3 Update help text

Add to `printUsage()`:

```typescript
Commands:
  ...
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove stale environments (default: 7 days)
```

### Success Criteria (Sub-Phase 3.8):

#### Automated Verification:

- [x] Type check passes: `bun run type-check`
- [x] List command works: `bun run cli isolation list`

#### Manual Verification:

- [ ] Create a worktree with `--branch`
- [ ] See it in `isolation list`
- [ ] Cleanup works: `bun run cli isolation cleanup 0` (removes all)

---

## Testing Strategy

### Unit Tests

Add tests for:

1. Database adapter interface compliance
2. SQLite dialect helpers
3. PostgreSQL dialect helpers
4. Connection auto-detection
5. CLI flag parsing

### Integration Tests

1. Run workflow with SQLite (no DATABASE_URL)
2. Run workflow with PostgreSQL (with DATABASE_URL)
3. Create worktree with `--branch`
4. Reuse existing worktree
5. List isolation environments
6. Cleanup stale environments

### Manual Testing Steps

1. **SQLite standalone test**:

   ```bash
   # Remove DATABASE_URL
   unset DATABASE_URL

   # Should create SQLite and work
   bun run cli workflow list

   # Verify SQLite created
   ls ~/.archon/archon.db
   sqlite3 ~/.archon/archon.db ".tables"
   ```

2. **PostgreSQL test**:

   ```bash
   export DATABASE_URL=postgresql://...
   bun run cli workflow list
   ```

3. **Isolation test**:

   ```bash
   # Create worktree
   cd /path/to/repo
   bun run cli workflow run assist --branch test-isolation "Hello"

   # List worktrees
   bun run cli isolation list

   # Should see:
   # owner/repo:
   #   test-isolation
   #     Path: ~/.archon/worktrees/owner/repo/task-test-isolation
   #     Type: task | Platform: cli | Last activity: 0d ago

   # Cleanup
   bun run cli isolation cleanup 0
   ```

---

## Performance Considerations

### SQLite

- WAL mode enabled for concurrent reads
- Foreign keys enabled for data integrity
- Schema auto-created on first run (~100ms)
- Single file, portable

### PostgreSQL

- Same connection pooling as before
- No performance changes

---

## Migration Notes

### Existing PostgreSQL Users

No migration needed. If `DATABASE_URL` is set, PostgreSQL is used automatically.

### New CLI Users

SQLite is used by default. No database setup required.

### Switching Between Databases

Data is NOT synchronized between SQLite and PostgreSQL. Choose one:

- Standalone CLI users: SQLite (default)
- Users sharing state with server: PostgreSQL (`DATABASE_URL`)

---

## Rollback Plan

If issues are discovered:

1. **Part A rollback**:
   - Revert `connection.ts` to use `Pool` directly
   - Remove `adapters/` directory
   - Keep `DATABASE_URL` required

2. **Part B rollback**:
   - Remove `--branch` and `--no-worktree` flags
   - Remove isolation command
   - Workflows always run in `cwd`

---

## References

- Phase 2 plan: `thoughts/shared/plans/2026-01-20-phase-2-cli-entry-point.md`
- Research document: `thoughts/shared/research/2026-01-20-cli-first-refactor-feasibility.md`
- Credentials research: `thoughts/shared/research/inportant-credentials-handling-cli.md`
- Current database modules: `packages/core/src/db/`
- Current isolation system: `packages/core/src/isolation/`
