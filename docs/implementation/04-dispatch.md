# 04 — Task-based model selection and dispatch

Status: implemented with offline acceptance coverage; live provider selection is
not yet measured. See [04 evidence](04-evidence.md), including the earlier
[classification checkpoint](04a-evidence.md). Depends on 01–03. Default remains fixed routing until explicitly
enabled with `MODEL_ROUTING_MODE=catalog` (enum fixed/catalog; default fixed).

## Outcome

A coding request can select a coding binding, while quick conversation uses a
responsive binding. Selection is reproducible and explainable. No learned router,
automatic provisioning, retrieval, repo file access, or tool execution in this task.
“Coding” initially means generating/explaining code using supplied context.

## Contracts and decisions

[Resource policy](08-resource-policy.md) defines mandatory admission invariants,
pool reservations and RES-01–07 selection/failure cases. Apply these hard constraints
before ranking; local-only and zero incremental spend are different policies.

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
first, then preview budgeted context for each candidate using the same captured
memory revision and active-task state. Preview must not trigger summary model calls
per candidate. Rank candidates retaining
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

## Configuration

Set `MODEL_ROUTING_MODE=catalog` and `MODEL_DISPATCH_CONFIG_PATH` to a local JSON
policy file. The existing catalog remains the curated model/task/capability list;
add known `limits.contextTokens`, `limits.maxOutputTokens` and optional integer
`routingPriority` there. Observed limits can supply missing limits or reduce declared
ones. Unknown limits, missing registry adapters, stale discovery and denied access
exclude a binding. Default mode remains `fixed`; its resource admission is unchanged.

Minimal policy shape for the existing mock catalog entry (synthetic only):

```json
{
  "environment": "default",
  "allowedExecutionScopes": ["local-device"],
  "allowedBillingComponents": ["owned-compute"],
  "maxIncrementalUsd": 0,
  "unknownCostAction": "deny",
  "quotaExhaustionAction": "fail",
  "waitTimeoutMs": 5000,
  "fallbackBindingIds": { "fast": [], "deep": [] },
  "bindings": {
    "mock-default": {
      "facts": { "executionScope": "local-device", "billingComponents": ["owned-compute"] },
      "evidence": {
        "source": "operator: synthetic mock adapter",
        "kind": "configured",
        "checkedAtIso": "2026-09-29T00:00:00.000Z",
        "expiresAtIso": "2026-09-30T00:00:00.000Z"
      },
      "incremental": {
        "currency": "USD",
        "maxInvocationUsd": 0,
        "evidence": {
          "source": "operator: synthetic mock adapter",
          "kind": "configured",
          "checkedAtIso": "2026-09-29T00:00:00.000Z",
          "expiresAtIso": "2026-09-30T00:00:00.000Z"
        }
      }
    }
  }
}
```

Update the example evidence dates when reviewing the facts. In a copy of the
catalog, set the synthetic mock entry's limits (for example 8192/2048) explicitly;
the shipped entry intentionally has unknown limits. This example does not grant
access to a real provider. `bindings` keys are catalog IDs; fallback lists use the
actual `bindingId` returned by `/models`, preserving explicit order. Discovery runs
asynchronously, so newly started catalog mode may report 503 until observations arrive.

`maxIncrementalUsd` is a process-lifetime aggregate USD ceiling across foreground,
deep, retry, fallback and model-summary reservations. `incremental.maxInvocationUsd`
is an operator-declared complete upper bound per invocation, covering all applicable
token/cache/request/time charges; it is not a measured bill or an inferred per-token
price. The old catalog's optional token pricing alone does not establish a complete
bound. Keep fixed subscription/compute expense separate (`fixedCostNote`). Missing
cost is allowed only with explicit `unknownCostAction: "allow-unpriced"` and a null
monetary ceiling. Such work has unknown cost, not zero cost.

