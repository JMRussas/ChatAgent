import {
  loadConversationRetention,
  conversationRetentionSchema,
  type ConversationRetention
} from "../config/conversationRetention";
import { GenerationError } from "../domain/generation";
import { randomUUID } from "node:crypto";
import type { ChatTimelineEvent } from "../domain/types";
import { z } from "zod";

const persistedEventSchema = z
  .object({
    type: z.enum(["user", "provisional", "refined", "activity", "delta", "terminal"]),
    text: z.string(),
    createdAtIso: z.string().datetime(),
    eventId: z.string().min(1),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    messageId: z.string().min(1).optional(),
    phase: z.enum(["fast", "deep"]).optional(),
    attemptId: z.string().optional(),
    taskId: z.string().optional(),
    retrying: z.boolean().optional(),
    finishReason: z.enum(["stop", "length", "cancelled", "error"]).optional(),
    processingStatus: z
      .enum(["provisional", "complete", "incomplete", "cancelled", "failed"])
      .optional(),
    activity: z
      .enum(["queued", "thinking", "running", "generating", "retrying", "failed"])
      .optional(),
    routeDecision: z.enum(["direct", "deep", "clarify"]).optional(),
    answerKind: z.enum(["acknowledgment", "substantive"]).optional(),
    errorCode: z.string().optional(),
    model: z
      .object({
        provider: z.string(),
        model: z.string(),
        reasoningEnabled: z.boolean().optional(),
        bindingId: z.string().optional(),
        task: z.string().optional(),
        selection: z.unknown().optional()
      })
      .strict()
      .optional(),
    answerReferences: z.unknown().optional(),
    groundedAnswer: z.unknown().optional(),
    contextBudget: z.unknown().optional(),
    roleExecution: z.unknown().optional(),
    payloadResults: z.unknown().optional(),
    attachedReferences: z.unknown().optional(),
    selectedContext: z.unknown().optional(),
    runControls: z.unknown().optional(),
    capabilityPlan: z.unknown().optional(),
    applicationResult: z
      .object({ tool: z.string().min(1).max(500), result: z.unknown() })
      .strict()
      .optional(),
    selections: z.unknown().optional()
  })
  .strict();
export const conversationTimelineSnapshotSchema = z
  .object({
    version: z.literal(1),
    conversations: z.array(
      z
        .object({
          id: z.string().min(1).max(4096),
          events: z.array(persistedEventSchema),
          sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          at: z.number().int().nonnegative().max(8640000000000000),
          expired: z.boolean(),
          expiredAt: z.number().int().nonnegative().max(8640000000000000).optional()
        })
        .strict()
    )
  })
  .strict();
export interface ConversationTimelineSnapshot {
  version: 1;
  conversations: {
    id: string;
    events: ChatTimelineEvent[];
    sequence: number;
    at: number;
    expired: boolean;
    expiredAt?: number;
  }[];
}

export interface ConversationTimelineStore {
  /** Directory metadata only; reading it neither copies full histories nor renews idle retention. */
  conversationSummaries?(): ConversationSummary[];
  reserveTerminal?(
    conversationId: string,
    identity: ChatTimelineEvent
  ): (event: ChatTimelineEvent) => Promise<void>;
  retainConversation?(conversationId: string): () => void;
  assertConversationAvailable?(conversationId: string): void;
  onConversationExpired?(listener: (conversationId: string) => void): void;
  readonly maxConversationIdentities?: number;
  /**
   * Optional identity-retirement contract. A store without it never releases an
   * identity. Retirement deletes the tombstone of an expired conversation, so the
   * ID becomes unknown and a later request with it starts unrelated work. Callers
   * must first clear everything else that references the conversation; see
   * `ChatService.retireConversation`.
   */
  conversationState?(conversationId: string): "live" | "expired" | undefined;
  /** Opaque incarnation token; changes when a retired ID is reused. */
  conversationVersion?(conversationId: string): symbol | undefined;
  expiredConversations?(): { conversationId: string; expiredAtIso: string }[];
  /** True when an expired tombstone was deleted; live or unknown IDs are untouched. */
  retireConversation?(conversationId: string): boolean;
  appendEvent(conversationId: string, event: ChatTimelineEvent): Promise<void>;
  getEvents(conversationId: string): Promise<ChatTimelineEvent[]>;
  /**
   * Optional: copies of only the events after a sequence, with the same availability
   * and access semantics as getEvents. Callers fall back to getEvents when absent.
   * With maxBytes, events are admitted in order while the serialized sizes copied
   * stay within it; the first event is always admitted, so one read copies at most
   * max(maxBytes, the first event's size).
   */
  getEventsAfter?(
    conversationId: string,
    afterSequence: number,
    maxBytes?: number
  ): Promise<ChatTimelineEvent[]>;
  /**
   * Optional: the last assigned sequence (0 if none), checked like getEvents, copying
   * nothing. A store that implements it keeps each conversation version append-only:
   * stored events never change, and the sequence grows with every append, so an
   * unchanged sequence within one version means an unchanged timeline.
   */
  lastSequence?(conversationId: string): number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  lastActivityAt: string;
  status: "ready" | "running" | "needs_attention" | "expired";
}

