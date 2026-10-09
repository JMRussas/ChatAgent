# 20 — Checkpoint attention summary and local handoff record (planning contract)

Status: **lead-reviewed planning contract; implementation remains pending.** Athena supplied
the source survey and proposal; the lead corrected atomic publication, coverage, bounds and
verification scope before recording acceptance. PlanStore acceptance and source integration
are recorded separately in the roadmap. It freezes ONE bounded increment on top of two accepted pieces: the
read-only recovery assessment ([doc 17](17-bounded-recovery-execution.md)) and the maintained
checkpoint execution and budget record ([doc 19](19-checkpoint-execution.md)), as surfaced by the
executive overview ([doc 18](18-executive-observability-mvp.md)). This survey modified no source,
test, roadmap or issue file. Line numbers are navigation hints; names govern.

## 1. Increment and non-claims

**Name:** `checkpoint-attention/v1` (a derived summary) plus `checkpoint-handoff/v1` (a local file
written by one one-shot CLI).

**One sentence:** promote the exact facts the registered runner records and lead gate files already
carry (stop, unconfirmed cleanup, overdue without end, and a current "verification unavailable"
gate) into a bounded **attention summary** at the top of the executive page, each item pointing at
the same-page task detail that already shows the evidence, and let the operator write the same
items to a **durable local handoff file** pinned to the exact attempts.

Non-claims. This increment does not:

- detect anything by itself, poll, schedule, wake a model, or notify a person. **A handoff file on
  disk is local durable storage. It is not a notification, not a wake, not delivery, and not an
  acknowledgment.** Nothing reads the file again except an on-demand `--show`.
- add a persistent daemon, service, timer, queue consumer, or LangGraph infrastructure.
- retry a model, relaunch, reset, claim, release, accept, integrate, or terminate any process,
  including a process named by a recorded PID.
- authenticate records, runners, leads or the handoff file (no signatures, no cryptographic
  provenance).
- change PlanStore state, the Hekate repository, `CliRunner`, the runner, `ROUTES`, or the doc 17
  assessment. It adds no HTTP route and no POST.
- close CA-ISSUE-004 (section 11).

## 2. Why this increment

Doc 19 delivered typed stop, cleanup and overdue facts, but they render only inside each task's
nested `<details>`; an operator must open every registered task to find a stuck one. Doc 18's
prods say `confirm_worker_liveness` for all `in_progress` tasks without distinguishing a recorded
cleanup failure. Doc 17 section 3 lists "escalation content that a later wake or escalation step
must consume" as missing. This increment supplies exactly that content and a place to put it,
and nothing that sends it.

Alternatives not chosen: a watcher that raises items automatically (a service; section 11),
an email/webhook/bridge sender (outward-facing, needs a delivery design), and folding the doc 17
assessment into the page (a separate larger surface).

## 3. Source seams (read)

- `src/integrations/hekate/checkpointBudget.ts`: `readCheckpointBudget` (145-191) already returns
  the fence-checked `CheckpointBudgetView`; `fenceMatches` (125-135) compares attempt id, epoch,
  content revision only; `classifyGate` (141-143) makes a gate `current` only when
  `sourceRef === task.artifactRef`; `overdueUnreported` (186-190) uses
  `startedAt + hard.wallMs + overdueGraceMs` (60 s, line 23) against an injectable `now`;
  `BudgetUnavailableReason` (26-33) includes `stale_identity` (quarantine).
- `src/checkpoint/checkpointRecord.ts`: closed stop codes `REFUSAL_CODES`, `TRIPWIRE_CODES`,
  `FAILURE_CODES` (185-205) and the `stopSchema` union (207-214); `budgetRecordSchema` (225-294;
  `rootPid` 279 is non-null only for `cleanup_failed`; `recordTrust`/`writerLiveness` literals
  284-285); `deriveGateOutcome` and `gateRecordSchema` (310-353; `verifier_unavailable` only when
  no checks or all `unavailable`); `parseBoundedJson`, `CHECKPOINT_LIMITS` (20-31, 60);
  atomic temp-then-rename and exclusive-create write pattern (`replaceBudgetRecord`,
  `reserveBudgetRecord`, 464-500).
