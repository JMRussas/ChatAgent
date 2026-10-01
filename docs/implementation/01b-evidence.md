# 01B — internal summaries and source-linked memory

Implemented in ChatAgent only. No Iris/Hekate files or running development
processes were changed. Stores remain in memory; no restart persistence is claimed.

## Runtime behavior

`ContextManager.prepare` captures one deep-copied timeline snapshot. It selects
still-valid derived memory and calls the pure context builder. Background jobs
start on a later event-loop turn; the foreground never awaits a new summary.
The original transcript is never summarized in place or given a summary bubble.

Compression triggers above the configured usable-input ratio or history-turn cap
with at least five completed pairs. The newest four pairs stay outside the older
source prefix where possible. Eligible sources are original user events and the
accepted complete assistant event for each turn. Activities, partial answers and
error prose are excluded. Jobs coalesce identical prefixes and abort superseded
prefixes. Publication checks current source validity, job identity and expected
summary revision. Failed/invalid output preserves prior still-valid memory.

The in-memory source store pins event identity and content hashes. Capture reflects
missing/deleted records; changed content cannot reuse an existing source identity.
Lookups compare conversation, event, message and SHA-256 content identity and return
copies. This is an internal interface reached after ChatService's existing owner
check, not a new authenticated public retrieval service.

The builder allocates mandatory instructions/current text, up to 20% of remaining
space for unresolved requests, newest exact pairs up to four, bounded memory up to
25% of usable space, then additional exact pairs. It omits whole records, excludes
memory overlapping exact pairs, and counts the same rendered data used by every
provider. Memory and source excerpts are quoted untrusted data; delimiter-like
source text cannot terminate their block. Counts remain conservative UTF-8-byte
estimates, not provider-tokenizer guarantees.

Source-check phrases are matched as whole phrases: “how do you know”, “check that”,
“verify that”, “what did I say”. At most four refs from newest included memory items
are checked against the captured source snapshot. Exact excerpts replace those
items within the memory allowance. Unavailable/oversized sources are explicit;
resolution outcomes take priority over larger excerpts.

## Configuration and internal calls

- `CONTEXT_SUMMARY_MODE=extractive`: off/extractive/model; default extractive.
- `CONTEXT_SUMMARY_TRIGGER_RATIO=0.8`: greater than 0, at most 1.
- `CONTEXT_SUMMARY_MAX_TOKENS=1024`: positive, capped at 1,000,000.
- `CONTEXT_SUMMARY_TIMEOUT_MS=5000`: positive, within Node's timer range.
- Model mode additionally requires `CONTEXT_SUMMARY_MODEL_BINDING=fast`. It uses
  the explicitly selected existing fast provider/model through a separately
  constructed adapter, with a summary output cap and input/instruction/safety
  reservation. There is no implicit deep-provider call or recursive ChatService
  invocation. Other binding values fail startup rather than silently selecting one.

Extractive mode makes zero model calls. It selects newest-first verbatim excerpts
(up to 160 Unicode code points each), labelled claim with actual provenance. Model
mode requests a schema-constrained JSON item array. Original sources are chunked
into bounded internal inputs, never recursively summarized from earlier summaries.
Chunk work yields to cancellation; jobs stop once the memory allowance is nearly
full. Output is validated both per chunk and after merge, including source identity,
provenance, schema/size, correction links and a 32-item ceiling.

`GET /telemetry/context` exposes job/request/failure/cancellation/timeout counts,
input/output estimates and cumulative latency without text or source content.
`ContextManager.shutdown()` aborts jobs and awaits their bounded lifecycle; server
close callbacks and signal shutdown invoke it. Ports must honor their abort signal;
a non-cooperative port is detached on cancellation and can never publish late output.
Full worker/provider draining remains spec 06, not a claim made by this hook.

## Acceptance evidence

`tests/unit/contextMemory.test.ts` covers:

| Requirement                 | Executed offline coverage                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Under threshold / off       | Exact history, zero jobs/calls, unchanged timeline                                                              |
| Background threshold        | Turn-count and ratio triggers; current response returns before deferred jobs; newest four remain exact          |
| No implicit inference calls | Extractive port makes zero calls; model mode requires explicit injection/binding; independent request budgets   |
| Immutable sources           | Timeline deep-copy isolation, original lookup, source-copy isolation, scope/hash limits                         |
| Invalid results             | Missing/cross-conversation/wrong-hash refs, fabricated tool provenance, malformed/oversized output              |
| Timeout / revision races    | Fake timer deadline, retained prior memory, deferred out-of-order completions, CAS rejection and coalescing     |
| Refinement / correction     | Future memory invalidation; already queued deep context survives fast-provider mutation and later updates       |
| Provenance / conflicts      | User/assistant distinction, disputed competing directives/constraints, unsupported supersedes rejection         |
| Verification requests       | Bounded exact excerpts, explicit oversized/missing sources, no duplicate current text                           |
| Pending work                | Request and running state retained; unfinished answer and activity prose absent from provider history           |
| Data/budget boundary        | Instruction-like delimiter text remains quoted data; tight/Unicode budgets, no overlapping exact-memory sources |
| Shutdown                    | Pending jobs cancelled/settled before the server close callback                                                 |

The existing provider mapping, context ownership, generation and HTTP regressions
also run in the common release gate. Final validation: **239 tests / 40 files passed**, TypeScript checking and build
passed, evaluation passed, and the seeded simulated benchmark comparison passed
(`BENCH_MODE=simulate BENCH_SIM_SEED=default-v1 npm run verify:release`). No live inference or model-summary quality evaluation ran.

## Deliberate limits

Provenance is origin, not truth. Structural source checks do not certify model
paraphrases. Correction detection conservatively recognizes “correction”, “actually”,
“instead” and “no longer”; it can suppress otherwise useful old memory. Differing
structured constraints and explicit leading directives (use/avoid/do not/must/
never/always) are conservatively disputed unless explicitly correction-linked.
This does not claim universal contradiction detection or infer global preferences.
Extractive items remain claims rather than invented goals/decisions.

Restart discards runtime sources, summaries, context and jobs. Retention/deletion
APIs and durable adapters remain future work; snapshot validation already rejects
missing sources. Source lookup is direct ID checking, not semantic search or a
browsing/tool feature.
