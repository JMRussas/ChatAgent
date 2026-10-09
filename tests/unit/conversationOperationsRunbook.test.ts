import { Script } from "node:vm";
import { createHash } from "node:crypto";
import { format, resolveConfig } from "prettier";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = resolve("docs/implementation/16-hekate-conversation-operations.md");
const text = readFileSync(DOC, "utf8");

describe("frozen conversation rehearsal evidence", () => {
  it("retains the exact independently reviewed read-only live verifier", () => {
    expect(
      createHash("sha256")
        .update(readFileSync("scripts/check-conversation-rehearsal.mjs"))
        .digest("hex")
    ).toBe("a3fab05487f15fc521cea5d03c6925cb2ba7e0be07847e2af788eaa0d10a9f1d");
  });
  it("emits the pinned formatter bytes", async () => {
    const config = await resolveConfig(DOC);
    expect(text).toBe(await format(text, { ...config, filepath: DOC }));
  });
});

describe("real rehearsal projection semantics", () => {
  const helper = readFileSync("scripts/check-conversation-rehearsal.mjs", "utf8");
  const functions = helper.slice(
    helper.indexOf("function leafOf("),
    helper.indexOf("async function main(")
  );
  const actual = new Script(functions + "\n({finalMode, summarize})").runInNewContext({
    ROOT: "b556d4ce-b813-50fa-8ac5-3633297518a6",
    ARTIFACT: "15528e5ac76634220ad4de69bb504350b6f82a8d",
    TOOLS: new Set(["Read", "Glob", "Grep", "Edit", "Write"]),
    check: (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
      return condition;
    }
  });
  const fixture = () => ({
    schema: "attempt-progress/v1",
    rootId: "b556d4ce-b813-50fa-8ac5-3633297518a6",
    nodeId: "21dcea12-cb65-54cf-8581-e2f896490139",
    consistency: "current",
    observedAt: "2026-10-09T05:06:00Z",
    task: {
      attemptId: "rehearsal-r1",
      attemptEpoch: 1,
      contentRevision: 2,
      attemptContentRevision: 2,
      effectiveAcceptance: "accepted"
    },
    selectedAttempt: {
      scope: "current",
      contentPins: "current",
      attemptId: "rehearsal-r1",
      attemptEpoch: 1
    },
    trace: { integrity: "verified", claimLinkage: "matched" },
    assessment: { workerLiveness: "unknown", usefulProgress: "unknown" },
    activity: { trust: "untrusted_inert_unverified_worker_claims", items: [] },
    acceptance: {
      decision: "accepted",
      attemptId: "rehearsal-r1",
      attemptEpoch: 1,
      contentRevision: 2,
      taskArtifact: { state: "shown", ref: "a".repeat(40) },
      decisionArtifact: { state: "shown", ref: "a".repeat(40) }
    },
    evidence: []
  });
  it("recognizes the maintained review_pending vocabulary", () => {
    expect(
      actual.finalMode({ attemptId: "rehearsal-r1", attemptEpoch: 1, state: "review_pending" })
    ).toBe("native_verification");
    expect(() =>
      actual.finalMode({ attemptId: "rehearsal-r1", attemptEpoch: 1, state: "awaiting_review" })
    ).toThrow();
  });
  it("accepts an exact final-task artifact independently of the predecessor pin", () => {
    const p = fixture();
    const view = actual.summarize(p, p.nodeId, null);
    expect(view.acceptedForThisAttempt).toBe(true);
    expect(view.taskArtifactMatchesPin).toBe(false);
  });
  it.each(["artifact", "attempt", "epoch", "content"])(
    "rejects a mismatched recorded %s decision",
    (mismatch) => {
      const p = fixture();
      if (mismatch === "artifact") p.acceptance.decisionArtifact.ref = "b".repeat(40);
      if (mismatch === "attempt") p.acceptance.attemptId = "earlier-r0";
      if (mismatch === "epoch") p.acceptance.attemptEpoch = 0;
      if (mismatch === "content") p.acceptance.contentRevision = 1;
      expect(actual.summarize(p, p.nodeId, null).acceptedForThisAttempt).toBe(false);
    }
  );
});

