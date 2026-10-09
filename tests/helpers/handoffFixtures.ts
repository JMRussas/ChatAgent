import {
  ATTENTION_FORBIDDEN,
  type Attention,
  type AttentionItem
} from "../../src/integrations/hekate/checkpointAttention";
import { FENCE, RUN_ID, STAMP } from "./checkpointFixtures";

/** One valid tripwire attention item; override fields per test. */
export const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: "stopped_tripwire",
  rootId: FENCE.rootId,
  nodeId: FENCE.nodeId,
  fence: { attemptId: "at-1", attemptEpoch: 2, contentRevision: 3 },
  runId: RUN_ID,
  stop: { kind: "tripwire", code: "hard_wall" },
  recordState: "ended",
  recordUpdatedAt: STAMP,
  rootPid: null,
  gateSourceRef: null,
  taskState: "in_progress",
  taskListed: true,
  attribution: "unattributed",
  action: "decide_new_attempt_or_discard",
  trust: "supplied_not_authenticated",
  writerLiveness: "unknown",
  ...over
});

export const attentionOf = (...items: AttentionItem[]): Attention => ({
  items,
  omitted: 0,
  registeredRecordsUnavailable: 1,
  basis: "supplied_records",
  automaticAllowed: false,
  forbidden: ATTENTION_FORBIDDEN
});
