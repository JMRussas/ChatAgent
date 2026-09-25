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
}

export class InMemoryDeadLetterStore implements DeadLetterStore {
  private readonly records: DeadLetterRecord[] = [];

  async add(record: DeadLetterRecord): Promise<void> {
    this.records.push(record);
  }

  async list(): Promise<DeadLetterRecord[]> {
    return [...this.records];
  }

  async remove(taskId: string): Promise<DeadLetterRecord | undefined> {
    const index = this.records.findIndex((r) => r.task.taskId === taskId);
    if (index < 0) return undefined;

    const [record] = this.records.splice(index, 1);
    return record;
  }
}
