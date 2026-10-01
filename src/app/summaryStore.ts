import type { ContextMemory } from "../domain/context";
export interface SummaryStore {
  forgetConversation?(conversationId: string): void;
  get(conversationId: string): ContextMemory | null;
  compareAndSwap(conversationId: string, expectedRevision: number, memory: ContextMemory): boolean;
}
export class InMemorySummaryStore implements SummaryStore {
  private readonly memories = new Map<string, ContextMemory>();
  forgetConversation(conversationId: string) {
    this.memories.delete(conversationId);
  }
  get(conversationId: string) {
    return structuredClone(this.memories.get(conversationId) ?? null);
  }
  compareAndSwap(conversationId: string, expectedRevision: number, memory: ContextMemory) {
    if (
      (this.memories.get(conversationId)?.revision ?? 0) !== expectedRevision ||
      memory.revision !== expectedRevision + 1
    )
      return false;
    this.memories.set(conversationId, structuredClone(memory));
    return true;
  }
}
