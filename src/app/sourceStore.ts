import { createHash } from "node:crypto";
import type { SourceRef } from "../domain/context";
import type { ChatTimelineEvent } from "../domain/types";

export const contentHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
export interface SourceRecord {
  source: SourceRef;
  text: string;
  sequence: number;
  provenance: "user-stated" | "assistant-claimed";
}
export interface SourceSnapshot {
  conversationId: string;
  records: readonly SourceRecord[];
}
export interface SourceStore {
  forgetConversation?(conversationId: string): void;
  retentionStats?(): { entries: number };
  capture(conversationId: string, events: readonly ChatTimelineEvent[]): SourceSnapshot;
  resolve(
    ref: SourceRef,
    snapshot: SourceSnapshot
  ): { source: SourceRef; text: string } | undefined;
}
/** Internal only: ChatService checks conversation ownership before preparation.
 * Capture reflects retention/deletion; previously seen IDs can never change content. */
export class InMemorySourceStore implements SourceStore {
  private readonly originals = new Map<string, string>();
  retentionStats() {
    return { entries: this.originals.size };
  }
  forgetConversation(conversationId: string) {
    for (const key of this.originals.keys())
      if (JSON.parse(key)[0] === conversationId) this.originals.delete(key);
  }
  capture(conversationId: string, events: readonly ChatTimelineEvent[]): SourceSnapshot {
    const records: SourceRecord[] = [];
    for (const e of events) {
      if (
        !e.eventId ||
        !e.messageId ||
        e.sequence === undefined ||
        !["user", "provisional", "refined"].includes(e.type)
      )
        continue;
      const hash = contentHash(e.text),
        key = JSON.stringify([conversationId, e.eventId]);
      const canonical = JSON.stringify([e.messageId, e.sequence, e.type, hash]);
      const prior = this.originals.get(key);
      if (prior !== undefined && prior !== canonical) continue;
      this.originals.set(key, canonical);
      records.push({
        source: { conversationId, eventId: e.eventId, messageId: e.messageId, contentHash: hash },
        text: e.text,
        sequence: e.sequence,
        provenance: e.type === "user" ? "user-stated" : "assistant-claimed"
      });
    }
    return structuredClone({ conversationId, records });
  }
  resolve(ref: SourceRef, snapshot: SourceSnapshot) {
    if (ref.conversationId !== snapshot.conversationId) return undefined;
    const original = this.originals.get(JSON.stringify([ref.conversationId, ref.eventId]));
    if (!original || JSON.parse(original)[3] !== ref.contentHash) return undefined;
    const record = snapshot.records.find(
      (r) =>
        r.source.eventId === ref.eventId &&
        r.source.messageId === ref.messageId &&
        r.source.contentHash === ref.contentHash &&
        contentHash(r.text) === ref.contentHash
    );
    return record ? { source: structuredClone(ref), text: record.text } : undefined;
  }
}
export function resolveSources(
  refs: readonly SourceRef[],
  snapshot: SourceSnapshot,
  store: SourceStore,
  allowance: number
) {
  const resolved: { source: SourceRef; text: string }[] = [],
    unavailable: SourceRef[] = [];
  for (const ref of refs.slice(0, 4)) {
    const result = store.resolve(ref, snapshot);
    const cost = result ? Buffer.byteLength(JSON.stringify(result)) : Infinity;
    if (!result || cost > allowance) unavailable.push(structuredClone(ref));
    else {
      resolved.push(result);
      allowance -= cost;
    }
  }
  return { resolved, unavailable };
}
