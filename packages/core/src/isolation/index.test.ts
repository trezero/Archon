import { describe, test, expect, afterEach } from 'bun:test';
import { getIsolationProvider, resetIsolationProvider } from './index';

describe('Isolation Provider Factory', () => {
  afterEach(() => {
    resetIsolationProvider();
  });

  test('getIsolationProvider returns same instance on repeated calls', () => {
    const first = getIsolationProvider();
    const second = getIsolationProvider();
    expect(first).toBe(second);
  });

  test('resetIsolationProvider clears singleton so next call returns new instance', () => {
    const first = getIsolationProvider();
    resetIsolationProvider();
    const second = getIsolationProvider();
    expect(first).not.toBe(second);
  });
});
