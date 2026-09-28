# Shared inference: measure before scheduling (2026-09-28)

**Decision: retain current runtime scheduling.** The controlled follow-up did not
show a benefit from a single shared slot with foreground priority. The gateway,
FIFO control and priority policy remain experiment-only; application startup does
not instantiate them. Observable plans also remain optional and experimental.

## Implementation and measurement boundary

`experiments/doc-agent/contention_gateway.ts` observes both the real Node
`OllamaFastProvider` and Python LangChain/LangGraph documentation agent. It records
arrival, body-ready, application admission/dispatch, response headers, first answer
text, first tool call, terminal frame and completion on one monotonic clock.
Ollama's reported token and duration fields are retained. Prompts, answer content,
tool arguments and thinking are not recorded in gateway telemetry. Synthetic
foreground answers and documentation results are retained separately in results.

Application admission wait is **not** Ollama's internal queue wait or GPU admission.
First answer means a nonempty streamed content chunk, not a thinking token. The
probe invokes the real foreground provider directly; it does not measure browser
rendering, HTTP chat routing, ContextManager preparation or the deep chat worker.

The only application-facing change is an optional local Ollama URL passed to the
Python sidecar. Its CLI validates loopback HTTP and uses the same endpoint for
model identity checks and generation. Defaults remain port 11434. No shared model
server setting, installed model, .env file or existing development process changed.
`durable.py` remains source-pinned: older saved tasks reject implementation drift
until an explicit migration; use new experimental task roots.

The candidate gate serializes individual model calls. FIFO uses arrival order.
Priority selects foreground first, but admits a waiting background call after at
most three foreground admissions, with FIFO within lanes. It bounds its waiting
queue at 32 and includes admission in its deadline. No active inference is
preempted; fairness is bounded in admission count, not wall-clock seconds.

## First run and correction

[v1 results](contention-v1-2026-09-28/results.json) and its
[frozen protocol](contention-v1-2026-09-28/protocol.md) are preserved. The first
comparison suggested 632 ms concurrent versus 550 ms priority median first-answer
latency during overlap. Review identified two limitations in the design:

- The candidate changed both serialization and priority, without a FIFO control.
- Baseline prompts were sequential while overlapping prompts arrived in a burst.

[v2 protocol](contention-v2-2026-09-28/protocol.md) adds FIFO and uses bursts of three
for both baseline and overlap. It ran concurrent / FIFO / priority / priority /
FIFO / concurrent, with a separate excluded warmup in every block. This is an
adaptive follow-up after observing v1, not a preregistered independent validation.
The revised result does not reproduce the apparent priority advantage.

## Controlled follow-up results

Model: `gemma4:26b`, 25.8B Q4_K_M, digest
`5571076f3d70050487b26b341705799e0ab29b808164f90d20d4cf84f699d251`.
Ollama 0.34.4. Metadata verified tools and thinking=false. Foreground uses temperature
0 and a 160-token output cap; background retains temperature 0, seed 20260926,
32,768 context, a 1,024-token output cap and existing call/tool budgets. Loaded-model
observations report 32,768 context and full model residency in VRAM.

Each block started three documentation tasks; one additional queued task was
cancelled. At foreground burst time, the bridge reported one running task and two
queued tasks, and the gateway confirmed an admitted, unfinished background call.
Task-running status alone was not the overlap criterion.

| Policy | Baseline first-answer median | Overlap first-answer median | Overlap observed maximum | Overlap application wait median | Overlap full-call median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Concurrent | 185 ms | 477 ms | 768 ms | <1 ms | 648 ms |
| FIFO, one slot | 186 ms | 479 ms | 735 ms | 414 ms | 654 ms |
| Foreground priority, one slot | 184 ms | 569 ms | 857 ms | 498 ms | 743 ms |

Each table cell aggregates **six requests**, three questions repeated in two
blocks. The 36 baseline/overlap requests all finished normally with stop, not
output truncation. All 18 noncancelled background tasks completed. The six queued
cancellations, six active foreground cancellations after first text, and six
following recovery calls passed. Including warmups/recovery/cancellation, v2
recorded 131 model requests across both lanes.