- `src/integrations/hekate/executiveOverview.ts`: `EXECUTIVE_OVERVIEW_SCHEMA`/`_V2` (26-28),
  `EXECUTIVE_LIMITS` (31-42), `ExecutiveTask` (60-90), `ExecutiveOverview` (109-115),
  `capOverviewBytes` (295-325; drops trailing tasks, never truncates JSON), `attachBudgets`
  (346-365), `collectExecutiveOverview` (394+; v2 chosen at 433-435, injectable `now`).
- `src/ui/executiveOverview.ts`: closed-schema validators `validRecord`/`validGate`/`validBudget`/
  `validRoot` (165-227; strict `keysAre`), `renderBudget` (457-490; overdue line 475, cleanup line
  477 says rootPid is a descriptor, not authority), `renderTask`/`renderRoot` (491-584, `textContent`
  only), task expansion issues the one existing progress GET.
- `src/server.ts`: overview wiring (587-600), route at 806-825, startup env load (1761+).
  `src/auth/routePolicy.ts:92` is the only overview rule. `src/config/checkpointRecordsConfig.ts`
  (registry, max 16 entries, 52-76).
- `src/integrations/hekate/recoveryAssessment.ts`: `FORBIDDEN_ACTIONS` (34); reused as the base of
  this document's forbidden list. `scripts/assessRecovery.ts` and `scripts/runCheckpoint.ts`
  (exit-code and bounded one-shot pattern, 39-59).
- `src/checkpoint/checkpointRun.ts`: claim lease (499-509), `rootPid` only on cleanup failure
  (559), `cleanup_failed` verdict (725). Not modified.

## 4. Trust model

- **Supplied, unauthenticated.** Budget records and gate files are files at operator-registered
  paths. ChatAgent verifies schema, size and the identity fence, not authorship. Every attention
  item and the handoff file carry `trust: "supplied_not_authenticated"` and
  `writerLiveness: "unknown"`. A "stopped" item means "a supplied record says so", not "the process
  is gone". An "overdue" item means the record has no end past a declared bound, not "hung".
- **Handoff file trust.** The file is written by the local CLI process into an operator-named
  directory. Anyone with file access can edit it. `itemsSha256` (section 6) detects accidental
  change and pins the exact item set for a future acknowledgment; it is not provenance.
- **Clock domains** (as doc 17 section 6): record timestamps are the runner's UTC wall clock;
  `overdueUnreported` compares them to the ChatAgent collector clock; the CLI `createdAt` is the
  CLI's clock. They are never mixed in any other comparison, and no state is derived from age
  beyond the existing `overdueUnreported` rule.
- **Verifier outage stays unattributed.** Every item has `attribution: "unattributed"` (literal).
  A `verification_unavailable` item never becomes a source failure, never a worker fault, and
  spends no model retry. A stop code is context, not cause (doc 19: exit status never selects
  cause).

## 5. Attention summary: `checkpoint-attention/v1`

### 5.1 Wiring

A pure module `src/integrations/hekate/checkpointAttention.ts` exports
`projectAttention(roots, registry)` over the built `ExecutiveRootView[]` and trusted registry
(reads no file, clock or network; overdue comes from the existing `overdueUnreported` flag).
`collectExecutiveOverview` calls it when a registry is configured, before `capOverviewBytes`, and
sets `taskListed` after capping. Coverage counts include registered entries whose root is unavailable or task is missing/omitted before attachment. A pure summary cannot infer those entries from visible tasks alone; the registry is an explicit input. Recompute final byte size after marking rows. If attention alone exceeds an injected response cap, deterministically drop trailing items and increment `omitted`; never return an oversized body or silently report no exceptions.

Overview schema: `executive-overview/v3` when a registry is configured (adds one top-level field
`attention`); **without a registry the response stays byte-identical `executive-overview/v1`**. A
registry no longer produces `v2` from the new server; the UI's closed validator accepts v1, v2
and v3 and a v3 body must carry `attention`. This compatibility step is the part of the contract
the lead should check first.

### 5.2 Item (closed, strict)

