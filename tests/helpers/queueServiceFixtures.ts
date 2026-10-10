import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ContinuationManifest } from "../../src/checkpoint/checkpointContinuation";
import type { QueueDeps } from "../../src/checkpoint/checkpointQueueService";
import {
  queueRecordPath,
  type QueueManifest,
  type QueueRecord
} from "../../src/checkpoint/checkpointQueueState";
import { runCheckpoint } from "../../src/checkpoint/checkpointRun";
import { GIT_PATH, NODE_PATH, git } from "./continuationFixtures";
import { guid } from "./executiveFixtures";

/**
 * Real loopback plan API (request log), real linked Git worktrees and real owned processes for the
 * queue service tests. The worker and the fixed checks are tiny local stand-ins: nothing here calls
 * a model, so these fixtures prove sequencing and authority, never real model delivery.
 */

export const ROOT = guid(1);
export const ACCEPTOR = "lead-reviewer";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// ----- loopback plan API -----

interface ServerNode {
  id: string;
  name: string;
  work: "todo" | "in_progress" | "done";
  contentRevision: number;
  stateRevision: number;
  attemptId: string | null;
  attemptEpoch: number;
  artifactRef: string | null;
  executorRef: string | null;
  decidedBy: string | null;
  accepted: boolean;
  /** Indexes of predecessor nodes whose acceptance gates this node. */
  after: number[];
}
export interface LoggedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

const PRE = "a".repeat(64);

export class PlanServer {
  nodes: ServerNode[] = [];
  log: LoggedRequest[] = [];
  /** ok: apply; conflict: 409; drop: destroy the socket without applying. */
  startMode: "ok" | "conflict" | "drop" = "ok";
  readMode: "ok" | "down" = "ok";
  url = "";
  private server!: Server;

  static async start(count: number, after: Record<number, number[]> = {}): Promise<PlanServer> {
    const plan = new PlanServer();
    for (let i = 0; i < count; i++)
      plan.nodes.push({
        id: guid(100, i + 1),
        name: `task-${i + 1}`,
        work: "todo",
        contentRevision: 1,
        stateRevision: 0,
        attemptId: null,
        attemptEpoch: 0,
        artifactRef: null,
        executorRef: null,
        decidedBy: null,
        accepted: false,
        after: after[i] ?? []
      });
    plan.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => plan.handle(req.method ?? "", req.url ?? "", Buffer.concat(chunks), res));
    });
    await new Promise<void>((done) => plan.server.listen(0, "127.0.0.1", done));
    const address = plan.server.address();
    plan.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    return plan;
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  posts = (nodeIndex?: number) =>
    this.log.filter(
      (r) =>
        r.method === "POST" &&
        (nodeIndex === undefined || r.path.includes(this.nodes[nodeIndex].id))
    );

  private satisfied = (node: ServerNode) => node.after.every((p) => this.nodes[p].accepted);

  /** The reviewer's decision, recorded outside the queue. `over` builds wrong-fence variants. */
  accept(
    index: number,
    over: { decidedBy?: string; artifactRef?: string; epochBump?: boolean } = {}
  ) {
    const node = this.nodes[index];
    node.accepted = true;
    node.decidedBy = over.decidedBy ?? ACCEPTOR;
    if (over.artifactRef) node.artifactRef = over.artifactRef;
    if (over.epochBump) node.attemptEpoch += 1;
  }

  private view() {
    const root = {
      id: ROOT,
      parentId: null,
      nodeType: "plan",
      name: "root",
      value: null,
      contentAttributes: {},
      siblingOrder: 0,
      contentRevision: 1,
      stateRevision: 0,
      work: "todo",
      attemptId: null,
      attemptEpoch: 0,
      artifactRef: null,
      executorRef: null,
      attemptContentRevision: null,
      attemptPrereqDigest: null,
      acceptance: null,
      effectiveAcceptance: "none"
    };
    const leaves = this.nodes.map((n, i) => ({
      id: n.id,
      parentId: ROOT,
      nodeType: "task",
      name: n.name,
      value: null,
      contentAttributes: {},
      siblingOrder: i,
      contentRevision: n.contentRevision,
      stateRevision: n.stateRevision,
      work: n.work,
      attemptId: n.attemptId,
      attemptEpoch: n.attemptEpoch,
      artifactRef: n.artifactRef,
      executorRef: n.executorRef,
      attemptContentRevision: n.work === "todo" ? null : n.contentRevision,
      attemptPrereqDigest: n.work === "todo" ? null : PRE,
      acceptance: n.accepted
        ? {
            decision: "accepted",
            contentRevision: n.contentRevision,
            artifactRef: n.artifactRef,
            attemptId: n.attemptId,
            attemptEpoch: n.attemptEpoch,
            decidedBy: n.decidedBy,
            evidenceRef: null
          }
        : null,
      effectiveAcceptance: n.accepted ? "accepted" : "none"
    }));
    return {
      contractVersion: "plan-contract/v1",
      outcome: null,
      rootId: ROOT,
      projectId: guid(2),
      defaultGate: "accepted",
      nodes: [root, ...leaves],
      dependencies: this.nodes.flatMap((n) =>
        n.after.map((p) => ({ predecessorId: this.nodes[p].id, successorId: n.id, gate: null }))
      ),
      readiness: {
        contractVersion: "plan-contract/v1",
        rootId: ROOT,
        errors: [],
        leaves: this.nodes.map((n) => ({
          nodeId: n.id,
          name: n.name,
          work: n.work,
          ready: n.work === "todo" && this.satisfied(n),
          gatesHold: this.satisfied(n),
          upstreamChanged: false,
          attemptId: n.attemptId,
          attemptEpoch: n.attemptEpoch,
          blockers: n.after
            .filter((p) => !this.nodes[p].accepted)
            .map((p) => ({
              ownerId: n.id,
              predecessorId: this.nodes[p].id,
              gate: "accepted",
              reason: "predecessor not accepted"
            }))
        })),
        containers: [
          {
            nodeId: ROOT,
            name: "root",
            completion: "incomplete",
            acceptance: "pending",
            gatesHold: true
          }
        ]
      }
    };
  }

  private handle(method: string, path: string, raw: Buffer, res: ServerResponse) {
    let body: Record<string, unknown> | null = null;
    if (raw.length > 0) body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    this.log.push({ method, path, body });
    const reply = (status: number, payload: unknown = {}) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (method === "GET" && path === `/api/plan-contract/v1/plans/${ROOT}`)
      return this.readMode === "down" ? reply(503) : reply(200, this.view());
    const match = /^\/api\/plan-contract\/v1\/nodes\/([^/]+)\/transition$/.exec(path);
    const node = match ? this.nodes.find((n) => n.id === match[1]) : undefined;
    if (method !== "POST" || !node || !body) return reply(404);
    if (body.to === "in_progress") {
      if (this.startMode === "drop") return res.socket?.destroy();
      const fits =
        this.startMode === "ok" &&
        node.work === "todo" &&
        this.satisfied(node) &&
        body.expectedStateRevision === node.stateRevision &&
        typeof body.attemptId === "string" &&
        typeof body.executorRef === "string";
      if (!fits) return reply(409);
      node.work = "in_progress";
      node.attemptId = body.attemptId as string;
      node.executorRef = body.executorRef as string;
      node.attemptEpoch += 1;
      node.stateRevision += 1;
      return reply(200);
    }
    if (
      body.to === "done" &&
      node.work === "in_progress" &&
      body.attemptId === node.attemptId &&
      body.attemptEpoch === node.attemptEpoch &&
      body.expectedStateRevision === node.stateRevision &&
      typeof body.artifactRef === "string"
    ) {
      node.work = "done";
      node.artifactRef = body.artifactRef;
      node.stateRevision += 1;
      return reply(200);
    }
    return reply(409);
  }
}

