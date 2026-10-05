import {
  deadLetterRetentionSchema,
  loadDeadLetterRetention,
  type DeadLetterRetention
} from "../config/deadLetterRetention";
import { GenerationError } from "../domain/generation";
import type { DeepTask } from "../domain/types";

export interface DeadLetterRecord {
  task: DeepTask;
  errorMessage: string;
  failedAtIso: string;
}

export interface DeadLetterStore {
  add(record: DeadLetterRecord): Promise<void>;
  list(): Promise<DeadLetterRecord[]>;
  remove(taskId: string): Promise<DeadLetterRecord | undefined>;
  /**
   * Optional bounded-admission contract. A store without it gives no capacity
   * guarantee. Reserves failure room for a task before it is queued, or throws
   * `DEAD_LETTER_CAPACITY`; repeated calls for one task hold a single slot.
   * The in-memory store owns a task snapshot; add() publishes that admitted task,
   * not subsequent mutations to the caller's or replay worker's copy.
   */
  reserve?(task: DeepTask): void;
  /** Frees a reservation once the task settles; a no-op after it became a record. */
  release?(taskId: string): void;
  /** Removes a record for replay while keeping its slot, so a failed replay can be restored. */
  claim?(taskId: string): Promise<DeadLetterRecord | undefined>;
  retentionStats?(): DeadLetterRetentionStats;
  /** Records plus reservations whose task belongs to the conversation. Identity
   * retirement refuses while this is nonzero or the store cannot answer. */
  conversationReferences?(conversationId: string): number;
}

export interface DeadLetterRetentionStats extends DeadLetterRetention {
  records: number;
  reservations: number;
  bytes: number;
  reservedBytes: number;
}

export class NoopDeadLetterStore implements DeadLetterStore {
  async add(_record: DeadLetterRecord): Promise<void> {
    return;
  }

  async list(): Promise<DeadLetterRecord[]> {
    return [];
  }

  async remove(_taskId: string): Promise<DeadLetterRecord | undefined> {
    return undefined;
  }

  conversationReferences(_conversationId: string): number {
    return 0;
  }
}

/** Owns failed-task records and the slots reserved for admitted deep work.
 * Records plus reservations never exceed the configured count and serialized
 * task bytes. Nothing expires or is evicted: a record is the only replayable
 * trace of work whose external execution is uncertain, so it leaves only by
 * explicit replay or discard. A full store rejects new reservations instead. */
export class InMemoryDeadLetterStore implements DeadLetterStore {
  private readonly records = new Map<string, { record: DeadLetterRecord; bytes: number }>();
  private readonly reservations = new Map<string, { task: DeepTask; bytes: number }>();
  private readonly retention: DeadLetterRetention;
  private bytes = 0;
  private reservedBytes = 0;

  constructor(retention: DeadLetterRetention = loadDeadLetterRetention()) {
    this.retention = deadLetterRetentionSchema.parse(retention);
  }

  private assertRoom(bytes: number) {
    if (
      this.records.size + this.reservations.size >= this.retention.maxRecords ||
      this.bytes + this.reservedBytes + bytes > this.retention.maxBytes
    )
      throw new GenerationError("DEAD_LETTER_CAPACITY", false);
  }

  private unreserve(taskId: string) {
    const reservation = this.reservations.get(taskId);
    if (!reservation) return undefined;
    this.reservations.delete(taskId);
    this.reservedBytes -= reservation.bytes;
    return reservation;
  }

  private take(taskId: string) {
    const stored = this.records.get(taskId);
    if (!stored) return undefined;
    this.records.delete(taskId);
    this.bytes -= stored.bytes;
    return stored;
  }

  reserve(task: DeepTask) {
    if (this.reservations.has(task.taskId) || this.records.has(task.taskId)) return;
    const snapshot = structuredClone(task);
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    this.assertRoom(bytes);
    this.reservations.set(task.taskId, { task: snapshot, bytes });
    this.reservedBytes += bytes;
  }

  release(taskId: string) {
    this.unreserve(taskId);
  }

  async add(record: DeadLetterRecord): Promise<void> {
    const taskId = record.task.taskId;
    const reservation = this.reservations.get(taskId);
    const previous = this.records.get(taskId);
    // Admitted work always retains the task that was reserved, even if a provider
    // or replay caller mutated its copy. Recording failure must still fit its slot.
    const snapshot = structuredClone({ ...record, task: reservation?.task ?? record.task });
    const bytes = Buffer.byteLength(JSON.stringify(snapshot.task));
    if (!reservation && !previous) this.assertRoom(bytes);
    else if (
      this.bytes + this.reservedBytes - (reservation?.bytes ?? previous!.bytes) + bytes >
      this.retention.maxBytes
    )
      throw new GenerationError("DEAD_LETTER_CAPACITY", false);
    // Validate and clone before changing accounting: a rejected replacement is atomic.
    this.unreserve(taskId);
    this.take(taskId);
    this.records.set(taskId, { record: snapshot, bytes });
    this.bytes += bytes;
  }

  async list(): Promise<DeadLetterRecord[]> {
    return [...this.records.values()].map((stored) => structuredClone(stored.record));
  }

  async remove(taskId: string): Promise<DeadLetterRecord | undefined> {
    return this.take(taskId)?.record;
  }

  async claim(taskId: string): Promise<DeadLetterRecord | undefined> {
    const stored = this.take(taskId);
    if (!stored) return undefined;
    this.reservations.set(taskId, { task: stored.record.task, bytes: stored.bytes });
    this.reservedBytes += stored.bytes;
    return structuredClone(stored.record);
  }

  conversationReferences(conversationId: string): number {
    const owned = (task: DeepTask) => task.conversationId === conversationId;
    return (
      [...this.records.values()].filter((stored) => owned(stored.record.task)).length +
      [...this.reservations.values()].filter((reserved) => owned(reserved.task)).length
    );
  }

  retentionStats(): DeadLetterRetentionStats {
    return {
      ...this.retention,
      records: this.records.size,
      reservations: this.reservations.size,
      bytes: this.bytes,
      reservedBytes: this.reservedBytes
    };
  }
}
