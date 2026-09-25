import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  renderBenchmarkMarkdown,
  runProfileBenchmark,
  summarizeBenchmark,
  type BenchmarkProfile,
  type BenchmarkPrompt
} from "./benchmarkCore";
import { runLiveBenchmark } from "./liveBenchmark";

async function readPrompts(path: string): Promise<BenchmarkPrompt[]> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as BenchmarkPrompt[];
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

async function main() {
  const promptsPath = process.env.BENCH_PROMPTS_PATH ?? "data/benchmark-prompts.json";
  const jsonOutPath = process.env.BENCH_JSON_OUT ?? "reports/benchmark-summary.json";
  const mdOutPath = process.env.BENCH_MD_OUT ?? "reports/benchmark-summary.md";
  const mode = (process.env.BENCH_MODE ?? "simulate").toLowerCase();
  const baseUrl = process.env.BENCH_BASE_URL ?? "http://localhost:3000";

  const prompts = await readPrompts(promptsPath);
  const profiles = defaultProfiles();

  const summaryWithRecords = [] as Array<{
    profile: BenchmarkProfile;
    records: ReturnType<typeof runProfileBenchmark>;
    summary: ReturnType<typeof summarizeBenchmark>;
  }>;

  for (const profile of profiles) {
    const records =
      mode === "live"
        ? await runLiveBenchmark(profile, prompts, {
            baseUrl
          })
        : runProfileBenchmark(profile, prompts);

    summaryWithRecords.push({
      profile,
      records,
      summary: summarizeBenchmark(profile, records)
    });
  }

  const summaries = summaryWithRecords.map((x) => x.summary);

  const markdown = renderBenchmarkMarkdown(summaries);

  await mkdir("reports", { recursive: true });
  await writeFile(
    jsonOutPath,
    JSON.stringify(
      {
        generatedAtIso: new Date().toISOString(),
        mode,
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
