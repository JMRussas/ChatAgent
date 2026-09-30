# Claude connection and shared-layer review

## 2026-09-30: review findings fixed

All three findings from the review of `4e0bea1` are addressed:

- Inventory respects the earlier of the adapter expiry and configured TTL. Adapters
  without their own limit omit expiry; malformed explicit expiry stays stale.
- Live cleanup inspection has a five-second timeout, bounded output, and guaranteed
  invocation-tree termination in `finally`, including inspection/parse failures.
- Cancellation/timeout acceptance uses the selected binding's model and production
  CLI wrapper, preserving its profile, quota pool, exhaustion policy and output
  budget. The acceptance harness now also goes through InventoryStore.

Validation: **432 TypeScript tests across 60 files**, typecheck, build and seeded
simulated release gate pass. New offline regressions cover expiry caps, inspection
failure/timeout, and a non-Sonnet binding with different quota settings. Live
cancellation and timeout were rerun; each observed three processes and zero
survivors. No account settings changed. Next remains spec 06 verification and
evaluation mode.


## 2026-09-30: Claude live acceptance complete

Claude 2.1.285 through the local Hekate bridge passed catalog selection and a live
answer (`BRIDGE_OK`). Separate cancellation and timeout checks each observed three
processes in the invocation tree and verified zero survivors. This establishes
local cleanup, not proof that remote inference stopped or incurred zero charges.
The runtime supports answer-only/final-only output; tool execution and interleaved
thinking comparisons remain separate evaluation work.

Local configuration now uses catalog routing and the approved 80% headroom policy.
Only Claude has resource-policy evidence in this local profile. Subscription and
potential metered usage are declared; incremental cost stays unknown, with explicit
`allow-unpriced`, no monetary ceiling, and no fallback. The user reports separate
account funding protections. No account settings were changed.

`quotaAdmission: "adapter-preflight"` requires a code-owned binding capability.
Claude evaluates a shared cached inspection before invocation under the CLI
concurrency gate. Discovery and all models share one in-flight account inspection;
reusing it never extends its original 30-second usage expiry. HTTP 429 is reported
as `CLI_USAGE_RATE_LIMITED` and cached as unavailable for 30 seconds to back off.
Other unsuccessful inspections back off for five seconds. No per-call usage HTTP
request is required while evidence is fresh; percentages are never converted to
invented request/token counts.
Configured resource evidence expires after one day and must be reviewed/renewed;
usage evidence expires after 30 seconds. Local discovery runs every 20 seconds.
Missing/stale evidence blocks dispatch.

Live checks are explicit commands, excluded from offline tests:
`npm run cli:claude:accept -- answer`, `-- cancel`, and `-- timeout`.
The latter two verify Windows process-tree cleanup. Each command can use live
subscription capacity. They require the configured local dispatch policy.

Validation: **423 TypeScript tests across 59 files**, **11 Python bridge tests**,
typecheck, build, and the seeded simulated release gate all pass. The simulation
is regression evidence, not a live quality/latency benchmark. Review also corrected
fixtures that assumed the first catalog entry was mock and isolated startup tests
from local routing configuration.

Next: **spec 06 lifecycle/verification and evaluation mode**, then the sports demo.


## 2026-09-29 correction: account setting stays enabled