/** A read budget must be a positive safe integer; anything else is a caller error. */
export function assertReadBudget(maxBytes: number | undefined) {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
    throw new RangeError(`Read budget must be a positive integer; got ${String(maxBytes)}.`);
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
 * Expiry alone never allows an old identity to be reused: the tombstone stays
 * until an operator explicitly retires it through the coordinated service path. */
export class InMemoryConversationTimelineStore implements ConversationTimelineStore {
  conversationSummaries(): ConversationSummary[] {
    this.prune();
    return [...this.records].map(([id, row]) => {
      const first = row.events.find((event) => event.type === "user");
      const last = row.events.at(-1);
      const phases = new Map<string, boolean>();
      for (const event of row.events) {
        if (!event.messageId) continue;
        const key = JSON.stringify([event.messageId, event.phase ?? "fast"]);
        if (event.type === "terminal") phases.set(key, !!event.retrying);
        else if (event.type === "user" || event.type === "activity" || event.type === "delta")
          phases.set(key, true);
        else if (event.processingStatus === "complete") phases.set(key, false);
      }
      const recent = [...row.events]
        .reverse()
        .find((event) => ["user", "provisional", "refined", "terminal"].includes(event.type));
      return {
        id,
        title: first?.text.trim().slice(0, 120) || "New conversation",
        preview: recent?.text.slice(0, 240) ?? "",
        lastActivityAt: last?.createdAtIso ?? new Date(row.at).toISOString(),
        status: row.expired
          ? "expired"
          : [...phases.values()].some(Boolean)
            ? "running"
            : last?.type === "terminal" && ["error", "cancelled"].includes(last.finishReason ?? "")
              ? "needs_attention"
              : "ready"
      };
    });
  }
  private readonly records = new Map<
    string,
    {
      version: symbol;
      events: ChatTimelineEvent[];
      /** Serialized size of each stored event, index-aligned with events. */
      sizes: number[];
      bytes: number;
      sequence: number;
      at: number;
      pins: number;
      expired: boolean;
      expiredAt?: number;
      terminalReservations: number;
    }
  >();
  private readonly listeners: ((id: string) => void)[] = [];
  private persistenceHook?: () => void;
  /** An authoritative hook: unlike the passive observer, write failures propagate. */
  setPersistenceHook(hook: (() => void) | undefined) {
    this.persistenceHook = hook;
  }
  exportSnapshot(): ConversationTimelineSnapshot {
    return {
      version: 1,
      conversations: [...this.records].map(([id, record]) => ({
        id,
        events: structuredClone(record.events),
        sequence: record.sequence,
        at: record.at,
        expired: record.expired,
        ...(record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt })
      }))
    };
  }
  /** Startup only. Leases, terminal reservations and incarnation symbols are process-local. */
  restoreSnapshot(value: unknown) {
    const snapshot = conversationTimelineSnapshotSchema.parse(value);
    const restored = new Map<
      string,
      typeof this.records extends Map<string, infer R> ? R : never
    >();
    let live = 0;
    for (const row of snapshot.conversations) {
      const events = row.events as ChatTimelineEvent[];
      const sizes = events.map((event) => Buffer.byteLength(JSON.stringify(event)));
      const bytes = sizes.reduce((sum, size) => sum + size, 0);
      if (
        restored.has(row.id) ||
        events.some((event, index) => event.sequence !== index + 1) ||
        (row.expired
          ? events.length > 0 || row.expiredAt === undefined
          : row.sequence !== events.length || row.expiredAt !== undefined) ||
        events.length > this.retention.maxEvents * 2 ||
        bytes > this.retention.maxBytes + this.retention.maxEvents * 1024
      )
        throw new Error("CONVERSATION_SNAPSHOT_INVALID");
      if (!row.expired) live++;
      restored.set(row.id, {
        version: Symbol(row.id),
        events: structuredClone(events),
        sizes,
        bytes,
        sequence: row.sequence,
        at: row.at,
        expired: row.expired,
        expiredAt: row.expiredAt,
        pins: 0,
        terminalReservations: 0
      });
    }
    if (restored.size > this.retention.maxIdentities || live > this.retention.maxHistories)
      throw new Error("CONVERSATION_SNAPSHOT_CAPACITY");
    if ([...this.records.values()].some((record) => record.pins || record.terminalReservations))
      throw new Error("CONVERSATION_RESTORE_WHILE_ACTIVE");
    this.records.clear();
    for (const [id, record] of restored) this.records.set(id, record);
  }
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
    record: {
      events: ChatTimelineEvent[];
      sizes: number[];
      bytes: number;
      expired: boolean;
      expiredAt?: number;
    }
  ) {
    record.events = [];
    record.sizes = [];
    record.bytes = 0;
    record.expired = true;
    record.expiredAt = this.clock();
    for (const listener of this.listeners) listener(id);
    this.persistenceHook?.();
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
  conversationState(id: string) {
    this.prune();
    const record = this.records.get(id);
    return record ? (record.expired ? ("expired" as const) : ("live" as const)) : undefined;
  }
  conversationVersion(id: string) {
    return this.records.get(id)?.version;
  }
  expiredConversations() {
    this.prune();
    return [...this.records]
      .filter(([, r]) => r.expired)
      .map(([conversationId, r]) => ({
        conversationId,
        expiredAtIso: new Date(r.expiredAt ?? r.at).toISOString()
      }));
  }
  retireConversation(id: string) {
    this.prune();
    if (!this.records.get(id)?.expired) return false;
    const removed = this.records.delete(id);
    if (removed) this.persistenceHook?.();
    return removed;
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
      version: Symbol(id),
      events: [],
      sizes: [],
      bytes: 0,
      sequence: 0,
      at: this.clock(),
      pins: 0,
      expired: false,
      terminalReservations: 0
    };
    this.records.set(id, record);
    this.persistenceHook?.();
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
      if (!record.pins) {
        record.at = this.clock();
        this.persistenceHook?.();
      }
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
      // The size of the exact stored event, sequence included.
      const size = Buffer.byteLength(JSON.stringify(stored));
      record.events.push(stored);
      record.sizes.push(size);
      record.bytes += size;
      record.at = this.clock();
      this.persistenceHook?.();
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
    record.sizes.push(bytes);
    record.bytes += bytes;
    record.at = this.clock();
    this.persistenceHook?.();
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
  /** Copies only the suffix after a sequence; events are stored in sequence order. */
  async getEventsAfter(
    conversationId: string,
    afterSequence: number,
    maxBytes?: number
  ): Promise<ChatTimelineEvent[]> {
    // Checked before pruning: an invalid request changes nothing.
    assertReadBudget(maxBytes);
    this.assertConversationAvailable(conversationId);
    const record = this.records.get(conversationId);
    const events = record?.events ?? [];
    // First index whose sequence is greater than afterSequence.
    let low = 0,
      high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((events[middle].sequence ?? 0) > afterSequence) high = middle;
      else low = middle + 1;
    }
    // Admit each event before adding it; only the first may exceed the budget.
    let end = low;
    if (maxBytes === undefined) end = events.length;
    else
      for (let copied = 0; end < events.length; end++) {
        const size = record!.sizes[end];
        if (end > low && copied + size > maxBytes) break;
        copied += size;
      }
    return structuredClone(events.slice(low, end));
  }
  lastSequence(conversationId: string): number {
    this.assertConversationAvailable(conversationId);
    return this.records.get(conversationId)?.sequence ?? 0;
  }
}
