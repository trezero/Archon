import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stripCwdEnv } from './strip-cwd-env';

describe('stripCwdEnv', () => {
  let tmpDir: string;
  let originalCwd: string;
  const testKeys = [
    'STRIP_TEST_MARKER_A',
    'STRIP_TEST_MARKER_B',
    'STRIP_TEST_LOCAL_MARKER',
    'STRIP_TEST_DEV_MARKER',
    'STRIP_TEST_PROD_MARKER',
    'STRIP_TEST_OVERLAP_KEY',
    'STRIP_TEST_PRESERVED_KEY',
    'STRIP_TEST_MALFORMED_KEY',
  ];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'strip-cwd-env-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    // Clean any leaked keys from earlier runs
    for (const key of testKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of testKeys) {
      delete process.env[key];
    }
  });

  test('strips keys present in CWD .env', () => {
    writeFileSync(join(tmpDir, '.env'), 'STRIP_TEST_MARKER_A=from_target_repo\n');
    // Simulate Bun's auto-load
    process.env.STRIP_TEST_MARKER_A = 'from_target_repo';

    const stripped = stripCwdEnv();

    expect(process.env.STRIP_TEST_MARKER_A).toBeUndefined();
    expect(stripped).toContain('STRIP_TEST_MARKER_A');
  });

  test('strips keys from .env.local, .env.development, .env.production', () => {
    writeFileSync(join(tmpDir, '.env.local'), 'STRIP_TEST_LOCAL_MARKER=local\n');
    writeFileSync(join(tmpDir, '.env.development'), 'STRIP_TEST_DEV_MARKER=dev\n');
    writeFileSync(join(tmpDir, '.env.production'), 'STRIP_TEST_PROD_MARKER=prod\n');
    process.env.STRIP_TEST_LOCAL_MARKER = 'local';
    process.env.STRIP_TEST_DEV_MARKER = 'dev';
    process.env.STRIP_TEST_PROD_MARKER = 'prod';

    const stripped = stripCwdEnv();

    expect(process.env.STRIP_TEST_LOCAL_MARKER).toBeUndefined();
    expect(process.env.STRIP_TEST_DEV_MARKER).toBeUndefined();
    expect(process.env.STRIP_TEST_PROD_MARKER).toBeUndefined();
    expect(stripped).toContain('STRIP_TEST_LOCAL_MARKER');
    expect(stripped).toContain('STRIP_TEST_DEV_MARKER');
    expect(stripped).toContain('STRIP_TEST_PROD_MARKER');
  });

  test('does nothing when no CWD .env files exist', () => {
    process.env.STRIP_TEST_PRESERVED_KEY = 'should_remain';

    const stripped = stripCwdEnv();

    expect(process.env.STRIP_TEST_PRESERVED_KEY).toBe('should_remain');
    expect(stripped).toEqual([]);
  });

  test('preserves keys not present in any CWD .env', () => {
    writeFileSync(join(tmpDir, '.env'), 'STRIP_TEST_MARKER_A=from_target\n');
    process.env.STRIP_TEST_MARKER_A = 'from_target';
    process.env.STRIP_TEST_PRESERVED_KEY = 'should_remain';

    stripCwdEnv();

    expect(process.env.STRIP_TEST_MARKER_A).toBeUndefined();
    expect(process.env.STRIP_TEST_PRESERVED_KEY).toBe('should_remain');
  });

  test('ignores parse errors in target repo .env', () => {
    // Write a .env with syntactically dubious content; dotenv's parser is
    // lenient but we still want to verify nothing throws.
    writeFileSync(join(tmpDir, '.env'), 'STRIP_TEST_MALFORMED_KEY="unterminated\n=noKey\n   \n');
    process.env.STRIP_TEST_MALFORMED_KEY = 'set_before_strip';

    // Should not throw
    expect(() => stripCwdEnv()).not.toThrow();
  });

  test('does not strip keys that dotenv parses but are absent from process.env', () => {
    writeFileSync(join(tmpDir, '.env'), 'STRIP_TEST_MARKER_A=only_in_file\n');
    // Intentionally do NOT set process.env.STRIP_TEST_MARKER_A
    // (simulates a .env file that Bun didn't auto-load — e.g. wrong CWD)

    const stripped = stripCwdEnv();

    expect(stripped).not.toContain('STRIP_TEST_MARKER_A');
  });
});