The earlier requirement to disable account extra usage was too restrictive and
has been removed. No account setting was changed. Checked installed 2.1.285 help,
[CLI reference](https://code.claude.com/docs/en/cli-reference), and
[environment variable reference](https://code.claude.com/docs/en/env-vars).
No supported per-invocation overage opt-out was found. `--max-budget-usd` is an API
spend cap, not a documented included-subscription-only switch; do not use it as one.

Strict mode now reports `CLI_INCLUDED_ONLY_UNSUPPORTED` independently of the
account flag. Prepared opt-in `HEKATE_CLAUDE_USAGE_POLICY=headroom`: fresh shared
and applicable model windows must be below 80%, with valid future resets.
Missing model-specific windows are omitted by the reader, not treated as zero;
shared windows remain mandatory. This is a best-effort check of reported limits,
not an entitlement guarantee or token reservation. Other sessions and observation
lag can still cause paid overage. User accepted this approach, citing existing account funding protections.
Enabled `headroom` in local `.env`; those protections are user-reported, not
independently verified.
Read-only inspection at 2026-09-30T03:02:18Z passed: Claude 2.1.285,
authenticated, automation supported, quota available under the headroom policy.
Shared five-hour usage was 0%, weekly usage 3%, extra usage remained enabled.
No live generation has been run. Resource-policy evidence and live answer/tree
cancellation acceptance remain outstanding.

## 2026-09-29 follow-up: CLI upgrade and actual account usage

Verified the user's update to **2.1.285**. A read-only request to the fixed
`https://api.anthropic.com/api/oauth/usage` endpoint succeeded using the existing
OS-profile OAuth credential, without exposing or persisting credentials.
The endpoint is undocumented and treated as best-effort, not a stable API contract.
This corrects the earlier implication that account usage could not be obtained.

`npm run cli:claude:inspect` now exposes a timestamped, allowlisted usage snapshot.
At the verification time, shared five-hour usage was **0%**, weekly usage **3%**,
and extra usage was **enabled**. Separate Opus/Sonnet limit fields were null;
null is not zero or proof of an unlimited model allowance. `seven_day_breakdown`
contains consumption shares and is not interpreted as a quota window.

The reader does not follow redirects, logs no credentials/raw errors, limits
response bytes/time, and makes no automatic retries. Missing, failed or malformed
observations remain unavailable. The existing strict generation gate is unchanged:
observed percentage headroom is not an exact token reservation or permission to
use paid overage. Resource-policy reconciliation and live answer/cancellation
acceptance remain open. No model request was made for this verification.

**11 Python contract tests pass**, including window normalization, null/malformed
values, model scope, extra-usage flags and distinction from breakdown percentages.
The original review below remains the record of the initial 2.1.143 investigation.

2026-09-29. User selected **Claude**, then **local bridge to Hekate's shared
provider**. This supersedes the pending product selection in older handoffs.
Local profile: `default` (existing OS login). Claude Code **2.1.143** reports
authenticated first-party `claude.ai` access and a Max subscription. No credential,
account identifier or auth-file content was copied into this repository.

## Review findings

Reviewed Hekate checkpoint `358e614`, including the unified provider, its executor,
quota manager, active gods provider and gateway source. Hekate has unrelated local
changes; this work does not modify or deploy that repository.

1. **High: the agent-oriented defaults are unsuitable for answer-only chat.**
   The shared provider defaults permit file/shell/MCP tools. The separate gods
   provider's `if cfg.tools:` drops `tools=""`, so setting that field does not
   disable tools. The bridge uses the unified builder, which preserves the empty
   string, and fixes tool, MCP, hooks, setting-source and session options.
2. **High: shared executor cleanup is insufficient for our cancellation contract.**
   Its `_run` kills only the immediate child; streaming stderr is read only after
   waiting for stdout/process completion, so a full stderr pipe can stall it.
   The bridge uses ChatAgent's outer process-tree lifecycle and drains both pipes
   concurrently with a combined raw-byte limit. Existing executors are not called.
3. **Medium: final answers can be duplicated.** The shared executor adds both
   assistant text and final result text. The bridge normalizes through Hekate but
   publishes one final answer without appending the duplicated result. Live debugging
   found that the CLI result may contain only the last public text block; the bridge
   now preserves earlier public blocks. Partial stream events expose output limits:
   on the first `max_tokens` stop, the bridge terminates its CLI child and returns
   the retained prefix as `length`, preventing hidden continuation and tail-only
   success. An empty prefix fails explicitly. Reasoning/diagnostic text is discarded;
   output to ChatAgent remains final-only. Unsupported transcript rewrites fail closed.
4. **High for admission: local quota estimates are not account allowance.**
   `ProviderQuotaManager` sums local `usage_log` rows against configured windows;
   it cannot account for external account usage. Authentication is not proof of
   remaining included usage. Inspection reports quota unknown and generation stays
   blocked under the current spec. A proposed bounded-attempt policy is awaiting
   the user's choice; it is not silently enabled.
5. **Medium: cost normalization is not reliable billing evidence.** The shared
   Claude normalizer reads `total_cost` and defaults missing values to zero. The
   bridge does not use that value to claim free execution. Subscription extras
   and actual incremental cost remain unverified.
6. **Fixed in ChatAgent:** the CLI wrapper now carries fast/deep role and uses its
   corresponding output reservation instead of one shared catalog maximum.

Shared file SHA-256 at review:
`8677a68a98927e5fdb15c23b66622f44248f99f9c2925f522106f7394d1d47db`.
The bridge imports `CommandBuilder` and `_normalize_claude_event` from that checkout.
The latter is a private interface: rerun the contract suite when updating Hekate.
It does not copy the provider registry/model catalog into TypeScript.

## Connection and verification

Operator paths in the gitignored `.env` locate the existing Hekate checkout,
native Python 3.12, native Claude executable and an empty working directory.
Both Python and Claude must run on the Node host OS for process-tree cleanup.
No shell shim, global CLI update, login automation or service deployment is used.

`npm run cli:claude:inspect` checks the local bridge, installed CLI flags and
existing authentication. Its output is allowlisted readiness metadata. It makes
no model request and does not establish generation readiness when quota is unknown.

For catalog integration, a CLI entry must specify `adapterId: "hekate-claude"`,
`accountProfile: "default"`, `authentication: "subscription-login"`,
`executionMode: "answer-only"`, `streaming: "unsupported"`, `outputFormat: "jsonl"`
and subscription billing with `usageBillingFallbackAllowed: false`. Catalog mode
still requires explicit resource policy and limits. Existing local Ollama routing
remains selected while the live acceptance cases are unresolved.

Run the actual shared-provider contract tests with:

```sh
python bridges/hekate/test_bridge.py
```

Set `HEKATE_TEST_ROOT` if the checkout is not a sibling named `Hekate`.
Tests cover empty tools/settings arguments, one-turn/no-fallback behavior,
diagnostic filtering, one final answer, rejected tool activity and safe errors.
TypeScript tests cover explicit registration, safe protocol parsing and phase
output budgets. Real authentication inspection passed. **Live answer and live
cancellation acceptance remain pending; no generation pass is claimed.**

Validation: **415 TypeScript tests / 59 files**, **9 Python contract tests**, build,
type checking and the seeded simulated release gate pass. The shipped catalog now
contains `claude-hekate-default`; its conservative context/output caps are application
limits, not measured model limits. Without the local bridge configuration it remains
unsupported; with authenticated inspection it remains unavailable for generation
while quota is unknown. No resource-policy or paid-fallback permission was fabricated.

The installed CLI's own `--help` was checked alongside the official
[CLI reference](https://code.claude.com/docs/en/cli-reference) and
[programmatic usage guide](https://code.claude.com/docs/en/headless).
In particular, installed `--bare` requires API authentication, so this subscription
bridge does not use it. Account quota and extra-usage behavior are not inferred
from newer documentation or subscription tier.
