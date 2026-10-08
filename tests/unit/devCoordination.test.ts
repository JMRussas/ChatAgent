import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  coordinationStatus,
  DevCoordinationError,
  fetchCoordinationStatus,
  planApiBase
} from "../../src/integrations/hekate/devCoordination";

// The real body (tests/fixtures/hekate/PROVENANCE.md) and synthetic edits of it.
const raw = readFileSync("tests/fixtures/hekate/c1-plan-status.raw.json", "utf8");
const ROOT = "e3f9c48e-1338-492a-b6c4-a9fbb1525957";
const READY = "77ad2c95-f8c6-43fe-9831-50bc67287f87";
const RUNNING = "49262a8f-dcae-4e0e-a900-9a1870d38ecb";
const REVIEW = "be0e3cab-738e-4cfb-bb2a-49fa2196a9ba";
const ACCEPTED = "f253b776-0375-4eea-9bd4-3df2003d039a";

type View = {
  nodes: Record<string, unknown>[];
  readiness: {
    errors: unknown[];
    leaves: Record<string, unknown>[];
    containers: Record<string, unknown>[];
    rootId: string;
  };
  dependencies: unknown[];
} & Record<string, unknown>;
/** Synthetic: the real body, parsed, edited and re-serialized. */
const synthetic = (edit: (v: View) => void) => {
  const v = JSON.parse(raw) as View;
  edit(v);
  return JSON.stringify(v);
};
const node = (v: View, id: string) => v.nodes.find((n) => n.id === id)!;
const leaf = (v: View, id: string) => v.readiness.leaves.find((l) => l.nodeId === id)!;
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DevCoordinationError) return error.code;
    throw error;
  }
  return "OK";
};
const states = (text: string) => {
  const status = coordinationStatus(text, ROOT);
  if (status.status !== "ok") throw new Error("invalid");
  return Object.fromEntries(status.leaves.map((l) => [l.nodeId, l]));
};

describe("projecting a real plan view", () => {
  it("reports each leaf's state and identities, never an execution acknowledgement", () => {
    const status = coordinationStatus(raw, ROOT);
    expect(status.status).toBe("ok");
    const byId = states(raw);
    expect(Object.keys(byId)).toEqual([READY, RUNNING, REVIEW, ACCEPTED]);
    expect(byId[READY]).toMatchObject({ state: "ready", attemptPins: "none", attemptId: null });
    expect(byId[RUNNING]).toMatchObject({
      state: "in_progress",
      attemptPins: "current",
      attemptEpoch: 1
    });
    expect(byId[REVIEW]).toMatchObject({ state: "review_pending", attemptPins: "current" });
    expect(byId[ACCEPTED]).toMatchObject({ state: "accepted", attemptPins: "current" });
    expect(byId[ACCEPTED].acceptance).toMatchObject({ decision: "accepted" });
    for (const l of Object.values(byId)) expect(l.executionAcknowledged).toBe("unknown");
  });
});

