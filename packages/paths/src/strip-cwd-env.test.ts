import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { stripCwdEnv } from './strip-cwd-env';

describe('stripCwdEnv', () => {
  const tmpDir = join(import.meta.dir, '__strip-cwd-env-test-tmp__');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_STRIP_KEY;
    delete process.env.TEST_STRIP_KEY2;
  });

  it('strips keys from single .env file', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('strips keys from all four Bun-auto-loaded files', () => {
    for (const f of ['.env', '.env.local', '.env.development', '.env.production']) {
      writeFileSync(join(tmpDir, f), 'TEST_STRIP_KEY=leaked\n');
    }
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('does nothing when no CWD .env files exist', () => {
    process.env.TEST_STRIP_KEY = 'safe';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBe('safe');
  });

  it('preserves keys not in CWD .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    process.env.TEST_STRIP_KEY2 = 'preserved';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
    expect(process.env.TEST_STRIP_KEY2).toBe('preserved');
  });

  it('tolerates malformed .env lines', () => {
    writeFileSync(join(tmpDir, '.env'), 'NOTAKEYVALUE\nTEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('does not delete key if it was not in process.env (no-op)', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=parsed\n');
    // Do NOT set process.env.TEST_STRIP_KEY — simulate key parsed but not auto-loaded
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined(); // still undefined, no error
  });
});
