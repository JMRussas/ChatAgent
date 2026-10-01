import "../config/loadEnv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parsePositiveIntEnv } from "../config/runtimeEnv";
import {
  buildGoldenReport,
  type GoldenCase,
  type GoldenCaseResult,
  goldenSuiteSchema,
  renderGoldenReportMarkdown
} from "./golden";

interface MessageResponse {
  fastResponse: {
    provisionalReply: string;
    processingStatus: "provisional" | "complete";
    analysis: {
      routeDecision: "direct" | "deep" | "clarify";
    };
  };
}

interface TimelineEvent {
  type: "user" | "provisional" | "refined";
  text: string;
  createdAtIso: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok) {
    throw new Error(
      body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`
    );
  }

  return body;
}

async function getTimeline(baseUrl: string, conversationId: string): Promise<TimelineEvent[]> {
  const response = await fetch(
    `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/events`
  );
  if (!response.ok) {
    throw new Error(`Timeline request failed (${response.status})`);
  }

  const payload = (await response.json()) as { events?: TimelineEvent[] };
  return Array.isArray(payload.events) ? payload.events : [];
}

function includesAll(text: string, expected: string[] | undefined): boolean {
  if (!expected || expected.length === 0) return true;
  const lower = text.toLowerCase();
  return expected.every((token) => lower.includes(token.toLowerCase()));
}

function includesAny(text: string, denied: string[] | undefined): boolean {
  if (!denied || denied.length === 0) return false;
  const lower = text.toLowerCase();
  return denied.some((token) => lower.includes(token.toLowerCase()));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

async function evaluateCase(
  baseUrl: string,
  goldenCase: GoldenCase,
  index: number,
  deepTimeoutMs: number,
  pollIntervalMs: number
): Promise<GoldenCaseResult> {
  const conversationId = `golden-${goldenCase.id}-${Date.now()}-${index}`;
  const start = Date.now();
  const failures: string[] = [];

  let messageResponse: MessageResponse;

  try {
    messageResponse = await postJson<MessageResponse>(`${baseUrl}/messages`, {
      conversationId,
      userId: "golden-eval",
      text: goldenCase.prompt
    });
  } catch (error) {
    return {
      id: goldenCase.id,
      prompt: goldenCase.prompt,
      expectedRoute: goldenCase.expectedRoute,
      actualRoute: goldenCase.expectedRoute,
      expectedPhase: goldenCase.expectedPhase,
      fastReply: "",
      fastLatencyMs: Date.now() - start,
      passed: false,
      failures: [`/messages failed: ${(error as Error).message}`]
    };
  }

  const fastLatencyMs = Date.now() - start;
  const actualRoute = messageResponse.fastResponse.analysis.routeDecision;
  const fastReply = messageResponse.fastResponse.provisionalReply ?? "";

  if (actualRoute !== goldenCase.expectedRoute) {
    failures.push(`Route mismatch. expected=${goldenCase.expectedRoute}, actual=${actualRoute}`);
  }

  if (!fastReply.trim()) {
    failures.push("Fast reply is empty.");
  }

  if (!includesAll(fastReply, goldenCase.expectedFastMustInclude)) {
    failures.push("Fast reply missing expected content tokens.");
  }

  if (includesAny(fastReply, goldenCase.expectedFastMustNotInclude)) {
    failures.push("Fast reply contains denied content token.");
  }

  const normalizedPrompt = normalizeText(goldenCase.prompt);
  const normalizedFastReply = normalizeText(fastReply);

  if (actualRoute === "clarify") {
    if (!fastReply.includes("?")) {
      failures.push("Clarify reply should ask a question.");
    }

    if (normalizedFastReply === normalizedPrompt) {
      failures.push("Clarify reply echoed prompt instead of asking a clarifying question.");
    }
  }

  if (actualRoute === "direct") {
    if (normalizedFastReply === normalizedPrompt) {
      failures.push("Direct reply echoed prompt instead of answering.");
    }
  }

  if (
    typeof goldenCase.maxFastLatencyMs === "number" &&
    fastLatencyMs > goldenCase.maxFastLatencyMs
  ) {
    failures.push(
      `Fast latency ${fastLatencyMs}ms exceeded maxFastLatencyMs ${goldenCase.maxFastLatencyMs}ms.`
    );
  }

  if (
    goldenCase.expectedPhase === "fast-only" &&
    messageResponse.fastResponse.processingStatus !== "complete"
  ) {
    failures.push(
      `Expected fast-only complete status but got ${messageResponse.fastResponse.processingStatus}.`
    );
  }

  if (
    goldenCase.expectedPhase === "deep-required" &&
    messageResponse.fastResponse.processingStatus !== "provisional"
  ) {
    failures.push(
      `Expected deep-required provisional status but got ${messageResponse.fastResponse.processingStatus}.`
    );
  }

  let refinedReply: string | undefined;
  let endToEndLatencyMs: number | undefined;

  if (goldenCase.expectedPhase === "deep-required") {
    const deadline = Date.now() + deepTimeoutMs;

    while (Date.now() < deadline) {
      const events = await getTimeline(baseUrl, conversationId);
      const refined = [...events].reverse().find((event) => event.type === "refined");
      if (refined) {
        refinedReply = refined.text;
        endToEndLatencyMs = Date.now() - start;
        break;
      }

      // Keep deep path moving in deterministic environments.
      await postJson(`${baseUrl}/workers/deep/run-once`, {});
      await sleep(pollIntervalMs);
    }

    if (!refinedReply) {
      failures.push(`No refined response observed within ${deepTimeoutMs}ms.`);
    } else if (!includesAll(refinedReply, goldenCase.expectedRefinedMustInclude)) {
      failures.push("Refined reply missing expected content tokens.");
    }

    if (
      typeof goldenCase.maxEndToEndLatencyMs === "number" &&
      typeof endToEndLatencyMs === "number" &&
      endToEndLatencyMs > goldenCase.maxEndToEndLatencyMs
    ) {
      failures.push(
        `End-to-end latency ${endToEndLatencyMs}ms exceeded maxEndToEndLatencyMs ${goldenCase.maxEndToEndLatencyMs}ms.`
      );
    }
  }

  return {
    id: goldenCase.id,
    prompt: goldenCase.prompt,
    expectedRoute: goldenCase.expectedRoute,
    actualRoute,
    expectedPhase: goldenCase.expectedPhase,
    fastReply,
    refinedReply,
    fastLatencyMs,
    endToEndLatencyMs,
    passed: failures.length === 0,
    failures
  };
}

async function main() {
  const goldenSetPath = process.env.GOLDEN_SET_PATH ?? "data/golden-prompts.json";
  const baseUrl = process.env.GOLDEN_BASE_URL ?? "http://localhost:3100";
  const reportJsonPath = process.env.GOLDEN_REPORT_JSON_PATH ?? "reports/golden-eval.json";
  const reportMdPath = process.env.GOLDEN_REPORT_MD_PATH ?? "reports/golden-eval.md";
  const deepTimeoutMs = parsePositiveIntEnv(
    process.env.GOLDEN_DEEP_TIMEOUT_MS,
    120_000,
    1000,
    300_000
  );
  const pollIntervalMs = parsePositiveIntEnv(process.env.GOLDEN_POLL_INTERVAL_MS, 400, 100, 10_000);

  const raw = await readFile(goldenSetPath, "utf8");
  const parsed = JSON.parse(raw);
  const suite = goldenSuiteSchema.parse(parsed);

  const results: GoldenCaseResult[] = [];
  for (let index = 0; index < suite.length; index += 1) {
    const result = await evaluateCase(baseUrl, suite[index], index, deepTimeoutMs, pollIntervalMs);
    results.push(result);
  }

  const report = buildGoldenReport(baseUrl, results);
  const markdown = renderGoldenReportMarkdown(report);

  await mkdir("reports", { recursive: true });
  await writeFile(reportJsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(reportMdPath, markdown, "utf8");

  console.log(`Golden eval JSON report written to ${reportJsonPath}`);
  console.log(`Golden eval markdown report written to ${reportMdPath}`);
  console.log(`Overall result: ${report.failed === 0 ? "PASS" : "FAIL"}`);

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
