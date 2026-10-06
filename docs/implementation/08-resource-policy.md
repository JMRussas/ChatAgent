# Execution, billing, quota and resource policy

2026-09-25. Normative planning extension to specs 03–06 and consolidation 07.
Metadata is implemented in spec 03; catalog-mode admission and process-local
reservation coverage are recorded in [04 evidence](04-evidence.md). CLI enforcement,
full provider usage/pricing reconciliation and integrated reporting remain later work.
The contracts below retain their normative scope and do not imply fixed-mode enforcement. They supersede any inference that an
Ollama binding is local/free, a CLI is subscription-billed, or cloud means per-token
billing. Implement metadata in 03, admission/selection in 04, CLI enforcement in
05, and reporting in 06. Context review fixes remain a separate bounded task.

## Independent facts per binding

| Dimension | Required meaning                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport | Adapter/API kind, connectionId, model binding and revision; how a request is sent.                                                                                 |
| Execution | local-device, self-hosted-remote, managed-cloud, hybrid, or unknown; where inference actually occurs. Record processing scope/region separately, possibly unknown. |
| Billing   | Components such as metered usage, subscription, provisioned capacity, owned compute or unknown; combinations are allowed.                                          |
| Quota     | Account/pool identity, unit, observed allowance/usage/reset and freshness; unavailable values stay unknown.                                                        |
| Compute   | Resource pool, concurrency, memory capacity and measured load where observable; include owned or rented GPUs.                                                      |

Execution and billing evidence carry source, observed/configured time, and expiry
when observational. Apply evidence per binding: models behind the same localhost
gateway can execute in different places. CLI process location is not inference
location. No model-name, provider-enum or URL heuristic establishes locality,
entitlement, rate or free usage. Explicit configuration is a declared policy fact,
not a verified provider observation; preserve that distinction. Conflicting or
stale evidence fails any hard constraint that depends on it.

