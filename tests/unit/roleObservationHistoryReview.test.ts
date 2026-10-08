import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createRoleObserver } from "../../src/integrations/hekate/roleObservation";
const root = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
const node = "49262a8f-dcae-4e0e-a900-9a1870d38ecb";
const cancelledPlan = (revision = 1) => {
  const p = JSON.parse(readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8"));
  const n = p.nodes.find((n: { id: string }) => n.id === node);
  Object.assign(n, {
    work: "cancelled",
    attemptId: null,
    attemptContentRevision: null,
    attemptPrereqDigest: null,
    contentRevision: revision
  });
  Object.assign(
    p.readiness.leaves.find((n: { nodeId: string }) => n.nodeId === node),
    { work: "cancelled", attemptId: null }
  );
  return p;
};
const events = {
  contractVersion: "plan-contract/v1",
  events: [
    {
      seq: 1,
      nodeId: node,
      nodeStateRevision: 1,
      kind: "attempt_started",
      attemptId: "fixture-attempt-1",
      attemptEpoch: 1,
      attemptContentRevision: 1,
      claimKey: "claim"
    }
  ],
  nextAfterSeq: null,
  historyStartsAtSeq: 0,
  historyBackfilled: false
};
const trace = {
  contractVersion: "plan-contract/v1",
  nodeId: node,
  attemptId: "fixture-attempt-1",
  attemptEpoch: 1,
  claimKey: "claim",
  status: "unfinished",
  reason: null,
  integrity: "unverified",
  executionKind: "langchain-role",
  exit: null,
  prompt: { text: "prompt", bytes: 6 },
  records: [
    {
      seq: 0,
      tMs: 0,
      stream: "hekate",
      text: "trace_incomplete:interrupted",
      cut: false,
      redacted: false
    }
  ],
  nextAfterSeq: null,
  capped: false
};
async function observe(revision = 1) {
  const p = cancelledPlan(revision);
  const responses = [p, events, trace, p];
  const requests: string[] = [];
  const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
    expect(options?.method).toBe("GET");
    requests.push(String(url));
    return new Response(JSON.stringify(responses.shift()));
  };
  return {
    snapshot: await createRoleObserver("http://127.0.0.1:5111", {
      fetch: fetchImpl as typeof fetch
    }).observe(root, node),
    requests
  };
}
it("retains explicitly historical trace after cancellation clears the current attempt", async () => {
  const { snapshot: s, requests } = await observe();
  expect(s.task.attemptId).toBeNull();
  expect(s.task.work).toBe("cancelled");
  expect(s.trace?.attemptId).toBe("fixture-attempt-1");
  expect(s.selectedAttempt).toMatchObject({
    scope: "historical",
    attemptId: "fixture-attempt-1",
    attemptEpoch: 1,
    sourceEventSeq: 1
  });
  expect(s.aiSnapshot.facts.selectedAttempt).toEqual(s.selectedAttempt);
  expect(s.consistency).toBe("partial");
  expect(s.assessment.workerLiveness).toBe("unknown");
  expect(requests).toHaveLength(4);
});
it("separates historical attempt content from current task content", async () => {
  const { snapshot: s } = await observe(2);
  expect(s.task.contentRevision).toBe(2);
  expect(s.selectedAttempt).toMatchObject({ attemptContentRevision: 1, contentPins: "stale" });
  expect(s.reasons).toContain("attempt_content_stale");
});
