import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { BenchmarkPrompt } from "./benchmarkCore";
import type { ChatTimelineEvent, OrchestratorResponse, RouteDecision } from "../domain/types";
import { digest, redact } from "../eval/recording/contract";

export interface LiveBenchmarkOptions {
  baseUrl: string;
  deadlineMs?: number;
  pollIntervalMs?: number;
  /** Equal labels share a fresh conversation within this batch only. */
  conversationGroups?: readonly string[];
  /** Sent with every request, for example a client bearer Authorization header. */
  headers?: Readonly<Record<string, string>>;
}
export interface LiveBenchmarkRecord {
  evidenceMode: "live" | "synthetic" | "mixed" | "unknown";
  promptId: string;
  messageId: string;
  conversationId: string;
  routeDecision: RouteDecision | null;
  requestStartedAtIso: string;
  responseReceivedMs: number | null;
  firstAnswerObservedMs: number | null;
  finalObservedMs: number | null;
  elapsedMs: number;
  firstUsefulAnswerMs: null;
  outcome: "stop" | "length" | "cancelled" | "error" | "deadline" | "transport-error";
  retryCount: number;
  httpStatus: number | null;
  errorCode: string | null;
  selectionExclusions?: Array<{ bindingId: string; reasons: string[] }>;
  attempts: Array<{
    attemptId: string;
    phase: string | null;
    provider: string | null;
    model: string | null;
    bindingId: string | null;
    bindingRevision: string | null;
    finishReason: string | null;
    queueMs: null;
    providerMs: null;
  }>;
  responseHash: string | null;
  quality: null;
  usage: null;
  costUsd: null;
  cancellation: "not-requested" | "acknowledged" | "unconfirmed";
}

class BenchmarkHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly exclusions?: LiveBenchmarkRecord["selectionExclusions"]
  ) {
    super("BENCH_HTTP_ERROR");
  }
}

/** One actual server configuration. HTTP observation timings include polling/transport delay.
 * No provider duration, useful-answer judgment, or quality score is inferred from routing.
 */
