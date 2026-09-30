import { randomUUID } from "node:crypto";
import type { ChatTimelineEvent } from "../domain/types";

export interface ConversationTimelineStore {
  appendEvent(conversationId: string, event: ChatTimelineEvent): Promise<void>;
  getEvents(conversationId: string): Promise<ChatTimelineEvent[]>;
}

export class NoopConversationTimelineStore implements ConversationTimelineStore {
  async appendEvent(_conversationId: string, _event: ChatTimelineEvent): Promise<void> {
    return;
  }

  async getEvents(_conversationId: string): Promise<ChatTimelineEvent[]> {
    return [];
  }
}

export class InMemoryConversationTimelineStore implements ConversationTimelineStore {
  constructor(private readonly observer?: (conversationId: string, event: ChatTimelineEvent) => void) {}
  private readonly eventsByConversation = new Map<string, ChatTimelineEvent[]>();
  private readonly sequenceByConversation = new Map<string, number>();

  async appendEvent(conversationId: string, event: ChatTimelineEvent): Promise<void> {
    const events = this.eventsByConversation.get(conversationId) ?? [];
    const sequence = (this.sequenceByConversation.get(conversationId) ?? 0) + 1;
    this.sequenceByConversation.set(conversationId, sequence);
    const stored = structuredClone({ ...event, eventId: event.eventId ?? randomUUID(), sequence });
    events.push(stored);
    this.eventsByConversation.set(conversationId, events);
    // Passive observation never alters the event or rejects an inference operation.
    try { this.observer?.(conversationId, structuredClone(stored)); } catch { /* Observer owns its failure status. */ }
  }

  async getEvents(conversationId: string): Promise<ChatTimelineEvent[]> {
    return structuredClone(this.eventsByConversation.get(conversationId) ?? []);
  }
}
