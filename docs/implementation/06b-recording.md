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

## Acceptance evidence and remaining work

`tests/unit/evaluationRecording.test.ts` covers EVAL-01 deterministic on/off
neutrality with deferred execution and retry; EVAL-02 overlapping turns and
cancellation; EVAL-03 exact-answer annotation integrity; EVAL-04 capture, limits
and retention; and EVAL-05 invalid/write-failed/incomplete evidence and CLI failure
status. `tests/integration/startup.test.ts` checks real server composition,
automatic deep work, safe status endpoint and shutdown flush with mock providers.

**453 tests across 62 files**, typecheck, build and the seeded simulated release
gate pass. No live provider call or model-grader invocation was needed.

These tests cover the recorder/artifact portion, not all of spec 06. Experiment
manifests and cross-run compatibility, full provider/queue timing instrumentation,
matched on/off overhead measurements (EVAL-06), model-grader calibration, honest
live benchmark replacement and browser/live-quality comparisons remain. Existing
historical benchmark reports are unchanged and are not evidence for this schema.
