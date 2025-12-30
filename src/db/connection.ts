/**
 * PostgreSQL connection pool configuration
 */
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 0, // Let cloud pooler (Supabase, Neon) manage connection lifecycle
  connectionTimeoutMillis: 10000,
});

// Handle pool errors gracefully for cloud database poolers (Supabase, Neon, etc.)
// Cloud poolers aggressively terminate idle connections - this is normal behavior, not fatal.
// The pool will automatically create new connections when needed.
// See: https://node-postgres.com/apis/pool#events
pool.on('error', (err, _client) => {
  console.error('[Database] Pool error (idle client terminated):', err.message);
  console.error('[Database] Pool will automatically recover on next query');
  // Don't exit - let pool recover naturally by creating new connections
});