describe("synthetic states", () => {
  it("separates blocked, cancelled, rejected and stale work", () => {
    expect(states(synthetic((v) => (leaf(v, READY).ready = false)))[READY].state).toBe("blocked");
    expect(
      states(
        synthetic((v) => {
          node(v, READY).work = "cancelled";
          leaf(v, READY).work = "cancelled";
        })
      )[READY].state
    ).toBe("cancelled");
    expect(
      states(
        synthetic((v) => {
          node(v, ACCEPTED).effectiveAcceptance = "rejected";
          (node(v, ACCEPTED).acceptance as Record<string, unknown>).decision = "rejected";
        })
      )[ACCEPTED].state
    ).toBe("rejected");
    expect(
      states(synthetic((v) => (node(v, ACCEPTED).effectiveAcceptance = "stale")))[ACCEPTED].state
    ).toBe("stale");
  });

  /** The accepted leaf on a later attempt, its recorded decision left at `decisionEpoch`. */
  const laterAttempt = (decision: string, decisionEpoch: number | null, nodeEpoch = 2) =>
    states(
      synthetic((v) => {
        node(v, ACCEPTED).attemptEpoch = nodeEpoch;
        leaf(v, ACCEPTED).attemptEpoch = nodeEpoch;
        node(v, ACCEPTED).effectiveAcceptance = "stale";
        if (decisionEpoch === null) node(v, ACCEPTED).acceptance = null;
        else
          Object.assign(node(v, ACCEPTED).acceptance as Record<string, unknown>, {
            decision,
            attemptEpoch: decisionEpoch
          });
      })
    )[ACCEPTED];

  it.each(["rejected", "accepted"])(
    "shows a %s decision for a strictly older attempt as history: review pending (plan 038)",
    (decision) => {
      const l = laterAttempt(decision, 1);
      expect(l).toMatchObject({
        state: "review_pending",
        acceptanceHistorical: true,
        executionAcknowledged: "unknown"
      });
      // The decision is kept and labelled; an older acceptance never shows accepted.
      expect(l.acceptance).toMatchObject({ decision, attemptEpoch: 1 });
    }
  );

  it("decides by epoch even when the attempt id is reused", () => {
    const l = laterAttempt("rejected", 1);
    expect(l.attemptId).toBe(l.acceptance?.attemptId);
    expect(l.state).toBe("review_pending");
  });

  it.each([
    ["same-epoch drift", "accepted", 2],
    ["a zero decision epoch", "rejected", 0],
    ["a future decision epoch", "rejected", 3],
    ["no recorded decision", "rejected", null]
  ] as const)("keeps %s stale, failing closed", (_label, decision, epoch) => {
    const l = laterAttempt(decision, epoch);
    expect(l.state).toBe("stale");
    expect(l).not.toHaveProperty("acceptanceHistorical");
  });

  it("leaves the captured fixture's output without the historical field", () => {
    for (const l of Object.values(states(raw)))
      expect(l).not.toHaveProperty("acceptanceHistorical");
  });

  it("never shows work with changed inputs as current", () => {
    const changed = states(
      synthetic((v) => {
        for (const id of [RUNNING, ACCEPTED]) {
          leaf(v, id).upstreamChanged = true;
          leaf(v, id).gatesHold = false;
        }
      })
    );
    expect(changed[RUNNING]).toMatchObject({
      state: "in_progress",
      attemptPins: "stale",
      upstreamChanged: true,
      gatesHold: false
    });
    expect(changed[ACCEPTED]).toMatchObject({ state: "stale", attemptPins: "stale" });
    // Own content revised after the attempt pinned it.
    expect(
      states(synthetic((v) => (node(v, RUNNING).contentRevision = 2)))[RUNNING].attemptPins
    ).toBe("stale");
    // An attempt recorded without pins is unknown, never current.
    expect(
      states(
        synthetic((v) => {
          node(v, RUNNING).attemptContentRevision = null;
          node(v, RUNNING).attemptPrereqDigest = null;
        })
      )[RUNNING].attemptPins
    ).toBe("unknown");
  });

  it("reports an invalid plan from its readiness errors without inferring states", () => {
    const status = coordinationStatus(
      synthetic((v) =>
        v.readiness.errors.push({
          code: "invalid_graph",
          message: "x",
          nodeId: READY,
          relatedId: null
        })
      ),
      ROOT
    );
    expect(status).toEqual({
      status: "invalid",
      rootId: ROOT,
      errors: [{ code: "invalid_graph", nodeId: READY }]
    });
  });
});

