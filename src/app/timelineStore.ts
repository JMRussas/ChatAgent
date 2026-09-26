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
  private readonly eventsByConversation = new Map<string, ChatTimelineEvent[]>();
  private readonly sequenceByConversation = new Map<string, number>();

  async appendEvent(conversationId: string, event: ChatTimelineEvent): Promise<void> {
    const events = this.eventsByConversation.get(conversationId) ?? [];
    const sequence = (this.sequenceByConversation.get(conversationId) ?? 0) + 1;
    this.sequenceByConversation.set(conversationId, sequence);
    events.push(structuredClone({ ...event, eventId: event.eventId ?? randomUUID(), sequence }));
    this.eventsByConversation.set(conversationId, events);
  }

  async getEvents(conversationId: string): Promise<ChatTimelineEvent[]> {
    return structuredClone(this.eventsByConversation.get(conversationId) ?? []);
  }
}
