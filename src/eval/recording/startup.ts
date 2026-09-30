import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonical, datasetSchema, recordingConfig, type RunArtifact } from "./contract";
import { EvaluationRecorder } from "./recorder";
import { pruneExpired } from "./storage";

export async function codeIdentity(): Promise<RunArtifact["manifest"]["code"]> {
  const run = (args: string[]) => promisify(execFile)("git", args, { timeout: 5000, maxBuffer: 1048576 });
  try {
    const paths = ["src", "bridges", "package.json", "package-lock.json", "tsconfig.json", "data/model-catalog.json"];
    const [revision, status, files] = await Promise.all([run(["rev-parse", "HEAD"]), run(["status", "--porcelain", "--", ...paths]),
      run(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths])]);
    const hash = createHash("sha256");
    for (const path of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
      hash.update(canonical(path));
      try { hash.update(await readFile(path)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("deleted");
      }
    }
    return { revision: /^[a-f0-9]{40,64}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null,
      dirty: Boolean(status.stdout.trim()), sourceDigest: hash.digest("hex") };
  } catch { return { revision: null, dirty: null, sourceDigest: null }; }
}
export async function startEvaluationRecording(configuration: unknown, env: NodeJS.ProcessEnv = process.env) {
  const config = recordingConfig(env);
  if (!config) return;
  if (!env.EVAL_DATASET_PATH) throw new Error("EVAL_DATASET_PATH is required when recording");
  if ((await stat(env.EVAL_DATASET_PATH)).size > 16777216) throw new Error("EVAL_DATASET_TOO_LARGE");
  const dataset = datasetSchema.parse(JSON.parse(await readFile(env.EVAL_DATASET_PATH, "utf8")));
  const recorder = new EvaluationRecorder(config, dataset, configuration, await codeIdentity());
  try { await pruneExpired(config.root); } catch { recorder.invalidate("EVAL_STORAGE_UNAVAILABLE"); }
  await recorder.flush();
  return recorder;
}