Observed completion times for each three-task background wave, from batch
submission through observing the last terminal result:

- Concurrent: 9.74 and 9.37 seconds.
- FIFO: 9.80 and 8.88 seconds.
- Priority: 8.43 and 9.21 seconds.

These are observation upper bounds, including Python task queue wait, not exact
per-task execution durations. Background model call counts varied (12–13 per
wave), so the shorter wave does not establish a scheduling speedup.

[Raw v2 records](contention-v2-2026-09-28/results.json) retain timings, actual answers,
statuses, settings, runtime/package versions and implementation hashes.
[Summary](contention-v2-2026-09-28/summary.json) is generated by
`experiments/doc-agent/summarize_contention.py`. The exact retrieved corpus is
preserved in [sources](contention-v2-2026-09-28/sources.json).

## Interpretation and real remaining gaps

All policies met the experimental first-answer target (median <=1.5 seconds,
observed maximum <=3 seconds, no normal-call errors). Priority was about 19% slower
than concurrent on the overlap median in this run. This small comparison does not
establish that priority scheduling is generally worse; it fails to justify changing
the default for this workload.

The current Python bridge runs one documentation task at a time. The foreground
burst arrives while one background model call is already active. An application
gate cannot preempt that call, and FIFO often already places the foreground burst
before the next background call. Neither serialized condition recorded a foreground
admission overtaking an earlier-ready background call. The priority branch's
reordering/fairness behavior is covered by deterministic tests, not demonstrated
as a live performance advantage by this workload.

Limits: two blocks per policy, repeated prompts and cache effects, fixed symmetric
order rather than randomized trials, short foreground answers, one model/GPU and
no sustained arrival stream. This was an unisolated workstation run; offline
verification also used the host during part of v2. These are pilot observations,
not p95, SLA, GPU-kernel overlap, inference-server queue measurements or general
model rankings. Completion/stop does not validate the semantic correctness of
all documentation answers. The first experiment's preliminary result is superseded
by the better-controlled comparison, not discarded.

## Verification

- Full release checks passed: 258 TypeScript tests, type check, fixture evaluation
  and seeded simulated benchmark comparison.
- 61 Python agent/lifecycle tests passed, including endpoint routing validation.
- TypeScript build and separate type checking of the new experiment runner passed.
- Ten new deterministic tests cover priority/FIFO order, bounded fairness,
  capacity, queued deadline/cancellation, fragmented streams, private-text exclusion,
  HTTP failure, truncated response, active cancellation and recovery.
- Simulation reports in the v2 folder are software release checks, **not** the live
  measurements above. No new browser validation is claimed in this increment.

## Next increment

Continue with evidence quality and on-demand use of completed task results:
freeze held-out multi-part questions and score requirement coverage, citation
support and appropriately scoped uncertainty before treating results as reusable
conversation context. A schema-valid completed answer is not automatically evidence.

Keep these timing measurements as a reusable probe. Revisit scheduling when longer
calls, sustained foreground traffic or multiple background workers demonstrate a
missed responsiveness target; test that offered load before adding a production
scheduler. Automatic context insertion and scheduled triggers remain unimplemented.

## Reproduce

From the repository root, using installed Windows Node/Python and local Ollama:

```powershell
node --import tsx experiments/doc-agent/run_contention.ts `
  D:/Git/LangChain/lca-lc-foundations/.venv/Scripts/python.exe `
  reports/doc-agent/contention-new-run
python experiments/doc-agent/summarize_contention.py reports/doc-agent/contention-new-run
```

Use a fresh output folder. Local task databases are ignored. Failures are persisted
and cleanup only stops this harness's sidecar and gateway. Protocol and source
hashes are saved before inference; model downloads are never automatic.

Official API references checked 2026-09-28:
[Ollama chat response/metrics](https://docs.ollama.com/api/chat) and
[Ollama concurrency and memory](https://docs.ollama.com/faq).
