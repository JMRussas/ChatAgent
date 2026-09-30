# 06B — Passive evaluation recordings

The recorder observes existing timeline events. It does not add inference calls,
change prompts/tools, select models, or own retries. It defaults off. The runtime
continues answering if artifact writes fail; `/telemetry/evaluation` exposes the
failure and runtime shutdown rejects if final recording is invalid. Invalid
configuration (for example a missing dataset) fails startup.

## Enable capture

Set `EVAL_RECORDING=true` and `EVAL_DATASET_PATH` to a versioned dataset like
[data/evaluation-dataset.example.json](../../data/evaluation-dataset.example.json).
The dataset is an object with `version` and unique `{id,text}` prompts. Exact user
text hashes associate turns with prompt IDs; unmatched turns have null prompt IDs
and cannot acquire ratings for a different prompt. The dataset is not sent to a
model or run automatically.

`EVAL_CAPTURE=metadata` is the default. `answers` explicitly retains final visible
answers for an appropriate evaluation dataset; prompts and deltas remain hashes.
Common credential patterns are redacted, not every possible kind of sensitive
information. Use a curated dataset when enabling answer capture. Private reasoning
and arbitrary provider diagnostics are never part of the allowlisted event schema.

Limits: `EVAL_MAX_BYTES=10485760`, `EVAL_MAX_EVENTS=10000`,
`EVAL_RETENTION_MS=604800000`. `EVAL_REPETITION` and `EVAL_CONDITION` (warm, cold,
unknown) record declared experimental conditions; they do not warm a model or run
repetitions automatically.

## Artifact and validity

Each run writes an atomic `reports/evaluations/<uuid>/run.json` (gitignored), with
schema version `chatagent-evaluation-v1` and manifest, trace and summary sections.
Files are private-mode where the filesystem supports Unix modes. The manifest
records code revision, dirty source digest, allowlisted configuration and digest,
dataset digest/version, capture policy, limits, condition, repetition and expiry.
Config endpoint values are hashed; credentials are omitted. The source digest
covers source/bridge code, package manifests, tsconfig and curated model catalog;
it does not archive those sources. Preserve the checkout to reproduce a dirty run.

Run-scoped hashed conversation/turn/task/attempt identities avoid persisting raw
user-supplied identifiers. Attempts use the turn as parent; no unimplemented
sub-agent or tool call is fabricated. Trace order and original timeline sequence
are both retained. Requested model labels and binding revisions are recorded;
resolved model IDs/weight revisions stay null when the adapter does not supply
them. In particular, a Claude CLI version is not a model-weight revision.

Timing is observation time at timeline append, not an instrumented provider call
boundary or request-arrival time. Queue/admission and provider time must not be
inferred as separately measured spans from a single running event. Usage, cost,
quality, and matched recorder overhead remain null/unrated when unavailable.
`recorderCpuMs` is time inside the recorder callback, not a matched on/off overhead
measurement. Mode is derived from executed event metadata as live, synthetic,
mixed or unknown. Failed/cancelled attempts remain in the trace.

Writes are serialized and flushed after terminal events and at shutdown. During
execution the artifact status remains `recording`; final status is complete,
incomplete (dropped events or unfinished phases), or failed. A crash leaves a
recording artifact, not a completed run. Byte/event caps include dropped-event
counts; failure does not trigger inference retry. A shutdown timeout invalidates
recording and attempts a final flush without delaying the runtime deadline.

Active runs expire and remove answer capture at the retention deadline. Finished
artifacts are pruned on the next recording startup or by the explicit prune command;
there is no daemon deleting files after the application exits. Readers reject
expired artifacts even before pruning. Pruning only removes recognized expired
run.json files, never arbitrary neighboring files. Run external scheduled pruning
if deletion while the application is stopped is required.

## Review and annotation

```sh
npm run eval:recordings -- validate reports/evaluations/<run-id>/run.json
npm run eval:recordings -- grade reports/evaluations/<run-id>/run.json annotations.json
npm run eval:recordings -- prune reports/evaluations
```

Validation/grade failures exit nonzero. Validation checks recording integrity and
code identity; it is not a quality pass. Grading prints JSON to stdout, including
rubric/judge identity and annotation digest. Store that output with the experiment
if needed; it contains verdicts/hashes, not retained answers.

Annotations are versioned separately:

```json
{
  "version": 1,
  "rubricVersion": "grounding-v1",
  "judge": {
    "kind": "human",
    "id": "reviewer-1",
    "configurationDigest": "<64-character SHA256 of grading instructions>"
  },
  "ratings": [{
    "promptId": "arithmetic",
    "responseHash": "<answer.scoredHash from this run>",
    "correctness": "pass",
    "relevance": "pass",
    "unsupportedClaims": "no",
    "firstUsefulEventSequence": 3
  }]
}
```

Correctness/relevance accept pass, fail or unrated; unsupportedClaims accepts yes,
no or unrated. First-useful sequence is optional and refers to this run's trace
sequence, for an answer/delta of the same scored attempt. It is an annotation,
not a claim that an acknowledgment is useful. Deep turns require the deep answer.

