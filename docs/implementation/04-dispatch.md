# 04 — Task-based model selection and dispatch

Status: planned. Depends on 01–03. Default remains fixed routing until explicitly
enabled with `MODEL_ROUTING_MODE=catalog` (enum fixed/catalog; default fixed).

## Outcome

A coding request can select a coding binding, while quick conversation uses a
responsive binding. Selection is reproducible and explainable. No learned router,
automatic provisioning, retrieval, repo file access, or tool execution in this task.
“Coding” initially means generating/explaining code using supplied context.

## Contracts and decisions

Add `src/routing/taskClassifier.ts` and `modelSelector.ts`, and a provider registry
keyed by bindingId in `src/providers/providerRegistry.ts`.

```ts
interface TaskRequirements {
  task: "conversation" | "coding" | "reasoning" | "summarization" | "extraction";
  requiredCapabilities: ("tools" | "vision" | "structuredOutput")[];
  inputTokens: number;
  outputTokens: number;
}
interface ModelSelection {
  bindingId: string;
  catalogVersion: number;
  observationTimeIso: string;
  reasons: string[];
  eligibleBindingIds: string[];
}
```

Task type and route remain separate: a short coding explanation may be fast;
a multi-file implementation request remains deep. Existing direct/clarify/deep
decision runs first. A clarify response uses conversation capability regardless
of the eventual task. Classification is deterministic, whole-word/case-insensitive:
explicit code fence, stack trace, or code/debug/refactor/compiler/type-error request
→ coding; otherwise summarize/summary → summarization; extract fields/JSON request
→ extraction; compare/design/tradeoff/analyze → reasoning; otherwise conversation.
Precedence is that order. Add representative golden cases before wiring dispatch.
Do not interpret “resource” as “source” or ordinary “encode” as “code”.

For deep turns select a fast conversation responder and a deep task specialist.
Fast input gets task intent in instructions but no tools. Requiring JSON sets
structuredOutput; images/tools require capabilities only when the request includes
those supported input/action types, not because a word mentions them. Unsupported
action types return an explicit capability error rather than implying execution.

Eligibility: enabled, intended role/task, implemented adapter with necessary
capabilities, fresh ready observation, sufficient context/output, allowed locality
and configured cost policy. Unknown hard constraints fail closed in catalog mode.
Fixed mode retains legacy behavior and emits its fixed-selection explanation.

Resolve context/selection dependency by building a raw immutable history snapshot
first, then preview budgeted context for each candidate. Rank candidates retaining
the greatest number of recent complete pairs first, then matching evaluation
success rate (minimum 20 samples, at most 30 days old), then first-useful p95,
then configured integer `routingPriority` (default 100, lower wins), then bindingId
lexically. Missing quality/latency ranks behind measured values. Measurements must
match task and connection environment. No invented scores from model size/names.
For a deep pair, build final shared context using the smaller input allowance;
persist that context and both selections before enqueuing/calling providers.

## Failure and UI

No eligible binding → HTTP 503 code NO_ELIGIBLE_MODEL, with safe exclusion reasons;
no model call or task enqueue. Bindings/config are snapshotted into tasks, including
model revision if known; retries do not silently switch models or new catalog versions.
Allow at most one fallback to an explicitly ordered per-role `fallbackBindingIds`
list on retryable availability failure before text emission. Reapply all constraints,
including shared context fit and billing policy. No fallback on cancellation/auth/
context errors. Exhausted allowance follows configured billing policy; no hidden
switch to API billing. Emit fallback selection event and new attemptId.

Add actual provider/model/bindingId and safe selection reasons to per-turn events.
homePage uses these, not global runtimeInfo, for labels on completed and active turns.
Record telemetry keyed by bindingId, phase (fast/deep), task, size and attempt result;
never mix a fast provisional call with deep reasoning on the same model.

## Acceptance

1. Coding explanation → fast coding candidate; complex coding → deep coding candidate
   and fast conversation responder. Candidate absence gives explicit error.
2. Classification corpus tests precedence and substring false positives.
3. Disabled, stale, denied, unknown-limit and unsupported-adapter bindings excluded.
4. Budget retains newest whole pairs; both providers see identical final history.
5. Evaluation ties follow the documented ordering; no random result across runs.
6. Mid-task catalog change does not change model/context on retry.
7. Allowed fallback records new selection; incompatible/paid-disallowed fallback blocked.
8. Two overlapping turns with different selected models display correct bubble labels.
9. Fixed mode passes existing golden routing expectations and HTTP compatibility tests.

Run common checks plus new selection corpus. Automatic cloud deployment is out of scope.
