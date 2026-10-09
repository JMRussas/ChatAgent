# 22 — Finite checkpoint verification continuation

Status: lead/operator recovery contract. The first Athena proposal stopped at its
five-minute hard wall without an artifact. This smaller source-backed boundary is
not a retry of that model run. Planning acceptance and implementation acceptance
remain separate; the roadmap and retained PlanStore receipts record both.

## 1. One useful increment

An operator starts one finite coordinator for one already claimed coding checkpoint.
It waits for the maintained worker, snapshots its declared source edits into an
isolated candidate commit, finishes that exact task attempt, then automatically
runs external format, type and focused test checks. It stores a supplied gate and
ends at `review_pending` or `needs_operator`. These transitions continue in the
owned process while the initiating chat turn is inactive.

The objective delivery is a real worker finishing followed by real independent
check processes starting without a user message. Tests running outside the coding
worker are external verification; they are not independent semantic AI review.
Lead review, acceptance, integration and the next claim remain separate. No
perpetual queue manager, independent AI wake, outbound notification or automatic
model retry is supplied. CA-ISSUE-004 remains open for those remaining boundaries.

## 2. Source seams and roles

- Reuse `src/checkpoint/checkpointRun.ts` and `checkpointRecord.ts` unchanged for
  worker profiles, authority reads, owned cleanup, counters and budget/gate schemas.
- Reuse `fetchCoordinationStatus`, `planApiBase` and `LeafStatus` from
  `src/integrations/hekate/devCoordination.ts` for bounded loopback reads.
- New `src/checkpoint/checkpointContinuation.ts`: manifest/state schemas, lifecycle,
  pinned shell-free commands, scoped candidate snapshot and finish-only client.
- New `scripts/continueCheckpoint.ts`: trusted one-shot `--manifest <file>` CLI.
- Add focused unit and process integration tests and nearby runtime documentation.

Athena supplies the separately accepted scope. Hermes is the existing coding
worker. Mimir names the external check role in this slice; no extra model is called
and no semantic review is claimed. The existing native/LangGraph role-planner
adapter remains unchanged: it grants neither process ownership nor task mutation
authority. No Hekate repository, native dispatcher, runner profile, HTTP route,
UI control or role catalog change is included.

The existing executive view can show the ended worker, recorded review-pending
source and final current gate. The durable continuation record also exposes
`snapshotting` and `verifying` to a human or AI reader. Wiring those intermediate
phases into the executive page is a separate presentation increment.

## 3. Closed trusted manifest

`checkpoint-continuation-run/v1`, UTF-8 JSON at most 32 KiB; refuse duplicate/unsafe
keys, unknown fields, invalid identity numbers and unsupported versions. It has:

- `schema` and `run`: the existing strict `checkpoint-run/v1` object, unchanged.
  This slice requires profile `coding`, a pinned linked worktree, exact base SHA,
  prompt/executable/Git hashes and an already claimed current task. The task's
  acceptance dependencies must hold. The original worker budget is never relabelled.
- `files`: 1–24 unique relative paths of source, scripts, tests or docs that may
  change. Each is at most 240 printable ASCII characters, has no empty or dot
  segments, backslashes, leading dash, control characters or parent traversal.
  Restrict roots to `src/`, `scripts/`, `tests/`, `docs/`; forbid Git metadata,
  node_modules, attributes files and package/config changes in this first slice.
- `focusedTests`: 1–8 unique paths under `tests/`, ending `.test.ts`, with the same
  path constraints. These are operator-selected checks, not worker-provided commands.
- `nodeExecutable`: absolute canonical path and SHA-256 of the Node executable.
- `toolingSha256`: hashes for fixed Prettier, TypeScript and Vitest entry scripts.
  Resolve only `node_modules/prettier/bin/prettier.cjs`,
  `node_modules/typescript/lib/_tsc.js` and `node_modules/vitest/vitest.mjs` from
  the linked worktree. No script-path or argv field exists. These entry pins do
  not authenticate every dependency or turn source execution into a sandbox.
- `limits`: `wallMs` (positive safe integer, at most 1,800,000),
  `verifierWallMs` (positive safe integer, at most 600,000), and
  `verifierOutputBytes` (positive safe integer, at most 4 MiB).
  The aggregate wall bound must exceed the declared worker and verifier bounds
  plus 30 seconds reserved for preflight/cleanup. Worker units/output/provider
  bounds remain those in `run`; no execution-time SLO is inferred.

Only an operator-invoked manifest supplies scope. Browser/chat/task text cannot
select commands, profiles, models, paths or authorization. The manifest and
records are supplied, not authenticated actor authority.

## 4. Ownership, preflight and durable state

The shared monotonic wall bound starts at CLI entry, including manifest reads.
Use bounded regular-file reads and verify pins before spawning. The linked
worktree must start clean, at the exact base ref, with no staged changes. Resolve
its Git metadata and fixed tooling safely; refuse symlink/outside-tree source
entries before staging. The node must be current `in_progress`, with exact
attempt/epoch/content/executor, current pins and the starting state revision.

Before any worker launch, exclusively reserve
`<runId>.continuation.json` and `.continuation-<claim-fence-hash>.lease` in the
already existing external `run.recordDir`. The hash includes root/node/attempt/
epoch/content. Refuse an existing run, gate or instance lease. Never use age or PID
to take over a lease. A crash retains it; confirmed operator recovery is separate.
This is a cooperative single-instance namespace, not a lock across arbitrarily
chosen directories. A fresh invocation never resumes or repeats an uncertain run.