```ts
interface AttentionItem {
  kind:
    | "cleanup_unconfirmed" // stop.code cleanup_failed
    | "overdue_unreported" // record running past hard wall + grace, no end
    | "stopped_tripwire" // stop.kind tripwire (closed TRIPWIRE_CODES)
    | "stopped_failed" // stop.kind failed, except cleanup_failed
    | "refused_start" // stop.kind refused (any REFUSAL_CODES)
    | "verification_unavailable"; // CURRENT gate with outcome verifier_unavailable
  rootId: string;
  nodeId: string;
  fence: { attemptId: string; attemptEpoch: number; contentRevision: number };
  runId: string;
  stop: { kind: string; code: string }; // from the supplied record, closed enums
  recordState: "running" | "ended";
  recordUpdatedAt: string;
  rootPid: number | null; // only for cleanup_unconfirmed; a descriptor, never authority
  gateSourceRef: string | null; // only for verification_unavailable
  taskState: LeafState; // projected plan state at read time
  taskListed: boolean; // false when capOverviewBytes omitted the task row
  attribution: "unattributed"; // literal
  action: AttentionAction; // closed, section 5.4
  trust: "supplied_not_authenticated";
  writerLiveness: "unknown";
}
interface Attention {
  items: AttentionItem[]; // at most 32, ordered (5.3)
  omitted: number; // items beyond 32, counted exactly
  registeredRecordsUnavailable: number; // registry entries with unobservable tasks or unavailable/quarantined records
  basis: "supplied_records"; // literal
  automaticAllowed: false;
  forbidden: readonly string[]; // exact constant list in 5.4
}
```

The item carries no task name, prompt, worker text, path, URL, stderr or free string. Task names
stay on the existing task row.

### 5.3 Derivation rules (only from existing typed facts)

An item is produced only for a registered task whose `checkpointBudget.state === "reported"`
(so the identity fence already matched; a quarantined record yields **no** item and only increments
`registeredRecordsUnavailable`, with its numbers never shown).

1. `cleanup_unconfirmed`: `record.stop.code === "cleanup_failed"`. Never suppressed by task state.
2. `overdue_unreported`: `overdueUnreported === true` (implies `state: running`).
3. `stopped_tripwire`: `record.state === "ended"` and `stop.kind === "tripwire"`.
4. `stopped_failed`: `ended`, `stop.kind === "failed"`, code not `cleanup_failed`.
5. `refused_start`: `ended`, `stop.kind === "refused"`. (`claim_already_owned` is shown as the
   code; it never triggers a second start.)
