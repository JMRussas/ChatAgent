import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { chromium, expect } from "@playwright/test";

// Read-only, headless, finite check of the real product UI through the lead's already paired
// browser state. It never launches, stops or mutates anything, never mocks a route and never
// forges authentication. The final task's mode comes only from its recorded status.
const URL_BASE = "http://127.0.0.1:5133/";
const ROOT = "b556d4ce-b813-50fa-8ac5-3633297518a6";
const PROGRESS_NODE = "9bc28ff4-829f-5eb6-8b8e-4932f9f960cf";
const ARTIFACT = "15528e5ac76634220ad4de69bb504350b6f82a8d";
const FINAL_NODE = "21dcea12-cb65-54cf-8581-e2f896490139";
const STATE_FILE =
  "D:/hekate-coordinator/runs/conversation-rehearsal-001/.private-browser-state.json";
const PREFLIGHT = "D:/hekate-coordinator/runs/conversation-rehearsal-001/rehearsal-preflight.json";
const EXPECTED_PREFLIGHT_SHA = "259c3bcdf8df9429c0f9a4203827dc1f86a25097b63ff30240c9a34bfc9414fa";
const PREFLIGHT_FLAGS = [
  "actualUiLaunch",
  "duplicateRefusal",
  "gracefulStop",
  "lateOldRequestIgnored"
];
const TOOLS = new Set(["Read", "Glob", "Grep", "Edit", "Write"]);
const DEADLINE_MS = 120_000;
const STEP_MS = 20_000;

const fail = (message) => {
  throw new Error(message);
};
const check = (condition, message) => condition || fail(message);

const statusPath = `/development/plans/${ROOT}/status`;
const progressPath = (node) => `/development/plans/${ROOT}/nodes/${node}/progress`;
const allowedDevelopment = new Set([
  `GET ${statusPath}`,
  `GET ${progressPath(PROGRESS_NODE)}`,
  `GET ${progressPath(FINAL_NODE)}`
]);

function verifyPreflight() {
  check(
    /^[0-9a-f]{64}$/.test(EXPECTED_PREFLIGHT_SHA) && !/^(.)\1{63}$/.test(EXPECTED_PREFLIGHT_SHA),
    "EXPECTED_PREFLIGHT_SHA is not pinned by the lead"
  );
  check(statSync(PREFLIGHT).size <= 1024 * 1024, "preflight manifest too large");
  const bytes = readFileSync(PREFLIGHT);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  check(sha256 === EXPECTED_PREFLIGHT_SHA, "preflight manifest hash differs from the pin");
  const manifest = JSON.parse(bytes.toString("utf8"));
  for (const flag of PREFLIGHT_FLAGS)
    check(manifest?.[flag] === true, `preflight ${flag} is not true`);
  return { sha256, flags: PREFLIGHT_FLAGS };
}

function leafOf(status, node) {
  check(
    status?.status === "ok" && status.rootId === ROOT && Array.isArray(status.leaves),
    "status shape"
  );
  const leaf = status.leaves.find((entry) => entry?.nodeId === node);
  return check(leaf, `task ${node} absent from plan status`) && leaf;
}

// Mode comes only from the recorded status; nothing the caller passes can change it.
function finalMode(leaf) {
  if (leaf.attemptId === null && (leaf.state === "ready" || leaf.state === "blocked")) {
    return "reference_preflight";
  }
  check(
    typeof leaf.attemptId === "string" &&
      Number.isSafeInteger(leaf.attemptEpoch) &&
      ["in_progress", "review_pending", "accepted"].includes(leaf.state),
    `final task state ${String(leaf.state)} is neither unattempted nor an attempted native state`
  );
  return "native_verification";
}

function artifactMatches(ref) {
  return ref === ARTIFACT || ref === `git:${ARTIFACT}`;
}

