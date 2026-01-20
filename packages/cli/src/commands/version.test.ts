/**
 * Tests for version command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { versionCommand } from './version';

describe('versionCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should output package name and version', async () => {
    await versionCommand();

    // Should have called console.log twice (package version and Bun version)
    expect(consoleSpy).toHaveBeenCalledTimes(2);

    // First call should contain package name and version
    const firstCall = consoleSpy.mock.calls[0][0] as string;
    expect(firstCall).toContain('@archon/cli');
    expect(firstCall).toMatch(/v\d+\.\d+\.\d+/);

    // Second call should contain Bun version
    const secondCall = consoleSpy.mock.calls[1][0] as string;
    expect(secondCall).toContain('Bun v');
  });

  it('should output correct format', async () => {
    await versionCommand();

    const firstCall = consoleSpy.mock.calls[0][0] as string;
    // Format: "@archon/cli v1.0.0"
    expect(firstCall).toMatch(/^@archon\/cli v\d+\.\d+\.\d+$/);
  });
});