A pass requires the exact retained, untransformed final substantive answer, a
successful terminal event, all required ratings, and valid recording evidence.
Hash-only, redacted, expired, missing, changed or incomplete answers cannot pass.
Scored and redacted-artifact hashes are distinct. This command consumes existing
human/code/model annotations; it does not invoke or calibrate a model grader.

## Comparing recorded runs (06C)

Use completed answer-capture artifacts and the exact versioned dataset:

```bash
npm run eval:recordings -- compare baseline/run.json candidate/run.json dataset.json baseline-ratings.json candidate-ratings.json [experiment.json]
```

The `chatagent-comparison-v1` JSON output separates comparison availability from
candidate quality passing, includes per-run configuration/execution/annotation
digests, pass/fail/unavailable counts, and a pass-rate delta only when compatible.
Exit status is nonzero for incompatible/missing evidence or failed candidate quality.
No model grader is invoked. A rated failure is valid comparison evidence; it does
not become a passing quality gate. Cost and recorder-overhead deltas stay null.

This initial contract requires a complete ordered dataset pass with one isolated
conversation per prompt, distinct run IDs, valid unexpired artifacts, exact retained
answers, known warm/cold conditions, matching repetition, code identity, capture
policy/limits, and the same rubric and judge configuration. Mixed/unknown execution
modes are rejected; synthetic and live evidence cannot be compared. It does not yet
support multi-turn history experiments, aggregate repetitions, or latency statistics.
The live HTTP observation report alone is still not comparison eligible: use recorder
artifacts and annotations. No automatic join of those two report formats is claimed.

By default configuration and actual model identities must match. A controlled
experiment uses this strict manifest shape:

```json
{
  "version": 1,
  "id": "strategy-v1",
  "createdAtIso": "2026-09-30T00:00:00.000Z",
  "datasetDigest": "<64-character SHA-256>",
  "baseline": {
    "configurationDigest": "<baseline configuration SHA-256>",
    "executionDigest": "<expected baseline execution SHA-256>"
  },
  "candidate": {
    "configurationDigest": "<candidate configuration SHA-256>",
    "executionDigest": "<expected candidate execution SHA-256>"
  },
  "allowedConfigurationDifferences": [["routing", "strategy"]]
}
```

Replace the illustrative path with exact paths in the recorded configuration. The
allowed paths must equal the actual changed leaves; arrays are atomic. Wildcards,
ancestor exemptions, extra unused paths, changed dataset/grading/code identity, or
unexpected execution digests do not bypass checks. Both full configuration digests
remain in the report. `executionDigest` in `comparison.ts` now hashes the `execution-v2` payload: ordered prompts and routes, phase-local
attempt order, model identity, terminal outcome/retry flag, and the attempt associated
with each phase's final answer. It excludes run-local IDs, timestamps and cross-phase
interleaving; repeated same-model retries remain distinct. Old set-based execution
digests will not match; regenerate expected identities from pilots and preregister a
new manifest before collecting new runs. Each required phase and every attempt must
have consistent nonempty provider/model identity and exactly one identified terminal.
The scored answer must carry matching identity and belong to the final attempt.
Use the exported helper with pilot artifacts to determine expected identities and
save the manifest before the new experiment runs. Actual model revision remains
unknown where the provider exposes only an alias.

The manifest timestamp must precede both runs. This is a consistency check on trusted
local files, not cryptographic proof of preregistration; preserve the manifest in
version control before execution for an auditable declaration. The comparator does
not itself launch or register experiments. Predeclaring every per-prompt execution
identity deliberately makes unexpected fallback/routing fail compatibility.

## Matched recorder overhead (EVAL-06 component)

```bash
npm run eval:overhead -- reports/overhead-new-run.json metadata
npm run eval:overhead -- reports/overhead-answers-new-run.json answers
```

This explicit offline command uses production timeline storage and the recorder with
real atomic disk writes, but replays a synthetic event fixture without providers,
HTTP, routing or worker execution. It does not load `.env` or change recording mode
for the application. It refuses to overwrite the output report. Temporary artifact
directories are removed after verification; the report retains measurements/digests,
not captured answer text. Supply a new output filename for each run.

Each capture condition has two discarded warmup pairs and twenty measured pairs,
alternating off/on and on/off. Each sample replays 20 isolated turns (250 events),
with direct/deep phases, streamed chunks and synthetic retries. Recording-on/off
must yield identical normalized timeline output hashes. Both use fresh timeline
stores. Setup includes recorder construction and initial persistence; feed covers
all timeline appends; final flush waits for queued writes. Their durations and the
full measured lifecycle are reported separately. Directory setup, output hashing,
artifact validation and cleanup are excluded. Writer failures or dropped/incomplete
recordings fail the command. Source/configuration/workload digests, platform/Node,
raw pairs, write counts and byte counts are retained.

Measured locally on Windows Node on 2026-09-30 (same workspace volume):

