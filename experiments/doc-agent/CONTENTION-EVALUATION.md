# Shared inference experiment protocol (2026-09-28)

Question: can one application admission slot with foreground priority improve
first-answer latency over the existing concurrent Node/Python requests?
This is an experiment, not an application default or an Ollama server setting.

Protocol v2 amendment, frozen before the second run: v1 changed both serialization
and priority, and baseline requests were sequential while overlap was a burst.
Preserve v1 as exploratory evidence; add a FIFO control and equal offered load.
This correction follows review of v1, not an independent confirmatory study.

Freeze before inference:
- Installed gemma4:26b; require digest, version, tools, thinking=false metadata.
- Real OllamaFastProvider streaming foreground; real LangGraph documentation tasks
  through PythonDocumentTasks. No deep conversational worker or UI in this probe.
- Six blocks, policy order concurrent / FIFO / priority / priority / FIFO / concurrent.
- Each block: warmup excluded; burst of three varied baseline foreground requests; three
  queued documentation jobs plus one queued job cancelled; the same three
  foreground prompts overlapping actual background inference. Await all jobs.
- Foreground output cap 160; background retains existing 1024-token and six-call
  limits. Both retain current prompt construction. Record loaded context/residency;
  do not override model-server configuration or download models.
- FIFO and priority serialize model calls, never whole tasks. FIFO uses arrival order. FIFO within each lane;
  allow a waiting background call after at most three foreground admissions.
  No inference preemption. Thirty-two waiting calls maximum; gateway deadline
  120s includes admission. Python call deadlines still apply while waiting.
- Use a burst of three foreground requests during overlap to expose queue effects.
  Baseline requests are also a burst of three; same offered load in both conditions.
- Local aspirational target: warmed first-answer median <=1500ms, observed max
  <=3000ms, no normal-call errors, and every noncancelled background job finishes.
  A policy is a candidate only if it improves median overlap first-answer latency
  without new failures; priority must also be compared with FIFO; background turnaround must be reported, not hidden.
- Cancellation after the first answer chunk is a separate live recovery check.
  Offline tests cover queued cancellation, provider failure, malformed/truncated
  streams, deadline recovery, bounded admission and starvation prevention by count.

Measurements use the gateway's monotonic clock: HTTP arrival, body-ready,
application admission/dispatch, response headers, first nonempty answer content,
first tool-call frame, terminal frame and completion. Admission wait is body-ready
to dispatch; it does NOT measure Ollama's internal queue or GPU scheduling.
First answer means first text chunk, not first thinking token/tool result.
Null/missing measurements remain missing for failures, cancellation and tool-only
calls. Capture Ollama-reported duration/token fields without deriving hidden queue
wait by subtraction. Harness additionally records client first-delta and completion.
No prompt, answer, tool arguments or thinking text in gateway telemetry.

Interpretation: small local pilot, no p95/SLA claim, no broad model comparison,
no inference-kernel overlap claim. Prompt cache, warmup, offered load and background
call length can dominate. An improvement in first-answer latency is not evidence
of answer correctness. Use new task DBs: source identity pins reject old databases
following implementation changes. Keep actual answers separately for inspection.

References checked 2026-09-28:
- https://docs.ollama.com/api/chat (streaming and reported timing fields)
- https://docs.ollama.com/faq (parallel requests, memory, and queue configuration)
