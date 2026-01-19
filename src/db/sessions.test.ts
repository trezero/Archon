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
  transitionSession,
  getSessionHistory,
  getSessionChain,
  SessionNotFoundError,
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
    parent_session_id: null,
    transition_reason: null,
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
        `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        ['conv-456', 'codebase-789', 'claude', 'claude-session-abc', null, null]
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
        `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        ['conv-456', null, 'claude', null, null, null]
      );
    });

    test('creates session with audit trail fields', async () => {
      const sessionWithAuditTrail: Session = {
        ...mockSession,
        parent_session_id: 'parent-session-123',
        transition_reason: 'plan-to-execute',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([sessionWithAuditTrail]));

      const result = await createSession({
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
        parent_session_id: 'parent-session-123',
        transition_reason: 'plan-to-execute',
      });

      expect(result).toEqual(sessionWithAuditTrail);
      expect(mockQuery).toHaveBeenCalledWith(
        `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        ['conv-456', 'codebase-789', 'claude', null, 'parent-session-123', 'plan-to-execute']
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

    test('throws SessionNotFoundError when session does not exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0)); // rowCount = 0

      const error = await updateSession('non-existent', 'new-session-id').catch(e => e);
      expect(error).toBeInstanceOf(SessionNotFoundError);
      expect(error.message).toBe('Session not found: non-existent');
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

    test('throws SessionNotFoundError when session does not exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0)); // rowCount = 0

      const error = await deactivateSession('non-existent').catch(e => e);
      expect(error).toBeInstanceOf(SessionNotFoundError);
      expect(error.message).toBe('Session not found: non-existent');
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

    test('throws SessionNotFoundError when session does not exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0)); // rowCount = 0

      const error = await updateSessionMetadata('non-existent', { key: 'value' }).catch(e => e);
      expect(error).toBeInstanceOf(SessionNotFoundError);
      expect(error.message).toBe('Session not found: non-existent');
    });
  });

  describe('transitionSession', () => {
    test('creates new session linked to current session', async () => {
      const currentSession: Session = {
        id: 'session-123',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
        assistant_session_id: 'claude-session-abc',
        active: true,
        metadata: { lastCommand: 'plan-feature' },
        started_at: new Date(),
        ended_at: null,
        parent_session_id: null,
        transition_reason: 'first-message',
      };

      const newSession: Session = {
        id: 'session-456',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
        assistant_session_id: null,
        active: true,
        metadata: {},
        started_at: new Date(),
        ended_at: null,
        parent_session_id: 'session-123',
        transition_reason: 'plan-to-execute',
      };

      // Mock getActiveSession, deactivateSession, and createSession calls
      mockQuery
        .mockResolvedValueOnce(createQueryResult([currentSession])) // getActiveSession
        .mockResolvedValueOnce(createQueryResult([], 1)) // deactivateSession
        .mockResolvedValueOnce(createQueryResult([newSession])); // createSession

      const result = await transitionSession('conv-456', 'plan-to-execute', {
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
      });

      expect(result).toEqual(newSession);
      expect(mockQuery).toHaveBeenCalledTimes(3);

      // Verify deactivateSession was called
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'UPDATE remote_agent_sessions SET active = false, ended_at = NOW() WHERE id = $1',
        ['session-123']
      );

      // Verify createSession was called with parent_session_id
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        ['conv-456', 'codebase-789', 'claude', null, 'session-123', 'plan-to-execute']
      );
    });

    test('creates first session when no current session exists', async () => {
      const newSession: Session = {
        id: 'session-123',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
        assistant_session_id: null,
        active: true,
        metadata: {},
        started_at: new Date(),
        ended_at: null,
        parent_session_id: null,
        transition_reason: 'first-message',
      };

      // Mock getActiveSession (no session) and createSession
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // getActiveSession returns null
        .mockResolvedValueOnce(createQueryResult([newSession])); // createSession

      const result = await transitionSession('conv-456', 'first-message', {
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
      });

      expect(result).toEqual(newSession);
      expect(mockQuery).toHaveBeenCalledTimes(2);

      // Verify createSession was called without parent_session_id (null when no current session)
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        ['conv-456', 'codebase-789', 'claude', null, null, 'first-message']
      );
    });

    test('propagates error when createSession fails after deactivateSession', async () => {
      const currentSession: Session = {
        id: 'session-123',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
        assistant_session_id: 'claude-session-abc',
        active: true,
        metadata: {},
        started_at: new Date(),
        ended_at: null,
        parent_session_id: null,
        transition_reason: 'first-message',
      };

      // Mock: getActiveSession succeeds, deactivateSession succeeds, createSession fails
      mockQuery
        .mockResolvedValueOnce(createQueryResult([currentSession])) // getActiveSession
        .mockResolvedValueOnce(createQueryResult([], 1)) // deactivateSession succeeds
        .mockRejectedValueOnce(new Error('Database connection lost')); // createSession fails

      await expect(
        transitionSession('conv-456', 'plan-to-execute', {
          codebase_id: 'codebase-789',
          ai_assistant_type: 'claude',
        })
      ).rejects.toThrow('Database connection lost');

      // Verify all three calls were made (deactivate happened before failure)
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });
  });

  describe('getSessionHistory', () => {
    test('returns sessions ordered by started_at DESC', async () => {
      const sessions: Session[] = [
        {
          id: 'session-3',
          conversation_id: 'conv-456',
          codebase_id: 'codebase-789',
          ai_assistant_type: 'claude',
          assistant_session_id: null,
          active: true,
          metadata: {},
          started_at: new Date('2024-01-03'),
          ended_at: null,
          parent_session_id: 'session-2',
          transition_reason: 'plan-to-execute',
        },
        {
          id: 'session-2',
          conversation_id: 'conv-456',
          codebase_id: 'codebase-789',
          ai_assistant_type: 'claude',
          assistant_session_id: null,
          active: false,
          metadata: {},
          started_at: new Date('2024-01-02'),
          ended_at: new Date('2024-01-03'),
          parent_session_id: 'session-1',
          transition_reason: 'isolation-changed',
        },
        {
          id: 'session-1',
          conversation_id: 'conv-456',
          codebase_id: 'codebase-789',
          ai_assistant_type: 'claude',
          assistant_session_id: null,
          active: false,
          metadata: {},
          started_at: new Date('2024-01-01'),
          ended_at: new Date('2024-01-02'),
          parent_session_id: null,
          transition_reason: 'first-message',
        },
      ];

      mockQuery.mockResolvedValueOnce(createQueryResult(sessions));

      const result = await getSessionHistory('conv-456');

      expect(result).toEqual(sessions);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT * FROM remote_agent_sessions
     WHERE conversation_id = $1
     ORDER BY started_at DESC`,
        ['conv-456']
      );
    });

    test('returns empty array for conversation with no sessions', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getSessionHistory('conv-456');

      expect(result).toEqual([]);
    });
  });

  describe('getSessionChain', () => {
    test('returns session chain from current to root (oldest first)', async () => {
      const sessions: Session[] = [
        {
          id: 'session-1',
          conversation_id: 'conv-456',
          codebase_id: 'codebase-789',
          ai_assistant_type: 'claude',
          assistant_session_id: null,
          active: false,
          metadata: {},
          started_at: new Date('2024-01-01'),
          ended_at: new Date('2024-01-02'),
          parent_session_id: null,
          transition_reason: 'first-message',
        },
        {
          id: 'session-2',
          conversation_id: 'conv-456',
          codebase_id: 'codebase-789',
          ai_assistant_type: 'claude',
          assistant_session_id: null,
          active: false,
          metadata: {},
          started_at: new Date('2024-01-02'),
          ended_at: new Date('2024-01-03'),
          parent_session_id: 'session-1',
          transition_reason: 'isolation-changed',
        },
        {
          id: 'session-3',
          conversation_id: 'conv-456',
          codebase_id: 'codebase-789',
          ai_assistant_type: 'claude',
          assistant_session_id: null,
          active: true,
          metadata: {},
          started_at: new Date('2024-01-03'),
          ended_at: null,
          parent_session_id: 'session-2',
          transition_reason: 'plan-to-execute',
        },
      ];

      mockQuery.mockResolvedValueOnce(createQueryResult(sessions));

      const result = await getSessionChain('session-3');

      expect(result).toEqual(sessions);
      expect(mockQuery).toHaveBeenCalledWith(
        `WITH RECURSIVE chain AS (
       SELECT * FROM remote_agent_sessions WHERE id = $1
       UNION ALL
       SELECT s.* FROM remote_agent_sessions s
       JOIN chain c ON s.id = c.parent_session_id
     )
     SELECT * FROM chain ORDER BY started_at ASC`,
        ['session-3']
      );
    });

    test('returns single session for root session with no parent', async () => {
      const rootSession: Session = {
        id: 'session-1',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
        assistant_session_id: null,
        active: true,
        metadata: {},
        started_at: new Date('2024-01-01'),
        ended_at: null,
        parent_session_id: null,
        transition_reason: 'first-message',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([rootSession]));

      const result = await getSessionChain('session-1');

      expect(result).toEqual([rootSession]);
    });

    test('returns empty array for non-existent session ID', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getSessionChain('non-existent-session');

      expect(result).toEqual([]);
    });
  });
});
