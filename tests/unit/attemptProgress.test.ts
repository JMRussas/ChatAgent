import { describe, expect, it } from "vitest";
import {
  ATTEMPT_PROGRESS_LIMITS,
  AttemptProgressError,
  createAttemptProgressService,
  projectAttemptProgress,
  projectPublicActivity,
  type AttemptProgress
} from "../../src/integrations/hekate/attemptProgress";
import {
  RoleObservationError,
  createRoleObserver,
  type RoleObservation,
  type RoleObserver
} from "../../src/integrations/hekate/roleObservation";
import {
  ATTEMPT,
  EPOCH,
  READY,
  ROOT,
  RUNNING,
  SECRETS,
  claude,
  planBody,
  traceRecords,
  upstreamBodies,
  type TraceRecordSpec,
  type UpstreamOptions
} from "../helpers/attemptProgressFixtures";

const BASE = "http://127.0.0.1:5100";

function fakeFetch(answer: (path: string) => string | undefined | Response) {
  const calls: { path: string; method?: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const path = url.slice(BASE.length);
    calls.push({ path, method: init.method, init });
    const out = answer(path);
    if (out === undefined) throw new Error(`unexpected ${path}`);
    return typeof out === "string" ? new Response(out, { status: 200 }) : out;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function observe(options: UpstreamOptions) {
  const bodies = upstreamBodies(options);
  const f = fakeFetch(bodies);
  const observation = await createRoleObserver(BASE, {
    fetch: f.impl,
    now: () => new Date("2026-10-08T12:00:00.000Z")
  }).observe(ROOT, RUNNING);
  return { observation, calls: f.calls };
}

async function project(records: TraceRecordSpec[], extra: Partial<UpstreamOptions> = {}) {
  const { observation } = await observe({ records: traceRecords(records), ...extra });
  return projectAttemptProgress(observation, { rootId: ROOT, nodeId: RUNNING });
}

const hostilePlan = () =>
  planBody((node) => {
    node.name = SECRETS.nodeName;
    node.value = SECRETS.nodeValue;
    node.executorRef = SECRETS.executor;
    node.artifactRef = `${SECRETS.artifact} with spaces`;
    node.acceptance = {
      decision: "accepted",
      contentRevision: node.contentRevision,
      artifactRef: `${SECRETS.decisionArtifact} with spaces`,
      attemptId: node.attemptId,
      attemptEpoch: node.attemptEpoch,
      decidedBy: SECRETS.decidedBy,
      evidenceRef: `${SECRETS.evidence} with spaces`
    };
  });

/** Every supported and forbidden record shape the Claude stream-json trace can carry. */
const mixedRecords = (): TraceRecordSpec[] => [
  { text: JSON.stringify({ type: "system", subtype: "init", prompt: SECRETS.system }) },
  {
    text: claude.assistant([
      { type: "thinking", thinking: SECRETS.thinking, signature: "sig" },
      { type: "redacted_thinking", data: SECRETS.redactedThinking },
      claude.text("I will read the failing test first."),
      claude.tool("Read")
    ])
  },
  {
    text: JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: SECRETS.toolResult },
          { type: "text", text: SECRETS.user }
        ]
      }
    })
  },
  { text: JSON.stringify({ type: "result", subtype: "success", result: SECRETS.result }) },
  { stream: "stderr", text: claude.assistant([claude.text(SECRETS.stderr)]) },
  { stream: "hekate", text: claude.assistant([claude.text(SECRETS.hekate)]) },
  { text: claude.assistant([claude.text(SECRETS.cut)]), cut: true },
  { text: claude.assistant([claude.text(SECRETS.redacted)]), redacted: true },
  // One line split across two records: neither half is a complete JSON record.
  {
    text: `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${SECRETS.fragment}`
  },
  { text: `${SECRETS.fragmentTail}"}]}}` },
  { text: `{"type":"assistant","message":{"content":[{"type":"text","text":"${SECRETS.malformed}` },
  { text: `not json ${SECRETS.malformed}` },
  {
    text: claude.assistant([
      claude.tool(SECRETS.toolName),
      claude.text("Edited the parser."),
      claude.tool("Edit", { file_path: "a.ts", new_string: SECRETS.toolInput })
    ])
  },
  {
    text: claude.assistant([claude.text("Done.")], {
      parent: { message: { content: [{ type: "text", text: SECRETS.nested }] } },
      prompt: SECRETS.system
    })
  }
];

