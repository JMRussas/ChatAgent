import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseBoundedJson } from "../checkpoint/checkpointRecord";

/**
 * Trusted startup registry of runner record files for the executive overview. Paths are
 * operator-written configuration; a browser, a worker or a directory crawl never supplies one.
 * Every refusal carries the stable code below and never echoes the configured value.
 */

export const CHECKPOINT_RECORDS_ERROR = "INVALID_CHECKPOINT_RECORDS";
export const CHECKPOINT_MAX_RECORDS = 16;
const MAX_ENV_CHARS = 64 * 1024;

export class CheckpointRecordsConfigError extends Error {
  readonly code = CHECKPOINT_RECORDS_ERROR;
  constructor() {
    super(CHECKPOINT_RECORDS_ERROR);
    this.name = "CheckpointRecordsConfigError";
  }
}

export interface CheckpointRecordEntry {
  rootId: string;
  nodeId: string;
  recordPath: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const entrySchema = z
  .object({
    rootId: z.string().regex(GUID),
    nodeId: z.string().regex(GUID),
    recordPath: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => isAbsolute(value) && !/[\u0000-\u001f]/.test(value))
  })
  .strict();
const entriesSchema = z
  .array(entrySchema)
  .min(1)
  .max(CHECKPOINT_MAX_RECORDS)
  .refine(
    (entries) =>
      new Set(entries.map((e) => `${e.rootId}|${e.nodeId}`)).size === entries.length &&
      new Set(entries.map((e) => e.recordPath)).size === entries.length
  );

/** Strict validation of an already parsed registry; returns detached copies. */
export function parseCheckpointRecords(value: unknown): CheckpointRecordEntry[] {
  const parsed = entriesSchema.safeParse(value);
  if (!parsed.success) throw new CheckpointRecordsConfigError();
  return parsed.data.map((e) => ({ rootId: e.rootId, nodeId: e.nodeId, recordPath: e.recordPath }));
}

/**
 * `HEKATE_CHECKPOINT_RECORDS_JSON` needs the executive overview to be enabled. Unset leaves the
 * overview byte-identical to the unregistered contract.
 */
export function loadCheckpointRecordsConfig(
  env: NodeJS.ProcessEnv,
  overviewEnabled: boolean
): CheckpointRecordEntry[] | undefined {
  const raw = env.HEKATE_CHECKPOINT_RECORDS_JSON;
  if (raw === undefined || raw === "") return undefined;
  if (!overviewEnabled || raw.length > MAX_ENV_CHARS) throw new CheckpointRecordsConfigError();
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(raw, { maxDepth: 4 });
  } catch {
    throw new CheckpointRecordsConfigError();
  }
  return parseCheckpointRecords(parsed);
}
