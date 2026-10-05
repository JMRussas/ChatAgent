# Runtime reference

Configuration, HTTP contracts and developer commands for ChatAgent. For the current
project overview and measured results, start with the [README](../README.md).
The package and some internal types retain the name ChatRuntime.

## Optional sports briefing HTTP boundary

Compose `new BriefingHttp(coordinator, profile)` and supply it as
`startServer(port, { briefings })` or `createChatServer(service, { briefings })`.
Alternatively, set `SPORTS_BRIEFING_CONFIG_PATH=data/sports/nfl-live-briefing.example.json`
in local configuration and start the server normally. `startServer` loads that file;
explicit injection takes precedence. `createChatServer` remains injection-only.
The file contains a profile, RSS feeds, shared games budget/cache settings and
coordinator limits. It never contains the API key; games use `BALLDONTLIE_API_KEY`.
The default games budget allows five starts per rolling minute with no mandatory
spacing; `minIntervalMs` optionally adds spacing. Excess requests fail fast and a
provider 429 imposes cooldown. RSS does not consume this budget. Cache hits/coalesced
reads do not reserve extra starts. Budgets are shared within one runtime, not across
processes or other applications using the same key.
Invalid configuration fails startup with a safe error. Startup performs no sports
fetches; only explicit start commands do. Missing games credentials leave news usable.

The coordinator receives the server-owned adapter registry and execution limits;
the profile is validated and copied at boundary construction. The default app does
not enable this endpoint or silently load fixtures. Live chat discovers the configured sources through its capability registry. See [the demo plan](18-nba-briefing-demo.md) for source and fixture setup.

After editing the configured file, apply it without restarting:

```bash
curl -X POST http://localhost:3100/briefings/config/reload \
  -H 'Content-Type: application/json' -d '{}'
```

Returns `200 {version, changed}`; invalid files return `400 SPORTS_BRIEFING_RELOAD_FAILED`
and retain the active configuration. Without a reload-capable briefing runtime it
returns `404 BRIEFING_RELOAD_DISABLED`. Reload requests accept no overrides and are
serialized. Identical validated configurations do not replace sources/caches.
New run snapshots include `configVersion`; existing jobs retain their versions,
source instances and deadlines. Identical retries still find their original runs.
Changed configuration replaces caches for new runs, but preserves the shared request
history and provider cooldown. Rate/concurrency/capacity changes apply to new
admissions immediately without cancelling active work or evicting runs. Capacity is
still process-local and retained runs are not automatically removed.

The selected file path and API key are pinned at startup; changing those, `.env`,
or the server port still requires restart. This is an explicit local-prototype
administration endpoint, with the same access boundary as the existing API.
There is no file watcher or UI reload control.

`POST /briefings` accepts exactly one of these JSON command shapes:

```json
{"op":"start","userId":"user-demo","requestId":"briefing-1","request":{"now":"2026-09-30T12:00:00Z","timezone":"America/New_York","team":null}}
```

```json
{"op":"status","userId":"user-demo","runId":"<returned UUID>"}
```

```json
{"op":"cancel","userId":"user-demo","runId":"<returned UUID>","taskId":"<optional returned task UUID>"}
```

Omit `taskId` to cancel the run. Start returns `202` with the run snapshot promptly;
status/cancel return `200`. A duplicate user/request ID with an identical resolved
plan returns the same run; changed inputs return `409 BRIEFING_REQUEST_CONFLICT`.
For retries, reuse the exact request including `now`. Use a new ID for Refresh.
Unknown or other-user runs return `404`; unknown task IDs return `404`. Capacity
returns `429`, a closed coordinator `503`, invalid bodies/checkpoints `400`.
Disabled briefings return `404 BRIEFINGS_DISABLED`. Shutdown rejects admission with
`503 SHUTTING_DOWN`. Client-supplied profile/budget fields are rejected; unexpected
configuration failures produce a safe `503 BRIEFING_UNAVAILABLE` without raw details.

`userId` is a prototype ownership guard, not authenticated identity. Requests supply
an explicit as-of clock for reproducible fixtures; a future live product boundary
must derive its operational clock/checkpoints server-side. This endpoint returns
structured evidence, not model-generated summaries. Results retain source identity,
synthetic/live mode and coverage. Inspect task states; settled does not mean successful.