export async function runLiveBenchmark(
  prompts: BenchmarkPrompt[],
  options: LiveBenchmarkOptions
): Promise<LiveBenchmarkRecord[]> {
  const deadlineMs = options.deadlineMs ?? 120000,
    pollMs = options.pollIntervalMs ?? 100;
  for (const value of [deadlineMs, pollMs]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
      throw new Error("Invalid benchmark timing");
  }
  if (
    options.conversationGroups &&
    (options.conversationGroups.length !== prompts.length ||
      options.conversationGroups.some((g) => !/^[a-zA-Z0-9_.-]{1,120}$/.test(g)))
  )
    throw new Error("Invalid conversation groups");
  const conversations = new Map<string, string>();
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const records: LiveBenchmarkRecord[] = [];
  for (const [index, prompt] of prompts.entries()) {
    const group = options.conversationGroups?.[index];
    const conversationId = (group && conversations.get(group)) || `bench-${randomUUID()}`,
      messageId = randomUUID();
    if (group) conversations.set(group, conversationId);
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const record: LiveBenchmarkRecord = {
      evidenceMode: "unknown",
      promptId: prompt.id,
      messageId,
      conversationId,
      routeDecision: null,
      requestStartedAtIso: new Date().toISOString(),
      responseReceivedMs: null,
      firstAnswerObservedMs: null,
      finalObservedMs: null,
      elapsedMs: 0,
      firstUsefulAnswerMs: null,
      outcome: "deadline",
      retryCount: 0,
      httpStatus: null,
      errorCode: null,
      attempts: [],
      responseHash: null,
      quality: null,
      usage: null,
      costUsd: null,
      cancellation: "not-requested"
    };
    const elapsed = () => Math.max(0, performance.now() - started);
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        headers: {
          ...options.headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          code?: unknown;
          exclusions?: unknown;
        } | null;
        const code =
          typeof payload?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(payload.code)
            ? payload.code
            : null;
        // Keep bounded safe identifiers/codes, never arbitrary server error text.
        const exclusions =
          code === "NO_ELIGIBLE_MODEL" && Array.isArray(payload?.exclusions)
            ? payload.exclusions.slice(0, 100).flatMap((item) => {
                if (!item || typeof item.bindingId !== "string" || !Array.isArray(item.reasons))
                  return [];
                return [
                  {
                    bindingId: redact(item.bindingId).slice(0, 512),
                    reasons: item.reasons
                      .filter(
                        (r: unknown): r is string =>
                          typeof r === "string" &&
                          /^(?:[A-Z][A-Z0-9_]{0,79}|disabled|unsupported-adapter|unchecked|stale|denied|unavailable)$/.test(
                            r
                          )
                      )
                      .slice(0, 30)
                  }
                ];
              })
            : undefined;
        throw new BenchmarkHttpError(response.status, code, exclusions);
      }
      return (await response.json()) as T;
    };
    // Handle rejection immediately; observation runs while POST /messages is still generating.
    const submissionState: { settled: boolean; error?: unknown } = { settled: false };
    const submission = (async () => {
      try {
        const submitted = await request<OrchestratorResponse>("/messages", {
          conversationId,
          messageId,
          userId: "benchmark-runner",
          text: prompt.text
        });
        record.responseReceivedMs = elapsed();
        if (submitted.messageId !== messageId) throw new Error("BENCH_CORRELATION_ERROR");
        const route = submitted.fastResponse.analysis.routeDecision;
        if (!["direct", "deep", "clarify"].includes(route)) throw new Error("BENCH_ROUTE_ERROR");
        record.routeDecision = route;
      } catch (error) {
        submissionState.error = error;
        if (error instanceof BenchmarkHttpError) {
          record.responseReceivedMs = elapsed();
          record.httpStatus = error.status;
          record.errorCode = error.code;
          if (error.exclusions) record.selectionExclusions = error.exclusions;
        }
      } finally {
        submissionState.settled = true;
      }
    })();
    let terminalObserved = false;
    try {
      while (!controller.signal.aborted && elapsed() < deadlineMs) {
        // On failed submission, collect at least one snapshot requested after settlement.
        const submissionSettledBeforePoll = submissionState.settled;
        const payload = await request<{ events: ChatTimelineEvent[] }>(
          `/conversations/${conversationId}/events`
        );
        const events = payload.events.filter((e) => e.messageId === messageId);
        const observed = elapsed();
        const route = events.find((e) => e.type === "user")?.routeDecision;
        if (route && ["direct", "deep", "clarify"].includes(route)) record.routeDecision = route;
        if (observed >= deadlineMs) break;
        if (
          record.firstAnswerObservedMs === null &&
          events.some(
            (e) =>
              e.text.length > 0 &&
              (e.type === "delta" ||
                ((e.type === "provisional" || e.type === "refined") &&
                  e.answerKind === "substantive"))
          )
        ) {
          record.firstAnswerObservedMs = observed;
        }
        const ids = [...new Set(events.flatMap((e) => (e.attemptId ? [e.attemptId] : [])))];
        record.attempts = ids.map((attemptId) => {
          const attempt = events.filter((e) => e.attemptId === attemptId);
          const model = attempt.find((e) => e.model)?.model;
          const label = (value: string | undefined) =>
            value === undefined ? null : redact(value).slice(0, 512);
          return {
            attemptId,
            phase: attempt[0].phase ?? null,
            provider: label(model?.provider),
            model: label(model?.model),
            bindingId: label(model?.bindingId),
            bindingRevision: label(model?.selection?.revision),
            finishReason: attempt.find((e) => e.type === "terminal")?.finishReason ?? null,
            queueMs: null,
            providerMs: null
          };
        });
        const providers = new Set(
          record.attempts.flatMap((a) =>
            a.provider ? [a.provider === "mock" ? "synthetic" : "live"] : []
          )
        );
        record.evidenceMode =
          providers.size > 1
            ? "mixed"
            : providers.has("live")
              ? "live"
              : providers.has("synthetic")
                ? "synthetic"
                : "unknown";
        record.retryCount = ["fast", "deep"].reduce(
          (n, phase) =>
            n + Math.max(0, record.attempts.filter((a) => a.phase === phase).length - 1),
          0
        );
        const requiredPhases = record.routeDecision === "deep" ? ["fast", "deep"] : ["fast"];
        const terminals = requiredPhases.map((phase) =>
          [...events]
            .reverse()
            .find((e) => e.phase === phase && e.type === "terminal" && !e.retrying)
        );
        if (
          record.routeDecision !== null &&
          terminals.every(
            (e) => e && ["stop", "length", "cancelled", "error"].includes(e.finishReason ?? "")
          )
        ) {
          record.outcome = terminals.some((e) => e?.finishReason === "error")
            ? "error"
            : terminals.some((e) => e?.finishReason === "cancelled")
              ? "cancelled"
              : terminals.some((e) => e?.finishReason === "length")
                ? "length"
                : "stop";
          terminalObserved = true;
          record.finalObservedMs = observed;
          const terminal = terminals[terminals.length - 1]!;
          const answer = [...events]
            .reverse()
            .find(
              (e) =>
                e.attemptId === terminal.attemptId &&
                e.phase === terminal.phase &&
                e.type === (record.routeDecision === "deep" ? "refined" : "provisional") &&
                e.answerKind === "substantive"
            );
          record.responseHash = answer ? digest(answer.text) : null;
          break;
        }
        if (submissionSettledBeforePoll && submissionState.error) break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(pollMs, Math.max(0, deadlineMs - elapsed())))
        );
      }
      await submission;
      if (submissionState.error) throw submissionState.error;
    } catch (error) {
      if (error instanceof BenchmarkHttpError) {
        record.httpStatus ??= error.status;
        record.errorCode ??= error.code;
        if (error.exclusions) record.selectionExclusions = error.exclusions;
      }
      record.outcome =
        controller.signal.aborted || elapsed() >= deadlineMs
          ? "deadline"
          : record.httpStatus !== null
            ? "error"
            : "transport-error";
    } finally {
      controller.abort();
      await submission;
      clearTimeout(timer);
      record.elapsedMs = elapsed();
      // A client deadline does not itself stop remote work. Request bounded cleanup and report its result.
      if (!terminalObserved) {
        record.cancellation = "unconfirmed";
        try {
          const response = await fetch(
            `${baseUrl}/conversations/${conversationId}/messages/${messageId}/cancel`,
            { method: "POST", headers: { ...options.headers }, signal: AbortSignal.timeout(5000) }
          );
          if (response.ok) record.cancellation = "acknowledged";
        } catch {
          /* No claim of server or provider cancellation without acknowledgment. */
        }
      }
    }
    records.push(record);
    // Do not pile new requests onto a server whose previous turn could still be running.
    if (
      record.cancellation === "unconfirmed" ||
      (options.conversationGroups && record.outcome !== "stop")
    )
      break;
  }
  return records;
}
