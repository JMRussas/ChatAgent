# 24 — Checkpoint continuation phase visibility

Status: implemented behavior contract for the P1 accepted archived-assessment
follow-up (Hekate task `84290f4f-29bd-527a-a1e6-a6c36037ee13`). Planning and
implementation acceptance, source integration and live proof are recorded
separately; this document does not claim them.

## 1. One useful increment

An executive can see, in the existing executive overview, which configured
checkpoint is working, checking, awaiting review or needs the operator, then
expand the existing in-place task detail without navigation. A human or an AI
client reads the same bounded JSON. The source is the closed
`checkpoint-continuation/v1` record that [document 22](22-checkpoint-continuation-manager.md)
already writes; no new writer, route, model call, retry, claim, polling loop or
execution engine exists, and worker and continuation execution are unchanged.

## 2. Trusted configuration

`CheckpointRecordEntry` gains an optional `continuationRecordPath`. It is
operator-written startup configuration (`HEKATE_CHECKPOINT_RECORDS_JSON` or the
`checkpointRecords` server option), never browser-supplied, and is strictly
validated:

- an absolute path of at most 1,024 characters without control characters;
- named `<runId>.continuation.json` with a lower-case GUID run ID;
- distinct from every other configured path, including the entry's own
  `recordPath`; exactly one entry per root and node as before.

An entry without it keeps exactly its previous shape (an explicit `undefined` is
dropped). Only explicitly configured files are read: there is no directory
crawl, no sibling lookup and no derived path.

## 3. Bounded read-only view

`src/integrations/hekate/checkpointContinuationView.ts` reads one record per
configured task. It requires a regular, non-symlink file of at most 16 KiB
(rechecked on the opened handle and while reading) within a 500 ms deadline, and
parses it only with the existing closed `parseContinuationRecord`. Failures stay
typed and explicit: `missing`, `unreadable`, `too_large`, `invalid`,
`unsupported_schema`, `timeout`.

A record is shown as current only when all of these hold; otherwise it is
`unavailable` and no phase is shown:

- Root, node, attempt, epoch and content revision equal the task's current fence,
  else `stale_identity`.
- The record's run equals the run in the configured file name, and equals the
  registered budget record's run when that record is available, else
  `run_mismatch`.
- When no budget record can confirm the run, the run is ambiguous and refused as
  `run_unverified`; only a `reserved` record may precede a missing budget file.
- A source-bearing record (`verifying`, `review_pending` or a confirmed finish)
  has `sourceRef` equal to the task artifact, and any other recorded source does
  not contradict a recorded artifact, else `stale_source`.
- The phase can follow the task's recorded state, else `stale_state`: in-flight
  phases need `in_progress` or `review_pending`; `review_pending` needs
  `review_pending` or, as settled history, `accepted`.

The view is a closed projection: run ID, phase, reason, start/update/end times,
candidate `sourceRef`, finish and gate flags, worker stop and exit metadata,
and per check name, result, ran, exit code, timed-out and output-limited flags.
No prompt, raw check output, output hash, base ref, executor, path, API body,
`leadAcceptance` or other record field is copied. The record and its writer
stay unauthenticated (`supplied_not_authenticated`, writer liveness `unknown`)
and semantic review stays `not_performed`.

Checks passing never implies acceptance. Current recorded task acceptance is
shown only from PlanStore state. A terminal phase on an `accepted` or
`cancelled` task is `settled` history with attention `none`; an in-flight phase
for such a task is `stale_state`. Only an open `needs_operator` or
`review_pending` record carries attention.

## 4. Overview v4

`executive-overview/v4` is opened only when at least one registry entry
configures a continuation path. Without one, v1 (no registry), v2/v3 behaviors
and the existing budget and attention schemas are unchanged. v4 is v3 plus:

- per task, `continuation`: the view above or `{ state: "unavailable", reason }`
  (only for tasks whose entry configured a path);
- top level `continuation`: `basis`, `configured`, per-phase counts of open
  records for all six phases, `settled`, `unavailable` (coverage gaps: record,
  task or root not observed as a matching record) with
  `configured = open + settled + unavailable`, at most 32 `items` ordered
  `needs_operator`, `review_pending`, `verifying`, `snapshotting`, `running`,
  `reserved`, and an exact `omitted` count. Items carry only ids, run, phase,
  reason, attention, update time, task state and whether the task row survived
  the response size cap.

## 5. Browser behavior

The page validates v1–v4 against closed schemas and rejects unknown fields,
unknown enum values, inconsistent counts or attention, and a continuation field
under a schema that does not define it. All values are written with
`textContent`. The phase panel precedes the roots; each open task summary shows
its phase; "Open phase detail" re-checks the item against the displayed task
(run, phase, reason, update time, task state, row listed) and then opens the
existing root and task detail and its existing single GET of the progress route.
Nothing else is requested, mutated or navigated to, and nothing polls.

## 6. Limits stated plainly

- Records are supplied and unauthenticated. A phase is the last recorded phase,
  not proof the writer is alive. `running` does not mean a process is running,
  and no staleness inference is made from time.
- `reserved` and `running` records whose budget record is missing or from another
  attempt are `run_unverified`, not guessed.
- A confirmed finish is read from the record and the task artifact only; this
  view never calls PlanStore itself beyond the existing overview read.
- The view does not decide, retry, claim, release, accept, integrate, notify or
  wake anyone. `docs/contracts/pilot.json` is intentionally unchanged.
- Coverage is bounded by the registry (16 entries) and the overview task cap;
  anything outside is counted as unavailable, never as healthy.

## 7. Verification

`tests/unit/checkpointContinuationView.test.ts` covers every phase, missing,
non-regular, oversize, malformed, unsupported and timed-out files, exact
root/node/attempt/epoch/content/run/source mismatches, verifier failure versus
review pending versus accepted task, the closed projection and the summary.
`tests/unit/checkpointRecord.test.ts` covers the registry field,
`tests/unit/executiveOverview.test.ts` and
`tests/integration/{checkpointRecordsHttp,executiveOverviewHttp}.test.ts` cover
absent-config compatibility and v4 over real files and HTTP,
`tests/unit/checkpointContinuationUi.test.ts` and `executiveOverviewUi.test.ts`
cover validation, escaping and same-page drill-down, and
`tests/browser/executiveOverview.spec.ts` covers the real page.
