/**
 * Database operations for conversations
 */
import { pool } from './connection';
import { Conversation, ConversationNotFoundError } from '../types';

/**
 * Get a conversation by platform type and platform ID
 * Returns null if not found (unlike getOrCreate which creates)
 */
export async function getConversationByPlatformId(
  platformType: string,
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );
  return result.rows[0] ?? null;
}

export async function getOrCreateConversation(
  platformType: string,
  platformId: string,
  codebaseId?: string,
  parentConversationId?: string
): Promise<Conversation> {
  const existing = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  // Check if we should inherit from a parent conversation (e.g., Discord thread inheriting from parent channel)
  let inheritedCodebaseId: string | null = null;
  let inheritedCwd: string | null = null;
  let assistantType = process.env.DEFAULT_AI_ASSISTANT ?? 'claude';

  if (parentConversationId) {
    const parent = await pool.query<Conversation>(
      'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
      [platformType, parentConversationId]
    );
    if (parent.rows[0]) {
      inheritedCodebaseId = parent.rows[0].codebase_id;
      inheritedCwd = parent.rows[0].cwd;
      assistantType = parent.rows[0].ai_assistant_type;
      console.log(
        `[DB] Inheriting context from parent conversation: codebase=${inheritedCodebaseId ?? 'none'}, cwd=${inheritedCwd ?? 'none'}`
      );
    }
  }

  // Use provided codebase or inherited codebase
  const finalCodebaseId = codebaseId ?? inheritedCodebaseId;

  // Determine assistant type from codebase if provided (overrides inherited)
  if (codebaseId) {
    const codebase = await pool.query<{ ai_assistant_type: string }>(
      'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
      [codebaseId]
    );
    if (codebase.rows[0]) {
      assistantType = codebase.rows[0].ai_assistant_type;
    }
  }

  const created = await pool.query<Conversation>(
    'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [platformType, platformId, assistantType, finalCodebaseId, inheritedCwd]
  );

  return created.rows[0];
}

export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'isolation_env_id'>>
): Promise<void> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${String(i++)}`);
    values.push(updates.cwd);
  }
  if (updates.isolation_env_id !== undefined) {
    fields.push(`isolation_env_id = $${String(i++)}`);
    values.push(updates.isolation_env_id);
  }

  if (fields.length === 0) {
    return; // No updates
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)}`,
    values
  );

  if (result.rowCount === 0) {
    console.error(`[DB] updateConversation: No rows updated for id=${id}`, {
      fields,
      updates,
    });
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Find a conversation by isolation environment ID (legacy - single result)
 * Used for provider-based lookup and shared environment detection
 */
export async function getConversationByIsolationEnvId(envId: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1 LIMIT 1',
    [envId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all conversations using a specific isolation environment (new UUID model)
 */
export async function getConversationsByIsolationEnvId(envId: string): Promise<Conversation[]> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows;
}

/**
 * Update last_activity_at for staleness tracking
 */
export async function touchConversation(id: string): Promise<void> {
  await pool.query('UPDATE remote_agent_conversations SET last_activity_at = NOW() WHERE id = $1', [
    id,
  ]);
}
