import { readFileSync } from "node:fs";

/**
 * Shared fixtures for the attempt-progress tests: the captured Hekate plan view plus
 * synthetic events and trace pages built around its running node. Every forbidden value is
 * a distinct SECRET_* sentinel so a leak names its source.
 */
export const RAW_PLAN = readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8");
export const ROOT = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
export const RUNNING = "49262a8f-dcae-4e0e-a900-9a1870d38ecb";
export const READY = "77ad2c95-f8c6-43fe-9831-50bc67287f87";
export const V = "plan-contract/v1";

type Plan = { nodes: Record<string, unknown>[] } & Record<string, unknown>;
const parsed = JSON.parse(RAW_PLAN) as Plan;
const running = parsed.nodes.find((n) => n.id === RUNNING)!;
export const ATTEMPT = running.attemptId as string;
export const EPOCH = running.attemptEpoch as number;

export const SECRETS = {
  thinking: "SECRET_THINKING",
  redactedThinking: "SECRET_REDACTED_THINKING",
  toolInput: "SECRET_TOOL_INPUT",
  toolResult: "SECRET_TOOL_RESULT",
  user: "SECRET_USER_MESSAGE",
  system: "SECRET_SYSTEM_PROMPT",
  result: "SECRET_RESULT_STRING",
  stderr: "SECRET_STDERR",
  hekate: "SECRET_HEKATE_DIAGNOSTIC",
  cut: "SECRET_CUT_RECORD",
  redacted: "SECRET_REDACTED_RECORD",
  fragment: "SECRET_FRAGMENT_A",
  fragmentTail: "SECRET_FRAGMENT_B",
  malformed: "SECRET_MALFORMED",
  toolName: "SECRET_TOOL_NAME",
  prompt: "SECRET_PROMPT",
  claimKey: "SECRET_CLAIM_KEY",
  reason: "SECRET_TRACE_REASON",
  killReason: "SECRET_KILL_REASON",
  eventPayload: "SECRET_EVENT_PAYLOAD",
  nodeName: "SECRET_NODE_NAME",
  nodeValue: "SECRET_NODE_VALUE",
  executor: "SECRET_EXECUTOR_REF",
  artifact: "SECRET_ARTIFACT_REF",
  decisionArtifact: "SECRET_DECISION_ARTIFACT",
  evidence: "SECRET_EVIDENCE_REF",
  decidedBy: "SECRET_DECIDED_BY",
  nested: "SECRET_NESTED_MESSAGE"
} as const;

export const claude = {
  assistant: (content: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content },
      session_id: "s1",
      ...extra
    }),
  text: (text: string) => ({ type: "text", text }),
  tool: (name: string, input: unknown = { command: SECRETS.toolInput }) => ({
    type: "tool_use",
    id: "toolu_1",
    name,
    input
  })
};

export interface TraceRecordSpec {
  stream?: "stdout" | "stderr" | "hekate";
  text: string;
  cut?: boolean;
  redacted?: boolean;
}

export const traceRecords = (specs: TraceRecordSpec[]) =>
  specs.map((s, seq) => ({
    seq,
    tMs: seq * 10,
    stream: s.stream ?? "stdout",
    text: s.text,
    cut: s.cut ?? false,
    redacted: s.redacted ?? false
  }));

export function planBody(edit?: (node: Record<string, unknown>, plan: Plan) => void): string {
  const p = JSON.parse(RAW_PLAN) as Plan;
  const node = p.nodes.find((n) => n.id === RUNNING)!;
  edit?.(node, p);
  const leaf = (p.readiness as { leaves: Record<string, unknown>[] }).leaves.find(
    (l) => l.nodeId === RUNNING
  );
  if (leaf) for (const k of ["name", "work", "attemptId", "attemptEpoch"]) leaf[k] = node[k];
  return JSON.stringify(p);
}

export interface UpstreamOptions {
  records: ReturnType<typeof traceRecords>;
  plan?: string;
  traceExtra?: Record<string, unknown>;
  eventExtra?: Record<string, unknown>;
}

export const eventsPath = (n: string) => `/api/plan-contract/v1/nodes/${n}/events?afterSeq=0`;
export const tracePath = (n: string, a: string) =>
  `/api/plan-contract/v1/nodes/${n}/attempts/${encodeURIComponent(a)}/trace`;
export const planPath = `/api/plan-contract/v1/plans/${ROOT}`;

/** The four GETs of one observation of the running node, answered from fixtures. */
export function upstreamBodies(options: UpstreamOptions): (path: string) => string | undefined {
  const plan = options.plan ?? planBody();
  return (path) => {
    if (path === planPath) return plan;
    if (path === eventsPath(RUNNING))
      return JSON.stringify({
        contractVersion: V,
        events: [
          {
            seq: 3,
            nodeId: RUNNING,
            nodeStateRevision: 1,
            kind: "attempt_started",
            attemptId: ATTEMPT,
            attemptEpoch: EPOCH,
            claimKey: SECRETS.claimKey,
            payload: SECRETS.eventPayload,
            ...options.eventExtra
          }
        ],
        nextAfterSeq: null,
        historyStartsAtSeq: 1,
        historyBackfilled: false
      });
    if (path === tracePath(RUNNING, ATTEMPT))
      return JSON.stringify({
        contractVersion: V,
        nodeId: RUNNING,
        attemptId: ATTEMPT,
        attemptEpoch: EPOCH,
        claimKey: SECRETS.claimKey,
        status: "running",
        reason: SECRETS.reason,
        integrity: "verified",
        executionKind: "agent",
        exit: { code: 0, killReason: SECRETS.killReason },
        prompt: { text: SECRETS.prompt, bytes: SECRETS.prompt.length },
        records: options.records,
        nextAfterSeq: null,
        capped: false,
        ...options.traceExtra
      });
    return undefined;
  };
}