| Capture | Median feed delta, batch ms | Median final-flush delta, batch ms | Median total delta, batch ms | P95 total paired delta, batch ms |
| --- | ---: | ---: | ---: | ---: |
| Metadata | 2.40 | 56.07 | 60.08 | 66.85 |
| Answers | 2.51 | 60.18 | 64.00 | 72.80 |

Raw evidence: [metadata](../../reports/recorder-overhead-metadata-2026-09-30.json)
and [answers](../../reports/recorder-overhead-answers-2026-09-30.json). These report
changes relative to each matched off sample, including negative deltas if observed;
P95 is the nearest-rank percentile of paired differences. No performance threshold
or improvement claim is inferred. Callback duration (`recorderCpuMs`) is the existing
recorder's accumulated elapsed callback timing, not process CPU accounting or the
full recorder cost. Most overhead here accumulates in final persistence of a burst;
a paced live workload can distribute writes differently. Do not divide these batch
numbers into an asserted production per-message latency.

These measurements cover the recorder component of EVAL-06. Matched end-to-end
provider/HTTP workloads, concurrent deadline effects, provider/queue instrumentation
and executed-child usage accounting where supported remain separate. No live calls,
quality ratings or model-billing estimates are produced. Raw reports identify the
dirty checkout/source digest used for this precommit measurement.

## Matched HTTP runtime overhead

```bash
npm run eval:overhead -- reports/http-overhead-new.json metadata http
npm run eval:overhead -- reports/http-overhead-answers-new.json answers http
```

The `http` condition uses an ephemeral loopback server, the production HTTP handler,
ChatService, context preparation, orchestrator, DeepWorker, timeline and runtime
shutdown. Providers are explicit mocks; the fixed configuration does not load local
provider settings. Twenty isolated prompts alternate direct and deep routes; each
deep task fails once and retries automatically. Worker/poll intervals are both 5 ms
for this harness (not application defaults), with a five-second per-turn deadline.
Two warmup pairs precede twenty alternating-order measured pairs per capture mode.

Pair validation hashes normalized provider requests (including model-visible context),
routes, phase/model-labelled answers and terminal/retry events. Transient IDs,
timestamps and cross-phase scheduling are excluded. The raw report also retains
per-prompt first-answer/final HTTP observations in each condition. Startup/binding
and recorder initial persistence count as setup; the workload phase includes HTTP
requests/polling and timeline evidence collection; final-flush timing includes full
runtime shutdown and recorder persistence. Capture failures reject and still close
the server and remove its temporary artifacts. This extends the earlier event replay;
it does not exercise catalog discovery/dispatch, browser rendering, live providers,
or concurrent user deadlines. It does not establish answer quality.

Local 2026-09-30 results (20-turn batch deltas, recording on minus off):

| Capture | Median setup ms | Median workload ms | Median shutdown ms | Median total ms | P95 total ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Metadata | 1.52 | -43.30 | 3.41 | -36.86 | 6.46 |
| Answers (isolated rerun) | 1.42 | -18.79 | 2.84 | -14.45 | 3.76 |

Raw reports: [metadata](../../reports/recorder-http-overhead-metadata-2026-09-30.json),
[answers isolated rerun](../../reports/recorder-http-overhead-answers-isolated-2026-09-30.json).
An [earlier answer-capture run](../../reports/recorder-http-overhead-answers-2026-09-30.json)
is preserved as exploratory: its tail overlapped a test invocation, so it is not the
controlled result above. No test/build suite ran alongside the isolated rerun.

Negative deltas are retained, not clamped or described as recorder speedups. They
show that paired end-to-end timings include event-loop/worker/poll scheduling and
machine variability; these observations cannot isolate pure recorder CPU cost.
The isolated component benchmark above measured positive recorder/persistence cost.
No live inference overhead estimate, deadline-safety claim, performance threshold or
statistical significance is inferred from this mock workload. Further live-provider,
concurrency and browser acceptance remains in spec 06.

## Acceptance evidence and remaining work

`tests/unit/evaluationRecording.test.ts` covers EVAL-01 deterministic on/off
neutrality with deferred execution and retry; EVAL-02 overlapping turns and
cancellation; EVAL-03 exact-answer annotation integrity; EVAL-04 capture, limits
and retention; and EVAL-05 invalid/write-failed/incomplete evidence and CLI failure
status. `tests/integration/startup.test.ts` checks real server composition,
automatic deep work, safe status endpoint and shutdown flush with mock providers.

**453 tests across 62 files**, typecheck, build and the seeded simulated release
gate pass. No live provider call or model-grader invocation was needed.

These tests cover the recorder/artifact portion, not all of spec 06. Full provider/queue timing instrumentation,
end-to-end overhead measurements (EVAL-06), model-grader calibration, honest
live report/recorder linkage and browser/live-quality comparisons remain.
Recorder comparison contracts are implemented as described above; the historical
453-test count in this section refers to the original 06B milestone. Existing
historical benchmark reports are unchanged and are not evidence for this schema.