Ollama documents cloud inference through both localhost and its hosted API:
[official cloud documentation](https://github.com/ollama/ollama/blob/main/docs/cloud.mdx)
(checked 2026-09-25). Use this as a required mixed-execution fixture, not a hardcoded
cloud-model suffix rule. Listing a model does not prove local weights/execution.

## Four separate budgets

1. Context capacity: input/output tokens, actual effective window, safety reserve.
   Applies to every model, even with no per-request invoice.
2. Incremental spend: additional monetary charge for this work. Rate components
   carry currency, unit, effective date/source and known/unknown status. Support
   input/output/cache/request/time components as applicable; missing rates are
   unknown. Estimates, reservations and reported charges are different fields.
3. Entitlement: subscription/rate/credit allowance and reset window. Subscription
   may have zero incremental charge for an included invocation while consuming a
   scarce allowance. Unknown remaining quota never means unlimited.
4. Compute/time: shared GPU capacity, concurrency, queue wait and deadlines.
   Owned compute has resource cost even if incremental provider spend is zero.

Track fixed subscription/provisioned/owned infrastructure expenses separately from
incremental spend. Optional amortized cost must be explicitly labeled with its
allocation method; never add the monthly fee to every request or present invented
per-token prices. Do not compare credits, GPU seconds and dollars as one number.

## Quota observation contract (v1, 2026-10-06)

`src/routing/quotaObservation.ts` is a validation and description boundary for
what a source reports about one quota limit. It is not reconciliation: nothing in
it grants, refunds or resets an allowance, nothing consumes it yet, and the
configured `bindings[].quota` and the admission ledger are unchanged. A schema
does not prove what a provider means.

- **Payload and capability are separate.** The trusted
  `QuotaSourceCapability` comes from the adapter, never from the payload. It
  states provenance, who states the as-of time (provider, local adapter or
  nobody), whether window semantics are documented, whether usage coverage can be
  declared, and request correlation. A payload claiming more than its capability
  is ambiguous.
- **Window and measure.** Windows are fixed (start and reset), rolling (duration),
  none, or unknown (a reported reset of undocumented meaning). Measures are
  quantitative (unit with limit, used and remaining, which must agree and may not
  be overdrawn) or headroom (a percentage, over 100 kept as reported), which never
  yields a number of requests or tokens.
- **Clocks.** `sourceAsOf` is never synthesized from receipt. Freshness is
  anchored to the source as-of, or to a configured declaration time, and capped by
  a declared expiry, so re-receiving or re-mapping a snapshot never makes it
  fresher. Without either it is labelled local-receipt freshness, for display
  only. Timestamps are canonicalized to UTC before comparison.
- **Coverage** may describe which events (accepted, completed, billed) and whose
  calls a figure covers, up to `throughAt`. Reporting lag and in-flight accepted
  requests mean this does not prove completeness, and request correlation does
  not either.
- **`describeAllowance`** reports a number only for a fresh quantitative figure
  inside its fixed window (not before it starts or after it ends), always with
  `authoritative: false`.
- **`classifySuccessor`** describes how a newer observation differs: different
  identity, no provider as-of (order unknown), out of order, duplicate (every
  accounting field and the capability equal; freshness is not extended),
  same-instant conflict, conflict (changed capability, window kind, unit, limit,
  rolling duration or overlapping fixed bounds), same window, a later disjoint
  fixed window, or an unknown window with a changed reset time. It lists
  descriptive changes and the capabilities a reconciler would lack. An empty list
  does not mean the evidence is complete or eligible. A future reconciler must
  still match authoritative covered charges, keep unstarted reservations and treat
  unmatched usage as uncertain.
- **Adapters.** `fromClaudeUsageWindows` maps the existing CLI usage shape as
  headroom over unknown windows with an adapter-reported as-of, all or nothing,
  without assuming what `five_hour` or `seven_day` mean. `fromConfiguredQuota`
  maps configuration as declared, with its configured check and expiry times.
- **Identity** keys combine source, pool and limit ids. They are internal and
  opaque, and must not reach user telemetry.

Validation: 30 focused contract tests; 1,147 tests across 125 files, 34 browser
tests, format and lint passed. No live provider calls or admission changes.

## Admission and selection (04)

Policy names must express intent: allowed execution scopes, allowed billing modes,
incremental monetary ceiling with currency, unknown-cost action (deny or explicitly
allow unpriced work), quota exhaustion action, pool concurrency and wait deadline.
No configuration means no new permission to use a paid/cloud fallback. A zero
incremental-spend policy can allow verified included subscription or owned-compute
work; it is distinct from local-only. Strict local-only excludes cloud/hybrid/unknown
execution even when the HTTP endpoint is localhost.

Apply enabled hard constraints before the existing quality/latency ranking. A cheap
binding with exhausted quota, insufficient capacity or disallowed processing scope
is ineligible. Unknown values fail constraints requiring them; unconstrained unknown
fields remain visibly unknown. Do not claim enforcement of policy in legacy fixed
mode until the admission layer actually runs there too.

Reserve estimated maximum incremental spend and known allowance atomically in the
shared account/resource pool before dispatch. Across a turn, account for fast and
deep calls, retries and fallback; model-based summarization has its own linked job
budget and shares account/pool limits. Revalidate live quota/policy before retries
without silently changing the frozen model/context. Reject, bounded-wait or use an
explicitly allowed fallback; never silently switch credentials or billing mode.

Release reservations only for known unconsumed work; reconcile with actual usage
when available. Cancellation/timeout may still be billed: unknown charge remains
unsettled, not zero, and must not immediately restore assumed full allowance.
Initial admission is in-process with the prototype; document restart loss and do
not claim a durable account-wide spending cap. Multiple runtime instances require
a shared ledger before claiming cross-instance enforcement.

## UI and telemetry (06)

Show execution scope, billing mode, and safe selection reasons as distinct facts.
Examples: local compute; cloud / subscription allowance; cloud / estimated metered
charge; execution unknown / price unknown. Keep counts, account IDs and prices out
of prompt content unless needed for the requested task. Never expose credentials.
Record estimated/reserved/reported spend separately, quota observations and pool
waits; show unknown usage as unknown. No live pricing lookup or billable probe is
required for offline acceptance.

## Required contract fixtures and traceability

| ID     | Fixture and expected outcome                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RES-01 | Two Ollama bindings on localhost: verified local weights and cloud-backed model. Local-only admits the former and excludes the latter; unknown execution also fails.          |
| RES-02 | CLI subscription has included capacity but exhausted/unknown quota. No invented free/unlimited access; apply the configured quota policy and no hidden API fallback.          |
| RES-03 | Remote self-hosted GPU and provisioned cloud binding. Preserve compute/fixed costs separately from incremental inference charges; neither implies local or per-token billing. |
| RES-04 | Missing/stale price versus verified zero incremental cost. Different admission outcomes under strict monetary policy; zero is never the default for unknown.                  |
| RES-05 | Concurrent fast/deep turns share a nearly exhausted pool. Atomic reservation prevents both spending the same remaining budget; retries/summary jobs use that pool too.        |
| RES-06 | Cancellation after provider acceptance with missing usage. Reservation remains unsettled; no false zero charge or immediate restoration of allowance.                         |
| RES-07 | Quota exhaustion with paid fallback forbidden. No fallback call; emit truthful bounded-wait or terminal status.                                                               |
| RES-08 | Public metadata and per-turn UI distinguish execution/billing/unknowns without leaking account secrets; legacy catalog migration infers neither locality nor zero cost.       |

Each implementing milestone maps its applicable IDs to named tests and results.
Outstanding cases remain explicitly open; document live evidence separately from
fixtures. Reuse these fixtures across ChatRuntime, Hekate and Iris adapters.
