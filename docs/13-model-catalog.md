# Model catalog and task routing

`data/model-catalog.json` is the versioned, validated inventory. Override its path
with `MODEL_CATALOG_PATH`. Invalid catalogs fail startup. `GET /models` returns the
inventory, current fast/deep selections, and any configured models missing from it.
The current router still uses `CHAT_FAST_*` and `CHAT_DEEP_*`; catalog eligibility
is groundwork for automatic selection, not an automatic dispatch change.

Each entry describes one provider/model binding using the current environment's
connection for that provider. Azure model names are deployment names. Multiple
accounts/endpoints for the same provider/model will require connection IDs before
they can be represented separately. Credentials belong in environment configuration,
never in this file, its notes, or evaluation reports.

Metadata:

- Stable ID, provider/model binding, enabled state, and intended fast/deep roles.
- Task preferences: conversation, coding, reasoning, summarization, extraction.
  These are operator preferences, not measured quality claims.
- Thinking, tools, vision, and structured-output support: supported, unsupported,
  or unknown. Supporting a capability at model level does not implement its tools
  in this application; adapter support must also be checked before dispatch.
- Effective context/output limits for the deployed instance. Missing means unknown;
  request generation budgets remain separate environment settings.
- Local/remote/unknown deployment. Ollama does not imply local: its URL can be remote.
- Optional dated pricing with a source; missing price does not mean free.
- Optional task evaluation records with sample count, success rate, latency,
  environment, date, and report reference. Do not populate these with simulated
  benchmark quality scores or model self-assessments.

`findModelCandidates` filters enabled entries by task, role, required capabilities,
and context/output capacity. Unknown hard requirements exclude a model. It does
not rank candidates or certify availability. `/models` deliberately reports
availability as unchecked, even for the configured pair.

Next implementation steps:

1. Discover installed Ollama models and deployment metadata from provider APIs;
   record identity/revision, source and freshness for each observation. Merge
   observations without overwriting operator preferences.
2. Maintain time-limited health observations separately from the static catalog.
   Distinguish installed, loaded, reachable, authorized, busy, and unavailable.
3. Build bounded per-turn context and estimate token requirements before selection.
4. Add a tested task classifier and enforce model **and adapter** capabilities.
5. Rank eligible, healthy models using task evaluations, latency, queue pressure,
   data-locality policy, and cost. Provide an explicit fallback when none qualify.
6. Persist the selected model and selection reason on each task/turn. Show that
   actual selection in the reply bubble; global fast/deep labels will be insufficient.

Start with deterministic policies and a golden routing set. Introduce a learned
router only after collecting evidence that it improves the decisions.

## CLI access through subscriptions

The catalog also accepts `provider: "cli"`. This describes an access path to a
model, not a claim that a particular subscription supports automation. CLI entries
require a `cli` object; subscription login also requires explicit subscription
billing metadata. Example fields to add to an otherwise complete model entry:

```json
{
  "provider": "cli",
  "cli": {
    "adapterId": "example-cli",
    "accountProfile": "personal",
    "authentication": "subscription-login",
    "nonInteractive": "unknown",
    "streaming": "unknown",
    "outputFormat": "unknown",
    "executionMode": "unknown",
    "automationSupport": "unknown"
  },
  "billing": {
    "kind": "subscription",
    "planLabel": "My existing subscription",
    "quotaPoolId": "personal-subscription",
    "exhaustionPolicy": "wait",
    "usageBillingFallbackAllowed": false
  }
}
```

No actual CLI adapter is implemented yet. `/models` reports CLI adapters as
`not-implemented`, and candidate filtering excludes them even if enabled.
CLI adapter and account profile are part of binding identity, so the same model
can be represented through different subscriptions. No subscribed models are
seeded because the user's actual CLI products and entitlements have not been verified.

The adapter ID refers to code we implement, not a shell command supplied by the
model or catalog. An adapter must handle structured invocation/output, login
expiry, cancellation of the process tree, deadlines, bounded output, and quota
errors. Keep sessions and credentials in the CLI's supported authentication store;
the catalog contains only a profile reference. Subprocess launch location does
not imply local inference: a local CLI can send prompts to a remote service.

Before enabling each adapter, verify its supported noninteractive interface and
the subscription's supported automation use. Distinguish text generation from an
agent that can edit files or run tools. Agent execution needs an explicit workspace
and tool permissions; it must not silently inherit authority from a chat request.

Subscription capacity is not an unlimited zero-cost token pool. Keep remaining
allowance, reset time, login state, CLI version, and health as dated runtime
observations. `quotaPoolId` identifies models sharing one allowance. On exhaustion,
apply the configured wait/fail/approved-fallback policy. Do not silently change to
separately billed API access. Billing settings describe policy; enforcement comes
with the future dispatcher and CLI adapter.
