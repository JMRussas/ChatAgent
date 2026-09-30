# Claude connection and shared-layer review

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
   publishes only one successful final result. It currently provides final-only
   output, not token streaming. Reasoning/diagnostic frames are discarded.
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
