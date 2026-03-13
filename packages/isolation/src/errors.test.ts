import { describe, test, expect } from 'bun:test';
import {
  classifyIsolationError,
  formatWorktreeLimitMessage,
  isKnownIsolationError,
  IsolationBlockedError,
} from './errors';
import type { WorktreeStatusBreakdown } from './types';

describe('classifyIsolationError', () => {
  test('matches "permission denied" in message', () => {
    const result = classifyIsolationError(new Error('Permission denied: /workspace'));
    expect(result).toContain('Permission denied');
  });

  test('matches "eacces" in message', () => {
    const result = classifyIsolationError(new Error('EACCES: access denied'));
    expect(result).toContain('Permission denied');
  });

  test('matches "timeout" in message', () => {
    const result = classifyIsolationError(new Error('Command timeout after 30s'));
    expect(result).toContain('Timed out');
  });

  test('matches "no space left" in message', () => {
    const result = classifyIsolationError(new Error('No space left on device'));
    expect(result).toContain('No disk space');
  });

  test('matches "enospc" in message', () => {
    const result = classifyIsolationError(new Error('ENOSPC: write failed'));
    expect(result).toContain('No disk space');
  });

  test('matches "not a git repository" in message', () => {
    const result = classifyIsolationError(new Error('fatal: not a git repository'));
    expect(result).toContain('not a valid git repository');
  });

  test('returns generic message for unrecognized errors', () => {
    const result = classifyIsolationError(new Error('something unexpected'));
    expect(result).toContain('Could not create isolated workspace');
    expect(result).toContain('something unexpected');
  });

  test('checks stderr when message does not match', () => {
    const err = new Error('Command failed') as Error & { stderr: string };
    err.stderr = 'fatal: not a git repository';
    const result = classifyIsolationError(err);
    expect(result).toContain('not a valid git repository');
  });

  test('checks stderr for permission denied', () => {
    const err = new Error('git worktree add failed') as Error & { stderr: string };
    err.stderr = 'error: permission denied';
    const result = classifyIsolationError(err);
    expect(result).toContain('Permission denied');
  });

  test('handles missing stderr gracefully', () => {
    const result = classifyIsolationError(new Error('unknown error'));
    expect(result).toContain('Could not create isolated workspace');
  });
});

describe('isKnownIsolationError', () => {
  test('identifies permission denied as known', () => {
    expect(isKnownIsolationError(new Error('permission denied'))).toBe(true);
  });

  test('identifies eacces as known', () => {
    expect(isKnownIsolationError(new Error('EACCES: access denied'))).toBe(true);
  });

  test('identifies timeout as known', () => {
    expect(isKnownIsolationError(new Error('timeout after 30s'))).toBe(true);
  });

  test('identifies no space left as known', () => {
    expect(isKnownIsolationError(new Error('No space left on device'))).toBe(true);
  });

  test('identifies enospc as known', () => {
    expect(isKnownIsolationError(new Error('ENOSPC: write failed'))).toBe(true);
  });

  test('identifies not a git repository as known', () => {
    expect(isKnownIsolationError(new Error('fatal: not a git repository'))).toBe(true);
  });

  test('identifies branch not found as known', () => {
    expect(isKnownIsolationError(new Error('branch not found'))).toBe(true);
  });

  test('returns false for unknown errors', () => {
    expect(isKnownIsolationError(new TypeError('cannot read property of null'))).toBe(false);
  });

  test('returns false for generic unexpected errors', () => {
    expect(isKnownIsolationError(new Error('something unexpected'))).toBe(false);
  });

  test('checks stderr when message does not match', () => {
    const err = new Error('Command failed') as Error & { stderr: string };
    err.stderr = 'error: permission denied';
    expect(isKnownIsolationError(err)).toBe(true);
  });
});

describe('formatWorktreeLimitMessage', () => {
  const baseBreakdown: WorktreeStatusBreakdown = {
    total: 25,
    merged: 3,
    stale: 5,
    active: 17,
    limit: 25,
    mergedEnvs: [],
    staleEnvs: [],
    activeEnvs: [],
  };

  test('includes counts in message', () => {
    const msg = formatWorktreeLimitMessage('my-repo', baseBreakdown, 14);
    expect(msg).toContain('25/25');
    expect(msg).toContain('3 merged');
    expect(msg).toContain('5 stale');
    expect(msg).toContain('17 active');
  });

  test('includes codebase name', () => {
    const msg = formatWorktreeLimitMessage('my-repo', baseBreakdown, 14);
    expect(msg).toContain('**my-repo**');
  });

  test('includes stale threshold days', () => {
    const msg = formatWorktreeLimitMessage('my-repo', baseBreakdown, 14);
    expect(msg).toContain('14+ days');
  });

  test('includes stale cleanup option when stale > 0', () => {
    const msg = formatWorktreeLimitMessage('my-repo', baseBreakdown, 14);
    expect(msg).toContain('/worktree cleanup stale');
  });

  test('omits stale cleanup option when stale = 0', () => {
    const noStale = { ...baseBreakdown, stale: 0 };
    const msg = formatWorktreeLimitMessage('my-repo', noStale, 14);
    expect(msg).not.toContain('/worktree cleanup stale');
  });

  test('includes correct command text for worktree removal', () => {
    const msg = formatWorktreeLimitMessage('my-repo', baseBreakdown, 14);
    expect(msg).toContain('/worktree remove');
    expect(msg).not.toContain('/worktree remove <name>');
  });

  test('always includes worktree list option', () => {
    const msg = formatWorktreeLimitMessage('my-repo', baseBreakdown, 14);
    expect(msg).toContain('/worktree list');
  });
});

describe('IsolationBlockedError', () => {
  test('has correct name', () => {
    const err = new IsolationBlockedError('blocked', 'limit_reached');
    expect(err.name).toBe('IsolationBlockedError');
  });

  test('has correct reason', () => {
    const err = new IsolationBlockedError('blocked', 'creation_failed');
    expect(err.reason).toBe('creation_failed');
  });

  test('is instanceof Error', () => {
    const err = new IsolationBlockedError('blocked', 'limit_reached');
    expect(err).toBeInstanceOf(Error);
  });

  test('has correct message', () => {
    const err = new IsolationBlockedError('test message', 'limit_reached');
    expect(err.message).toBe('test message');
  });
});
