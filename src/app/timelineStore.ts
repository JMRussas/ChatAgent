import {
  loadConversationRetention,
  conversationRetentionSchema,
  type ConversationRetention
} from "../config/conversationRetention";
import { GenerationError } from "../domain/generation";
import { randomUUID } from "node:crypto";
import type { ChatTimelineEvent } from "../domain/types";

export interface ConversationTimelineStore {
  reserveTerminal?(
    conversationId: string,
    identity: ChatTimelineEvent
  ): (event: ChatTimelineEvent) => Promise<void>;
  retainConversation?(conversationId: string): () => void;
  assertConversationAvailable?(conversationId: string): void;
  onConversationExpired?(listener: (conversationId: string) => void): void;
  readonly maxConversationIdentities?: number;
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

/** Owns history and bounded expired-ID tombstones. Live writers must hold a lease.
 * Expiry never allows an old identity to be reused during this process lifetime. */
export class InMemoryConversationTimelineStore implements ConversationTimelineStore {
  private readonly records = new Map<
    string,
    {
      events: ChatTimelineEvent[];
      bytes: number;
      sequence: number;
      at: number;
      pins: number;
      expired: boolean;
      terminalReservations: number;
    }
  >();
  private readonly listeners: ((id: string) => void)[] = [];
  private readonly retention: ConversationRetention;
  constructor(
    private readonly observer?: (conversationId: string, event: ChatTimelineEvent) => void,
    retention: ConversationRetention = loadConversationRetention(),
    private readonly clock = Date.now
  ) {
    this.retention = conversationRetentionSchema.parse(retention);
  }
  get maxConversationIdentities() {
    return this.retention.maxIdentities;
  }
  onConversationExpired(listener: (id: string) => void) {
    this.listeners.push(listener);
  }
  private expire(
    id: string,
    record: { events: ChatTimelineEvent[]; bytes: number; expired: boolean }
  ) {
    record.events = [];
    record.bytes = 0;
    record.expired = true;
    for (const listener of this.listeners) listener(id);
  }
  private prune() {
    for (const [id, r] of this.records) {
      if (!r.expired && !r.pins && this.clock() - r.at >= this.retention.idleTtlMs)
        this.expire(id, r);
    }
  }
  assertConversationAvailable(id: string) {
    this.prune();
    if (this.records.get(id)?.expired) throw new GenerationError("CONVERSATION_EXPIRED", false);
  }
  private ensure(id: string) {
    this.assertConversationAvailable(id);
    let record = this.records.get(id);
    if (record) return record;
    if (this.records.size >= this.retention.maxIdentities)
      throw new GenerationError("CONVERSATION_CAPACITY", false);
    const live = [...this.records].filter(([, r]) => !r.expired);
    if (live.length >= this.retention.maxHistories) {
      const oldest = live.filter(([, r]) => !r.pins).sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) throw new GenerationError("CONVERSATION_CAPACITY", false);
      this.expire(...oldest);
    }
    record = {
      events: [],
      bytes: 0,
      sequence: 0,
      at: this.clock(),
      pins: 0,
      expired: false,
      terminalReservations: 0
    };
    this.records.set(id, record);
    return record;
  }
  retainConversation(id: string) {
    const record = this.ensure(id);
    record.pins++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.pins--;
      if (!record.pins) record.at = this.clock();
    };
  }
  // Separate bounded emergency budget: at most maxEvents compact terminals,
  // each at most 1024 serialized bytes, for admitted generation attempts.
  reserveTerminal(id: string, identity: ChatTimelineEvent) {
    const record = this.ensure(id);
    const base = { ...identity, text: "", eventId: randomUUID() };
    if (
      record.terminalReservations >= this.retention.maxEvents ||
      Buffer.byteLength(JSON.stringify(base)) > 768
    )
      throw new GenerationError("CONVERSATION_HISTORY_CAPACITY", false);
    record.terminalReservations++;
    let used = false;
    return async (event: ChatTimelineEvent) => {
      if (used) return;
      const stored = {
        ...base,
        sequence: record.sequence + 1,
        createdAtIso: new Date().toISOString(),
        finishReason: event.finishReason,
        retrying: false,
        errorCode: "CONVERSATION_HISTORY_CAPACITY"
      };
      used = true;
      record.sequence++;
      record.events.push(stored);
      record.bytes += Buffer.byteLength(JSON.stringify(stored));
      record.at = this.clock();
      try {
        this.observer?.(id, structuredClone(stored));
      } catch {
        /* Passive observer. */
      }
    };
  }
  retentionStats() {
    this.prune();
    const rows = [...this.records.values()];
    return {
      identities: rows.length,
      histories: rows.filter((r) => !r.expired).length,
      expired: rows.filter((r) => r.expired).length,
      pins: rows.reduce((n, r) => n + r.pins, 0),
      events: rows.reduce((n, r) => n + r.events.length, 0),
      bytes: rows.reduce((n, r) => n + r.bytes, 0)
    };
  }
  async appendEvent(conversationId: string, event: ChatTimelineEvent): Promise<void> {
    const record = this.ensure(conversationId);
    const stored = structuredClone({
      ...event,
      eventId: event.eventId ?? randomUUID(),
      sequence: record.sequence + 1
    });
    const bytes = Buffer.byteLength(JSON.stringify(stored));
    if (
      record.events.length >= this.retention.maxEvents ||
      record.bytes + bytes > this.retention.maxBytes
    )
      throw new GenerationError("CONVERSATION_HISTORY_CAPACITY", false);
    record.sequence++;
    record.events.push(stored);
    record.bytes += bytes;
    record.at = this.clock();
    try {
      this.observer?.(conversationId, structuredClone(stored));
    } catch {
      /* Passive observer. */
    }
  }
  async getEvents(conversationId: string): Promise<ChatTimelineEvent[]> {
    this.assertConversationAvailable(conversationId);
    return structuredClone(this.records.get(conversationId)?.events ?? []);
  }
}