Optional per-binding `quota` contains `poolId`, unit (`requests` or `tokens`),
`remaining`, and the same evidence fields. Shared pools must use identical snapshots;
conflicts fail closed. Subscription bindings require quota evidence, or explicit
`quotaAdmission: "adapter-preflight"` backed by a code-owned registered capability.
The latter delegates the live check to a reviewed adapter before every invocation;
it does not create ledger quota units or promise a token reservation. Currently
Hekate Claude implements this with fresh reported usage below the approved cutoff.
A policy flag alone cannot grant the capability. Cost admission still applies;
unknown incremental cost requires explicit `allow-unpriced` and a null ceiling. Optional
`compute` contains `poolId` and positive `concurrency`. `quotaExhaustionAction` also
controls whether busy compute pools fail immediately or wait up to `waitTimeoutMs`.
Queued tasks reserve cost/quota but do not occupy compute slots until execution.
A wait cannot invent fresh quota: exhausted/unchanged snapshots eventually fail.

The ledger tracks at most `ADMISSION_MAX_QUOTA_POOLS` distinct quota pools (default
100, range 1–10000, read at construction). A pool occupies a slot while any
reservation for it is live, and permanently once started work settles against it,
including a zero-unit report. Releasing the last unstarted reservation of a pool with
no settled work frees its slot. Retained totals and fingerprints are never expired or
evicted. A request for a further pool fails with `QUOTA_POOL_CAPACITY` before any
reservation is created; the whole batch is rejected, nothing waits on it, and
selection reports the binding as excluded while other bindings stay eligible.
Changed snapshots of a retained pool still fail with `QUOTA_SNAPSHOT_CONFLICT`.
Startup fails when the policy itself declares more distinct pools than the limit.
The ledger cannot tell a renamed pool from a new one: within the limit a new
`poolId` is admitted with its own declared allowance, and the old total stays
retained. Keeping one identifier per real account or allowance is the operator's
responsibility. Recovery from a full ledger currently requires a restart, which
also discards every total.

The registry reuses existing adapters and configured credentials; it adds no CLI,
image or tool execution. Explicit image/action payloads are rejected. JSON output
requests require declared structuredOutput support and are checked for valid JSON
before acceptance; this is host validation, not a provider-native constrained decoder
or arbitrary JSON Schema guarantee. Malformed output terminates with
`STRUCTURED_OUTPUT_INVALID` and does not enter accepted history.

## Runtime boundaries

Initial fast/deep selections are saved on the user timeline event before enqueue.
Deep tasks reference an in-memory frozen dispatch plan by `dispatchId`; that plan
holds the selected adapter/configuration and context. Retry revalidates access,
revision, fit and resource policy without consulting new catalog preferences.
An explicit fallback keeps captured history/memory intact, corrects its phase's
trusted provider/model fact, budgets that correction, and receives a new context
snapshot and attempt. No fallback follows text emission, cancellation, auth or
context errors; changing to metered billing additionally requires the original
entry's `billing.usageBillingFallbackAllowed`.

Matching evaluations use `<connectionId>:<policy.environment>`, at least 20 samples,
and a timestamp between now and 30 days ago. Missing measurements rank after valid
ones. No model-name score is invented. Fixed-mode adaptive metrics retain their legacy
schema; catalog attempt telemetry is separate by binding, phase, task, size and result,
and is included in the existing telemetry file saves. The telemetry endpoint omits
pool IDs and credentials. Summary jobs use their explicit configured fast binding,
validated for summarization, and the same ledger with separate request budgets.

The ledger is in memory. Restart loses reservations; saved telemetry is evidence,
not a ledger to replay. Existing adapters do not normalize provider charges/usage,
so started calls remain unsettled at their reservation bound, including cancellation
and timeout. The ledger supports reported-consumption reconciliation when supplied,
but does not invent missing usage. Configured cost bounds are not guarantees about
provider invoices. Multi-process/account-wide enforcement, automated quota refresh
and provider-specific pricing/usage reconciliation remain separate work. Compute
slots cover the adapter call lifetime; abort does not prove remote GPU work stopped.