Runtime shutdown closes briefing admission and signals cancellation in its background
stop hook; direct server close also closes the coordinator. Noncooperative adapters
may outlive logical cancellation, retain their execution slot and cannot publish late
results. No durable storage, resume, automatic refresh, retrieval tool exposure to
chat models or UI integration is implied.

## HTTP API

Malformed JSON payloads on POST endpoints return `400` with error `Invalid JSON body`.
JSON bodies for POST endpoints must be non-null objects; `null`, arrays, and primitive values return `400`.

`POST /messages` accepts an optional UUID `messageId` (the server allocates one
when absent) and returns the same response fields after the fast phase ends. It also returns:

- `409` with code `DUPLICATE_MESSAGE_ID` for a repeated ID in the same conversation.
- `409` with code `CONVERSATION_OWNER_MISMATCH` if a `userId` other than the one
  that first submitted to a `conversationId` tries to post to it. This is a
  local-prototype guard against accidentally mixing two users' turns into one
  conversation's shared context, not authentication.
- `413` with code `CONTEXT_TOO_LARGE` if the message plus configured instructions
  would exceed the conversation context budget (see "Conversation context budget"
  below) even before any history is added. No events are appended and no deep task
  is enqueued when this happens.

1. Submit message

```bash
curl -X POST http://localhost:3100/messages \
	-H "Content-Type: application/json" \
	-d '{"conversationId":"conv1","userId":"u1","text":"Find latest inflation data and cite sources"}'
```

2. Run deep worker once

```bash
curl -X POST http://localhost:3100/workers/deep/run-once
```

3. Get conversation timeline

```bash
curl http://localhost:3100/conversations/conv1/events
```

4. List deep-worker dead-letter records

```bash
curl http://localhost:3100/workers/deep/dead-letters
```

5. Replay a dead-letter task

```bash
curl -X POST http://localhost:3100/workers/deep/dead-letters/<taskId>/replay
```

The list response also reports `capacity`: the configured `DEAD_LETTER_MAX_RECORDS`
/ `DEAD_LETTER_MAX_BYTES` limits and the current records, reserved slots and bytes.
Every queued, running or replayed deep task reserves one slot sized to its serialized
task, so its failure can always be recorded. Records never expire and are never
evicted. When records plus reservations reach either limit, a new deep-routed
message is rejected with `503` / `DEAD_LETTER_CAPACITY` before its user event is
written, so the same `messageId` can be resubmitted later; direct turns continue.
A replayed record keeps its slot until the replayed task settles. Replay still
fails explicitly (`CONVERSATION_EXPIRED`, `DISPATCH_SNAPSHOT_UNAVAILABLE`,
`REPLAY_CONFLICT`) and restores the record when its dependencies are gone.

Dead-letter reservations own the admitted task snapshot. Provider/replay mutations
cannot expand the stored task or change the replay input. Added records and list
results are copied; unreserved record replacements update serialized task-byte
accounting atomically and preserve the old record on capacity rejection. The byte
limit covers serialized tasks, excluding failure metadata and heap overhead.
The worker also records failures during attempt creation after dequeue, including
expired history. Direct queue enqueues bypass reservation; their failure records
remain subject to available dead-letter capacity.

Discard a dead-letter record (explicit operator decision; frees its slot):

```bash
curl -X DELETE http://localhost:3100/workers/deep/dead-letters/<taskId>
```

Discarding removes the only replayable copy of the task. The failure itself stays
in the conversation timeline as the task's terminal error event while that history
is retained.

Conversation identities (operator endpoints; no authentication, like the rest of
this server):

```bash
curl http://localhost:3100/conversations/retention
curl -X DELETE http://localhost:3100/conversations/<conversationId>/identity
```

An expired conversation keeps its ID reserved: history, selected scope, summary
memory and source indexes are gone, but the owner and a tombstone remain so the ID
cannot silently become a new conversation. Nothing recycles these slots
automatically. The listing reports the identity limit, current owners and up to
200 expired identities with their expiry time; `DELETE` retires one of them.