describe("public activity projection from real Claude stream-json records", () => {
  it("lists only top-level assistant text and safe tool names and keeps every forbidden value out", async () => {
    const progress = await project(mixedRecords(), { plan: hostilePlan() });
    const body = JSON.stringify(progress);
    for (const [name, secret] of Object.entries(SECRETS))
      expect([name, body.includes(secret)]).toEqual([name, false]);
    expect(progress.activity!.items).toEqual([
      {
        traceSeq: 1,
        index: 2,
        kind: "text",
        text: "I will read the failing test first.",
        textClipped: false
      },
      { traceSeq: 1, index: 3, kind: "tool_use", tool: "Read" },
      { traceSeq: 12, index: 1, kind: "text", text: "Edited the parser.", textClipped: false },
      { traceSeq: 12, index: 2, kind: "tool_use", tool: "Edit" },
      { traceSeq: 13, index: 0, kind: "text", text: "Done.", textClipped: false }
    ]);
    expect(progress.activity!.counts).toEqual({
      stdoutRecords: 12,
      assistantRecords: 3,
      otherRecords: 3,
      unavailableRecords: 6,
      withheldItems: 1
    });
    expect(progress.activity).toMatchObject({
      trust: "untrusted_inert_unverified_worker_claims",
      complete: false
    });
    expect(progress.trace!.streams).toEqual({ stdout: 12, stderr: 1, hekate: 1 });
    expect(body).not.toContain("rawText");
    expect(body).not.toContain('"prompt"');
  });

  it("does not salvage a JSON fragment, and reads nothing from a cut, redacted or non-stdout record", () => {
    const activity = projectPublicActivity(
      traceRecords([
        {
          text: `{"type":"assistant","message":{"content":[{"type":"text","text":"${SECRETS.fragment}`
        },
        { text: claude.assistant([claude.text(SECRETS.cut)]), cut: true },
        { text: claude.assistant([claude.text(SECRETS.redacted)]), redacted: true },
        { stream: "stderr", text: claude.assistant([claude.text(SECRETS.stderr)]) },
        { stream: "hekate", text: claude.assistant([claude.text(SECRETS.hekate)]) },
        // Two complete lines in one record are not one JSON record.
        {
          text: `${claude.assistant([claude.text(SECRETS.malformed)])}\n${claude.assistant([claude.text("x")])}`
        }
      ]),
      true
    );
    expect(activity.items).toEqual([]);
    expect(activity.counts).toMatchObject({ stdoutRecords: 4, unavailableRecords: 4 });
    expect(JSON.stringify(activity)).not.toMatch(/SECRET_/);
    expect(activity.complete).toBe(false);
  });

  it("accepts a complete record with trailing whitespace and ignores unsupported block types", () => {
    const activity = projectPublicActivity(
      traceRecords([
        {
          text: `${claude.assistant([claude.text("ok"), { type: "image", source: SECRETS.toolInput }])}\n`
        }
      ]),
      true
    );
    expect(activity.items).toEqual([
      { traceSeq: 0, index: 0, kind: "text", text: "ok", textClipped: false }
    ]);
    expect(activity.complete).toBe(true);
    expect(JSON.stringify(activity)).not.toMatch(/SECRET_/);
  });

  it("requires the assistant type, an object message and an array of content", () => {
    const shapes = [
      { type: "assistant", message: "text" },
      { type: "assistant", message: { content: SECRETS.nested } },
      { type: "assistant", content: [claude.text(SECRETS.nested)] },
      { type: "assistant", message: null },
      { type: "assistant", message: { role: "user", content: [claude.text(SECRETS.user)] } },
      { type: "assistant", message: { role: "system", content: [claude.text(SECRETS.system)] } },
      { type: "assistant", message: { content: [claude.text(SECRETS.nested)] } },
      { type: "message", message: { content: [claude.text(SECRETS.nested)] } },
      ["assistant"],
      "assistant"
    ];
    const activity = projectPublicActivity(
      traceRecords(shapes.map((s) => ({ text: JSON.stringify(s) }))),
      true
    );
    expect(activity.items).toEqual([]);
    expect(JSON.stringify(activity)).not.toContain(SECRETS.nested);
  });

  it("caps the newest items, clips long text and counts what it omits", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      text: claude.assistant([claude.text(`statement ${i}`)])
    }));
    const activity = projectPublicActivity(traceRecords(many), true);
    expect(activity.items).toHaveLength(ATTEMPT_PROGRESS_LIMITS.maxItems);
    expect(activity.items[0]).toMatchObject({ traceSeq: 10, text: "statement 10" });
    expect(activity.items.at(-1)).toMatchObject({ traceSeq: 29, text: "statement 29" });
    expect(activity).toMatchObject({ totalItems: 30, omittedItems: 10 });

    const long = projectPublicActivity(
      traceRecords([{ text: claude.assistant([claude.text("é".repeat(1000))]) }]),
      true
    );
    const item = long.items[0];
    expect(item.kind === "text" && Array.from(item.text)).toHaveLength(
      ATTEMPT_PROGRESS_LIMITS.maxTextChars
    );
    expect(item).toMatchObject({ textClipped: true });
  });

  it("inspects a bounded number of blocks per record and strips control characters", () => {
    const blocks = Array.from({ length: 80 }, (_, i) => claude.text(`b${i}`));
    const capped = projectPublicActivity(traceRecords([{ text: claude.assistant(blocks) }]), true);
    expect(capped.totalItems).toBe(ATTEMPT_PROGRESS_LIMITS.maxBlocksPerRecord);
    expect(capped.complete).toBe(false);
    const clean = projectPublicActivity(
      traceRecords([{ text: claude.assistant([claude.text("a\u0000b‮c\u0007d\ne")]) }]),
      true
    );
    expect(clean.items[0]).toMatchObject({ text: "abcd\ne" });
  });

  it("keeps a complete flag only when the trace itself is complete", () => {
    const records = traceRecords([{ text: claude.assistant([claude.text("hi")]) }]);
    expect(projectPublicActivity(records, true).complete).toBe(true);
    expect(projectPublicActivity(records, false).complete).toBe(false);
  });
});

