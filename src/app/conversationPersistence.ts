import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { scopedOwnerKey } from "../auth/authenticator";
import { GenerationError } from "../domain/generation";
import { ChatService, conversationIdentitySnapshotSchema } from "./chatService";
import {
  InMemoryConversationTimelineStore,
  conversationTimelineSnapshotSchema,
  type ConversationTimelineSnapshot
} from "./timelineStore";
import { protocolConversationBindingSchema, type ProtocolConversationBinding } from "./protocolV1";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const snapshotSchema = z
  .object({
    version: z.literal(1),
    timeline: conversationTimelineSnapshotSchema,
    identities: conversationIdentitySnapshotSchema,
    protocolBindings: z.array(protocolConversationBindingSchema)
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;

/**
 * Optional local conversation persistence. One application instance owns the file.
 * Atomic synchronous snapshots include every streaming append; large histories incur
 * write amplification. Provider processes, queues, credentials and leases are not saved.
 */
export class ConversationPersistence {
  private bindings: ProtocolConversationBinding[] = [];
  private closed = false;
  constructor(
    private readonly filePath: string,
    private readonly timeline: InMemoryConversationTimelineStore,
    private readonly service: ChatService
  ) {
    try {
      if (existsSync(filePath)) {
        const info = lstatSync(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SNAPSHOT_BYTES)
          throw new GenerationError("CONVERSATION_PERSISTENCE_INVALID", false);
        const bytes = readFileSync(filePath);
        if (bytes.byteLength > MAX_SNAPSHOT_BYTES)
          throw new GenerationError("CONVERSATION_PERSISTENCE_INVALID", false);
        const saved = snapshotSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
        this.validate(saved);
        const restored = this.interrupted(saved.timeline as ConversationTimelineSnapshot);
        this.timeline.restoreSnapshot(restored);
        this.service.restoreSnapshot(saved.identities);
        this.bindings = structuredClone(saved.protocolBindings);
      }
    } catch {
      throw new GenerationError(
        "CONVERSATION_PERSISTENCE_INVALID",
        false,
        "Saved conversations could not be restored. The existing file was preserved."
      );
    }
    this.timeline.setPersistenceHook(() => this.flush());
    this.service.setPersistenceHook(() => this.flush());
    try {
      this.flush();
    } catch (error) {
      this.timeline.setPersistenceHook(undefined);
      this.service.setPersistenceHook(undefined);
      throw error;
    }
  }

  private validate(snapshot: Snapshot) {
    const rows = new Map(snapshot.timeline.conversations.map((row) => [row.id, row]));
    const owners = new Map(snapshot.identities.owners);
    const scopes = new Map(snapshot.identities.scopes);
    if (
      rows.size !== snapshot.timeline.conversations.length ||
      owners.size !== snapshot.identities.owners.length ||
      scopes.size !== snapshot.identities.scopes.length ||
      rows.size > this.timeline.maxConversationIdentities ||
      [...owners.keys()].some((id) => !rows.has(id)) ||
      [...rows].some(([id, row]) => row.events.length > 0 && !owners.has(id)) ||
      [...scopes.keys()].some((id) => !owners.has(id) || rows.get(id)?.expired)
    )
      throw new GenerationError("CONVERSATION_PERSISTENCE_INVALID", false);
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (const binding of snapshot.protocolBindings) {
      const key = JSON.stringify([
        binding.principalId,
        binding.accountId,
        binding.projectId,
        binding.conversationId
      ]);
      if (
        keys.has(key) ||
        ids.has(binding.internalId) ||
        !rows.has(binding.internalId) ||
        owners.get(binding.internalId) !==
          scopedOwnerKey(binding.principalId, [binding.accountId, binding.projectId])
      )
        throw new GenerationError("CONVERSATION_PERSISTENCE_INVALID", false);
      keys.add(key);
      ids.add(binding.internalId);
    }
  }

  private interrupted(snapshot: ConversationTimelineSnapshot): ConversationTimelineSnapshot {
    const restored = structuredClone(snapshot);
    for (const row of restored.conversations) {
      if (row.expired) continue;
      const phases = new Map<
        string,
        {
          messageId: string;
          phase: "fast" | "deep";
          attemptId?: string;
          taskId?: string;
          complete: boolean;
        }
      >();
      for (const event of row.events) {
        if (!event.messageId) continue;
        const phase = event.phase ?? "fast";
        const key = JSON.stringify([event.messageId, phase]);
        const previous = phases.get(key);
        phases.set(key, {
          messageId: event.messageId,
          phase,
          attemptId: event.attemptId,
          taskId: event.taskId,
          complete:
            event.type === "terminal"
              ? !event.retrying
              : event.type === "activity" || event.type === "delta" || event.type === "user"
                ? false
                : (previous?.complete ?? false)
        });
      }
      for (const phase of phases.values()) {
        if (phase.complete) continue;
        row.sequence++;
        row.events.push({
          type: "terminal",
          text: "This response was interrupted by an application restart. Submit a new message to continue.",
          createdAtIso: new Date().toISOString(),
          eventId: randomUUID(),
          sequence: row.sequence,
          messageId: phase.messageId,
          phase: phase.phase,
          attemptId: phase.attemptId,
          taskId: phase.taskId,
          finishReason: "error",
          processingStatus: "incomplete",
          retrying: false,
          errorCode: "RUNTIME_RESTARTED"
        });
      }
    }
    return restored;
  }

  protocolBindings(): ProtocolConversationBinding[] {
    return structuredClone(this.bindings);
  }

  setProtocolBindings(bindings: readonly ProtocolConversationBinding[]) {
    const previous = this.bindings;
    this.bindings = z.array(protocolConversationBindingSchema).parse(bindings);
    try {
      this.flush();
    } catch (error) {
      this.bindings = previous;
      throw error;
    }
  }

  flush() {
    if (this.closed) throw new GenerationError("CONVERSATION_PERSISTENCE_CLOSED", false);
    const timeline = this.timeline.exportSnapshot();
    const known = new Map(timeline.conversations.map((row) => [row.id, row]));
    const identities = this.service.exportSnapshot();
    // Coordinated retirement removes the timeline before the service's owner map.
    identities.owners = identities.owners.filter(([id]) => known.has(id));
    identities.scopes = identities.scopes.filter(
      ([id]) => known.has(id) && !known.get(id)!.expired
    );
    const snapshot = snapshotSchema.parse({
      version: 1,
      timeline,
      identities,
      protocolBindings: this.bindings.filter((binding) => known.has(binding.internalId))
    });
    this.validate(snapshot);
    const encoded = JSON.stringify(snapshot);
    if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES)
      throw new GenerationError(
        "CONVERSATION_PERSISTENCE_CAPACITY",
        false,
        "Saved conversation history exceeds the local storage limit."
      );
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      if (existsSync(this.filePath) && !lstatSync(this.filePath).isFile())
        throw new Error("invalid target");
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, encoded, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
    } catch {
      throw new GenerationError(
        "CONVERSATION_PERSISTENCE_UNAVAILABLE",
        false,
        "Conversation history could not be saved."
      );
    } finally {
      try {
        if (descriptor !== undefined) closeSync(descriptor);
      } catch {
        /* Keep the stable write error. */
      }
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        /* Keep the stable write error. */
      }
    }
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.timeline.setPersistenceHook(undefined);
    this.service.setPersistenceHook(undefined);
    this.closed = true;
  }
}
