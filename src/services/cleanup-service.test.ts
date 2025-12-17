import { mock, describe, test, expect, beforeEach } from 'bun:test';

// Mock git utility
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
mock.module('../utils/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

// Mock isolation provider
const mockDestroy = mock(() => Promise.resolve());
mock.module('../isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
}));

import { hasUncommittedChanges, isBranchMerged, getLastCommitDate } from './cleanup-service';

describe('cleanup-service', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
  });

  describe('hasUncommittedChanges', () => {
    test('returns true when git status shows changes', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: ' M file.ts\n',
        stderr: '',
      });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/test',
        'status',
        '--porcelain',
      ]);
    });

    test('returns false when git status is clean', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(false);
    });

    test('returns false when git fails (path not found)', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repository'));

      const result = await hasUncommittedChanges('/nonexistent');

      expect(result).toBe(false);
    });

    test('returns false when git status is only whitespace', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '   \n', stderr: '' });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(false);
    });
  });

  describe('isBranchMerged', () => {
    test('returns true when branch is in merged list', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  feature-a\n  issue-42\n* main\n',
        stderr: '',
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'branch',
        '--merged',
        'main',
      ]);
    });

    test('returns false when branch is not merged', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  feature-a\n* main\n',
        stderr: '',
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(false);
    });

    test('returns false when git command fails', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('git error'));

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(false);
    });

    test('handles current branch marker (*)', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '* issue-42\n  main\n',
        stderr: '',
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(true);
    });

    test('uses custom main branch', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  issue-42\n  master\n',
        stderr: '',
      });

      await isBranchMerged('/workspace/repo', 'issue-42', 'master');

      expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'branch',
        '--merged',
        'master',
      ]);
    });
  });

  describe('getLastCommitDate', () => {
    test('returns date from git log', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '2025-01-15 10:30:00 +0000\n',
        stderr: '',
      });

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2025);
      expect(result?.getMonth()).toBe(0); // January is 0
      expect(result?.getDate()).toBe(15);
    });

    test('returns null when git fails', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('no commits'));

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeNull();
    });

    test('handles different date formats', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '2024-12-25 23:59:59 -0500\n',
        stderr: '',
      });

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2024);
    });
  });
});
