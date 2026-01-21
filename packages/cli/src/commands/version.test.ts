/**
 * Tests for version command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { versionCommand } from './version';

describe('versionCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should output version and system info', async () => {
    await versionCommand();

    // Should have called console.log 4 times (version, platform, build, database)
    expect(consoleSpy).toHaveBeenCalledTimes(4);

    // First call should contain "Archon CLI" and version
    const firstCall = consoleSpy.mock.calls[0][0] as string;
    expect(firstCall).toContain('Archon CLI');
    expect(firstCall).toMatch(/v\d+\.\d+\.\d+/);

    // Second call should contain platform info
    const secondCall = consoleSpy.mock.calls[1][0] as string;
    expect(secondCall).toContain('Platform:');

    // Third call should contain build type
    const thirdCall = consoleSpy.mock.calls[2][0] as string;
    expect(thirdCall).toContain('Build:');

    // Fourth call should contain database type
    const fourthCall = consoleSpy.mock.calls[3][0] as string;
    expect(fourthCall).toContain('Database:');
  });

  it('should output correct format for version line', async () => {
    await versionCommand();

    const firstCall = consoleSpy.mock.calls[0][0] as string;
    // Format: "Archon CLI v0.2.0"
    expect(firstCall).toMatch(/^Archon CLI v\d+\.\d+\.\d+$/);
  });

  it('should show source (bun) build type in development', async () => {
    await versionCommand();

    const buildCall = consoleSpy.mock.calls[2][0] as string;
    expect(buildCall).toContain('source (bun)');
  });
});
