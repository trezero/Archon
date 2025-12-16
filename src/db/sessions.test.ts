import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult } from '../test/mocks/database';
import { Session } from '../types';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
}));

import {
  getActiveSession,
  createSession,
  updateSession,
  deactivateSession,
  updateSessionMetadata,
} from './sessions';

describe('sessions', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const mockSession: Session = {
    id: 'session-123',
    conversation_id: 'conv-456',
    codebase_id: 'codebase-789',
    ai_assistant_type: 'claude',
    assistant_session_id: 'claude-session-abc',
    active: true,
    metadata: { lastCommand: 'plan' },
    started_at: new Date(),
    ended_at: null,
  };

  describe('getActiveSession', () => {
    test('returns active session', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockSession]));

      const result = await getActiveSession('conv-456');

      expect(result).toEqual(mockSession);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_sessions WHERE conversation_id = $1 AND active = true LIMIT 1',
        ['conv-456']
      );
    });

    test('returns null when no active session', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getActiveSession('conv-456');

      expect(result).toBeNull();
    });

    test('returns null for non-existent conversation', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getActiveSession('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('createSession', () => {
    test('creates session with all fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockSession]));

      const result = await createSession({
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        assistant_session_id: 'claude-session-abc',
        ai_assistant_type: 'claude',
      });

      expect(result).toEqual(mockSession);
      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO remote_agent_sessions (conversation_id, codebase_id, ai_assistant_type, assistant_session_id) VALUES ($1, $2, $3, $4) RETURNING *',
        ['conv-456', 'codebase-789', 'claude', 'claude-session-abc']
      );
    });

    test('creates session with optional fields omitted', async () => {
      const sessionWithoutOptional: Session = {
        ...mockSession,
        codebase_id: null,
        assistant_session_id: null,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([sessionWithoutOptional]));

      const result = await createSession({
        conversation_id: 'conv-456',
        ai_assistant_type: 'claude',
      });

      expect(result).toEqual(sessionWithoutOptional);
      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO remote_agent_sessions (conversation_id, codebase_id, ai_assistant_type, assistant_session_id) VALUES ($1, $2, $3, $4) RETURNING *',
        ['conv-456', null, 'claude', null]
      );
    });
  });

  describe('updateSession', () => {
    test('updates assistant_session_id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateSession('session-123', 'new-claude-session-xyz');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_sessions SET assistant_session_id = $1 WHERE id = $2',
        ['new-claude-session-xyz', 'session-123']
      );
    });
  });

  describe('deactivateSession', () => {
    test('sets active=false and ended_at', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await deactivateSession('session-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_sessions SET active = false, ended_at = NOW() WHERE id = $1',
        ['session-123']
      );
    });
  });

  describe('updateSessionMetadata', () => {
    test('merges metadata correctly', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateSessionMetadata('session-123', { lastCommand: 'execute', plan: 'Add dark mode' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_sessions SET metadata = metadata || $1::jsonb WHERE id = $2',
        [JSON.stringify({ lastCommand: 'execute', plan: 'Add dark mode' }), 'session-123']
      );
    });

    test('handles empty metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateSessionMetadata('session-123', {});

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_sessions SET metadata = metadata || $1::jsonb WHERE id = $2',
        ['{}', 'session-123']
      );
    });

    test('handles nested metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const nestedMetadata = {
        lastCommand: 'plan',
        context: {
          feature: 'dark mode',
          priority: 'high',
        },
      };

      await updateSessionMetadata('session-123', nestedMetadata);

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_sessions SET metadata = metadata || $1::jsonb WHERE id = $2',
        [JSON.stringify(nestedMetadata), 'session-123']
      );
    });
  });
});