describe("allowlisted progress projection", () => {
  it("carries exact identities, bindings, pins, trace metadata and unknown liveness", async () => {
    const progress = await project(mixedRecords(), { plan: hostilePlan() });
    expect(progress).toMatchObject({
      schema: "attempt-progress/v1",
      observedAt: "2026-10-08T12:00:00.000Z",
      rootId: ROOT,
      nodeId: RUNNING,
      consistency: "current",
      task: { attemptId: ATTEMPT, attemptEpoch: EPOCH },
      selectedAttempt: { attemptId: ATTEMPT, attemptEpoch: EPOCH, scope: "current" },
      trace: {
        status: "running",
        integrity: "verified",
        claimLinkage: "matched",
        recordCount: 14,
        firstSeq: 0,
        lastSeq: 13,
        capped: false,
        truncated: false,
        exitCode: 0
      },
      assessment: { workerLiveness: "unknown", usefulProgress: "unknown" },
      trust: {
        activity: "unverified_worker_claims",
        acceptance: "plan_store_recorded_decision",
        verifier: "not_reported"
      }
    });
    expect(progress.bindings.before).toEqual(progress.bindings.after);
    expect(progress.evidence).toHaveLength(4);
    for (const e of progress.evidence) expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(progress.aiSnapshot.facts.workerLiveness).toBe("unknown");
    expect(progress.aiSnapshot.facts.trace).toMatchObject({
      claimKey: null,
      claimLinkage: "matched"
    });
    expect(progress.aiSnapshot.policy).toMatchObject({ modelInvocation: false, tools: false });
  });

  it("shows digest references and withholds arbitrary scheme payloads", async () => {
    const plain = await project([], {
      plan: planBody((node) => {
        node.artifactRef = "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        node.acceptance = {
          decision: "rejected",
          contentRevision: node.contentRevision,
          artifactRef: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          attemptId: node.attemptId,
          attemptEpoch: node.attemptEpoch,
          decidedBy: "x",
          evidenceRef: "sha256:" + "a".repeat(64)
        };
      })
    });
    expect(plain.acceptance).toMatchObject({
      source: "plan_store_recorded_decision",
      decision: "rejected",
      taskArtifact: { state: "shown", ref: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      evidence: { state: "shown", ref: "sha256:" + "a".repeat(64) }
    });
    const hostile = await project([], { plan: hostilePlan() });
    expect(hostile.acceptance).toMatchObject({
      taskArtifact: { state: "withheld" },
      decisionArtifact: { state: "withheld" },
      evidence: { state: "withheld" }
    });
    expect(JSON.stringify(hostile)).not.toMatch(/SECRET_/);
  });

  it("shows native Git SHA and digest references but not paths or near-miss digests", async () => {
    const NATIVE = "5c0ccb5a5190ffe323aa5ca7e593b6c549406092";
    const SHA256 = "a1".repeat(32);
    const shown = await project([], {
      plan: planBody((node) => {
        node.artifactRef = NATIVE;
        node.acceptance = {
          decision: "accepted",
          contentRevision: node.contentRevision,
          artifactRef: SHA256,
          attemptId: node.attemptId,
          attemptEpoch: node.attemptEpoch,
          decidedBy: "x",
          evidenceRef: `sha256:${SHA256}`
        };
      })
    });
    expect(shown.acceptance).toMatchObject({
      taskArtifact: { state: "shown", ref: NATIVE },
      decisionArtifact: { state: "shown", ref: SHA256 },
      evidence: { state: "shown", ref: `sha256:${SHA256}` }
    });
    for (const ref of [
      NATIVE.toUpperCase(),
      NATIVE.slice(1),
      `${NATIVE}0`,
      "D:/secrets/key.pem",
      "/etc/passwd",
      "secret:SECRET_TOKEN",
      "fixture:checks",
      `${NATIVE}\n${NATIVE}`
    ]) {
      const withheld = await project([], {
        plan: planBody((node) => {
          node.artifactRef = ref;
        })
      });
      expect(withheld.acceptance.taskArtifact).toEqual({ state: "withheld" });
    }
  });

  it("reports a node with no attempt as having no trace and no activity", async () => {
    const f = fakeFetch((path) => {
      if (path === `/api/plan-contract/v1/plans/${ROOT}`) return planBody();
      if (path === `/api/plan-contract/v1/nodes/${READY}/events?afterSeq=0`)
        return JSON.stringify({
          contractVersion: "plan-contract/v1",
          events: [],
          nextAfterSeq: null,
          historyStartsAtSeq: 1,
          historyBackfilled: false
        });
      return undefined;
    });
    const observation = await createRoleObserver(BASE, { fetch: f.impl }).observe(ROOT, READY);
    const progress = projectAttemptProgress(observation, { rootId: ROOT, nodeId: READY });
    expect(progress.selectedAttempt).toBeNull();
    expect(progress.trace).toBeNull();
    expect(progress.activity).toBeNull();
    expect(progress.acceptance).toMatchObject({ decision: null, taskArtifact: { state: "none" } });
  });

  it("caps the copied AI event list and counts the omitted events", async () => {
    const { observation } = await observe({ records: traceRecords([]) });
    const events = Array.from({ length: 120 }, (_, i) => ({
      seq: i + 1,
      nodeStateRevision: 1,
      currentAttempt: true
    }));
    const edited = structuredClone(observation) as RoleObservation;
    (edited.aiSnapshot.facts as unknown as { events: unknown[] }).events = events;
    const progress = projectAttemptProgress(edited, { rootId: ROOT, nodeId: RUNNING });
    expect(progress.aiSnapshot.facts.events).toHaveLength(ATTEMPT_PROGRESS_LIMITS.maxEvents);
    expect(progress.aiSnapshot.facts.events[0].seq).toBe(71);
    expect(progress.aiSnapshotEventsOmitted).toBe(70);
    expect(JSON.stringify(progress).length).toBeLessThan(ATTEMPT_PROGRESS_LIMITS.maxBodyBytes);
  });

  it("refuses root, node, attempt and shape mismatches without echoing them", async () => {
    const { observation } = await observe({ records: traceRecords([]) });
    // JSON.parse yields an untyped copy, so the edits below can break the shape on purpose.
    type Loose = ReturnType<typeof JSON.parse>;
    const code = (edit: (o: Loose) => void, expected = { rootId: ROOT, nodeId: RUNNING }) => {
      const copy: Loose = JSON.parse(JSON.stringify(observation));
      edit(copy);
      try {
        projectAttemptProgress(copy as RoleObservation, expected);
      } catch (error) {
        return error instanceof AttemptProgressError ? error.code : "OTHER";
      }
      return "OK";
    };
    expect(code(() => undefined)).toBe("OK");
    expect(code(() => undefined, { rootId: READY, nodeId: RUNNING })).toBe("INVALID_OBSERVATION");
    expect(code(() => undefined, { rootId: ROOT, nodeId: READY })).toBe("INVALID_OBSERVATION");
    expect(code((o) => (o.task.nodeId = READY))).toBe("INVALID_OBSERVATION");
    expect(code((o) => (o.trace.attemptId = "other"))).toBe("INVALID_OBSERVATION");
    expect(code((o) => (o.trace.attemptEpoch = EPOCH + 1))).toBe("INVALID_OBSERVATION");
    expect(code((o) => (o.assessment.usefulProgress = "yes"))).toBe("INVALID_OBSERVATION");
    expect(code((o) => (o.consistency = "great"))).toBe("INVALID_OBSERVATION");
    expect(code((o) => (o.trace.records[0] = { stream: "other" }))).toBe("INVALID_OBSERVATION");
    expect(code((o) => (o.schema = "x"))).toBe("INVALID_OBSERVATION");
  });
});