Retirement removes the tombstone, the owner, the protocol-v1 wire mapping, settled
execution records and any tool results or team/game snapshots bound to the
conversation, in that order of dependence: ownership is released last. It returns
`404 CONVERSATION_NOT_FOUND` for an ID the process does not hold and
`409 CONVERSATION_RETIREMENT_BLOCKED` with a `blockers` list otherwise:

| Blocker                                             | Meaning                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `HISTORY_LIVE`                                      | Not expired. Retirement never deletes history.                      |
| `DEAD_LETTERS`                                      | A record or reserved slot refers to it; replay or discard it first. |
| `QUEUED_TASKS`, `ACTIVE_TURNS`                      | Work could still write to it.                                       |
| `DOCUMENT_TASKS`, `DOCUMENT_TASKS_UNKNOWN`          | The sidecar holds tasks for it, or could not be asked.              |
| `QUEUE_UNINSPECTABLE`, `DEAD_LETTERS_UNINSPECTABLE` | A custom queue or store lacks the inspection contract.              |
| `RETIREMENT_UNSUPPORTED`, `PARTICIPANT_UNAVAILABLE` | The timeline store has no retirement contract, or a check failed.   |

`RETIREMENT_REFUSED` means the timeline refused the final deletion; ownership
remains claimed even if dependent cleanup already ran.

A retired ID is unknown to the process. A later request with it starts an
unrelated conversation that any `userId` may claim, and message IDs used in the
old conversation are no longer rejected as duplicates. This is bounded
process-local identity, not durable deduplication. Dead letters are never
discarded on the operator's behalf, and there is no abandon operation for
document tasks, so a conversation with document tasks cannot be retired yet. A
legacy or protocol-v1 stream that followed the retired conversation is closed
rather than continued into the new one. Pending team-directory/game searches and
document-task starts lease the history until their response settles, so they
cannot publish dependent state after retirement. Retirement rechecks an opaque
identity incarnation after awaiting participant blockers; stale answers cannot
retire a reused ID. Custom timeline retirement requires `conversationVersion`
alongside the state and deletion contracts.

6. Read latency telemetry and current routing policy

```bash
curl http://localhost:3100/telemetry/latency
```

Response now also includes `queueDepth` for the current in-memory deep-task queue.

7. Trigger policy auto-tune based on queue depth

```bash
curl -X POST http://localhost:3100/routing/policy/tune \
	-H "Content-Type: application/json" \
	-d '{"queueDepth":10}'
```

## TDD flow

Use this loop for each feature:

1. Write or update tests in `tests/`
2. Run `npm run test:tdd`
3. Implement minimal code in `src/`
4. Refactor while tests stay green

## Configuration and secrets

Runtime provider configuration is read from environment variables. The experiment runners also have documented fixed settings; consult their protocols before comparing results.

Local setup:

```bash
cp .env.example .env
# then edit .env with real values
```

`.env` is listed in `.gitignore` and should not be committed. `.env.example` is the checked-in template for local configuration, with placeholder or empty credential values.

Provider keys belong in environment configuration, not source control. Startup
validation checks required configuration and logs a redacted provider summary.
AWS authentication uses the standard SDK credential chain, including environment
credentials or configured profiles/roles. See `src/config/providerConfig.ts` and
the provider adapters for the implemented behavior.

The server has no built-in authentication. Conversation ownership checks use
client-supplied identities and are only prototype guards. Production deployment
requires a separate authentication and operational-hardening design.

## Provider configuration

The validated inventory lives in [data/model-catalog.json](../data/model-catalog.json).
Inspect it and the active selections at `GET /models`, which now also reports
each binding's real discovery-derived `availability` (`disabled`,
`unsupported-adapter`, `unchecked`, `stale`, `denied`, `unavailable`, `ready`,
in that precedence) instead of a hardcoded value, plus declared
execution/billing/compute facts when a matching connection exists. Discovered
models with no matching catalog entry appear separately under `discovered`,
always disabled -- discovery never auto-curates. See
[model catalog design](../docs/13-model-catalog.md) for metadata and the
task-routing plan. Automatic selection is not enabled yet. The schema also
accounts for CLI subscription access and shared quota pools; CLI execution
adapters are not implemented yet.

