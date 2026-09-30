import { z } from "zod";
import { canonical, datasetSchema, digest, type RunArtifact } from "./contract";
import { annotationsSchema, scoreRecording } from "./annotations";
import { recordingEvidenceValid, validateArtifact } from "./storage";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const experimentSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/), createdAtIso: z.string().datetime(),
  datasetDigest: hash,
  baseline: z.object({ configurationDigest: hash, executionDigest: hash }).strict(),
  candidate: z.object({ configurationDigest: hash, executionDigest: hash }).strict(),
  // Exact paths of differing leaves; arrays are atomic. No wildcard or ancestor exemptions.
  allowedConfigurationDifferences: z.array(z.array(z.string()).min(1)).max(100)
}).strict();

export function configurationDifferences(a: unknown, b: unknown, path: string[] = []): string[][] {
  if (canonical(a) === canonical(b)) return [];
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (object(a) && object(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return [[...path, key]];
    return configurationDifferences(a[key], b[key], [...path, key]);
  });
  return [path];
}
/** Ordered actual model selections per prompt/phase, excluding run-local attempt IDs. */
export function executionDigest(run: RunArtifact): string {
  return digest(canonical(run.trace.filter(e => e.type === "user").map(turn => {
    const models = run.trace.filter(e => e.turnId === turn.turnId && e.model).map(e => ({ phase: e.phase, ...e.model! }));
    return { promptId: turn.promptId, models: [...new Map(models.map(model => [canonical(model), model])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, model]) => model) };
  })));
}

export function compareRecordings(baselineValue: unknown, candidateValue: unknown, datasetValue: unknown,
  baselineAnnotations: unknown, candidateAnnotations: unknown, experimentValue?: unknown, now = Date.now()) {
  const runs = [validateArtifact(baselineValue, now), validateArtifact(candidateValue, now)];
  const dataset = datasetSchema.parse(datasetValue), datasetDigest = digest(canonical(dataset));
  const annotations = [annotationsSchema.parse(baselineAnnotations), annotationsSchema.parse(candidateAnnotations)];
  const grades = runs.map((run, i) => scoreRecording(run, annotations[i], now));
  const issues: string[] = [];
  const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  for (const [i, run] of runs.entries()) {
    const label = i === 0 ? "baseline" : "candidate";
    if (!recordingEvidenceValid(run) || run.manifest.code.dirty === null) issues.push(`${label}: invalid recording`);
    if (!equal(run.manifest.dataset, { version: dataset.version, digest: datasetDigest })) issues.push(`${label}: dataset identity mismatch`);
    const turns = run.trace.filter(e => e.type === "user");
    // Initial comparison contract uses fresh isolated conversations and one complete ordered dataset pass.
    if (!equal(turns.map(e => ({ id: e.promptId, hash: e.textHash })), dataset.prompts.map(p => ({ id: p.id, hash: digest(p.text) }))) ||
      new Set(turns.map(t => t.turnId)).size !== turns.length || new Set(turns.map(t => t.conversationId)).size !== turns.length)
      issues.push(`${label}: expected one isolated turn per dataset prompt in dataset order`);
    const modes = new Set(run.trace.flatMap(e => e.model ? [e.model.provider === "mock" ? "synthetic" : "live"] : []));
    if (modes.size !== 1 || !modes.has(run.summary.mode)) issues.push(`${label}: unknown, mixed or inconsistent execution mode`);
    if (turns.some(t => !run.trace.some(e => e.turnId === t.turnId && e.model))) issues.push(`${label}: missing execution identity`);
    if (run.manifest.condition === "unknown") issues.push(`${label}: unknown warm/cold condition`);
    if (grades[i].results.some(r => r.outcome === "unavailable")) issues.push(`${label}: required exact-answer grading unavailable`);
  }
  const [a, b] = runs;
  if (a.manifest.runId === b.manifest.runId) issues.push("distinct runs required");
  for (const key of ["code", "condition", "repetition", "capture", "redaction", "maxBytes", "maxEvents", "supportedCalls"] as const) {
    if (!equal(a.manifest[key], b.manifest[key])) issues.push(`${key} mismatch`);
  }
  if (a.summary.mode !== b.summary.mode) issues.push("execution mode mismatch");
  if (!equal({ rubric: annotations[0].rubricVersion, judge: annotations[0].judge }, { rubric: annotations[1].rubricVersion, judge: annotations[1].judge }))
    issues.push("quality method mismatch");
  const differences = configurationDifferences(a.manifest.configuration, b.manifest.configuration);
  const executions = runs.map(executionDigest);
  const experiment = experimentValue === undefined ? undefined : experimentSchema.parse(experimentValue);
  if (experiment) {
    if (Date.parse(experiment.createdAtIso) > Math.min(...runs.map(r => Date.parse(r.manifest.startedAtIso)))) issues.push("experiment declared after execution began");
    if (experiment.datasetDigest !== datasetDigest) issues.push("experiment dataset mismatch");
    for (const [i, expected] of [experiment.baseline, experiment.candidate].entries()) {
      if (expected.configurationDigest !== runs[i].manifest.configurationDigest || expected.executionDigest !== executions[i]) issues.push("experiment condition identity mismatch");
    }
    const paths = (values: string[][]) => values.map(canonical).sort();
    if (!equal(paths(differences), paths(experiment.allowedConfigurationDifferences))) issues.push("undeclared or unused configuration differences");
  } else {
    if (differences.length) issues.push("configuration mismatch: experiment required");
    if (executions[0] !== executions[1]) issues.push("execution identity mismatch: experiment required");
  }
  const available = issues.length === 0;
  const counts = grades.map(g => ({ pass: g.results.filter(r => r.outcome === "pass").length,
    fail: g.results.filter(r => r.outcome === "fail").length, unavailable: g.results.filter(r => r.outcome === "unavailable").length }));
  return { schemaVersion: "chatagent-comparison-v1", available, issues, datasetDigest,
    experimentDigest: experiment ? digest(canonical(experiment)) : null,
    runs: runs.map((run, i) => ({ runId: run.manifest.runId, configurationDigest: run.manifest.configurationDigest,
      executionDigest: executions[i], annotationDigest: grades[i].annotationDigest, counts: counts[i] })),
    passRateDelta: available ? (counts[1].pass - counts[0].pass) / dataset.prompts.length : null,
    candidateQualityPassed: available && grades[1].passed,
    costDeltaUsd: null, recorderOverheadMs: null };
}