The newline-terminated closed record is at most 16 KiB. It contains `schema:
checkpoint-continuation/v1`, run ID, exact task identity, `phase`, typed `reason`,
start/update/end timestamps, `sourceRef` (SHA or null), worker stop/exit metadata,
fixed-name check results with exit/timeout/output-byte metadata and output hashes,
`failureAttribution: unattributed`, `leadAcceptance: pending`,
`semanticReview: not_performed`, `delivery: not_sent`, `wake: none`,
`acknowledgment: none`, `recordTrust: supplied_not_authenticated` and
`writerLiveness: unknown`. No prompts, thinking, raw stdout/stderr, tool results,
paths, credentials or API response bodies are retained or printed.

Phases: `reserved`, `running`, `snapshotting`, `verifying`, `review_pending`,
`needs_operator`. Publish atomically through this instance's exclusive temp file;
check its lease token and deadline immediately before publication. Do not reset
malformed or moved state. Keep a durable no-repeat lease after completion.

## 5. One sequential lifecycle

1. Invoke `runCheckpoint` exactly once with the original pinned input and a signal
   linked to the aggregate deadline/operator abort. Require its ended record,
   clean owned-tree termination, zero exit and `stop.kind: exited`. On tripwire,
   uncertainty, refusal or failure, publish `needs_operator`; launch no checks,
   create no candidate and finish no task. Do not infer a source defect or retry.
2. Re-read current authority. Require the same current attempt, pins and base HEAD.
   Collect bounded NUL-separated Git status/diff paths with rename detection off.
   All changes must be declared regular source files; reject outside-scope edits,
   symlinks, an unexpected index or no source change. No crawl or worker output
   supplies a filename. Declared new files and deletions are allowed.
3. Run fixed shell-free Git operations in the isolated worktree: stage exactly the
   observed declared paths, then create one candidate commit with fixed identity
   and message. Disable hooks, fsmonitor and GPG signing through command-local
   configuration; do not change shared/user Git configuration. Recheck that only
   declared paths changed, HEAD is the resulting candidate SHA and the tree is
   clean. A failing/uncertain command stops with `needs_operator`; keep files,
   index and candidate evidence. No automatic rollback or main-branch integration.
4. Re-read the current PlanStore leaf and issue exactly one finish-only POST to
   `/api/plan-contract/v1/nodes/<nodeId>/transition`: `to: done`, exact attempt/
   epoch, candidate SHA, current CAS state revision, fixed actor and deterministic
   operation key bound to run/source. No claim, release, revise or decide call.
   Bound the request/response. On a conflict, outage or uncertain response, stop;
   never replay the mutation automatically. Confirm exact done/review-pending
   identity and artifact through a bounded GET before verification.
5. Automatically run fixed Node command profiles, `shell: false`, `windowsHide`,
   with owned process-tree cleanup. Prettier checks only declared changed files;
   TypeScript runs `--project tsconfig.json --noEmit`; Vitest runs the declared
   focused files with `--maxWorkers=1`. The verifier wall/output bounds are shared
   across all three checks. Record results and streaming output hashes; discard
   text. A launch error is unavailable, a nonzero exit is a failed check with
   unattributed cause. Keep later checks unavailable after a stop, and do not
   call any model. Tests are candidate code execution explicitly authorized by
   the operator's fixed profile, not an OS security sandbox.
6. Recheck current task identity/artifact, candidate HEAD and clean tree. If source,
   authority, lease or deadline changed, publish uncertainty and no current gate.
   Otherwise write the existing `checkpoint-gate/v1` for the worker's original
   run/fence and candidate ref. Use `deriveGateOutcome`, always unattributed; no
   automatic `source_failed` verdict. All passed checks yield `review_pending`,
   other outcomes `needs_operator`. The gate is supplied evidence, not acceptance.

Each owned command has bounded output and time, and cleanup is awaited before a
clean terminal record. Cancellation never signals an unknown PID. A process or
filesystem operation already in flight may settle late; do not start a later phase,
commit, POST or gate publication after an observed stop. Retain ambiguous side
effects and report `needs_operator`; no silent cleanup or repeat is claimed.

CLI exits: 0 only for stored `review_pending` with all checks passed; 1 for a stored
operator outcome; 2 for input/preflight refusal; 4 for persistence/cleanup failure.
Zero is never task acceptance. Errors print fixed codes only.

## 6. Objective delivery gates

- Independent old-source/relevant negative cases: scope escape, stale claim/content/
  source, unavailable PlanStore, existing run/lease, changed lease before publication,
  unsupported pins, dirty start and no source changes refuse without a second worker.
- Deterministic real subprocess fixtures: clean worker → one candidate → exact finish
  → three external check processes; worker/gate failure, hung verifier, output cap,
  aggregate deadline and cleanup failure stop at the proper boundary. No replay of
  an uncertain POST, no automatic source attribution, and no acceptance/integration.
- Strict manifests/records reject unsupported versions, decimals in identity fields,
  duplicate/unsafe keys, arbitrary command/script/action fields and oversized input.
- Real allowlisted retained-store checkpoint in a separate worktree: a small real
  coding worker satisfies independently prepared tests; timestamped process/phase
  records prove external checks started after its exit without a user message.
  Compare exact source/task/fence and final gate in the existing paired executive
  view. Preserve any failed live gate and repair through a new explicit operator
  attempt rather than changing a completed artifact or reusing old budget identity.
- Pinned format/lint/docs checks, focused tests and a full suite appropriate to these
  process and mutation changes. Semantic review and lead acceptance remain external.
