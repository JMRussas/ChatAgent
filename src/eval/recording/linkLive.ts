import { liveReportSchema } from "../../bench/liveReport";
import { canonical, datasetSchema, digest } from "./contract";
import { recordingEvidenceValid, validateArtifact } from "./storage";
import { scenarioDataset } from "../scenarios";
import { scoreRecording } from "./annotations";

/** Join immutable, completed recording evidence to independently observed HTTP timings. */
function linkRecording(reportValue: unknown, artifactValue: unknown, datasetValue: unknown, annotationsValue: unknown, now: number, groups?: string[]) {
  const report = liveReportSchema.parse(reportValue), run = validateArtifact(artifactValue, now), dataset = datasetSchema.parse(datasetValue);
  const require = (condition: unknown, code: string) => { if (!condition) throw new Error(code); };
  require(recordingEvidenceValid(run) && report.recorderRunId === run.manifest.runId, "EVAL_LINK_RUN_MISMATCH");
  require(run.manifest.dataset.version === dataset.version && run.manifest.dataset.digest === digest(canonical(dataset)) &&
    report.promptsDigestSha256 === digest(JSON.stringify(dataset.prompts)), "EVAL_LINK_DATASET_MISMATCH");
  const turns = run.trace.filter(e => e.type === "user");
  require(turns.length === dataset.prompts.length && report.records.length === turns.length &&
    report.requestedPromptCount === turns.length && report.executedPromptCount === turns.length, "EVAL_LINK_COVERAGE_MISMATCH");
  require(new Set(turns.map(t => t.turnId)).size === turns.length, "EVAL_LINK_DUPLICATE_TURN");
  if (groups) {
    require(groups.length === turns.length, "EVAL_LINK_COVERAGE_MISMATCH");
    const groupToConversation = new Map<string, string>(), conversationToGroup = new Map<string, string>();
    report.records.forEach((record, i) => {
      const group = groups[i], conversation = record.conversationId;
      require((!groupToConversation.has(group) || groupToConversation.get(group) === conversation) &&
        (!conversationToGroup.has(conversation) || conversationToGroup.get(conversation) === group), "EVAL_LINK_CONVERSATION_GROUP_MISMATCH");
      groupToConversation.set(group, conversation); conversationToGroup.set(conversation, group);
    });
  } else require(new Set(report.records.map(r => r.conversationId)).size === turns.length, "EVAL_LINK_DUPLICATE_TURN");
  const identity = (kind: string, value: string) => digest(`${run.manifest.runId}:${kind}:${value}`);
  for (const [i, record] of report.records.entries()) {
    const turn = turns[i], prompt = dataset.prompts[i];
    require(record.promptId === prompt.id && turn.promptId === prompt.id && turn.textHash === digest(prompt.text) &&
      turn.turnId === identity("turn", JSON.stringify([record.conversationId, record.messageId])) &&
      turn.conversationId === identity("conversation", record.conversationId) && turn.route === record.routeDecision, "EVAL_LINK_TURN_MISMATCH");
    const events = run.trace.filter(e => e.turnId === turn.turnId);
    const calls = new Set(events.flatMap(e => e.callId ? [e.callId] : []));
    require(calls.size === record.attempts.length && new Set(record.attempts.map(a => a.attemptId)).size === calls.size, "EVAL_LINK_ATTEMPT_MISMATCH");
    for (const attempt of record.attempts) {
      const call = events.filter(e => e.callId === identity("attempt", attempt.attemptId));
      const models = call.flatMap(e => e.model ? [e.model] : []), model = models[0];
      const terminals = call.filter(e => e.type === "terminal");
      require(call.length && call.every(e => e.phase === attempt.phase) && model && models.every(m => canonical(m) === canonical(model)) &&
        model.provider === attempt.provider && model.model === attempt.model && model.bindingId === attempt.bindingId && model.bindingRevision === attempt.bindingRevision &&
        terminals.length === 1 && terminals[0].finishReason === attempt.finishReason, "EVAL_LINK_ATTEMPT_MISMATCH");
    }
    const retries = ["fast", "deep"].reduce((n, phase) => n + Math.max(0, record.attempts.filter(a => a.phase === phase).length - 1), 0);
    require(retries === record.retryCount, "EVAL_LINK_RETRY_MISMATCH");
    const phases = turn.route === "deep" ? ["fast", "deep"] : ["fast"];
    const terminal = phases.map(phase => [...events].reverse().find(e => e.type === "terminal" && e.phase === phase && !e.retrying));
    require(terminal.every(e => e?.finishReason), "EVAL_LINK_TERMINAL_MISSING");
    const outcome = terminal.some(e => e!.finishReason === "error") ? "error" : terminal.some(e => e!.finishReason === "cancelled") ? "cancelled"
      : terminal.some(e => e!.finishReason === "length") ? "length" : "stop";
    require(record.outcome === outcome && record.finalObservedMs !== null && record.finalObservedMs <= record.elapsedMs &&
      (record.firstAnswerObservedMs === null || record.firstAnswerObservedMs <= record.finalObservedMs), "EVAL_LINK_OUTCOME_MISMATCH");
    const final = terminal[terminal.length - 1]!;
    const answer = [...events].reverse().find(e => e.answer && e.callId === final.callId && e.phase === final.phase && e.answerKind === "substantive");
    require(record.responseHash === (answer?.answer?.scoredHash ?? null), "EVAL_LINK_ANSWER_MISMATCH");
    const modes = new Set(record.attempts.map(a => a.provider === "mock" ? "synthetic" : a.provider ? "live" : "unknown"));
    const mode = modes.size > 1 ? "mixed" : [...modes][0] ?? "unknown";
    require(record.evidenceMode === mode && record.evidenceMode === run.summary.mode && ["live", "synthetic"].includes(mode), "EVAL_LINK_MODE_MISMATCH");
  }
  const grading = scoreRecording(run, annotationsValue, now);
  return { schemaVersion: "chatagent-linked-benchmark-v1", linked: true, runId: run.manifest.runId,
    observationDigest: digest(canonical(report)), recordingDigest: digest(canonical(run)), datasetDigest: run.manifest.dataset.digest,
    configurationDigest: run.manifest.configurationDigest, code: run.manifest.code, mode: run.summary.mode,
    grading, qualityPassed: grading.passed,
    observations: report.records.map((r, i) => ({ promptId: r.promptId, turnId: turns[i].turnId, responseHash: r.responseHash,
      firstAnswerObservedMs: r.firstAnswerObservedMs, finalObservedMs: r.finalObservedMs, elapsedMs: r.elapsedMs,
      firstUsefulRecorderMs: grading.results[i].firstUsefulMs })),
    comparisonEligible: false, comparisonNote: "Compare the original recordings with eval:recordings compare; linking does not establish cross-run compatibility." };
}

export function linkLiveRecording(report: unknown, artifact: unknown, dataset: unknown, annotations: unknown, now = Date.now()) {
  return linkRecording(report, artifact, dataset, annotations, now);
}
/** Scenario linking validates exact grouping; it does not relax isolated-run comparison rules. */
export function linkScenarioRecording(report: unknown, artifact: unknown, plan: unknown, annotations: unknown, now = Date.now()) {
  const { suite, dataset, conversationGroups } = scenarioDataset(plan);
  return { ...linkRecording(report, artifact, dataset, annotations, now, conversationGroups),
    schemaVersion: "chatagent-linked-scenarios-v1", scenarioDigest: digest(canonical(suite)),
    comparisonNote: "Multi-turn scenario comparisons are not implemented; existing comparison requires isolated turns." };
}