Fast and deep layers are independently configurable. This allows mix-and-match across Azure, Bedrock, and Ollama.

Supported provider values:

1. `mock`
2. `azure`
3. `bedrock`
4. `ollama`

Core environment variables:

```bash
CHAT_FAST_PROVIDER=ollama
CHAT_FAST_MODEL=llama3.1:8b
CHAT_DEEP_PROVIDER=bedrock
CHAT_DEEP_MODEL=anthropic.claude-3-5-sonnet-20240620-v1:0
CHAT_FAST_TEMPERATURE=0.2
CHAT_DEEP_TEMPERATURE=0.2
```

Provider-specific settings:

```bash
# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_API_VERSION=2024-10-21

# AWS Bedrock
BEDROCK_REGION=us-east-1

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_FAST_TIMEOUT_MS=20000
OLLAMA_DEEP_TIMEOUT_MS=60000
OLLAMA_FAST_NUM_PREDICT=256
OLLAMA_DEEP_NUM_PREDICT=512
```

Azure, Ollama and Bedrock calls have deadlines covering response headers and streamed bodies. Bedrock uses a 60-second deadline; Azure uses 10 seconds.
If local Ollama models are large or cold-start slowly on your hardware, increase `OLLAMA_FAST_TIMEOUT_MS` and `OLLAMA_DEEP_TIMEOUT_MS`.
If a model emits long reasoning traces and returns empty final text at low token budgets, increase `OLLAMA_FAST_NUM_PREDICT` and `OLLAMA_DEEP_NUM_PREDICT`.