describe("attempt progress service", () => {
  const goodObservation = async () => (await observe({ records: traceRecords([]) })).observation;
  const fixed =
    (observation: () => Promise<RoleObservation>): (() => RoleObserver) =>
    () => ({
      observe: observation
    });

  it("uses the bounded collector: at most 8 GETs, 10 seconds and 4 MiB, one observer per request", async () => {
    expect(ATTEMPT_PROGRESS_LIMITS.observer).toEqual({
      timeoutMs: 10_000,
      maxPages: 8,
      maxBytes: 4 * 1024 * 1024
    });
    let created = 0;
    const service = createAttemptProgressService(BASE, {
      createObserver: () => {
        created++;
        return { observe: async () => goodObservation() };
      }
    });
    expect((await service.read(ROOT, RUNNING)).status).toBe(200);
    expect((await service.read(ROOT, RUNNING)).status).toBe(200);
    expect(created).toBe(2);
  });

  it("returns 404 for a missing node and a fixed unavailable code for every other failure", async () => {
    const failing = (error: unknown) =>
      createAttemptProgressService(BASE, {
        createObserver: fixed(async () => {
          throw error;
        })
      }).read(ROOT, RUNNING);
    expect(await failing(new RoleObservationError("NODE_NOT_FOUND"))).toEqual({
      status: 404,
      body: { code: "NODE_NOT_FOUND" }
    });
    expect(await failing(new RoleObservationError("HTTP_ERROR", 500))).toEqual({
      status: 503,
      body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "HTTP_ERROR" }
    });
    expect(await failing(new RoleObservationError("ROOT_MISMATCH"))).toMatchObject({
      body: { reason: "ROOT_MISMATCH" }
    });
    // Anything that is not a coded refusal is reported without its message.
    const unknown = await failing(new Error(`boom ${SECRETS.toolInput}`));
    expect(unknown).toEqual({
      status: 503,
      body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "UNAVAILABLE" }
    });
  });

  it("refuses an observation for another root or node", async () => {
    const observation = await goodObservation();
    const other = { ...observation, rootId: READY } as RoleObservation;
    const result = await createAttemptProgressService(BASE, {
      createObserver: fixed(async () => other)
    }).read(ROOT, RUNNING);
    expect(result).toEqual({
      status: 503,
      body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "INVALID_OBSERVATION" }
    });
  });

  it("limits concurrent observations and releases the slot afterwards", async () => {
    const observation = await goodObservation();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = createAttemptProgressService(BASE, {
      maxConcurrent: 1,
      createObserver: fixed(async () => {
        await gate;
        return observation;
      })
    });
    const first = service.read(ROOT, RUNNING);
    expect(await service.read(ROOT, RUNNING)).toMatchObject({
      status: 503,
      body: { reason: "BUSY" }
    });
    release();
    expect((await first).status).toBe(200);
    expect((await service.read(ROOT, RUNNING)).status).toBe(200);
  });

  it("maps a backend refusal or a closed API to unavailable without echoing the body", async () => {
    for (const answer of [
      () => new Response(`${SECRETS.hekate} internal`, { status: 500 }),
      () => new Response(`${SECRETS.hekate} gone`, { status: 404 })
    ]) {
      const f = fakeFetch(answer);
      const result = await createAttemptProgressService(BASE, {
        createObserver: () =>
          createRoleObserver(BASE, { fetch: f.impl, ...ATTEMPT_PROGRESS_LIMITS.observer })
      }).read(ROOT, RUNNING);
      expect(result).toEqual({
        status: 503,
        body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "HTTP_ERROR" }
      });
      expect(f.calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(SECRETS.hekate);
    }
    const closed = (async () => {
      throw new TypeError("fetch failed ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await createAttemptProgressService(BASE, {
      createObserver: () =>
        createRoleObserver(BASE, { fetch: closed, ...ATTEMPT_PROGRESS_LIMITS.observer })
    }).read(ROOT, RUNNING);
    expect(result).toEqual({
      status: 503,
      body: { code: "ATTEMPT_PROGRESS_UNAVAILABLE", reason: "UNAVAILABLE" }
    });
  });

  it("makes only GET requests, bounded to 8, and never sends a body", async () => {
    const bodies = upstreamBodies({ records: traceRecords([]) });
    const f = fakeFetch(bodies);
    const service = createAttemptProgressService(BASE, {
      createObserver: () =>
        createRoleObserver(BASE, { fetch: f.impl, ...ATTEMPT_PROGRESS_LIMITS.observer })
    });
    const result = await service.read(ROOT, RUNNING);
    expect(result.status).toBe(200);
    expect(f.calls.length).toBeLessThanOrEqual(8);
    for (const c of f.calls) {
      expect(c.method).toBe("GET");
      expect(c.init.body).toBeUndefined();
      expect(c.init.redirect).toBe("error");
    }
  });

  it("returns a deeply serializable body below the browser's read bound", async () => {
    const result = await createAttemptProgressService(BASE, {
      createObserver: fixed(
        async () => (await observe({ records: traceRecords(mixedRecords()) })).observation
      )
    }).read(ROOT, RUNNING);
    expect(result.status).toBe(200);
    const body = result.body as AttemptProgress;
    expect(JSON.stringify(body).length).toBeLessThan(1024 * 1024);
  });
});
