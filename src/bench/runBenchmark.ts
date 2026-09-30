import "../config/loadEnv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  renderBenchmarkMarkdown,
  runProfileBenchmark,
  summarizeBenchmark,
  type BenchmarkProfile,
  type BenchmarkPrompt
} from "./benchmarkCore";
import { runLiveReport } from "./liveReport";

const BenchmarkPromptSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1)
});

const BenchmarkPromptListSchema = z.array(BenchmarkPromptSchema).min(1);

export type BenchmarkMode = "simulate" | "live";

export function normalizeBenchmarkMode(rawMode: string | undefined): BenchmarkMode {
  const mode = (rawMode ?? "simulate").toLowerCase();
  if (mode === "simulate" || mode === "live") {
    return mode;
  }

  throw new Error(`Invalid BENCH_MODE value: ${rawMode}. Expected 'simulate' or 'live'.`);
}

export function validateBenchmarkPrompts(value: unknown): BenchmarkPrompt[] {
  const prompts = BenchmarkPromptListSchema.parse(value);
  const seen = new Set<string>();

  for (const prompt of prompts) {
    if (seen.has(prompt.id)) {
      throw new Error(`Invalid benchmark prompts: duplicate prompt id '${prompt.id}'`);
    }

    seen.add(prompt.id);
  }

  return prompts;
}

export function shouldRunBenchmarkCli(entryFilePath: string | undefined, moduleUrl: string): boolean {
  if (!entryFilePath) {
    return false;
  }

  return pathToFileURL(entryFilePath).href === moduleUrl;
}

async function readPrompts(path: string): Promise<BenchmarkPrompt[]> {
  const raw = await readFile(path, "utf8");
  return validateBenchmarkPrompts(JSON.parse(raw));
}

function defaultProfiles(): BenchmarkProfile[] {
  return [
    {
      name: "azure-balanced",
      fastProvider: "azure",
      fastModel: "gpt-4o-mini",
      deepProvider: "azure",
      deepModel: "gpt-4.1"
    },
    {
      name: "bedrock-balanced",
      fastProvider: "bedrock",
      fastModel: "anthropic.claude-3-5-haiku",
      deepProvider: "bedrock",
      deepModel: "anthropic.claude-3-5-sonnet"
    },
    {
      name: "ollama-local",
      fastProvider: "ollama",
      fastModel: "llama3.1:8b",
      deepProvider: "ollama",
      deepModel: "qwen2.5:14b"
    }
  ];
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  const promptsPath = process.env.BENCH_PROMPTS_PATH ?? "data/benchmark-prompts.json";
  const mode = normalizeBenchmarkMode(process.env.BENCH_MODE);
  const jsonOutPath = process.env.BENCH_JSON_OUT ?? (mode === "live" ? "reports/live-benchmark-v2.json" : "reports/benchmark-summary.json");
  const mdOutPath = process.env.BENCH_MD_OUT ?? (mode === "live" ? "reports/live-benchmark-v2.md" : "reports/benchmark-summary.md");
  const baseUrl = process.env.BENCH_BASE_URL ?? "http://localhost:3100";
  const simulationSeed = process.env.BENCH_SIM_SEED ?? "default-v1";

  const prompts = await readPrompts(promptsPath);
  if (mode === "live") {
    const report = await runLiveReport(prompts, { baseUrl, deadlineMs: Number(process.env.BENCH_DEADLINE_MS ?? 120000) });
    const records = report.records;
    await mkdir(dirname(jsonOutPath), { recursive: true });
    await mkdir(dirname(mdOutPath), { recursive: true });
    await writeFile(jsonOutPath, JSON.stringify(report, null, 2), "utf8");
    await writeFile(mdOutPath, `# Live benchmark observations\n\n${records.length} turns; ${records.filter(r => r.outcome === "stop").length} stopped normally.\n\nQuality, usage and cost are unknown. Use eval:recordings link-live with the completed recorder artifact, dataset and annotations to validate evidence and grade exact answers; this observation report alone cannot pass a quality or comparison gate. Timings are client observations, not provider execution durations.\n`, "utf8");
    console.log(`Live benchmark report written to ${jsonOutPath}`);
    if (records.some(r => r.outcome !== "stop")) process.exitCode = 1;
    return;
  }
  const profiles = defaultProfiles();

  const summaryWithRecords = [] as Array<{
    profile: BenchmarkProfile;
    records: ReturnType<typeof runProfileBenchmark>;
    summary: ReturnType<typeof summarizeBenchmark>;
  }>;

  for (const profile of profiles) {
    const records = runProfileBenchmark(profile, prompts, { simulationSeed });

    summaryWithRecords.push({
      profile,
      records,
      summary: summarizeBenchmark(profile, records)
    });
  }

  const summaries = summaryWithRecords.map((x) => x.summary);

  const markdown = renderBenchmarkMarkdown(summaries) + `\nMode: ${mode}\n`;

  await mkdir("reports", { recursive: true });
  await writeFile(
    jsonOutPath,
    JSON.stringify(
      {
        generatedAtIso: new Date().toISOString(),
        mode,
        runContext: {
          simulationSeed: mode === "simulate" ? simulationSeed : undefined,
          promptsDigestSha256: digestJson(prompts),
          profilesDigestSha256: digestJson(profiles)
        },
        summaries,
        recordsByProfile: summaryWithRecords.map((x) => ({
          profile: x.profile,
          records: x.records
        }))
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(mdOutPath, markdown, "utf8");

  console.log(`Benchmark JSON report written to ${jsonOutPath}`);
  console.log(`Benchmark markdown report written to ${mdOutPath}`);
}

if (shouldRunBenchmarkCli(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