Ollama requests go to `/api/chat` (not `/api/generate`), sending role-based
`system`/`user`/`assistant` messages so both fast and deep layers see the same
shared conversation snapshot; Azure and Bedrock also switch to role-based
messages (Bedrock's system instruction goes in its separate `system` field).

### Model discovery and inventory (spec 03)

On startup, and every `MODEL_DISCOVERY_INTERVAL_MS`, the server discovers what
each configured connection actually offers: Ollama's installed models via
`GET /api/tags` + `POST /api/show` (verified against the official docs), Azure
deployments via the ARM management plane (the Azure OpenAI resource's own
deployments-list endpoint was retired in 2024; this now requires a _separate_
AAD app-registration credential, distinct from `AZURE_OPENAI_API_KEY`), and
Bedrock foundation models via `@aws-sdk/client-bedrock`'s
`ListFoundationModelsCommand` (the control-plane client, distinct from
`@aws-sdk/client-bedrock-runtime` used for actual inference). Missing cloud
credentials make that connection's discovery simply unavailable; they never
block startup or affect other connections. An observation is fresh for
`MODEL_DISCOVERY_TTL_MS`; a failed refresh retains the last-known observation
without extending its expiry, so a binding correctly becomes `stale`.

```bash
MODEL_DISCOVERY_INTERVAL_MS=300000
MODEL_DISCOVERY_TTL_MS=600000
MODEL_DISCOVERY_TIMEOUT_MS=10000

# Azure ARM (management-plane) credentials, separate from AZURE_OPENAI_API_KEY:
AZURE_ARM_TENANT_ID=
AZURE_ARM_CLIENT_ID=
AZURE_ARM_CLIENT_SECRET=
AZURE_ARM_SUBSCRIPTION_ID=
AZURE_ARM_RESOURCE_GROUP=
AZURE_ARM_ACCOUNT_NAME=
```

Execution location and billing are **declared policy facts, never inferred**
from a base URL or provider name -- a `localhost` Ollama endpoint is not by
itself evidence of `local-device` execution, since Ollama can also proxy its
own hosted cloud models through a local instance. Set them explicitly per
connection if you want them recorded:

```bash
# Scope: local-device | self-hosted-remote | managed-cloud | hybrid | unknown
# Billing (comma-separated): metered-usage, subscription, provisioned-capacity, owned-compute, unknown
OLLAMA_EXECUTION_SCOPE=local-device
OLLAMA_BILLING_COMPONENTS=owned-compute
```

Legacy v1 catalog entries (naming only a `provider`) are migrated in memory to
v2's `connectionId`/`apiKind` shape using a deterministic `default-<provider>`
connection -- the catalog file itself is never rewritten. This is metadata
only (spec 03); admission/selection logic that acts on it is spec 04.

### Streaming and cancellation

Orchestrated calls use Ollama chat NDJSON, Azure chat SSE, and Bedrock
`ConverseStream`. Direct adapter callers without `GenerationControl` retain a
non-streaming transport, with the same typed finish outcomes. Delta events are
coalesced to at most one per 50 ms per attempt (with a final flush); answer buffers
and stream frames are capped at 1 MiB. SSE still sends full timeline snapshots.

`POST /conversations/:id/messages/:messageId/cancel` returns 404 for an unknown
turn, or 200 with existing/cancelled phase states. It aborts running calls and makes
workers skip cancelled queued tasks. Disconnecting SSE does not cancel work.
The browser creates IDs before POST so Stop works while the fast call is pending.

`length` output is shown as incomplete and excluded from accepted context history.
Only transient failures before any answer text are retried (at most twice, each
with a new attempt ID). Partial failures retain their text; cancellation is never
retried or dead-lettered. Public failures use safe codes rather than provider bodies.

```bash
OLLAMA_FAST_THINK=off
OLLAMA_DEEP_THINK=default
```

Values are `off`, `on`, or `default`. Explicit controls require a successful
`/api/version` check and a matching boolean in `/api/show`'s `thinking.values` for
the selected model. Unsupported or unavailable metadata fails startup; use
`default` to leave model behavior unspecified. No model-name heuristic establishes
support. Startup metadata checks do not generate answers. Live behavior and browser
layout remain separate verification gates; see [adapter notes](../docs/implementation/02-evidence.md).

### Conversation context budget

Both the fast and deep layers for a turn receive the same bounded conversation
snapshot: recent completed user/assistant pairs, the current user message, frozen
grounding instructions, and a verified-facts block (actual provider/model pair
and a server timestamp — never a guessed host location). Turns still in progress,
failed, or retrying appear to later turns as an explicit "unresolved request"
note, not as an accepted answer.

```bash
CONTEXT_WINDOW_TOKENS=8192
CONTEXT_MAX_HISTORY_TURNS=12
CONTEXT_SAFETY_TOKENS=256
CHAT_FAST_MAX_OUTPUT_TOKENS=512
CHAT_DEEP_MAX_OUTPUT_TOKENS=2048
```

Startup caps the shared window at the minimum of `CONTEXT_WINDOW_TOKENS` and
any `limits.contextTokens` configured in the model catalog for the selected
fast/deep provider and model bindings. Missing or unlisted limits remain unknown;
unselected models do not constrain the window. Output and safety reserves are
validated against this effective window before providers are constructed.

`CONTEXT_WINDOW_TOKENS` is an application working limit for this prototype, not a
claim about any specific model's real context window; token counts are a
conservative UTF-8-byte-based estimate, not a provider tokenizer. The server
fails to start if the output reserve plus safety tokens would leave no room for
input. `OLLAMA_FAST_NUM_PREDICT` / `OLLAMA_DEEP_NUM_PREDICT` remain authoritative
when explicitly set; otherwise Ollama uses `CHAT_FAST_MAX_OUTPUT_TOKENS` /
`CHAT_DEEP_MAX_OUTPUT_TOKENS`. See [01 — Conversation context](../docs/implementation/01-context.md)
and its [memory extension](../docs/implementation/01-context-memory.md) for the full
design. Internal source-linked memory (01B) is implemented; the visible transcript
is never replaced by a summary.

```bash
CONTEXT_SUMMARY_MODE=extractive  # off / extractive / model
CONTEXT_SUMMARY_TRIGGER_RATIO=0.8
CONTEXT_SUMMARY_MAX_TOKENS=1024
CONTEXT_SUMMARY_TIMEOUT_MS=5000
# Model mode requires explicit opt-in to extra calls on the existing fast binding:
# CONTEXT_SUMMARY_MODEL_BINDING=fast
```

Compression runs in the background over older completed turns; the newest four
pairs stay eligible as exact history. Extractive mode selects verbatim excerpts
with user/assistant attribution and makes no model calls. Model mode uses a
separate bounded internal request and output cap, never the chat queue. Invalid
or timed-out summaries leave bounded history and any still-valid prior memory.

“How do you know”, “check that”, “verify that”, and “what did I say” trigger bounded
source-ID checks for included memory. Original records remain immutable; later
refinements invalidate affected future memory without changing queued snapshots.
Memory is untrusted data, not verified facts. `/telemetry/context` reports counts,
budget estimates and latency without text. All stores remain in memory and reset
on restart. See [01B evidence](../docs/implementation/01b-evidence.md) for acceptance
coverage and the limits of lexical correction/conflict handling and model summaries.

Evaluation reliability thresholds (optional env vars):

```bash
EVAL_MAX_DEAD_LETTER_RATE_DEEP=0.1
EVAL_MAX_AVG_RETRIES_DEEP=1
```

Adaptive routing threshold (optional env var):

```bash
ROUTING_MAX_FAST_P95_MS=1000
TELEMETRY_STORE_PATH=data/latency-telemetry.json
TELEMETRY_SAVE_INTERVAL_MS=5000
DEEP_WORKER_AUTO_RUN=true
DEEP_WORKER_INTERVAL_MS=500
```

Telemetry snapshots are schema-validated on load/save. Invalid or malformed snapshot files are ignored with warnings, and snapshot writes use atomic file replacement.
`ROUTING_MAX_FAST_P95_MS` and `TELEMETRY_SAVE_INTERVAL_MS` are normalized and clamped to safe ranges during startup.
When `DEEP_WORKER_AUTO_RUN=true`, the server drains one deep task per interval tick so provisional replies can refine automatically without manual `/workers/deep/run-once` calls.

UI behavior:

1. `GET /` serves a static control-room page (vanilla HTML/CSS/JS) for desktop and mobile.
2. The page posts to `/messages`, streams timeline updates from `/conversations/:id/events/stream` (SSE), and polls `/telemetry/latency` once per second.
3. Deep-route turns render provisional replies first and then swap in-place to refined replies when background processing completes.
4. Each turn has attached activity with expandable attempt history, model identity,
   separate queue/execution times, and a Stop button. Substantive fast answers remain
   visible when a deep answer arrives as an Update, with each version’s own outcome
   label. Empty failed/incomplete/cancelled phases also retain a visible status. Application acknowledgments can
   be replaced; model depth never implies a correction or verification.
5. SSE snapshots now carry answer deltas and terminal outcomes. The browser rebuilds
   by event sequence/attempt identity on reconnect. Hidden reasoning is never emitted;
   “Reasoning enabled” appears only for an explicitly verified/applied control.
6. When a conversation's history expires, the legacy stream sends a
   `conversation-expired` event before it closes; a page that loads an already
   expired ID learns it from the 410 on the events endpoint. The page then shows a
   notice, keeps the last copy it received as read-only text, disables Send and
   offers "Start a new conversation", which switches to a fresh ID. A full history
   (413) shows the same offer; server conversation capacity (503) is explained in
   the status line because a new ID would not help.

Adaptive routing behavior:

1. Classifies prompt complexity, ambiguity, external-data need, and size band.
2. Seeds provider/model priors for latency percentiles by route and size.
3. Blends priors with live observations as traffic increases.
4. Uses p95 guardrail to escalate moderate requests to deep path when fast-path tail latency is predicted to breach SLO.

## Benchmarking

Run profile benchmark report generation:

```bash
npm run bench:run
```

Set an explicit simulation seed for reproducible benchmark candidates:

```bash
BENCH_SIM_SEED=default-v1
npm run bench:run
```

Run benchmark in live mode against a running local server:

```bash
BENCH_MODE=live
BENCH_BASE_URL=http://localhost:3100
npm run bench:run
```

`BENCH_MODE` must be either `simulate` or `live`; invalid values fail fast.
Benchmark prompt files are validated for non-empty `{ id, text }` records with unique ids.
The benchmark runner executes only when called as a CLI entrypoint, so importing it in tests does not trigger benchmark runs.

Compare candidate benchmark run to baseline with gates:

```bash
npm run bench:compare
```

Compare also enforces benchmark context compatibility (mode, prompt digest, profile digest, and simulation seed when available).
It also requires full profile-set parity (no missing/extra profile names between baseline and candidate).

Optional compare thresholds/env:

```bash
BENCH_BASELINE_PATH=reports/benchmark-summary-baseline.json
BENCH_CANDIDATE_PATH=reports/benchmark-summary.json
BENCH_COMPARE_OUT=reports/benchmark-compare.md
BENCH_MAX_FIRST_P95_REGRESSION_MS=150
BENCH_MAX_FINAL_P95_REGRESSION_MS=300
BENCH_MAX_DEAD_LETTER_REGRESSION=0.05
BENCH_MIN_QUALITY_DELTA=-0.05
```

Threshold values are validated at runtime; invalid values fail compare with explicit configuration errors.

Retention measurements (provider-free; both need `--expose-gc`, which the scripts pass):

```bash
npm run bench:admission-retention
npm run bench:sustained-memory -- --out docs/measurements/sustained-memory-<date>.json
```

`bench:sustained-memory` builds the live-shaped runtime (`CapabilityChat` with
catalog dispatch and the sports registry) and the queue-shaped runtime
(`ChatOrchestrator`, deep worker, dead letters) in one process, drives them over
loopback HTTP past scaled-down limits, and asserts registry sizes after every
round and after shutdown. It exits nonzero when an assertion fails or when
post-warmup heap grows by more than 5% between the first and last third of the
measured rounds. `--measured <n>` lengthens the run and `--heap-only` keeps a long
soak from measuring its own report. The settings, workload, exclusions and raw
samples are in the report; it is not part of `verify:release`.

## Release Verification

Run the full release gate in one command:

```bash
npm run verify:release
```

This runs:

1. tests
2. type-check
3. evaluation report generation
4. benchmark run
5. benchmark compare gates

Artifacts:

1. `reports/benchmark-summary.json`
2. `reports/benchmark-summary.md`
3. `reports/benchmark-compare.md`

## Golden Route Set (end-to-end)

Use the golden set to fully execute the running system against route expectations
and response-shape checks.

1. Start the server (`npm run dev`).
2. Run the golden suite:

```bash
npm run eval:golden
```

Default inputs/outputs:

1. Input cases: `data/golden-prompts.json`
2. JSON report: `reports/golden-eval.json`
3. Markdown report: `reports/golden-eval.md`

Optional env vars:

```bash
GOLDEN_SET_PATH=data/golden-prompts.json
GOLDEN_BASE_URL=http://localhost:3100
GOLDEN_REPORT_JSON_PATH=reports/golden-eval.json
GOLDEN_REPORT_MD_PATH=reports/golden-eval.md
GOLDEN_DEEP_TIMEOUT_MS=120000
GOLDEN_POLL_INTERVAL_MS=400
```

Examples:

1. Fast on Ollama, deep on Bedrock

```bash
CHAT_FAST_PROVIDER=ollama
CHAT_FAST_MODEL=llama3.1:8b
CHAT_DEEP_PROVIDER=bedrock
CHAT_DEEP_MODEL=anthropic.claude-3-5-sonnet-20240620-v1:0
```

2. Fast on Azure, deep on Ollama

```bash
CHAT_FAST_PROVIDER=azure
CHAT_FAST_MODEL=gpt-4o-mini
CHAT_DEEP_PROVIDER=ollama
CHAT_DEEP_MODEL=qwen2.5:14b
```

## Project docs

- Product and scope: `docs/01-product-scope.md`
- Architecture: `docs/02-architecture.md`
- Success metrics: `docs/03-success-criteria.md`
- Evaluation methodology: `docs/04-evaluation-plan.md`
- TDD execution plan: `docs/05-tdd-execution.md`
- Model/provider strategy: `docs/06-model-strategy.md`
- Demo script: `docs/07-demo-script.md`
- Engineering decision log: `docs/08-engineering-decision-log.md`
- Code review (2026-09-25): `docs/09-code-review-2026-09-25.md`
- Class map (open in a browser; eight Mermaid diagrams, loads Mermaid from cdnjs so it needs network access): `docs/10-class-map.html`
- Original UI proposal (partly implemented): `docs/11-ui-plan.md`
- Current roadmap and verification status: `docs/12-development-roadmap.md`
- Executable handoff and milestone acceptance tests: [docs/implementation/README.md](../docs/implementation/README.md)

Effective output limits are resolved once at startup. For an Ollama role, an explicit
`OLLAMA_*_NUM_PREDICT` is used both in its request and in context reservation.
Applicable overrides must be positive integers; invalid or input-exhausting values
fail startup. Azure/Bedrock roles ignore Ollama overrides.

## Capability-planned live chat

Live startup uses `CapabilityChat` on both message APIs. The model sees bounded
conversation history and current registered tool descriptions/schemas. It returns
answer, clarify, unsupported or retrieve. The complete plan is validated before any
of up to three independent read-only calls starts. Unknown tools, invalid arguments
and malformed JSON fail without executing calls. A truncated plan returns
`CAPABILITY_PLAN_TRUNCATED`; increase the configured fast output allowance if needed.
Plans are stored as `capabilityPlan` on answer events, internal JSON deltas are hidden,
and confidence is null. Background tool results appear as refined timeline events
with source evidence and limitations. Cancellation and shutdown signal active reads.

The current registry comes from the briefing profile; no generic search or email tool
is installed. Configuration reload invalidates previously captured tool snapshots.
The planner bypasses heuristic routing and derived summary memory; original recent
turns remain available. Fixed mock-only startup keeps the legacy test/demo behavior.

The manual `POST /sports/chat` endpoint remains available for explicit scope requests:
`{userId, requestId, league, kind, request}`. League must match the profile and kind is
games/news. The request uses the briefing schema with explicit exclusive end `now`
and inclusive `lastSuccessful` timestamps. The model-planning path does not depend
on this endpoint or a sports-specific UI. User IDs remain prototype ownership guards.

## Remaining retained-state bounds

The in-memory deep queue limits both task count and serialized task bytes. Defaults
follow `DEAD_LETTER_MAX_RECORDS` and `DEAD_LETTER_MAX_BYTES`; optional
`DEEP_QUEUE_MAX_TASKS` and `DEEP_QUEUE_MAX_BYTES` override them. Overflow rejects
atomically with `DEEP_QUEUE_CAPACITY` (HTTP 503). Initial enqueue failures settle
created attempts and release slots, leases and dispatch references; an already
written user event remains an accepted failed turn. Failed replay enqueue restores
the dead letter. Queue entries own immutable copies. `ChatService.cancelMessage`
removes matching queued entries promptly and releases their dependent resources;
dequeued work keeps its resources until physical settlement. Custom queues without
`removeMessage` retain the previous worker-drain cancellation behavior.

Completed attempt text is cleared only after terminal writes and all workflow/task
consumers settle. Completed dispatch candidates alias their retained replay context
instead of keeping ranking-only copies. Replay still owns `phase.context` and its
candidate metadata; history continues to own answer text.

`TOOL_RESULT_MAX_BYTES` defaults to 16 MiB of aggregate serialized results. The
existing count limit also applies. Oldest results are evicted under either limit;
an individually oversized result throws `RESULT_TOO_LARGE` before evicting live
records. Selection of an evicted handle fails with `RESULT_NOT_FOUND`, so refresh
or detach it. Expiry, retirement and clear all release byte accounting. Timeline
copies remain governed by conversation retention separately.

File telemetry retains one physical write and at most one latest replacement.
Superseded pending `save()` calls share the replacement's completion: successful
resolution means that snapshot or a newer one was persisted. Write failure rejects
that batch's callers without poisoning later writes. Shutdown's final `save()`
replaces pending intermediate snapshots and awaits persistence. The number of
snapshots is bounded; serialized snapshot size still follows estimator/catalog
state, and a stalled disk can still delay shutdown until its timeout.

Discovery listing and retained-observation bounds and completeness rules are in
[the inventory contract](implementation/03-inventory.md). A failed listing never
renews the previous evidence's expiry; absent observations fail closed.
