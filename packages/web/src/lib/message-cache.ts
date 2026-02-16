import type { ChatMessage } from '@/lib/types';

const messageCache = new Map<string, ChatMessage[]>();

export function getCachedMessages(id: string): ChatMessage[] {
  return messageCache.get(id) ?? [];
}

export function setCachedMessages(id: string, msgs: ChatMessage[]): void {
  messageCache.set(id, msgs);
}
