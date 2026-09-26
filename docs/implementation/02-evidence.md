# Spec 02 implementation evidence

2026-09-25. Implements [generation](02-generation.md) and its
[activity UI extension](02-activity-ui.md). 01B, protocol v1/Iris integration,
resource admission, durable storage and spec 06 browser/live gates remain separate.

## Contracts and behavior

- Providers return typed finish outcomes and accept optional `GenerationControl`.
  Orchestrated calls stream; direct callers without control keep non-streaming
  request shapes. HTTP POST retains its fields and resolves after fast completion.
  `processingStatus` additionally represents incomplete/cancelled/failed outcomes.
- A registry shared by orchestrator/worker through their queue claims client IDs
  atomically, tracks each phase/attempt and aborts running or queued work. State is
  in memory. Duplicate submissions return 409 `DUPLICATE_MESSAGE_ID`.
- Deltas carry phase/attempt identity, with existing timeline sequence ordering.
  Writes coalesce over 50 ms, flush before terminal, and bound answers/frames to
  1 MiB. Partial failures never retry; transient pre-output failures retry at most
  twice, using new attempt IDs and the same frozen context. Bedrock SDK retries
  are disabled so the runtime is the sole retry owner. Provider errors use safe
  codes; context/protocol/auth errors and cancellation are terminal.
- The cancel endpoint returns phase states, aborts active calls and suppresses late
  chunks/results. Cancelled queued jobs are skipped. SSE disconnect does not cancel.
  The browser retries a pre-registration 404 once after observing the user event.
- Context selection ignores deltas, terminal text and incomplete answers. Pending
  state follows the relevant phase's latest transition; fast completion cannot
  erase pending or cancelled deep work.
- The UI projects complete snapshots by message/attempt/sequence. Substantive fast
  answers survive as separate versions; deep answers are attached Updates. Only
  application fallback acknowledgments can be replaced. Activities have model
  labels, step disclosure and server-timestamp queue/execution timers. Timer ticks
  only update timer nodes, preserving answer DOM and disclosure/Stop focus.

## Adapter verification

Protocol documentation checked 2026-09-25:

- [Ollama chat](https://docs.ollama.com/api/chat): streaming NDJSON, `message.content`
  only, `done` and `done_reason`; no `message.thinking` enters events or memory.
- [Ollama thinking](https://docs.ollama.com/capabilities/thinking): top-level `think`;
  explicit on/off settings require booleans in the runtime's `/api/show`
  `thinking.values`. `/api/version` must also succeed. Missing metadata or a
  string-only control fails explicit settings. `default` sends no control and
  claims no applied reasoning setting. Fast defaults off; deep defaults unspecified.
- [Azure 2024-10-21 specification](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cognitiveservices/data-plane/AzureOpenAI/inference/stable/2024-10-21/inference.yaml):
  chat stream choice deltas, finish reason, SSE completion marker; original
  deployment URL/API version and output caps retained.
- [Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html):
  `contentBlockDelta.delta.text`, `messageStop.stopReason`, typed stream exceptions.
  Checked against installed `@aws-sdk/client-bedrock-runtime` **3.1140.0** and
  Smithy's HTTP handler abort-signal propagation. Reasoning/tool blocks never become
  answer text. Request deadline is 60 seconds including stream consumption.

No local Ollama version or live model behavior was certified. Startup performs the
metadata verification for explicitly configured controls; offline tests use fake
runtime metadata and streams, without inference or cloud credentials.

## Acceptance mapping

All names below are executable tests. Generation IDs match the numbered cases in
02-generation.md; UI IDs match 02-activity-ui.md.

| Cases | Test file and test names |
|---|---|
| GEN-1 | `generationStreaming.test.ts`: `decodes split UTF-8 and frames in %s without exposing reasoning`; `generation.test.ts`: `HTTP/SSE exposes a delta before POST completes, reconnects exactly once and cancels by client ID` |
| GEN-2, UI-3, UI-5 | `turnViewModel.test.ts`: `preserves or replaces fast %s appropriately`; `concurrentWorkflow.test.ts`: `runs deep work before fast completes and correlates every event` |
| GEN-3 | `generationStreaming.test.ts`: `retains empty and partial %s length outcomes`; `generationLifecycle.test.ts`: `keeps length finish %j out of accepted history`, `keeps truncated deep output out of accepted history and records cancellation for later turns` |
| GEN-4 | `generationLifecycle.test.ts`: `cancels pending fast and queued deep once, suppressing uncooperative late output`, `cancels a running deep call and never retries or dead-letters it`, `leaves completed turns unchanged on cancellation` |
| GEN-5 | `generationStreaming.test.ts`: `rejects malformed and unterminated %s streams`, `aborts stalled %s stream bodies on deadline and user cancellation`, `bounds frame and accumulated answer sizes`; `generationLifecycle.test.ts`: `turns a malformed provider stream after text into a visible terminal failure without retry` |
| GEN-6 | `generationLifecycle.test.ts`: `retries transient deep failure only before output (emitted=%s)`, `retries fast failures only before output (emitted=%s)`, `never retries a typed context overflow` |
| GEN-7, UI-6 | `generationStreaming.test.ts`: `sends supported controls at the top level and exposes only applied reasoning metadata`, `rejects missing or unsupported runtime metadata without invoking inference`, `leaves default unspecified without claiming verified reasoning or making metadata calls`, `streams Bedrock text only, passes abort signal and maps max_tokens` |
| GEN-8 | `tests/integration/generation.test.ts`: the HTTP/SSE test above uses a deferred streaming fake and observes a delta while POST remains pending |
| UI-1, UI-2 | `turnViewModel.test.ts`: `keeps concurrent placeholders, models and timestamps attached by messageId` |
| UI-4, UI-7 | `turnViewModel.test.ts`: `reconstructs retry history and drafts exactly once across snapshots`, `uses terminal length/cancellation states without inventing successful steps` |
| UI-5, UI-8 | `turnViewModel.test.ts`: `preserves answer DOM, disclosure and Stop focus during activity timer ticks and reconnect`; native button/details controls, reduced-motion CSS; real browser behavior remains a spec 06 gate |
| Additional invariants | `generationLifecycle.test.ts`: `atomically rejects duplicate IDs while the original fast call is pending`, `coalesces deltas every 50ms and flushes pending text before terminal`; all CTX-01–04 regressions retained |

## Executed verification

**195 tests across 38 files passed**, including the focused acceptance cases.
`npm run lint` and `npm run build` passed. `npm run verify:release` passed with
`BENCH_MODE=simulate` and `BENCH_SIM_SEED=default-v1`: fixture evaluation and
seeded benchmark comparison both passed. Historical reports/baselines were preserved. Live providers and real-browser/mobile tests
were not run; they remain explicit spec 06 validation work, not an offline quality
or visual-parity claim. Existing development processes were not restarted.