describe("refusing malformed or inconsistent views", () => {
  it.each([
    [
      "another contract",
      (v: View) => (v.contractVersion = "plan-contract/v2"),
      "UNSUPPORTED_CONTRACT"
    ],
    ["another readiness root", (v: View) => (v.readiness.rootId = READY), "ROOT_MISMATCH"],
    ["an unknown field", (v: View) => (v.extra = 1), "INVALID_RESPONSE"],
    ["an unknown work state", (v: View) => (node(v, READY).work = "paused"), "INVALID_RESPONSE"],
    [
      "a leaf disagreeing with its node",
      (v: View) => (leaf(v, RUNNING).attemptEpoch = 2),
      "INVALID_RESPONSE"
    ],
    ["a node left unclassified", (v: View) => v.readiness.leaves.pop(), "INVALID_RESPONSE"],
    ["a duplicate leaf", (v: View) => v.readiness.leaves.push(leaf(v, READY)), "INVALID_RESPONSE"],
    ["a leaf with a child", (v: View) => (node(v, RUNNING).parentId = READY), "INVALID_RESPONSE"],
    [
      "a childless node hidden as a container",
      (v: View) => {
        v.readiness.leaves = v.readiness.leaves.filter((l) => l.nodeId !== REVIEW);
        v.readiness.containers.push({ ...v.readiness.containers[0], nodeId: REVIEW });
      },
      "INVALID_RESPONSE"
    ],
    [
      "the root as a leaf",
      (v: View) => {
        v.readiness.containers = [];
        v.readiness.leaves.push({ ...leaf(v, READY), nodeId: ROOT });
      },
      "INVALID_RESPONSE"
    ],
    [
      "a parent cycle",
      (v: View) => {
        node(v, READY).parentId = RUNNING;
        node(v, RUNNING).parentId = READY;
      },
      "INVALID_RESPONSE"
    ],
    [
      "a dependency on a foreign node",
      (v: View) =>
        v.dependencies.push({
          predecessorId: "00000000-0000-0000-0000-000000000000",
          successorId: READY,
          gate: "accepted"
        }),
      "INVALID_RESPONSE"
    ],
    [
      "a blocker naming a foreign node",
      (v: View) =>
        ((leaf(v, READY).blockers as unknown[]) = [
          {
            ownerId: READY,
            predecessorId: "00000000-0000-0000-0000-000000000000",
            gate: "accepted",
            reason: "x"
          }
        ]),
      "INVALID_RESPONSE"
    ],
    [
      "an acceptance without its recorded decision",
      (v: View) => (node(v, ACCEPTED).acceptance = null),
      "INVALID_RESPONSE"
    ],
    [
      "an acceptance for another attempt",
      (v: View) => ((node(v, ACCEPTED).acceptance as Record<string, unknown>).attemptEpoch = 9),
      "INVALID_RESPONSE"
    ],
    [
      "an acceptance of other content",
      (v: View) => (node(v, ACCEPTED).contentRevision = 2),
      "INVALID_RESPONSE"
    ],
    [
      "an acceptance on unfinished work",
      (v: View) => {
        node(v, ACCEPTED).work = "in_progress";
        leaf(v, ACCEPTED).work = "in_progress";
      },
      "INVALID_RESPONSE"
    ],
    [
      "a leaf-style acceptance on the container",
      (v: View) => (v.readiness.containers[0].acceptance = "none"),
      "INVALID_RESPONSE"
    ]
  ])("refuses %s", async (_, edit, expected) => {
    expect(await code(() => coordinationStatus(synthetic(edit), ROOT))).toBe(expected);
  });

  it("refuses unsafe numbers and keys in the raw text, even behind a duplicate", async () => {
    const at = '"stateRevision":';
    expect(raw).toContain(at);
    for (const [variant, expected] of [
      [raw.replace(at, `${at}9007199254740993,${at}`), "INVALID_NUMBER"],
      [raw.replace(at, `${at}1.5,${at}`), "INVALID_NUMBER"],
      [raw.replace(at, `${at}1,${at}`), "DUPLICATE_KEY"],
      [raw.replace(at, `"state\\u0052evision":1,${at}`), "DUPLICATE_KEY"],
      [raw.replace(at, `"__proto__":{},${at}`), "UNSAFE_KEY"],
      ["{", "INVALID_RESPONSE"]
    ] as const)
      expect(await code(() => coordinationStatus(variant, ROOT))).toBe(expected);
  });

  it("checks the requested root and bounds the text before scanning", async () => {
    expect(await code(() => coordinationStatus(raw, READY))).toBe("ROOT_MISMATCH");
    expect(await code(() => coordinationStatus(raw, "not-a-guid"))).toBe("INVALID_ROOT");
    expect(await code(() => coordinationStatus(raw, ROOT, Buffer.byteLength(raw) - 1))).toBe(
      "RESPONSE_TOO_LARGE"
    );
    for (const bound of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(await code(() => coordinationStatus(raw, ROOT, bound))).toBe("INVALID_OPTIONS");
  });
});

describe("reading over HTTP", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("accepts only literal loopback http URLs", async () => {
    expect(planApiBase("http://127.0.0.1:5100")).toBe("http://127.0.0.1:5100");
    expect(planApiBase("http://[::1]:5100")).toBe("http://[::1]:5100");
    for (const url of [
      undefined,
      "http://localhost:5100",
      "https://127.0.0.1:5100",
      "http://example.com",
      "http://user:pass@127.0.0.1:5100",
      "http://127.0.0.1:5100/?x=1",
      "http://127.0.0.1:5100/#x"
    ])
      expect(await code(() => planApiBase(url))).toBe("INVALID_URL");
  });

  it("reads the plan for the requested root and nothing else", async () => {
    const paths: string[] = [];
    const base = await serve((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(raw);
    });
    const status = await fetchCoordinationStatus(base, ROOT);
    expect(status.status).toBe("ok");
    expect(paths).toEqual([`GET /api/plan-contract/v1/plans/${ROOT}`]);
  });

  it("refuses redirects, error statuses, oversize and slow bodies with codes only", async () => {
    const followed: string[] = [];
    const target = await serve((req, res) => {
      followed.push(req.url!);
      res.end(raw);
    });
    const redirecting = await serve((_, res) => {
      res.writeHead(302, { location: `${target}/api/plan-contract/v1/plans/${ROOT}` });
      res.end();
    });
    expect(await code(() => fetchCoordinationStatus(redirecting, ROOT))).toBe("UNAVAILABLE");
    expect(followed).toEqual([]);

    const missing = await serve((_, res) => {
      res.writeHead(404);
      res.end('{"code":"plan_not_found","message":"secret detail"}');
    });
    const error = await fetchCoordinationStatus(missing, ROOT).catch((e) => e);
    expect(error).toMatchObject({ code: "HTTP_ERROR", status: 404 });
    expect(String(error)).not.toContain("secret");

    const huge = await serve((_, res) => {
      res.writeHead(200);
      res.end("x".repeat(2048));
    });
    expect(await code(() => fetchCoordinationStatus(huge, ROOT, { maxBytes: 1024 }))).toBe(
      "RESPONSE_TOO_LARGE"
    );

    // Headers arrive at once; the body never finishes. The deadline covers the body.
    const stalled = await serve((_, res) => {
      res.writeHead(200);
      res.write("{");
    });
    expect(await code(() => fetchCoordinationStatus(stalled, ROOT, { timeoutMs: 100 }))).toBe(
      "TIMEOUT"
    );

    for (const options of [{ timeoutMs: 0 }, { timeoutMs: Number.NaN }, { maxBytes: 1.5 }])
      expect(await code(() => fetchCoordinationStatus(target, ROOT, options))).toBe(
        "INVALID_OPTIONS"
      );
  });

  // The CLI as a subprocess: arguments, environment, output and exit codes.
  const devcoord = (args: string[], url?: string) =>
    new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve) => {
      const env = { ...process.env, HEKATE_PLAN_API_URL: url };
      if (url === undefined) delete env.HEKATE_PLAN_API_URL;
      execFile(
        process.execPath,
        ["--import", "tsx", "scripts/devcoord.ts", ...args],
        { env },
        (error, stdout, stderr) =>
          resolve({ exit: error ? (error.code as number) : 0, stdout, stderr })
      );
    });

  it("runs the CLI against a plan API and prints human or JSON status", async () => {
    const paths: string[] = [];
    const base = await serve((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(raw);
    });

    const human = await devcoord(["status", "--root", ROOT], base);
    expect(human).toMatchObject({ exit: 0, stderr: "" });
    const lines = human.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`plan ${ROOT}: 4 leaves (execution acknowledgement unknown)`);
    // One leaf of the captured plan is in progress, so the plan is active, not complete.
    expect(lines[1]).toBe("  progress active (root container incomplete/pending)");
    expect(lines[2]).toMatch(new RegExp(`^  ready +${READY} Ready$`));
    expect(lines[3]).toMatch(
      new RegExp(`^  in_progress +${RUNNING} In progress  attempt \\S+#1  pins current  executor `)
    );
    expect(lines[4]).toMatch(
      new RegExp(`^  review_pending +${REVIEW} .*pins current.*artifact git:`)
    );
    expect(lines[5]).toMatch(new RegExp(`^  accepted +${ACCEPTED} .*pins current`));

    const json = await devcoord(["status", "--json", "--root", ROOT], base);
    expect(json).toMatchObject({ exit: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(coordinationStatus(raw, ROOT));
    expect(paths).toEqual([
      `GET /api/plan-contract/v1/plans/${ROOT}`,
      `GET /api/plan-contract/v1/plans/${ROOT}`
    ]);
  });

  it("labels an older attempt's decision as historical in the human output", async () => {
    const body = synthetic((v) => {
      node(v, ACCEPTED).attemptEpoch = 2;
      leaf(v, ACCEPTED).attemptEpoch = 2;
      node(v, ACCEPTED).effectiveAcceptance = "stale";
      (node(v, ACCEPTED).acceptance as Record<string, unknown>).decision = "rejected";
    });
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    const human = await devcoord(["status", "--root", ROOT], base);
    expect(human.stdout).toMatch(
      new RegExp(`review_pending +${ACCEPTED} .*prior decision rejected@1 \\(historical\\)`)
    );
  });

  it("exits 2 on usage errors and 1 with a code only on refusals", async () => {
    const missing = await serve((_, res) => {
      res.writeHead(404);
      res.end('{"message":"secret detail"}');
    });
    for (const args of [
      [],
      ["claim", "--root", ROOT],
      ["status"],
      ["status", "--root"],
      ["status", "--root", ROOT, "--force"]
    ])
      expect(await devcoord(args, missing)).toMatchObject({
        exit: 2,
        stdout: "",
        stderr: expect.stringContaining("usage: devcoord status")
      });
    expect(await devcoord(["status", "--root", ROOT], missing)).toEqual({
      exit: 1,
      stdout: "",
      stderr: "devcoord: HTTP_ERROR 404\n"
    });
    expect(await devcoord(["status", "--root", ROOT])).toEqual({
      exit: 1,
      stdout: "",
      stderr: "devcoord: INVALID_URL\n"
    });
    expect(await devcoord(["status", "--root", "not-a-guid"], missing)).toEqual({
      exit: 1,
      stdout: "",
      stderr: "devcoord: INVALID_ROOT\n"
    });
  });
});
