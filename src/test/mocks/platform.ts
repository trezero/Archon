import type { IPlatformAdapter } from '../../types';
import { mock, type Mock } from 'bun:test';

export class MockPlatformAdapter implements IPlatformAdapter {
  public sendMessage: Mock<(conversationId: string, message: string) => Promise<void>> = mock(() =>
    Promise.resolve()
  );
  public getStreamingMode: Mock<() => 'stream' | 'batch'> = mock(() => 'stream' as const);
  public getPlatformType: Mock<() => string> = mock(() => 'mock');
  public start: Mock<() => Promise<void>> = mock(() => Promise.resolve());
  public stop: Mock<() => void> = mock(() => undefined);

  public reset(): void {
    this.sendMessage.mockClear();
    this.getStreamingMode.mockClear();
    this.getPlatformType.mockClear();
    this.start.mockClear();
    this.stop.mockClear();
  }
}

export const createMockPlatform = (): MockPlatformAdapter => new MockPlatformAdapter();
