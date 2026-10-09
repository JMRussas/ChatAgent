// TEST ONLY. A scriptable stand-in for Hekate's `e1.owned_dispatch` status/launch/stop
// commands. It prints what a scenario file says and records each call; it starts no
// dispatcher, opens no store and talks to nothing. Behaviour comes from
// <state-dir>/fake/scenario.json and <state-dir>/fake/status.json.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const stateDir = flag("--state-dir");
const dir = join(stateDir, "fake");
mkdirSync(dir, { recursive: true });
const read = (name) => {
  const file = join(dir, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};
const scenario = read("scenario.json") ?? {};
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const hang = () => setInterval(() => {}, 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

appendFileSync(
  join(dir, "invocations.jsonl"),
  JSON.stringify({
    command,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: Object.keys(process.env),
    workspace: process.env.HEKATE_E1_CONTAINER_WORKSPACE ?? null,
    traceRootSet: "HEKATE_TRACE_ROOT" in process.env,
    // Test values only: the cache path, and the names of any other npm variable that arrived.
    npmCache: process.env.npm_config_cache ?? null,
    npmKeys: Object.keys(process.env).filter((key) => key.toLowerCase().startsWith("npm_")),
    pid: process.pid
  }) + "\n"
);
writeFileSync(join(dir, `${command}.pid`), String(process.pid));

// What the maintained `plan_cli.check_run_inputs` and `harness.container_workspace_label`
// demand of a real `launch`, enforced here so a positive launch proves the adapter supplies
// them. `scenario.enforce === false` switches this off for a test that needs the bare fake.
const ORIGINAL_WORKSPACE = "D:\\Git\\Hekate";
const normPath = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const LAUNCH_FLAGS = new Set([
  "--state-dir",
  "--plan",
  "--plan-sha256",
  "--run-root",
  "--exe",
  "--exe-sha256",
  "--launch-real-model",
  "--root-go",
  "--worker",
  "--actor",
  "--max-duration-s",
  "--poll-s",
  "--max-poll-s",
  "--heartbeat-s",
  "--max-nodes",
  "--wait-s",
  "--worker-model"
]);
const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
if (command === "launch" && scenario.enforce !== false) {
  const refuse = (code, detail) => {
    print({ refused: code, detail });
    process.exit(2);
  };
  for (const item of rest)
    if (item.startsWith("--") && !LAUNCH_FLAGS.has(item)) refuse("unexpected_flag", item);
  for (const need of [
    "--state-dir",
    "--plan",
    "--plan-sha256",
    "--run-root",
    "--exe",
    "--exe-sha256",
    "--launch-real-model",
    "--root-go"
  ])
    if (!rest.includes(need)) refuse("run_needs", need);
  if (!flag("--root-go")?.trim()) refuse("run_needs", "--root-go");
  if (sha256File(flag("--plan")) !== flag("--plan-sha256")) refuse("plan_pin_mismatch");
  if (sha256File(flag("--exe")) !== flag("--exe-sha256")) refuse("executable_hash_mismatch");
  const model = flag("--worker-model");
  if (model !== undefined && flag("--worker") !== "codex") refuse("worker_model");
  const workspace = process.env.HEKATE_E1_CONTAINER_WORKSPACE;
  const accepted = scenario.acceptedWorkspaces ?? [ORIGINAL_WORKSPACE];
  if (workspace === undefined || !accepted.some((p) => normPath(p) === normPath(workspace))) {
    // The maintained code raises RuntimeError: no JSON, a traceback and a failing exit.
    process.stderr.write(
      "RuntimeError: HEKATE_E1_CONTAINER_WORKSPACE is not set to an owned workspace\n"
    );
    process.exit(1);
  }
}

async function flood(stream, bytes) {
  const chunk = "x".repeat(1024);
  for (let sent = 0; sent < bytes; sent += chunk.length) stream.write(chunk);
  await sleep(50);
}

if (command === "status") {
  const mode = scenario.statusMode;
  if (mode === "hang") hang();
  else if (mode === "flood-stdout") {
    await flood(process.stdout, 200 * 1024);
    hang();
  } else if (mode === "garbage") {
    process.stdout.write("not json at all\n");
  } else if (mode === "exit7") {
    print(read("status.json") ?? {});
    process.exit(7);
  } else {
    const status = read("status.json");
    if (status) print(status);
    else {
      print({ state: "no_status", liveness: null });
      process.exit(2);
    }
  }
} else if (command === "launch") {
  const launch = scenario.launch ?? { mode: "launched" };
  if (launch.delayMs) await sleep(launch.delayMs);
  const launchId = launch.launchId ?? "a".repeat(32);
  if (launch.mode === "launched") {
    if (launch.writeStatus)
      writeFileSync(join(dir, "status.json"), JSON.stringify(launch.writeStatus));
    print({
      launched: true,
      pid: 4242,
      launcherPid: process.pid,
      launchId,
      breakaway: false,
      state: "starting",
      status: join(stateDir, "dispatch", "status.json"),
      log: join(stateDir, "dispatch", "dispatcher.log")
    });
  } else if (launch.mode === "unconfirmed") {
    // The legacy producer sent no ID; one is echoed only when the scenario supplies it
    // (any value, so malformed IDs can be scripted).
    print({
      launched: "unconfirmed",
      pid: 4242,
      ...(launch.launchId !== undefined ? { launchId: launch.launchId } : {}),
      note: "no matching status yet",
      log: join(stateDir, "x.log")
    });
    process.exit(1);
  } else if (launch.mode === "failed") {
    print({ launched: false, exitCode: 3, log: join(stateDir, "x.log") });
    process.exit(1);
  } else if (launch.mode === "refused") {
    print({ refused: launch.refusal ?? "plan_pin_mismatch", detail: { path: stateDir } });
    process.exit(2);
  } else if (launch.mode === "garbage") {
    process.stdout.write("<<< not json\n");
  } else if (launch.mode === "flood-stdout") {
    await flood(process.stdout, 200 * 1024);
    hang();
  } else if (launch.mode === "flood-stderr") {
    await flood(process.stderr, 64 * 1024);
    hang();
  } else if (launch.mode === "hang") {
    hang();
  } else if (launch.mode === "hang-with-child") {
    // A detached grandchild: killing only this launcher must leave it running.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    writeFileSync(join(dir, "grandchild.pid"), String(child.pid));
    child.unref();
    hang();
  }
} else if (command === "stop") {
  const stop = scenario.stop ?? { mode: "requested" };
  // The native fence, as `request_stop` documents it. This is a scripted model of that
  // contract, not proof of the real process or of delivery.
  const expected = flag("--expected-launch-id");
  const refuseStop = (value) => {
    print(value);
    process.exit(2);
  };
  // A swap that lands between the adapter's status read and the native command.
  if (stop.swapOwnerTo) {
    const current = read("status.json") ?? {};
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ ...current, owner: { ...current.owner, launchId: stop.swapOwnerTo } })
    );
  }
  if (scenario.enforce !== false) {
    if (expected === undefined) refuseStop({ refused: "unfenced_stop" });
    if (!/^[0-9a-f]{32}$/.test(expected)) refuseStop({ refused: "invalid_expected_launch_id" });
    const live = read("status.json");
    if (live?.liveness !== "running") refuseStop({ refused: "no_live_owner", state: live?.state });
    if (live.owner?.launchId !== expected)
      refuseStop({ refused: "owner_changed", expectedLaunchId: expected });
  }
  if (stop.mode === "hang") hang();
  else if (stop.mode === "already") {
    print({ refused: "stop_already_requested" });
    process.exit(2);
  } else if (stop.mode === "no_owner") {
    print({ refused: "no_live_owner", state: "exited" });
    process.exit(2);
  } else {
    writeFileSync(join(dir, "stop.request"), JSON.stringify({ requestedBy: flag("--actor") }));
    const out = {
      stopRequested: true,
      note: "graceful: the running node finishes, then no new claim"
    };
    if (stop.echo === undefined) out.targetLaunchId = expected;
    else if (stop.echo === "different") out.targetLaunchId = "c".repeat(32);
    // "missing" leaves the echo out, as an unfenced native answer would.
    print(out);
    if (stop.exitCode !== undefined) process.exit(stop.exitCode);
  }
} else {
  print({ refused: "unknown_command" });
  process.exit(2);
}
