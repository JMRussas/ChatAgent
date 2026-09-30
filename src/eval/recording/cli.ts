import { readFile } from "node:fs/promises";
import { readArtifact, pruneExpired, recordingEvidenceValid } from "./storage";
import { compareRecordings } from "./comparison";
import { scoreRecording } from "./annotations";
try {
  const [command, path, annotations] = process.argv.slice(2);
  if (command === "compare") {
    const [, baseline, candidate, dataset, baselineRatings, candidateRatings, experiment] = process.argv.slice(2);
    if (!baseline || !candidate || !dataset || !baselineRatings || !candidateRatings) throw new Error("Missing comparison inputs");
    const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
    const result = compareRecordings(await readArtifact(baseline), await readArtifact(candidate), await json(dataset),
      await json(baselineRatings), await json(candidateRatings), experiment ? await json(experiment) : undefined);
    console.log(JSON.stringify(result, null, 2)); if (!result.candidateQualityPassed) process.exitCode = 1;
  } else if (command === "prune" && path) console.log(JSON.stringify({ removed: await pruneExpired(path) }));
  else if (command === "grade" && path && annotations) {
    const result = scoreRecording(await readArtifact(path), JSON.parse(await readFile(annotations, "utf8")));
    console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
  } else if (command === "validate" && path) {
    const run = await readArtifact(path);
    const valid = recordingEvidenceValid(run);
    console.log(JSON.stringify({ runId: run.manifest.runId, status: run.manifest.status, valid, quality: "unrated" }));
    if (!valid) process.exitCode = 1;
  } else throw new Error("Usage: eval:recordings validate <run.json> | grade <run.json> <annotations.json> | prune <root>");
} catch { console.error("EVAL_EVIDENCE_INVALID_OR_UNAVAILABLE"); process.exitCode = 1; }