describe("reviewed runbook facts", () => {
  it("preserves the exact reviewed prefix before its delivery checklist", () => {
    const boundary = text.indexOf("\n## 9.");
    expect(boundary).toBeGreaterThan(0);
    expect(createHash("sha256").update(text.slice(0, boundary)).digest("hex")).toBe(
      "3cb2d6a12ec3672be3d26ecebcd3eeef1bfda59b0c9ad96e5f6127f496cfc233"
    );
  });
});
describe("conversation operations runbook", () => {
  it("names the trusted startup settings and pins", () => {
    for (const needle of [
      "HEKATE_PLAN_API_URL",
      "HEKATE_DISPATCH_CONFIG_PATH",
      "traceRoot",
      /pin/i,
      /pairing/i
    ]) {
      expect(text).toMatch(needle instanceof RegExp ? needle : new RegExp(needle));
    }
    expect(text).toMatch(/never[^.]*(credential|code)[^.]*URL/i);
  });

  it("describes only explicit actions with a fresh operation id", () => {
    expect(text).toMatch(/Load\/refresh/);
    expect(text).toMatch(/Check host/);
    expect(text).toMatch(/Start prepared plan/);
    expect(text).toMatch(/operationId/);
    expect(text).toMatch(/no automatic\s+execution/i);
  });

  it("keeps unknown outcomes, journal blocks and stop semantics distinct", () => {
    expect(text).toMatch(/unknown/i);
    expect(text).toMatch(/does\s+not\s+mean\s+failure/i);
    expect(text).toMatch(/journal/i);
    expect(text).toMatch(/stop_requested/);
    expect(text).toMatch(/stopped/);
    expect(text).toMatch(/OWNER_CHANGED/);
    expect(text).toMatch(/expected-launch-id/);
    expect(text).toMatch(/second\s+owner/i);
  });

  it("states the progress bounds and trust model", () => {
    for (const bound of [
      /6 reads/,
      /5 s/,
      /60 s/,
      /8 GETs/,
      /4 MiB/,
      /10 s/,
      /1 MiB/,
      /not incremental/i,
      /thinking/i,
      /unverified/i,
      /liveness/i,
      /useful progress/i,
      /aiSnapshot/,
      /historical/i
    ]) {
      expect(text).toMatch(bound);
    }
    for (const tool of ["Read", "Glob", "Grep", "Edit", "Write"]) {
      expect(text).toContain(tool);
    }
  });

  it("separates acceptance from integration and admits remaining gaps", () => {
    expect(text).toMatch(/Acceptance is not integration/i);
    expect(text).toMatch(/exact Git SHA/i);
    expect(text).toMatch(/process-local/i);
    expect(text).toMatch(/plan_done/);
    expect(text).toMatch(/sole API and\s+database lock/i);
    expect(text).toMatch(/not implemented/i);
    expect(text).toMatch(/no service-level objective/i);
  });

  it("claims no run result", () => {
    expect(text).not.toMatch(/\b\d+\s+(tests?\s+)?passed\b/i);
    expect(text).not.toMatch(/\ball checks (pass|passed)\b/i);
  });

  it("links to existing documents with relative paths", () => {
    const links = [...text.matchAll(/\]\((?!https?:|#)([^)#\s]+)(#[^)\s]*)?\)/g)];
    const targets = links.map((m) => m[1]);
    expect(targets).toEqual(
      expect.arrayContaining(["13-hekate-plan-node-integration.md", "14-local-authentication.md"])
    );
    for (const target of targets) {
      expect(target.startsWith("/")).toBe(false);
      expect(existsSync(resolve(dirname(DOC), target))).toBe(true);
    }
  });
});

describe("prepared task execution prerequisite", () => {
  it("documents the approved cache and preclaim refusal without a default", () => {
    expect(text).toContain("npmCacheDir");
    expect(text).toContain("npm_config_cache");
    expect(text).toMatch(/before claim/i);
    expect(text).toMatch(/offline/i);
    expect(text).toMatch(/missing cache/i);
    expect(text).toMatch(/does not start a worker/i);
    expect(text).toMatch(/default/i);
  });
});

describe("finite delivery checklist", () => {
  const section = text.slice(text.indexOf("\n## 9."));
  const normalized = section.replace(/\s+/g, " ");
  it("gates one prepared launch on readiness and preserves unknown owner fencing", () => {
    expect(normalized).toMatch(/readiness/i);
    expect(normalized).toMatch(/cache/i);
    expect(normalized).toMatch(/Check host/i);
    expect(normalized).toMatch(/Start prepared plan/i);
    expect(normalized).toMatch(/once|one launch/i);
    expect(normalized).toMatch(/unknown/i);
    expect(normalized).toMatch(/stop_requested/i);
    expect(normalized).toMatch(/stopped/i);
  });
  it("separates native checks, recorded acceptance, exact integration and explicit reload read", () => {
    for (const concept of [
      /attempt/i,
      /epoch/i,
      /unknown/i,
      /native/i,
      /recorded/i,
      /accepted/i,
      /Git SHA/i,
      /merge/i,
      /reload/i,
      /read/i,
      /blocked/i
    ])
      expect(normalized).toMatch(concept);
  });
});
