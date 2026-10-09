import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ContinuationManifest,
  ContinuationDeps
} from "../../src/checkpoint/checkpointContinuation";
import { runCheckpoint } from "../../src/checkpoint/checkpointRun";
import type { CoordinationStatus, LeafStatus } from "../../src/integrations/hekate/devCoordination";
import { FENCE, RUN_ID } from "./checkpointFixtures";
import { leaf } from "./executiveFixtures";

/** Real Git, real Node and real stub tooling processes; no model and no running service. */
const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_SCRIPT = join(HERE, "continuationWorker.mjs");

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const findGit = () =>
  realpathSync.native(
    execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)[0]
      .trim()
  );
export const GIT_PATH = findGit();
export const NODE_PATH = realpathSync.native(process.execPath);
let nodeHash: string | undefined;
const nodeSha = () => (nodeHash ??= sha(readFileSync(NODE_PATH)));
let gitHash: string | undefined;
const gitSha = () => (gitHash ??= sha(readFileSync(GIT_PATH)));

export const git = (cwd: string, ...args: string[]) =>
  execFileSync(GIT_PATH, ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const STUB = (name: string, esm: boolean, ctl: string) => `${
  esm
    ? 'import fs from "node:fs"; import { spawn } from "node:child_process";'
    : 'const fs = require("node:fs"); const { spawn } = require("node:child_process");'
}
const CTL = ${JSON.stringify(ctl)};
fs.appendFileSync(CTL + "/tools.log", JSON.stringify({ tool: ${JSON.stringify(name)}, argv: process.argv.slice(2), at: Date.now() }) + "\\n");
const file = CTL + "/mode-${name}";
const mode = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "ok";
if (mode === "fail") { process.stdout.write("SECRET_TOOL_TEXT\\n"); process.exit(1); }
if (mode === "hang") {
  const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  fs.writeFileSync(CTL + "/hang-${name}.pids", JSON.stringify({ child: process.pid, grand: grand.pid }));
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  setInterval(() => process.stdout.write("x".repeat(4096)), 1);
} else process.exit(0);
`;

export class PlanStub {
  leaf: LeafStatus = leaf(1, "in_progress", {
    attemptPins: "current",
    attemptId: FENCE.attemptId,
    attemptEpoch: FENCE.attemptEpoch,
    contentRevision: FENCE.contentRevision,
    executorRef: "exec-1",
    stateRevision: 4
  });
  posts: { url: string; body: Record<string, unknown> }[] = [];
  reads = 0;
  unavailable = false;
  /** ok: transition applied; ignored: 200 without applying; conflict: 409; outage: throws. */
  postMode: "ok" | "ignored" | "conflict" | "outage" = "ok";
  onPost: () => void = () => undefined;

  fetchStatus = async (): Promise<CoordinationStatus> => {
    this.reads++;
    if (this.unavailable) throw new Error("UNAVAILABLE");
    return {
      status: "ok",
      rootId: FENCE.rootId,
      leaves: [this.leaf]
    } as unknown as CoordinationStatus;
  };

  post = async ({ url, body }: { url: string; body: string }) => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    this.posts.push({ url, body: parsed });
    this.onPost();
    if (this.postMode === "outage") throw new Error("UNAVAILABLE");
    if (this.postMode === "conflict") return { status: 409 };
    if (this.postMode === "ok")
      this.leaf = {
        ...this.leaf,
        state: "review_pending",
        artifactRef: String(parsed.artifactRef),
        stateRevision: this.leaf.stateRevision + 1
      };
    return { status: 200 };
  };
}

export interface Fixture {
  root: string;
  main: string;
  wt: string;
  rec: string;
  baseRef: string;
  plan: PlanStub;
  manifest: ContinuationManifest;
  workerCalls: number;
  scenario: string;
  deps: (extra?: ContinuationDeps) => ContinuationDeps;
  toolLog: () => { tool: string; argv: string[]; at: number }[];
  workerExits: () => number[];
  setMode: (tool: string, mode: string) => void;
  write: (rel: string, text: string) => void;
}

export function makeFixture(scenario = "edit"): Fixture {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "ckpt-cont-")));
  const main = join(root, "main");
  const wt = join(root, "wt");
  const rec = join(root, "rec");
  mkdirSync(main);
  mkdirSync(rec);
  const write = (rel: string, text: string) => {
    const path = join(wt, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
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
  seed("src/b.ts", "export const b = 1;\n");
  seed("tests/a.test.ts", "export {};\n");
  seed("docs/x.md", "# x\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  const baseRef = git(main, "rev-parse", "HEAD");
  git(main, "worktree", "add", "-q", "-b", "work", wt);

  const entries = {
    prettier: ["node_modules/prettier/bin/prettier.cjs", false],
    typescript: ["node_modules/typescript/lib/_tsc.js", false],
    vitest: ["node_modules/vitest/vitest.mjs", true]
  } as const;
  const toolingSha256: Record<string, string> = {};
  for (const [name, [rel, esm]] of Object.entries(entries)) {
    const text = STUB(name, esm, root);
    write(rel, text);
    toolingSha256[name] = sha(text);
  }
  const prompt = "implement the declared change\n";
  writeFileSync(join(root, "prompt.txt"), prompt);

  const plan = new PlanStub();
  const manifest: ContinuationManifest = {
    schema: "checkpoint-continuation-run/v1",
    run: {
      schema: "checkpoint-run/v1",
      runId: RUN_ID,
      unit: "assistant_message_ids_distinct/v1",
      profile: "coding",
      identity: { ...FENCE, stateRevision: 4, executorRef: "exec-1", baseRef },
      executable: { path: NODE_PATH, sha256: nodeSha() },
      gitExecutable: { path: GIT_PATH, sha256: gitSha() },
      worktree: wt,
      promptFile: join(root, "prompt.txt"),
      promptSha256: sha(prompt),
      recordDir: rec,
      model: "test-model",
      expected: { units: 5 },
      hard: { units: 10, wallMs: 60_000, outputBytes: 1024 * 1024 },
      planApiUrl: "http://127.0.0.1:1"
    },
    files: ["src/a.ts", "src/new.ts", "docs/x.md", "tests/a.test.ts"],
    focusedTests: ["tests/a.test.ts"],
    nodeExecutable: { path: NODE_PATH, sha256: nodeSha() },
    toolingSha256: toolingSha256 as ContinuationManifest["toolingSha256"],
    limits: { wallMs: 180_000, verifierWallMs: 60_000, verifierOutputBytes: 1024 * 1024 }
  };

  const fixture: Fixture = {
    root,
    main,
    wt,
    rec,
    baseRef,
    plan,
    manifest,
    workerCalls: 0,
    scenario,
    write,
    deps: (extra = {}) => ({
      fetchStatus: plan.fetchStatus,
      post: plan.post,
      runWorker: (input, deps) => {
        fixture.workerCalls++;
        return runCheckpoint(input, {
          ...deps,
          fetchStatus: plan.fetchStatus,
          launchArgs: [WORKER_SCRIPT, fixture.scenario],
          tickMs: 200
        });
      },
      ...extra
    }),
    toolLog: () => {
      try {
        return readFileSync(join(root, "tools.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    workerExits: () => {
      try {
        return readFileSync(join(root, "worker-exit.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(Number);
      } catch {
        return [];
      }
    },
    setMode: (tool, mode) => writeFileSync(join(root, `mode-${tool}`), mode)
  };
  return fixture;
}
