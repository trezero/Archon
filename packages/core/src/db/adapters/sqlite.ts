/**
 * SQLite adapter using bun:sqlite
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { IDatabase, QueryResult, SqlDialect } from './types';

export class SqliteAdapter implements IDatabase {
  private db: Database;
  readonly dialect = 'sqlite' as const;
  readonly sql: SqlDialect = sqliteDialect;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.run('PRAGMA journal_mode = WAL');

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');

    // Initialize schema if needed
    this.initSchema();
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Convert $1, $2, etc. to ? placeholders
    const convertedSql = this.convertPlaceholders(sql);

    try {
      // Determine if this is a SELECT or mutation
      const trimmedSql = sql.trim().toUpperCase();
      const isSelect = trimmedSql.startsWith('SELECT') || trimmedSql.startsWith('WITH');

      // Cast params to SQLite's expected type
      const sqliteParams = (params ?? []) as SQLQueryBindings[];

      if (isSelect) {
        const stmt = this.db.prepare(convertedSql);
        const rows = stmt.all(...sqliteParams) as T[];
        return { rows, rowCount: rows.length };
      } else {
        // For INSERT/UPDATE/DELETE
        const stmt = this.db.prepare(convertedSql);
        const result = stmt.run(...sqliteParams);

        // Handle RETURNING clause (SQLite doesn't support it natively)
        const upperSql = sql.toUpperCase();
        if (upperSql.includes('RETURNING')) {
          if (upperSql.includes('INSERT')) {
            // Emulate INSERT RETURNING by fetching the inserted row
            const lastId = result.lastInsertRowid;
            const table = this.extractInsertTableName(sql);
            const selectStmt = this.db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`);
            const rows = [selectStmt.get(lastId)] as T[];
            return { rows, rowCount: result.changes };
          } else {
            // UPDATE/DELETE RETURNING not supported - fail fast rather than return empty rows
            throw new Error(
              'SQLite adapter does not support RETURNING clause on UPDATE/DELETE statements. ' +
                `Query: ${convertedSql.substring(0, 100)}... ` +
                'Hint: Use a SELECT before the mutation if you need the row data.'
            );
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
   * Extract table name from INSERT statement for RETURNING clause emulation
   */
  private extractInsertTableName(sql: string): string {
    const match = /INSERT\s+INTO\s+(\w+)/i.exec(sql);
    const tableName = match?.[1];

    if (!tableName) {
      throw new Error(`Failed to extract table name from INSERT: ${sql.substring(0, 100)}...`);
    }

    return tableName;
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
    this.db.run(`
      -- Codebases table
      CREATE TABLE IF NOT EXISTS remote_agent_codebases (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT,
        repository_url TEXT,
        default_cwd TEXT NOT NULL,
        default_branch TEXT DEFAULT 'main',
        ai_assistant_type TEXT DEFAULT 'claude',
        commands TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Conversations table
      CREATE TABLE IF NOT EXISTS remote_agent_conversations (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        platform_type TEXT NOT NULL,
        platform_conversation_id TEXT NOT NULL,
        ai_assistant_type TEXT DEFAULT 'claude',
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
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        ai_assistant_type TEXT NOT NULL DEFAULT 'claude',
        assistant_session_id TEXT,
        active INTEGER DEFAULT 1,
        metadata TEXT DEFAULT '{}',
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        parent_session_id TEXT REFERENCES remote_agent_sessions(id),
        transition_reason TEXT
      );

      -- Command templates table
      CREATE TABLE IF NOT EXISTS remote_agent_command_templates (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Isolation environments table
      CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
        -- Note: uniqueness enforced via partial index below (only active environments)
      );

      -- Partial unique index: only active environments need uniqueness
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
        ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
        WHERE status = 'active';

      -- Workflow runs table
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        workflow_name TEXT NOT NULL,
        user_message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step_index INTEGER,
        metadata TEXT DEFAULT '{}',
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        last_activity_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_conversations_platform ON remote_agent_conversations(platform_type, platform_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON remote_agent_sessions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON remote_agent_sessions(active);
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

  jsonMerge(column: string, _paramIndex: number): string {
    // SQLite json_patch: merges two JSON objects
    return `json_patch(${column}, ?)`;
  },

  jsonArrayContains(column: string, path: string, _paramIndex: number): string {
    // SQLite: check if JSON array contains value using instr
    return `instr(json_extract(${column}, '$.${path}'), ?) > 0`;
  },

  nowMinusDays(_paramIndex: number): string {
    return "datetime('now', '-' || ? || ' days')";
  },

  daysSince(column: string): string {
    return `(julianday('now') - julianday(${column}))`;
  },
};
