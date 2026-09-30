import { z } from "zod";
import { canonical, datasetSchema, digest, type RunArtifact, type RecordedEvent } from "./contract";
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
/** Correlate identities to calls, preserving retry order within each independent phase. */
function executionEvidence(run: RunArtifact) {
  let valid = true;
  const identified = (model: RecordedEvent["model"]) => !!model?.provider.trim() && !!model.model.trim();
  const turns = run.trace.filter(e => e.type === "user").map(turn => {
    const events = run.trace.filter(e => e.turnId === turn.turnId && e.type !== "user");
    const required = turn.route === "deep" ? ["fast", "deep"] : ["fast"];
    if (!turn.route) valid = false;
    for (const event of events) {
      if (!event.callId || !event.phase) valid = false;
    }
    const phases = (["fast", "deep"] as const).map(phase => {
      const phaseEvents = events.filter(e => e.phase === phase);
      const ids = [...new Set(phaseEvents.flatMap(e => e.callId ? [e.callId] : []))];
      const attempts = ids.map(callId => {
        const call = events.filter(e => e.callId === callId);
        const models = call.flatMap(e => e.model ? [e.model] : []);
        const model = models[0] ?? null;
        const terminals = call.filter(e => e.type === "terminal");
        const terminal = terminals[0];
        if (call.some(e => e.phase !== phase) || !identified(model) ||
          models.some(m => canonical(m) !== canonical(model)) || terminals.length !== 1 ||
          !identified(terminal?.model ?? null)) valid = false;
        return { model, finishReason: terminal?.finishReason ?? null, retrying: terminal?.retrying ?? null };
      });
      if (required.includes(phase) && !attempts.length) valid = false;
      if (attempts.some((attempt, i) => i < attempts.length - 1 ? attempt.retrying !== true : attempt.retrying !== false)) valid = false;
      const answer = [...phaseEvents].reverse().find(e => e.answer);
      const answerAttempt = answer?.callId ? ids.indexOf(answer.callId) : -1;
      if (phase === (turn.route === "deep" ? "deep" : "fast") && answer && (answerAttempt < 0 || !identified(answer.model) ||
        canonical(answer.model) !== canonical(attempts[answerAttempt]?.model))) valid = false;
      // The graded answer must belong to the final attempt, not an earlier successful call.
      if (phase === (turn.route === "deep" ? "deep" : "fast") && (!answer || answerAttempt !== attempts.length - 1)) valid = false;
      return { phase, attempts, answerAttempt: answer ? answerAttempt : null };
    });
    return { promptId: turn.promptId, route: turn.route, phases };
  });
  return { valid, turns };
}

/** v2 binds phase-local attempt order/outcomes and final answers to model identities.
 * Run-local IDs, timestamps and cross-phase scheduling do not affect the digest.
 */
export function executionDigest(run: RunArtifact): string {
  return digest(canonical({ version: "execution-v2", turns: executionEvidence(run).turns }));
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
    if (!executionEvidence(run).valid) issues.push(`${label}: missing or inconsistent call execution identity`);
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
