import type { BenchmarkProfile, BenchmarkPrompt, BenchmarkRunRecord } from "./benchmarkCore";

export interface LiveBenchmarkOptions {
  baseUrl: string;
  maxWorkerRunsPerPrompt?: number;
  maxEventPolls?: number;
}

function nowMs(): number {
  return Date.now();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return (await response.json()) as T;
}

async function postNoBody<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return (await response.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return (await response.json()) as T;
}

function qualityFromRoute(route: "direct" | "deep" | "clarify"): number {
  if (route === "deep") return 4.5;
  if (route === "clarify") return 4.0;
  return 4.2;
}

export async function runLiveBenchmark(
  profile: BenchmarkProfile,
  prompts: BenchmarkPrompt[],
  options: LiveBenchmarkOptions
): Promise<BenchmarkRunRecord[]> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const maxWorkerRunsPerPrompt = options.maxWorkerRunsPerPrompt ?? 4;
  const maxEventPolls = options.maxEventPolls ?? 4;

  const records: BenchmarkRunRecord[] = [];

  for (const prompt of prompts) {
    const conversationId = `bench-${profile.name}-${prompt.id}-${nowMs()}`;

    const firstStart = nowMs();
    const messageResponse = await postJson<{
      fastResponse: { analysis: { routeDecision: "direct" | "deep" | "clarify" } };
    }>(`${baseUrl}/messages`, {
      conversationId,
      userId: "benchmark-runner",
      text: prompt.text
    });
    const firstResponseLatencyMs = nowMs() - firstStart;

    const routeDecision = messageResponse.fastResponse.analysis.routeDecision;
    let retryCount = 0;
    let deadLettered = false;
    let finalLatencyMs = firstResponseLatencyMs;

    if (routeDecision === "deep") {
      const deepStart = nowMs();

      for (let i = 0; i < maxWorkerRunsPerPrompt; i += 1) {
        await postNoBody<{ result: unknown }>(`${baseUrl}/workers/deep/run-once`);
        retryCount = i;

        const eventsPayload = await getJson<{ events: Array<{ type: string }> }>(
          `${baseUrl}/conversations/${conversationId}/events`
        );

        if (eventsPayload.events.some((e) => e.type === "refined")) {
          break;
        }
      }

      for (let i = 0; i < maxEventPolls; i += 1) {
        const eventsPayload = await getJson<{ events: Array<{ type: string }> }>(
          `${baseUrl}/conversations/${conversationId}/events`
        );

        if (eventsPayload.events.some((e) => e.type === "refined")) {
          break;
        }

        if (i === maxEventPolls - 1) {
          const dlq = await getJson<{ records: Array<{ task: { conversationId: string } }> }>(
            `${baseUrl}/workers/deep/dead-letters`
          );
          deadLettered = dlq.records.some((r) => r.task.conversationId === conversationId);
        }
      }

      finalLatencyMs = nowMs() - deepStart + firstResponseLatencyMs;
    }

    records.push({
      promptId: prompt.id,
      routeDecision,
      firstResponseLatencyMs,
      finalLatencyMs,
      qualityScore: qualityFromRoute(routeDecision),
      retryCount,
      deadLettered
    });
  }

  return records;
}
