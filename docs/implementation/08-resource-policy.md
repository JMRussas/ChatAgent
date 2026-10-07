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

## Configured quota envelopes (2026-10-06)

`src/routing/quotaEnvelope.ts` is conservative **local** accounting against
operator-declared fixed-window envelopes. It is **not** provider reconciliation:
its only authority is an explicit configured envelope, it never reads quota
observations, and observation-v1 coverage or timestamps never refund or release
anything. Admission uses it only for bindings that opt in (below).

**Admission (opt-in, 2026-10-06).** A binding opts in with
`resources.quotaEnvelope: {poolId, unit}`, a separate field that cannot be combined
with the static `quota`; the policy lists the declared windows in `quotaEnvelopes`
(the current window of each pool and at most its successor). Configurations without
envelopes behave exactly as before.

- **Startup** refuses a binding whose pool has no declared envelope or a different
  unit, a pool used both statically and as an envelope, more static and envelope
  pools together than `ADMISSION_MAX_QUOTA_POOLS`, and any envelope the ledger
  refuses (for example a successor that already started).
- **Reservation** checks money, static quota and the envelope against one
  clock reading, then commits the envelope and the outer reservation together: a
  refusal by either changes neither. `check` allocates no identity. Runtime requests
  are rechecked against the declared pools: a request naming both quota kinds, an
  undeclared envelope pool, a different unit or a static request on an envelope pool
  is refused. A token budget whose input and output sum is not a safe integer is
  refused.
- **Starting** gates work on compute availability and rechecks the envelope's
  window and debit before compute is taken or the work marked started. Admission
  releases both unstarted reservations on envelope refusal; the standalone
  envelope ledger's refusal itself changes nothing.
- **Settlement** uses one report decision for both ledgers (a report counts only if
  both amounts are valid). Work finished without a report stays debited at its
  estimate and keeps a link until a per-call report is applied. Only Ollama
  token-envelope calls report usage so far (below); every other binding's debits
  accumulate, and an envelope can be exhausted by unreported work or by its
  open-charge cap. That is deliberate: elapsed time is not proof of what was
  consumed. If envelope settlement ever fails, nothing changes in either ledger and
  the work keeps its compute until settlement succeeds.

**Per-call usage reporting (Q1c-a, 2026-10-07: Ollama, token envelopes only).**

- **Source.** `GenerationResult` and `DeepResult` carry optional `usage`
  (`source: "provider-response"`, `inputTokens`, `outputTokens`). Both counts must be
  non-negative safe integers with a safe sum, or there is no usage. The Ollama
  adapter sets it only from the `done: true` final frame or non-streaming response,
  after the completion is accepted as stop or length: `prompt_eval_count` is input
  and `eval_count` output ([chat API](https://docs.ollama.com/api/chat) and
  [api.md](https://github.com/ollama/ollama/blob/main/docs/api.md), checked
  2026-10-07). Counts on non-terminal frames are never read. Missing or invalid
  counts keep the answer and omit usage; nothing is derived from text. Deep results
  carry the same usage.
- **Settlement.** `CatalogDispatch.execute` revalidates the returned usage and keeps
  it only for a stop or length result. `finish` then finishes the exact ticket as
  before and, for a token-envelope binding only, applies input plus output through
  the existing delayed `reportQuotaUsage`, which retires the link. Money is never
  reported (no invented zero charge), and static quotas, request envelopes and
  envelope-free bindings are unchanged. If finishing throws, the ticket is kept and
  nothing is reported. Reported usage above the estimate is charged in full,
  including debt above the allowance; it blocks further admission. Finalizing
  reports frees open-charge slots without forgetting their consumed tokens.
- **Cancellation.** A call that completed and returned usage is known consumption
  and settles its own ticket even if the turn was aborted afterwards. A thrown,
  rejected (including validation inside the work) or cancelled result keeps its
  estimate.
- **Not claimed.** These are the provider's per-call counts, not billed amounts or
  account-wide usage. The charge's diagnostic row keeps its estimated units; the
  envelope projection shows the settled amount. Azure, Bedrock and CLI bindings, and
  request-unit reporting, still report nothing.
- **Clock.** Envelope decisions never use a time earlier than one already used, so
  a wall clock stepping back holds time instead of failing settlement.
- **Visibility.** `envelopeAvailability()` is a live projection (window, remaining,
  debt) without credentials. It is kept out of persisted telemetry, since a restart
  loses the ledger it describes; the persisted accounting is unchanged.
- **Not claimed.** This is in-process: a restart loses it, and it is no
  account-wide cap across processes. Windows change only through configuration and
  a restart; no runtime declaration route exists yet. Provider authority remains
  unsupported.

- **Declarations.** An envelope names its pool, window id, an explicit successor
  `sequence`, fixed bounds, allowance, unit, scope (`account` or one configured
  credential) and evidence times. The schema is strict, so an observation-shaped
  payload cannot pass. A re-declaration of the same window is a no-op; the same
  window with newer evidence (a later check, an expiry no earlier) refreshes it;
  anything else, a change of unit or scope, an overlap, a successor at or below the
  pool's highest sequence, or a successor starting before its declaration time is
  a conflict. A new window applies only once declared and started: no reset is
  inferred from time.
- **Accounting.** Amounts are exact decimal units. Every open charge (reserved,
  started, or finished without a per-call usage report) counts once against the
  window active at the time. Unstarted reservations therefore carry into a newly
  active window exactly once; a started charge straddling a reset counts in both
  windows. Per-call reported usage from the call's own response finalizes that one
  charge, in every retained window it straddled; it is distinct from provider
  aggregate observations. A delayed report applies once to an open, finished
  charge; reports for unknown, final or unfinished charges change nothing. Usage
  without a report stays debited at its estimate. Debt beyond an allowance is kept
  and refuses new work, including zero-unit reservations.
- **Safety.** Every refusal leaves the ledger unchanged. Starting work rechecks the
  active window and its debit. Changes may not move the clock backwards;
  `available` is a non-mutating projection that does not advance it. Charge ids
  are a per-ledger prefix plus a BigInt counter and are never reused. Credential
  identities never appear in snapshots or errors.
- **Bounds.** Pools, open charges per pool and retained windows per pool are
  capped. At the open-charge cap a reservation is refused; nothing open is evicted.
  The oldest window is dropped only once it has ended, is not active and no open
  charge started in it; otherwise a new declaration is refused.

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
