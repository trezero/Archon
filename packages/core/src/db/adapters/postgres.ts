/**
 * PostgreSQL adapter using pg Pool
 */
import { Pool } from 'pg';
import type { IDatabase, QueryResult, SqlDialect } from './types';

export class PostgresAdapter implements IDatabase {
  private pool: Pool;
  readonly dialect = 'postgres' as const;
  readonly sql: SqlDialect = postgresDialect;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 10000,
    });

    this.pool.on('error', err => {
      console.error('[PostgreSQL] CRITICAL: Pool-level connection error', {
        error: err.message,
        code: (err as NodeJS.ErrnoException).code,
        timestamp: new Date().toISOString(),
      });
      // Pool-level errors indicate infrastructure problems (DB unreachable, auth failed, etc.)
      // We don't throw here as this is an event handler, but the error is now properly logged
      // with enough context to diagnose. Individual queries will fail with their own errors.
    });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Cast to satisfy pg's QueryResultRow constraint while keeping our generic interface
    const result = await this.pool.query(sql, params);
    return {
      rows: result.rows as T[],
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
