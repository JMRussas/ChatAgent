# Next ChatAgent handoff after 01B

Current user direction: **keep work in ChatAgent**. Leave Iris/Hekate changes and
integration validation for sessions working on those repositories. Existing
cross-repository commits are historical context, not authorization to expand scope.

## Completed

- 01A bounded context, pending-task awareness, immutable fast/deep snapshots,
  effective model context limits, and CTX-01–04 regression fixes.
- 01B background internal summaries, immutable source identities and bounded
  source checks. Default extractive mode makes no model calls. Optional model mode
  requires explicit fast-binding selection and separate request budgets. See
  [01B evidence](01b-evidence.md) for acceptance coverage and implementation limits.
- Spec 02 streaming/cancellation and preserved fast/deep answers; see
  [02 evidence](02-evidence.md).
- ChatAgent protocol v1 endpoints are present. Prior Iris integration evidence is
  retained in [the slice checkpoint](07-iris-slice-evidence.md); do not continue
  that repo's work as part of the next ChatAgent milestone.

## Next bounded implementation: spec 03 inventory

Read [03 inventory](03-inventory.md) and the applicable metadata requirements in
[08 resource policy](08-resource-policy.md). Implement connections, catalog v2
migration, fresh provider observations and the named RES-01/03/04/08 fixtures in
ChatAgent. Preserve unknown locality, billing, access and health states rather
than inferring them from provider names. Do not implement dispatch/CLI incidentally
or download models, activate subscriptions, or perform billed probes.

## Limits and deferred work

- Runtime timelines, sources, summaries, queues and duplicate claims are in memory;
  restart persistence and durable replay remain deferred.
- Model summary output is structurally validated, not semantically certified.
  Source checks are bounded ID lookup, not semantic retrieval or tool execution.
- Correction/directive detection is conservative lexical handling, not universal
  contradiction or intent detection. Summaries never become verified facts.
- Summary jobs cancel and settle on server shutdown. Full worker/provider draining
  and the broader spec 06 lifecycle remain separate work.
- No live provider, real browser/mobile or desktop quality gate ran for 01B.
- Existing development processes were not restarted. Restart loses runtime state.

Suggested task: "Implement only ChatAgent spec 03 inventory and its resource
metadata fixtures. Preserve completed context/generation work and keep other
repositories out of scope."