function summarize(progress, node, expectedLeaf) {
  check(progress?.schema === "attempt-progress/v1", "progress schema");
  check(progress.rootId === ROOT && progress.nodeId === node, "progress identity");
  check(progress.consistency === "current", "progress sample is stale or partial");
  const { task, selectedAttempt: sel, trace, assessment, activity, acceptance } = progress;
  check(sel?.scope === "current" && sel.contentPins === "current", "attempt is not current");
  check(
    task?.attemptId === sel.attemptId && task.attemptEpoch === sel.attemptEpoch,
    "attempt/epoch binding"
  );
  if (expectedLeaf) {
    check(
      task.attemptId === expectedLeaf.attemptId && task.attemptEpoch === expectedLeaf.attemptEpoch,
      "progress attempt differs from recorded status"
    );
  }
  check(trace?.integrity === "verified" && trace.claimLinkage === "matched", "trace not verified");
  check(
    assessment?.workerLiveness === "unknown" && assessment.usefulProgress === "unknown",
    "liveness/useful progress must stay unknown"
  );
  check(
    activity?.trust === "untrusted_inert_unverified_worker_claims" && Array.isArray(activity.items),
    "activity trust"
  );
  const kinds = { text: 0, tool_use: 0 };
  for (const item of activity.items) {
    check(item.kind in kinds, "activity kind");
    kinds[item.kind] += 1;
    if (item.kind === "tool_use") check(TOOLS.has(item.tool), "activity tool outside fixed set");
  }
  const decision = acceptance?.decision ?? null;
  const accepted =
    decision === "accepted" &&
    task.effectiveAcceptance === "accepted" &&
    acceptance.attemptId === task.attemptId &&
    acceptance.attemptEpoch === task.attemptEpoch &&
    acceptance.contentRevision === task.contentRevision &&
    acceptance.taskArtifact?.state === "shown" &&
    acceptance.decisionArtifact?.state === "shown" &&
    acceptance.taskArtifact.ref === acceptance.decisionArtifact.ref;
  return {
    nodeId: node,
    observedAt: progress.observedAt,
    consistency: progress.consistency,
    attemptId: task.attemptId,
    attemptEpoch: task.attemptEpoch,
    work: task.work,
    attemptContentRevision: task.attemptContentRevision,
    contentRevision: task.contentRevision,
    stateRevision: task.stateRevision,
    scope: sel.scope,
    contentPins: sel.contentPins,
    trace: { status: trace.status, integrity: trace.integrity, claimLinkage: trace.claimLinkage },
    recordedDecision: decision,
    acceptedForThisAttempt: accepted,
    taskArtifactState: acceptance?.taskArtifact?.state ?? null,
    taskArtifactMatchesPin: artifactMatches(acceptance?.taskArtifact?.ref),
    evidence: (progress.evidence ?? []).map((entry) => ({ ref: entry.ref, sha256: entry.sha256 })),
    activityCounts: { ...kinds, total: activity.items.length },
    workerLiveness: assessment.workerLiveness,
    usefulProgress: assessment.usefulProgress
  };
}