// ----- queue fixture -----

export interface QueueFixture {
  root: string;
  main: string;
  queueDir: string;
  plan: PlanServer;
  items: ContinuationManifest[];
  itemPaths: string[];
  queue: QueueManifest;
  manifestPath: string;
  workerLog: () => number[];
  worktree: (index: number) => string;
  bytes: () => Buffer;
  /** Rewrites the queue manifest after `edit`, returning the new bytes. */
  rewrite: (edit: (queue: QueueManifest) => void) => Buffer;
  deps: (extra?: QueueDeps) => QueueDeps;
  record: () => QueueRecord | undefined;
  cleanup: () => Promise<void>;
}

let nodeHash: string | undefined;
let gitHash: string | undefined;

export interface QueueFixtureOptions {
  after?: Record<number, number[]>;
  reviewWaitMs?: number;
  totalUnits?: number;
  unrelated?: number;
}

export async function makeQueueFixture(
  count: number,
  options: QueueFixtureOptions = {}
): Promise<QueueFixture> {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "ckpt-queue-")));
  const main = join(root, "main");
  const queueDir = join(root, "queue");
  mkdirSync(main);
  mkdirSync(queueDir);
  git(main, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@invalid"],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"]
  ])
    git(main, "config", key, value);
  const seed = (rel: string, text: string) => {
    const path = join(main, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  seed(".gitignore", "node_modules/\n");
  seed("package.json", '{"name":"fixture"}\n');
  seed("tsconfig.json", "{}\n");
  seed("src/a.ts", "export const a = 1;\n");
  seed("tests/a.test.ts", "export {};\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  const baseRef = git(main, "rev-parse", "HEAD");

  // Extra nodes are ready TODO siblings that are not part of the queue and must never be touched.
  const plan = await PlanServer.start(count + (options.unrelated ?? 0), options.after);
  const workerLogPath = join(root, "worker.log");
  nodeHash ??= sha(readFileSync(NODE_PATH));
  gitHash ??= sha(readFileSync(GIT_PATH));
  const entries = {
    prettier: "node_modules/prettier/bin/prettier.cjs",
    typescript: "node_modules/typescript/lib/_tsc.js",
    vitest: "node_modules/vitest/vitest.mjs"
  } as const;

  const items: ContinuationManifest[] = [];
  const itemPaths: string[] = [];
  const queueItems: QueueManifest["items"] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const wt = join(root, `wt${n}`);
    const rec = join(root, `rec${n}`);
    mkdirSync(rec);
    git(main, "worktree", "add", "-q", "-b", `work${n}`, wt);
    const toolingSha256: Record<string, string> = {};
    for (const [name, rel] of Object.entries(entries)) {
      const text = "process.exit(0);\n";
      const path = join(wt, ...rel.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      toolingSha256[name] = sha(text);
    }
    const prompt = `implement checkpoint ${n}\n`;
    writeFileSync(join(root, `prompt${n}.txt`), prompt);
    writeFileSync(
      join(root, `worker${n}.mjs`),
      `import { appendFileSync, writeFileSync } from "node:fs";
process.stdin.resume();
process.stdin.on("data", () => undefined);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m1", content: [] } }) + "\\n");
  writeFileSync("src/item${n}.ts", "export const item${n} = true;\\n");
  appendFileSync(${JSON.stringify(workerLogPath)}, Date.now() + "\\n");
  process.stdout.write("", () => process.exit(0));
});
`
    );
    const manifest: ContinuationManifest = {
      schema: "checkpoint-continuation-run/v1",
      run: {
        schema: "checkpoint-run/v1",
        runId: guid(300, n),
        unit: "assistant_message_ids_distinct/v1",
        profile: "coding",
        identity: {
          rootId: ROOT,
          nodeId: plan.nodes[i].id,
          attemptId: `at-${n}`,
          attemptEpoch: 1,
          contentRevision: 1,
          stateRevision: 1,
          executorRef: "exec-1",
          baseRef
        },
        executable: { path: NODE_PATH, sha256: nodeHash },
        gitExecutable: { path: GIT_PATH, sha256: gitHash },
        worktree: wt,
        promptFile: join(root, `prompt${n}.txt`),
        promptSha256: sha(prompt),
        recordDir: rec,
        model: "test-model",
        expected: { units: 5 },
        hard: { units: 10, wallMs: 60_000, outputBytes: 1024 * 1024 },
        providerUsdCap: 0.1,
        planApiUrl: plan.url
      },
      files: [`src/item${n}.ts`],
      focusedTests: ["tests/a.test.ts"],
      nodeExecutable: { path: NODE_PATH, sha256: nodeHash },
      toolingSha256: toolingSha256 as ContinuationManifest["toolingSha256"],
      limits: { wallMs: 180_000, verifierWallMs: 60_000, verifierOutputBytes: 1024 * 1024 }
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const path = join(root, `item${n}.json`);
    writeFileSync(path, bytes);
    items.push(manifest);
    itemPaths.push(path);
    queueItems.push({ manifestPath: path, manifestSha256: sha(bytes) });
  }

  const queue: QueueManifest = {
    schema: "checkpoint-queue-service-manifest/v1",
    queueId: guid(400, 1),
    queueDir,
    planApiUrl: plan.url,
    actor: "queue-operator",
    acceptors: [ACCEPTOR],
    items: queueItems,
    limits: {
      wallMs: 600_000,
      pollMs: 1000,
      reviewWaitMs: options.reviewWaitMs ?? 60_000,
      totalUnits: options.totalUnits ?? 40,
      totalOutputBytes: 8 * 1024 * 1024,
      totalProviderCapMicros: 1_000_000
    }
  };
  const manifestPath = join(root, "queue.json");
  const write = () => {
    const bytes = Buffer.from(JSON.stringify(queue));
    writeFileSync(manifestPath, bytes);
    return bytes;
  };
  write();

  const fixture: QueueFixture = {
    root,
    main,
    queueDir,
    plan,
    items,
    itemPaths,
    queue,
    manifestPath,
    workerLog: () => {
      try {
        return readFileSync(workerLogPath, "utf8").split("\n").filter(Boolean).map(Number);
      } catch {
        return [];
      }
    },
    worktree: (index) => join(root, `wt${index + 1}`),
    bytes: () => readFileSync(manifestPath),
    rewrite: (edit) => {
      edit(queue);
      return write();
    },
    deps: (extra = {}) => ({
      // Polling cadence is a test seam only; the manifest still enforces the real minimum.
      sleep: async () => {
        await delay(25);
      },
      continuationDeps: (index) => ({
        runWorker: (input, deps) =>
          runCheckpoint(input, {
            ...deps,
            launchArgs: [join(root, `worker${index + 1}.mjs`)],
            tickMs: 200
          })
      }),
      ...extra
    }),
    record: () => {
      try {
        return JSON.parse(
          readFileSync(queueRecordPath(queueDir, queue.queueId), "utf8")
        ) as QueueRecord;
      } catch {
        return undefined;
      }
    },
    cleanup: async () => {
      await plan.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  };
  return fixture;
}

/** Polls the retained record until `predicate` holds, failing loudly instead of hanging. */
export async function waitForRecord(
  fx: QueueFixture,
  predicate: (record: QueueRecord) => boolean,
  timeoutMs = 60_000
): Promise<QueueRecord> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const record = fx.record();
    if (record && predicate(record)) return record;
    if (Date.now() > end) throw new Error("timed out waiting for the queue record");
    await delay(25);
  }
}
