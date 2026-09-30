import { readFile } from "node:fs/promises";
import { readArtifact, pruneExpired, recordingEvidenceValid } from "./storage";
import { scoreRecording } from "./annotations";
try {
  const [command, path, annotations] = process.argv.slice(2);
  if (command === "prune" && path) console.log(JSON.stringify({ removed: await pruneExpired(path) }));
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