async function main(outputDir, preflight) {
  const requests = [];
  const pageErrors = [];
  let phase = "load";
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_MS);
    page.on("pageerror", () => pageErrors.push("pageerror"));
    page.on("request", (request) => {
      const url = new globalThis.URL(request.url());
      requests.push({ phase, method: request.method(), origin: url.origin, path: url.pathname });
    });
    const assertClean = (opts = {}) => {
      for (const r of requests) {
        check(
          r.origin + "/" === URL_BASE || r.origin === "null" || r.origin === "data:",
          `foreign request ${r.origin}`
        );
        check(!r.path.includes("/messages"), `request to ${r.path.replace(ROOT, ":root")}`);
        if (r.path.startsWith("/development")) {
          check(
            allowedDevelopment.has(`${r.method} ${r.path}`),
            `unexpected development ${r.method} request`
          );
        }
      }
      if (opts.noDevelopment) {
        const early = requests.filter(
          (r) => r.phase === opts.noDevelopment && r.path.startsWith("/development")
        );
        check(
          early.length === 0,
          `development requests before an explicit action in ${opts.noDevelopment}`
        );
      }
    };

    const refresh = async () => {
      await page.locator("#planStatusPanel").evaluate((el) => (el.open = true));
      await page.locator("#attemptProgress").evaluate((el) => (el.open = true));
      const [response] = await Promise.all([
        page.waitForResponse((r) => new globalThis.URL(r.url()).pathname === statusPath),
        page.locator("#planRefresh").click()
      ]);
      check(response.status() === 200, "plan status read failed");
      await expect(page.locator("#planRefresh")).toBeEnabled();
      await expect(page.locator("#progressTask option[value='" + FINAL_NODE + "']")).toHaveCount(1);
      return response.json();
    };
    const readProgress = async (node) => {
      await page.locator("#progressTask").focus();
      await page.locator("#progressTask").selectOption(node);
      const [response] = await Promise.all([
        page.waitForResponse((r) => new globalThis.URL(r.url()).pathname === progressPath(node)),
        page.locator("#progressRead").click()
      ]);
      check(response.status() === 200, `progress read failed for ${node}`);
      check(response.headers()["cache-control"] === "no-store", "progress is not no-store");
      const projection = await response.json();
      await expect(page.locator("#progressRead")).toBeEnabled();
      await expect(page.locator("#progressView")).toContainText("Task: " + node);
      await expect(page.locator("#progressView")).toContainText(projection.task.attemptId);
      return projection;
    };

    await page.goto(URL_BASE, { waitUntil: "load" });
    check(page.url() === URL_BASE, "page URL carries a path, query or credential");
    assertClean({ noDevelopment: "load" });

    await page.locator("#planStatusPanel").evaluate((el) => (el.open = true));
    await page.locator("#planRoot").fill(ROOT);
    phase = "explicit";
    const status = await refresh();
    const progressLeaf = leafOf(status, PROGRESS_NODE);
    const finalLeaf = leafOf(status, FINAL_NODE);
    check(progressLeaf.attemptId !== null, "progress node has no recorded attempt");

    const progress = summarize(await readProgress(PROGRESS_NODE), PROGRESS_NODE, progressLeaf);
    check(progressLeaf.state === "accepted", "progress node is not recorded as accepted");
    check(
      progress.acceptedForThisAttempt && progress.taskArtifactMatchesPin,
      "accepted progress artifact not shown"
    );
    check(progress.activityCounts.total > 0, "no public activity items");

    const mode = finalMode(finalLeaf);
    let final = null;
    if (mode === "native_verification")
      final = summarize(await readProgress(FINAL_NODE), FINAL_NODE, finalLeaf);
    await page.locator("#progressView").screenshot({ path: join(outputDir, "progress-ui.png") });
    assertClean();

    phase = "reload";
    await page.reload({ waitUntil: "load" });
    assertClean({ noDevelopment: "reload" });
    check(
      (await page.locator("#planRoot").inputValue()) === ROOT,
      "root not restored after reload"
    );
    phase = "after_reload_explicit";
    const again = leafOf(await refresh(), PROGRESS_NODE);
    check(again.attemptId === progressLeaf.attemptId, "attempt changed across reload");
    summarize(await readProgress(PROGRESS_NODE), PROGRESS_NODE, again);
    assertClean();

    const counts = {};
    for (const r of requests) {
      const key = `${r.phase} ${r.method} ${r.path.replaceAll(ROOT, ":root").replaceAll(PROGRESS_NODE, ":progressNode").replaceAll(FINAL_NODE, ":finalNode")}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    check(pageErrors.length === 0, "browser page errors");
    const report = {
      pageErrors,
      checkedAt: new Date().toISOString(),
      product: URL_BASE,
      rootId: ROOT,
      acceptedArtifactPin: ARTIFACT,
      preflight,
      progressNode: progress,
      finalTask: { nodeId: FINAL_NODE, mode, recordedState: finalLeaf.state, native: final },
      requests: counts,
      notClaimed: [
        "integration",
        "worker liveness",
        "useful progress",
        "final acceptance before a recorded decision"
      ]
    };
    writeFileSync(join(outputDir, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ evidence: outputDir, mode, ok: true }));
  } finally {
    await browser.close();
  }
}

const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
const outputDir = join(
  dirname(process.cwd()),
  `conversation-rehearsal-${basename(process.cwd())}-${stamp}-${process.pid}`
);
const timer = setTimeout(() => {
  console.error("deadline exceeded");
  process.exit(1);
}, DEADLINE_MS);
try {
  const preflight = verifyPreflight();
  mkdirSync(outputDir);
  await main(outputDir, preflight);
} catch (error) {
  console.error(
    `conversation rehearsal check failed: ${String(error?.message ?? error).split("\n")[0]}`
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