6. `verification_unavailable`: gate view `state === "current"` (fence **and** `sourceRef ===`
   the task's `artifactRef`) and `gate.outcome === "verifier_unavailable"`. A `history` gate, a
   missing/invalid gate file, or any other outcome yields no item. `failureAttribution` is ignored;
   the item is always `unattributed`.

`cancelled` and `exited` (clean) stops yield no item. Items kinds 3-5 are suppressed (counted in
`omitted`-free fashion: not listed) when the task's projected state is `accepted` or `cancelled`;
kinds 1, 2 and 6 are not suppressed. Per task at most two items (an ended stop kind or overdue,
plus verification). Order: kind priority above, then root configured order, then task order, then
`runId`. Cap 32 (registry maximum 16 tasks x 2), deterministic, `omitted` exact.

Not added: executorRef or `observedStateRevision` equality (doc 19: state revision legitimately
advances; post-release executorRef value unverified). The lead may tighten this.

### 5.4 Actions (advice text keys, never executable)

`inspect_owned_process_manually` (cleanup_unconfirmed), `confirm_owner_before_any_action`
(overdue_unreported), `decide_new_attempt_or_discard` (tripwire/failed), `fix_start_precondition`
(refused_start), `rerun_independent_checks_outside_worker` (verification_unavailable). The
attention block and each handoff carry `automaticAllowed: false` and a constant `forbidden` list:
doc 17 `FORBIDDEN_ACTIONS` plus `model_retry`, `terminate_unknown_pid`,
`second_worker_for_claim`. UI text for each action is a fixed template; no interpolation except
validated ids and enum codes.

### 5.5 Page behavior (in-place detail)

- A new "Attention" panel renders at the top of the existing overview body from `attention.items`
  (`textContent` only, closed-schema validated before rendering, at most 32 rows). The empty case
  reads "No attention items from registered records (not a health statement)". A non-zero
  `registeredRecordsUnavailable` and `omitted` are always shown.
- Each row names root label, kind, code and action, and has an **Open detail** control. It opens
  the matching root `<details>` and task `<details>` (existing `openRoots` state), scrolls the task
  into view, and the user sees the existing `renderBudget` evidence (stop, cleanup line, overdue
  line, gate with its supplied-by-lead label) in that same page. `location` does not change.
- If `taskListed` is false the row says "Task row omitted by the size cap; refresh or reduce
  scope" and offers no control. If a refresh changes the item's fence or the task no longer exists,
  the row is replaced by "changed, refresh" and is never left looking current.
- No request on load or reload; the only added request is the existing one progress GET when the
  task is expanded. No polling, no POST, no new route.

## 6. Handoff record: `checkpoint-handoff/v1`

A closed JSON file `<handoffId>.handoff.json` (lowercase GUID), at most 64 KiB, newline-terminated:

```
schema            "checkpoint-handoff/v1"
handoffId         guid (CLI random)
createdAt         ISO UTC, CLI process clock
source            { overviewSchema: "executive-overview/v3", overviewGeneratedAt, atomic: false }
items             HandoffItem[] = AttentionItem without taskListed, at most 32
fenceStatus       "observed_at_capture" (not an atomic current-state guarantee)
omitted, registeredRecordsUnavailable
itemsSha256       sha256 hex of JSON.stringify(items) (pins the exact set; not provenance)
forbidden         the constant list in 5.4
automaticAllowed  false
trust             { records: "supplied_not_authenticated", writerLiveness: "unknown",
                    author: "local_cli_unauthenticated" }
delivery          "not_sent"
notification      "none"
wake              "none"
acknowledgment    "none"
```

`delivery`, `notification`, `wake` and `acknowledgment` are literals in this version; a parser
rejects any other value, so a later increment must introduce a new schema to claim any of them.

### 6.1 CLI: `scripts/handoffCheckpoint.ts`

`npx tsx scripts/handoffCheckpoint.ts --out-dir <abs dir>` writes a handoff;
`npx tsx scripts/handoffCheckpoint.ts --show <file>` strictly parses one file (same bounded
parser, no overwrite) and prints fixed text. It reads the same env as the server
(`HEKATE_PLAN_API_URL`, executive roots, `HEKATE_CHECKPOINT_RECORDS_JSON`) via the existing loaders;
no bridge token, cookie, browser state or session is read.

Write protocol (the pin-before-durable rule):

1. Collect the overview once (`collectExecutiveOverview`, the existing loopback GETs and registered
   file reads only) and project attention. Zero items: write nothing, print "no attention items
   (not a health statement)", exit 0.
2. Collect a **second time** and project again. Compare the two item sets on `kind`, ids, `fence`,
   `runId`, `stop`, `recordState`, `gateSourceRef`, ignoring `recordUpdatedAt`/`taskListed`. Any
   difference, or any root `unavailable` in either read for a root that had items, refuses the
   write: exit 1, no file, a fixed reason code.
3. Only then publish the file: `out-dir` must be canonical absolute, an existing regular
   directory (`lstat` not a symlink; realpath matches the configured path). Write a bounded temp
   file exclusively in that directory, sync its contents and close, then atomically create the
   final name with a no-overwrite operation (`link(temp, target)`); unlink the temp. A racing
   existing target must refuse without modifying its bytes. Do not use check-then-rename:
   rename can replace a file created after the check. Unsupported link/write/sync operation
   refuses rather than falling back to overwrite. Directory sync and power-loss safety are not claimed in this increment.
   Clean up the temp on every failed publication and preserve an existing target. Never append,
   prune, or write an index. Complete all collection/deadline/size checks before publication.
   The two reads are observational and non-atomic; a local file pins captured facts, not
   authoritative current state at or after publication. A future action needs a fresh fence.

Exit codes: 0 handoff written or nothing to hand off; 1 refused (pin changed, read unavailable,
deadline); 2 usage; 4 write failed. The CLI has a hard total deadline.

### 6.2 What a future acknowledgment must pin (rule now, writer later)

This increment writes no acknowledgment. Any future acknowledgment record must carry the item's
complete `fence` + `runId` + `kind` and the file's `handoffId` + `itemsSha256`, must re-read the
current attempt fence immediately before it is written durably, and must be refused (not
downgraded) if the fence, `runId`, stop code or gate `sourceRef` differs. An acknowledgment of a
superseded attempt is never recorded as acknowledging the current one.

## 7. Boundaries (explicit)

- No-network: the only sockets are the existing loopback plan-API GETs through
  `fetchCoordinationStatus`/`planApiBase`. No other host, no mail, webhook, bridge or notification
  call, no `child_process`, no process signal, no spawn.
- No-send: the artifact is a file. The CLI output says "written locally; not sent".
- No new persistent daemon, timer, watcher or listener. The CLI exits after one run.
- No auto model retry, relaunch or reset; no unknown-PID termination. `rootPid` is displayed only
  as a recorded descriptor, a PID can be reused, and no code path accepts it as input to any
  operation.
- No arbitrary command execution; no shell; no write outside `--out-dir`.

## 8. Provisional budgets (not measured, not SLOs)

| Item                                          | Provisional bound                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Attention items per overview                  | 32 (+ exact `omitted`)                                                                        |
| One serialized item                           | 1 KiB (reject an oversized item)                                                              |
| Overview after the change                     | under the existing 1 MiB cap                                                                  |
| Handoff file                                  | 64 KiB; CLI refuses to write over                                                             |
| Collections per CLI write                     | at most 2 (zero items may exit after 1)                                                       |
| CLI total deadline                            | 20 s total collection/publication deadline, monotonic; cancel or refuse late publication      |
| Registered file reads per collection          | 2 per registered task, 16 tasks, 500 ms each                                                  |
| Added requests on page load / refresh         | 0 / 0 (same GET as today)                                                                     |
| Rows rendered / retained handoff files        | 32 / unbounded by design (no pruning; see section 11)                                         |
| Implementation + lead review (planning guess) | No measured ETA; worker expected30/hard60 message IDs,15-minute/8-MiB bound,USD5 provider cap |

## 9. Frozen gates

Oracles in `tests/unit/checkpointAttention.test.ts`, `tests/unit/checkpointHandoff.test.ts`,
`tests/integration/checkpointHandoffCli.test.ts`, with additions to `executiveOverview.test.ts`,
`executiveOverviewUi.test.ts`, `checkpointBudgetUi.test.ts`, `checkpointRecordsHttp.test.ts`,
`httpAuth.test.ts` (inventory unchanged) and `tests/browser/executiveOverview.spec.ts`. Fixtures
reuse `tests/helpers/checkpointFixtures.ts`.

### 9.1 Objective negatives (each must fail by assertion at a stub/old source)

- N1 Unregistered records yield no item and are outside coverage. Registered `missing`,
  `invalid`, `too_large`, `timeout`, `stale_identity`, missing task and unavailable-root cases
  yield no item; `registeredRecordsUnavailable` rises; a sentinel number from a quarantined record
  appears nowhere in the overview, attention, handoff or page.
- N2 Fence off by one (attempt id, epoch, content revision) gives no item. A gate with the same
  fence but a different `sourceRef` (history) or a task with `artifactRef: null` yields no
  `verification_unavailable`.
- N3 A `verifier_unavailable` gate, with `failureAttribution: "source"` set, still yields an item
  with `attribution: "unattributed"`; no item, handoff or rendered text contains
  `source_failed`, "rejected" or a retry recommendation derived from it. A `partial`,
  `checks_passed` or `source_failed` gate yields no verification item.
- N4 Clean `exited`, `cancelled` and `none` records yield no item. Tripwire/failed/refused items
  for `accepted`/`cancelled` tasks are suppressed; `cleanup_unconfirmed` for the same tasks is not.
- N5 No attention or handoff item asserts `alive`, `healthy`, `idle`, `stalled`, `hung`, `dead`,
  `stopped successfully`, `delivered`, `notified`, `acknowledged` (other than the literal
  `"none"` field values), or a percent, ETA or SLO.
- N6 `rootPid` appears only on `cleanup_unconfirmed`, as an integer descriptor; a mutant that
  passes it to `process.kill`, `taskkill` or any spawn is caught by throwing doubles.
- N7 Privacy: sentinels in prompt, assistant text, tool results, stderr, task name, paths and
  unknown record keys never appear in attention or the handoff file. The Attention panel uses
  only fixed text, validated item fields and trusted configured root labels. Existing task detail
  still renders bounded task names as inert text; do not turn this into a whole-page text ban.
- N8 No registry gives a byte-identical `executive-overview/v1` body with no `attention` field;
  a v3 body without `attention`, with an unknown item key, a 33rd item, or an unknown `kind` is
  rejected by the UI validator.
- N9 Handoff: second read differs in any pinned field, a root becomes unavailable, the out-dir is
  relative, a symlink, a missing directory, the target exists (including creation racing publication), or the serialized size exceeds
  64 KiB: no handoff file remains (temp removed) and the exit code is 1 or 4 as specified. An
  existing file is never modified (byte-compared).
- N10 `--show` rejects duplicate keys, `__proto__`, floats, an unknown schema, any
  `delivery`/`notification`/`wake`/`acknowledgment` value other than the literals, a mismatching
  `itemsSha256`, and oversize input, with a non-echoing code.
- N11 No-network/no-send: a request log across both CLI modes and the page shows only `GET`s to
  the loopback plan API paths (CLI) and the overview and progress paths (page); `fetch`,
  `http`, `net`, `child_process` and `process.kill` doubles throw on any other use; `ROUTES` and
  the route inventory are unchanged and no POST exists.
- N12 No daemon: after the CLI promise settles the test checks no active handles are left (no
  timer, server or socket) and the process exits without `process.exit`.

### 9.2 Positive gates

- P1 One fixture task per kind produces exactly its item with the specified fence, `runId`, stop,
  action and `taskListed`, in the specified order; two items for one task (stop + verification)
  are both present; 17 registered tasks are refused at startup as today and 16 tasks with 32
  items give `omitted: 0`; a forced 33rd source gives `omitted: 1`.
- P2 Normal task-row capping sets `taskListed: false` without silently discarding its attention
  item. An injected cap below the attention body size drops trailing items with exact `omitted`;
  final body size stays within the supported cap. No current row/control is invented.
- P3 In the browser spec: the Attention panel renders with no request on load; **Open detail**
  expands root and task, the existing budget evidence for that task is visible, `location` is
  unchanged, and a refresh that changes the fence replaces the row with "changed, refresh".
- P4 Handoff written: file parses with `--show`, `itemsSha256` matches, literals are
  `not_sent`/`none`, content equals the first collection, exactly two collections occurred, the
  directory holds exactly that file, and the CLI said "written locally; not sent".
- P5 Zero items writes nothing and exits 0; an unavailable root with no items does not claim
  "none" for it (the unavailable count/reason is printed).
- P6 Determinism: same overview input gives byte-identical attention JSON; the pure function is run
  with throwing clock, random, fs and fetch doubles; inputs are deep-frozen.
- P7 Targeted negative controls, limited to meaningful independently observed contracts: lists a quarantined record; treats a history
  gate as current; maps `verifier_unavailable` to source/rejected; ignores one fence field; ignores
  `sourceRef`; suppresses `cleanup_unconfirmed` for an accepted task; emits v3 without a registry;
  writes after one read; overwrites an existing handoff; follows a symlinked out-dir; writes a
  `delivery` other than `not_sent`; offers a kill/restart/retry control; reads wall clock inside the
  pure function.

### 9.3 Commands (lead, in a clean worktree at the exact artifact SHA)

- `npx vitest run tests/unit/checkpointAttention.test.ts tests/unit/checkpointHandoff.test.ts`
- `npx vitest run tests/integration/checkpointHandoffCli.test.ts tests/integration/checkpointRecordsHttp.test.ts tests/integration/httpAuth.test.ts`
- `npx vitest run tests/unit/executiveOverview.test.ts tests/unit/executiveOverviewUi.test.ts tests/unit/checkpointBudgetUi.test.ts`
- `npx playwright test tests/browser/executiveOverview.spec.ts`
- `npx tsc -p tsconfig.json --noEmit`, `npm run format:check`, `npm run lint`, `npm run docs:check`
  and the full suite. A failing command is reported as failing.

## 10. Commit-sized scope

New: `src/integrations/hekate/checkpointAttention.ts` (types, `projectAttention`, handoff builder
and strict bounded parser, `itemsSha256`), `scripts/handoffCheckpoint.ts`. Edited: `executiveOverview.ts`
(v3 field, wiring before the cap), `src/ui/executiveOverview.ts` (validator, panel, open-detail),
`docs/runtime-reference.md`. Not touched: `checkpointRun.ts`, `checkpointRecord.ts` (reused
read-only; the atomic-write pattern is copied into the new module rather than editing the shared
writer), `server.ts`, `routePolicy.ts`, Hekate, tests listed as frozen except by addition. The lead
owns roadmap, open-issues, docs index and formatting-only commits. If implementing forces a Hekate
or runner change, stop and split it out.

## 11. Future work required before CA-ISSUE-004 can close (all out of scope here)

1. **Durable pending record before notification:** a state machine (`pending → delivered →
acknowledged | superseded | expired`) that survives restart and a consumed notification, with
   a single-writer/lease and exclusive-create semantics. This file has no state transitions.
2. **A supported delivery channel:** actual user notification and/or wake of a lead model
   (bridge, desktop, email or other), its authentication, rate limits, redaction, and outward-send
   approval. Nothing is sent today.
3. **Wake with acknowledgment tied to the record:** idempotency key from `handoffId` +
   `itemsSha256` + item fence, duplicate-delivery, lost-wake and acknowledged-then-no-progress
   handling, and evidence of resumed review (doc 13 scenario; doc 17 section 3).
4. **Acknowledgment writer:** operator-authenticated action (route or CLI) honoring the 6.2 pin
   rule with a fresh fence read, CSRF/auth review, and supersession fences.
5. **Retry limits and escalation** to an authorized operator when recovery is exhausted.
6. **A persistent supervising service:** detection within a stated time bound, thresholds for
   idleness, restart safety, one-instance lease, shutdown, and its own review. Today `overdue` is
   a single registered-record rule, and worker liveness stays `unknown`.
7. **Lead-side idleness and post-response stalls:** integration of the doc 15 bridge classifier
   and modelled checkpoint evidence for ongoing work.
8. **Record provenance:** authenticated runner/lead records if the threat model requires it.
9. **Handoff lifecycle:** retention, pruning, an index or inbox, and a reader that is not
   on-demand `--show`.
10. **Typed rejection/verifier cause export** from Hekate (doc 17 section 7), so a stop or an
    unavailable gate can be attributed without guessing.
11. **Independent verification of the whole doc 13 review-pending scenario.**

CA-ISSUE-004 stays open after this increment.

## 12. Limitations and open questions for the lead

- Attention is only as complete as the operator's registry (at most 16 tasks); an unregistered
  task is invisible, by design.
- `overdue_unreported` depends on the runner and collector clocks being comparable; the contract
  makes no claim if they are not.
- A handoff pins what the supplied records said at the second read, not what is true now.
- Whether to bump to v3 (chosen) or add `attention` to v2 without a version change is the lead's
  call; v2 clients with a closed validator would reject the extra field.
- The reused name `FORBIDDEN_ACTIONS` is exported from `recoveryAssessment.ts`; confirm the
  export shape at implementation before extending it locally.
- Planning is not implementation acceptance. No tests, lint or live checks have been run for this
  contract.

## 13. Independent lead review and acceptance scope

Retain Athena original proposal, source diff and actual maintained run record outside the repository. Corrections are attributed to the lead: no-overwrite atomic publication and race negative, explicit observational fences, registry-aware unavailable coverage, complete summary/trust fields, realistic item/file caps, directory-sync limitations, precise UI privacy assertions and finite worker budgets. The no-registry v1 compatibility and existing v2-client reading remain required; no new HTTP route or automatic execution is authorized. Source artifact acceptance freezes this contract only. It does not certify an unbuilt implementation, a delivered notification, human acknowledgment or an unattended management service.
