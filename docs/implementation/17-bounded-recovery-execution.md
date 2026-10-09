# 17 — Bounded recovery execution: first increment (planning contract)

Status: behavior contract for the first bounded, read-only recovery assessment and
its CLI. Recorded task acceptance and source integration are separate evidence in
the roadmap. This phase does not implement unattended recovery, wake-up or automatic
control actions. Sections 8–13 retain the proposed prepared TaskSpec automation path;
section 14 describes the actual supervised API/CLI execution boundary.

Scope: the existing recovery backlog task `af690ee2-4e2e-5043-a71a-c0d126030971` under
root `d6450921-6673-5535-b495-07cc165ada2d` (reconcile idle lead/worker state before
automatic recovery), as named in the
[roadmap assessment](../12-development-roadmap.md#current-assessment-and-next-execution-gate-2026-10-09).
The other backlog tasks stay unprepared and separate. Hekate source references were independently checked against revision
`10163d97820cda2b739943981de662ea29d854b8` in the maintained E1 source.
Line numbers are navigation hints; function names and exact source pins govern execution.

## 1. Non-claims

This increment does not implement or claim persistent recovery, a schedule, automatic
AI wake-up, a measured baseline or a service-level objective. It never relaunches,
resets, retries, claims, reviews, accepts, integrates or stops anything. A recommendation
is advice for a named human or lead role; it is never an authorized control operation.

## 2. The first increment: a read-only recovery assessment

**Name:** `recovery-assessment/v1`, one pure classifier plus a one-shot read-only CLI.

**Question it answers, per plan node:** given the exact attempt, content revision and
owner the caller expects, what do the authoritative plan record and the observation
say, and what bounded action, by whom, is recommended, with every automatic action
forbidden?

**Why this one, supported by existing code:**

- The inputs already exist and are typed. `attempt-progress/v1`
  (`src/integrations/hekate/attemptProgress.ts:20`, `projectAttemptProgress` at 310)
  carries identities, enums, recorded decision, content pins and trace metadata. The
  observer's failure reasons are a fixed set (`ROLE_REASONS`, lines 461-482; the 503
  body is `{code, reason}` at 499-502 and 526-533). The host status body is already
  projected through an allowlist (`DispatchHost.status`, `dispatchHost.ts:582`;
  lifecycle at 1226-1237; journal summary at 1197-1206).
- The shape is proven. `classifyActivity` (`src/integrations/bridge/activity.ts:303`)
  is pure, takes an injected `nowMs`, reports only what the input records, and makes
  incomplete input `unknown` rather than a guessed state (lines 147-155, 164). The same
  discipline applies here.
- It needs no new Hekate behaviour, so it fits one repository (ChatAgent).
- It addresses the failure that actually cost model attempts. Two rejected final
  attempts passed native source checks, but the external observer failed on a valid
  private trace record (CA-ISSUE-035,
  [open-issues.md](../open-issues.md#ca-issue-035--observer-rejects-a-valid-large-native-trace-record)).
  Nothing downstream could tell an observer fault from a worker fault. The roadmap
  (next delivery order, item 2) requires a frozen contract that distinguishes them.

**Alternatives not chosen first:**

- Wiring an automatic retry or relaunch policy: forbidden until the evidence layer can
  be trusted, and the thing this layer exists to guard.
- A persistent monitor or scheduler: out of scope and unclaimable here.
- Adding the assessment to the browser panel or a new server route: a larger,
  separately reviewed surface; it follows once the pure contract is accepted.
- Folding the bridge lead-idle classifier in: doc 15 already owns lead initial-response
  detection. Merging the two would double the matrix. See section 3.

## 3. How this is a bounded phase of CA-ISSUE-004

[CA-ISSUE-004](../open-issues.md#ca-issue-004--no-automatic-recovery-of-an-idle-lead-or-worker)
needs a stalled lead or worker detected from recorded evidence and then resumed or
escalated within a stated bound. Doc 15 delivered initial-response detection for bridge
assignments. Doc 13's review-pending scenario (steps 2, 4 and 5) needs, before any wake
or escalation, a reconciliation layer that says which state is authoritative, which
failure is whose, and what must not be repeated. This increment is that layer for the
Hekate worker side: the typed input and the escalation content that a later wake or
escalation step must consume.

**Original closure criteria that remain unmet after this increment:**

- Detection within a stated time bound. This increment defines no thresholds and polls
  nothing; liveness and useful progress stay `unknown`.
- Resumption or escalation actually delivered. A recommendation is printed on request;
  nothing is sent, woken or resumed.
- The doc 13 scenario: a durable `review-pending` record written before notification,
  surviving restart and consumed notification; a supported wake with an acknowledgment
  tied to that record; evidence of resumed review.
- Lost wake-up, duplicate delivery and acknowledgment-then-no-progress cases, retry
  limits, and escalation to an authorized operator when recovery is exhausted.
- Wake-up supersession fences. Only the assessment itself is fenced here.
- Ongoing-work stall detection after a response (doc 15 left it for modelled
  checkpoint evidence).
- Lead-side idleness. The bridge classifier is not integrated with this assessment.
- Independent verification of the whole scenario. Verification of this proposed increment is still pending.

CA-ISSUE-004 therefore stays open.

## 4. Source seams (read and verified)

ChatAgent:

- `src/integrations/hekate/roleObservation.ts`
  - `createRoleObserver` (521) and its bounds: 10 s, 8 GETs, 4 MiB by default (532-534).
    `get` (345) shares the deadline and byte budget and uses no redirects.
  - `observedAt` is taken from `options.now ?? new Date()` (770): the ChatAgent
    process wall clock at the end of the observation.
  - `consistency` is `current`, `stale` or `partial` (66, 768-769). Reasons include
    `attempt_content_stale` (659), `trace_*` (737-745), `drift_*` (758-762) and
    `events_ahead_of_plan` (764).
  - Selected attempt and content pins (614-660); claim linkage (708-718).
  - Trace record text cap is the whole-observation budget, not 64 KiB (277-289),
    which is the CA-ISSUE-035 repair.
- `src/integrations/hekate/attemptProgress.ts`
  - Recorded decision and linkage (420-429), selected attempt (335-342), trace
    metadata (366-379), liveness and progress fixed `unknown` (441-446).
  - `activity` (220, 380) carries unverified public worker text; `aiSnapshot` (298)
    is already an allowlisted metadata projection without arbitrary worker text.
    The assessment excludes both and selects only the fields its contract needs.
  - Service: 503 `ATTEMPT_PROGRESS_UNAVAILABLE` with a fixed reason, 404
    `NODE_NOT_FOUND` (510-539).
- `src/integrations/hekate/devCoordination.ts`: strict node and decision schema
  (107-142; acceptance 128-139), `planViewSchema` (144), `parseStrictJson` (53),
  older-attempt decision handling documented in doc 13.
- `src/integrations/hekate/dispatchHost.ts`: `status` (582), lifecycle (1226-1237),
  journal summary with `unresolvedIntent`, `uncertainLaunch`, `uncertainStop`,
  `malformedRecords` (1197-1206), projected fields (1246-1269), relaunch gate
  (1326-1338). It does not project the native `lastRun` or `detail`.
- `src/server.ts`: progress route `/development/plans/:root/nodes/:node/progress`
  (789-808); dispatch status route `/development/plans/:root/dispatch` (811-829).
  Both require the operator session; the assessment CLI does not use them.
- `scripts/observeRole.ts`: serial, at most 20 cycles, at least 250 ms apart (15-17,
  45-51). `scripts/agentStalls.ts`: exit codes 0/4/1/2 (119-125) and the
  deadline-plus-one-second hard stop (127-140).
- `src/integrations/bridge/activity.ts`: reference for the pure-classifier pattern.

Hekate (`scripts/local/supervisor_e1/e1/`):

- `task_runner.py`: the verifier's decision is `accepted | rejected | uncertain`;
  `uncertain` stops the pilot without a decision or retry (module docstring, 20;
  `SpecVerifier`, 440-468; reasons such as `view_unverifiable` 463,
  `artifact_parent_not_base` 482, `diff_outside_allowlist` 491,
  `verify_kill_unconfirmed` 534, `step_failed:*` 544). The verdict `why` is written to
  the run's local `evidence.json` (671-672), not to the plan API.
  `verify_only` (681-753) records that it is not a replay of the original decision.
- `plan_run.py`: `classify` (102-127) gives the typed stop reasons `inflight`,
  `review_pending`, `acceptance_stale`, `node_rejected`, `node_cancelled`,
  `plan_drift`, `no_ready_work`; before any claim it can stop with `spec_pending`
  (256), `spec_mismatch` (263), `base_not_chained` (278), `node_run_root_exists`
  (267, 282) and `preflight_refused` (285-286); `make_claim_check` (138-153) pins node,
  content and predecessor artifacts; there is no automatic integration and no resume
  (docstring, 19-20).
- `owned_dispatch.py`: `liveness` and `report` (230-268), including the note that a
  gone owner's node "may be in flight: inspect PlanStore, do not reset"; `observe`
  (282-307); `WAITABLE` and `FAILED` (45-47); the native status carries
  `lastRun={outcome, reason}` (392).
- `wire.py`: `SupervisorClient` can only claim, read and finish or release (58-76);
  `Response.code` (24-31). `task_spec.py`: `TaskSpec` (41-54), `SpecRefused` (35-38).

## 5. Contract

### 5.1 Input

One frozen, replayable `recovery-assessment-input/v1` object, at most 64 KiB, strict JSON
(exact safe integers, no duplicate keys, same rules as `parseStrictJson`):

- `expected` (required fence): `rootId`, `nodeId`, `attemptId` (string or null),
  `attemptEpoch`, `contentRevision`, and optionally the host `launchId` (32 lowercase
  hex). A caller that cannot name the exact task attempt and content gets
  `input_invalid`, never a default. Host ownership is not established when host input
  is absent; a supplied expected launch ID without a supplied matching host is a mismatch.
- `observation`: either
  - `observed`: an allowlisted extraction of `attempt-progress/v1`: `observedAt`,
    `consistency`, `reasons`, `task` (work, state and content revisions, attempt id and
    epoch, attempt content revision, effective acceptance), `selectedAttempt` (id, epoch,
    scope, content pins), trace metadata (status, integrity, claim linkage, capped,
    truncated, metadata stable, exit code, record count), `acceptance` (decision, content
    revision, epoch, attempt id, artifact views) and the evidence citations
    (`ref`, canonical relative API endpoint, sha256); or
  - `failed`: `{httpStatus: 404 | 503, reason}` with the service's fixed reason.
- `host` (optional): the allowlisted subset of the dispatch status body: lifecycle,
  liveness, state, stop reason, launch id, current node id, and the journal summary.
  Labelled `supplied`: this CLI does not authenticate or fetch it.

The extraction function is part of the deliverable. It drops `activity`, `aiSnapshot`,
prompts, trace text, withheld or unrecognized artifact refs and every unlisted key, so a stored or
replayed input never holds worker text.

### 5.2 Output

`recovery-assessment/v1`, deterministic, at most 16 KiB, with these parts:

- `recorded`: the observed root, node, state revision, content revision, attempt
  identity/epoch/content pin, effective acceptance and safe task/decision artifact
  views. A pending-review candidate artifact is preserved even without a decision.
  A failed observation has no recorded binding. These fields let both roles cite
  exactly which record was assessed; supplied replay is not authenticated evidence.
- `subject` and `fence`: validated identities only, and for each fenced field whether it matches
  (`match`, `mismatch`, and the field names that differ).
- `observation`: `status` (`observed` or `failed`), `faultClass`, the fixed `reason`,
  `consistency`, bounded `reasons`, `observedAt` and `clockDomain`.
- `attempt`: `workerSource`, `claim`, and `decision` binding (below).
- `host`: `supplied`, `owner`, `uncertainEffects`.
- `recommendation`: `action`, `authority`, `automaticAllowed: false` (a literal type),
  `forbidden` (the constant list below), `codes`, and a `summary` built from a fixed
  template per `action`. Only validated ids are interpolated; no input string is.
- `evidence`: the observation's citations (`ref`, endpoint, sha256) so a reviewer can
  find the exact responses the observer hashed.
- `trust`: worker liveness and useful progress `unknown`; worker statements not read.

`forbidden` is always: `blind_relaunch`, `automatic_source_retry`,
`reset_in_progress_node`, `restart_unknown_owner`, `second_owner`, `mutate_plan_state`.

### 5.3 Observation fault classes (distinct from worker outcome)

Derived only from the fixed reason set, never from message text:

- `availability`: `TIMEOUT`, `UNAVAILABLE`, `HTTP_ERROR`, `BUSY`. Action
  `reobserve_then_escalate`.
- `bound_exceeded`: `RESPONSE_TOO_LARGE`, `PAGE_LIMIT`, `TOO_LARGE`. Action
  `repair_observer_or_contract`.
- `contract`: `INVALID_RESPONSE`, `INVALID_NUMBER`, `DUPLICATE_KEY`, `UNSAFE_KEY`,
  `UNSUPPORTED_CONTRACT`, `ROOT_MISMATCH`, `IDENTITY_MISMATCH`, `CURSOR_STALLED`,
  `INVALID_SEQUENCE`, `INVALID_ATTEMPT`, `INVALID_NODE`, `INVALID_OBSERVATION`. Action
  `repair_observer_or_contract`. The side at fault (consumer or producer) is reported
  `unattributed`; `INVALID_RESPONSE` cannot tell them apart.
- `config`: `INVALID_URL`, `INVALID_ROOT`, `INVALID_OPTIONS`. Action
  `escalate_operator`.
- `not_found`: HTTP 404 `NODE_NOT_FOUND`. Action `escalate_operator`.
- `unrecognized`: any other reason. Treated as `contract`, action
  `repair_observer_or_contract`.

A failed observation always yields `workerSource: unobserved`. It is never evidence of a
worker, source or verifier decision, and it never recommends a model retry.

### 5.4 Attempt classification (observation succeeded)

Lead decision: evaluate inconsistent state, decision epoch/content/attempt/ref matching
and content pins before accepted/rejected outcomes. Report historical decisions
separately from current execution: a released TODO node with no live attempt can have
an old artifact and decision. It is still unclaimed for the current fence and never
accepted because of that history. A withheld/incomplete decision binding is unknown,
never a current accepted outcome. The ordering below is a vocabulary list, not a
license to mask those guard conditions.

`workerSource` is one of the following, after the fence and observation checks:

- `no_attempt`: work `todo`, no attempt id.
- `in_flight`: work `in_progress`.
- `awaiting_review`: work `done`, no decision.
- `accepted_current`: a current decision of `accepted` (rule in 5.5).
- `rejected_current`: a current decision of `rejected`.
- `decision_historical`: the decision belongs to a strictly older positive epoch.
- `decision_stale`: same epoch but different attempt id or content revision, or an
  effective acceptance of `stale`.
- `pins_stale`: the attempt's content pin no longer equals the task's content revision.
- `cancelled`: work `cancelled`.
- `inconsistent`: any impossible combination (a decision epoch above the task epoch, a
  done node with a decision but no attempt id, an effective acceptance that disagrees
  with the decision).

`claim` is reported from the plan node, which is authoritative:

- `none_since_fence`: work `todo`, no attempt id, epoch equal to the expected epoch.
  This is the pre-claim case. A host stop code cannot prove it; the plan node does.
- `claimed_trace_linked`, `claimed_trace_unlinked`, `claimed_trace_unavailable`: an
  attempt id exists, with the trace's claim linkage `matched`, `unavailable`, or no
  captured trace. This is allocation, not worker start (`executionAcknowledged` stays
  unknown, as in doc 13).

A host stop code is context only. The assessment may label a known pre-claim code
(`spec_pending`, `spec_mismatch`, `base_not_chained`, `node_run_root_exists`,
`preflight_refused`) as `known_preclaim_code`; any other code is `unrecognized_code`. It
never turns a host code into a worker or verifier cause.

**Recorded rejection is not a typed cause.** The plan record gives only `decision:
rejected` plus an opaque evidence reference. The reason for rejection or an `uncertain`
verifier verdict is in the run-local `evidence.json`, which the plan API does not
expose. So for `rejected_current` the output states `causeTyping: not_available` and
the action sends the lead to the retained evidence. No cause is inferred from trace
text, activity text or an error string (section 8).

### 5.5 Current versus historical decision

A decision is current only if all hold: the node's work is `done`; the node has an
attempt id; the decision's attempt id, attempt epoch and content revision equal the
node's; the node's effective acceptance equals the decision; the attempt's content pin
equals the node's content revision; and the node still matches the expected fence. The selected attempt must also match
scope `current`, attempt ID, epoch and current content pins. Task and decision artifact
views must both be `shown`, safely projected, nonempty and exactly equal. A mismatched
or withheld artifact never yields `accepted_current`. These are recorded metadata
checks, not authenticated actor provenance or proof of source integration.
A decision with a strictly older positive epoch is `decision_historical` (doc 13:
history, never this attempt's outcome). Anything else not current is `decision_stale` or
`inconsistent`. An older acceptance is never reported as accepted.

### 5.6 Host reconciliation (when supplied)

`owner` is derived from the projected lifecycle and the current node id:

- `owner_dispatching_this_node`, `owner_dispatching_other_node`,
  `owner_idle_between_nodes`, `owner_stop_requested` (a request, not a stop),
  `owner_unverified`, `owner_gone`, `owner_exited`, `no_host`, `host_mismatch`,
  `not_supplied`.

`uncertainEffects` is true when the journal reports an unresolved intent, an
uncertain launch or stop, or a malformed record. If an `expected.launchId` is given it
must equal the host's launch id, otherwise the fence is `mismatch` on `owner`.

### 5.7 Recommendation

Actions form a closed set; each has an authority and `automaticAllowed: false`.

- `none` (authority none): `accepted_current` with no uncertainty, or `no_attempt`.
- `wait_and_reobserve` (none): `in_flight` with `owner_dispatching_this_node`, or with
  the host not supplied (code `host_not_supplied`; no conclusion is drawn).
- `reobserve_then_escalate` (none, then operator): availability fault. Re-run at most
  3 times, at least 5 s apart, then escalate. This is stateless advice, not a loop.
- `lead_review_required` (lead): `awaiting_review`, `decision_historical`,
  `decision_stale`.
- `repair_observer_or_contract` (operator): `bound_exceeded`, `contract` and
  `unrecognized` faults. A separate repair task; no model retry against the attempt's
  existing inputs.
- `operator_decides_new_attempt` (operator): `rejected_current`, `pins_stale`,
  `cancelled`. A new attempt needs an explicit supported state or content change.
- `escalate_operator` (operator): `in_flight` with an owner that is gone, unverified,
  exited, absent or on another node; `inconsistent`; `config` and `not_found` faults.
  The summary says: inspect PlanStore; do not reset or relaunch.
- `reconcile_uncertain_effects` (operator): `uncertainEffects` true. It takes precedence
  over everything except a fence mismatch or invalid input, and it keeps every item in
  `forbidden` in force. Reconcile only by the exact matching exited launch id or an
  explicit operator inspection that preserves the original uncertainty (doc 16, 3).
- `stop_and_reread_authority` (operator): fence `mismatch`. No recommendation is made
  about the observed attempt, which is not the expected one.

Precedence: invalid input, fence mismatch, observation failure, `stale` consistency
(`reobserve_then_escalate`), uncertain effects, then the attempt classification.

`partial` consistency (for example `trace_capped` or `trace_integrity_unverified`) does
not block classification, because decision and identity fields come from the strict plan
view. It adds the reason codes and sets the evidence completeness to `partial`.

### 5.8 Implemented interface

`extractAssessmentInput({ expected, response, host? })` accepts the existing typed
attempt-progress service result, selects bounded metadata and returns a `Result`.
`extractHostInput` selects the optional supplied host projection. `parseAssessmentInput`
strictly parses bounded UTF-8 replay bytes. `assessRecovery` returns the deterministic
assessment, and `renderAssessment` presents the same facts as fixed human text.
`assessmentExitCode` maps a valid assessment to 0 or 4.

Unknown response codes and oversized metadata lists are refused, not silently
converted into complete evidence. Signed safe native exit codes are valid metadata
and do not determine a worker/source outcome. Trace citations bind to the selected
attempt; they never point at a different attempt on the same node. A supplied owner
without root or launch identity is unverified. State, attempt and artifact identities
remain available in both JSON and human output.

### 5.9 CLI

`npx tsx scripts/assessRecovery.ts --root <guid> --node <guid> --attempt <id|none>
--epoch <n> --content <n> [--launch-id <hex32>] [--host-status <file>] [--replay
<input.json>] [--cycles 1..6] [--interval-ms 5000..60000] [--json]`

- Live mode builds `createAttemptProgressService(HEKATE_PLAN_API_URL)`, the same
  service the server route uses, so the assessment and the panel share one code path.
  The URL must pass `planApiBase` (literal loopback http, no credentials). No bridge
  token, no cookie and no browser state are read.
- `--replay` reads one input object and makes no request.
- Each cycle is an independent fresh observation. Explicit cycles continue for
  `wait_and_reobserve` or `reobserve_then_escalate`, and end on other recommendations. There is no cross-cycle inference and
  no state between runs. Cadence is finite: at most 6 cycles, at least 5 s apart, at most
  60 s in total (the deadline can end fewer cycles; each observation receives only
  the remaining time, and late results are discarded), matching the existing Watch bounds in doc 16 section 5.
- Exit codes follow `agentStalls`: 0 only when the action is `none`, 4 for any other
  valid assessment, 1 for a refusal (including the deadline), 2 for a usage error.
- It writes nothing to disk. The lead redirects stdout to external evidence storage.

## 6. Clock domains, bounds, privacy, idempotence

**Clocks.** Three domains are never mixed:

- `observedAt`: ChatAgent process wall clock at the end of one observation
  (`roleObservation.ts:770`). The plan projection has no Hekate time (doc 13).
- Trace `tMs` and host `heartbeatAt` / `startedAt` / `exitedAt`: Hekate-side values.
  The classifier does not compare them with each other or with `observedAt`.
- The assessing process clock: used only by the CLI to space cycles. The pure function
  receives no `now` and decides nothing by elapsed time.

No state is derived from age. Staleness is the observer's `consistency` and the fence,
both recorded facts.

**Bounds.** Observation: 10 s, 8 GETs, 4 MiB (`ATTEMPT_PROGRESS_LIMITS.observer`).
Input at most 64 KiB; output at most 16 KiB; at most 32 reasons and 16 citations; the
CLI at most 6 cycles within 60 s with a hard stop at the deadline plus one second.

**Privacy.** Output contains GUIDs, attempt ids that match the existing id pattern,
integers, enums, digest-shaped refs, evidence sha256 citations, canonical relative API citation paths and fixed template text.
It never contains worker statements, tool inputs or results, prompts, stderr, free
reason or error strings, absolute URLs, filesystem paths or credentials. Unlisted keys in any input are
dropped at extraction, not echoed. Unknown reason values become the fixed code
`UNRECOGNIZED`; they are never copied. Citation paths must match the existing bounded
plan/node/events/trace GET routes for this exact subject; a supplied path is not trusted.

**Idempotent non-mutation.** Live mode issues GET requests only, through the observer.
The same input bytes produce byte-identical output. The pure function reads no clock,
random source, file or network. Nothing is claimed, released, stopped, launched or
written.

## 7. Native prerequisite (separate, not part of this task)

The plan API cannot say why a decision was `rejected`, nor that the verifier ended
`uncertain`. Those causes exist as typed values in Hekate (`accepted | rejected |
uncertain` with a `why` code) but only in the run-local `evidence.json`; the dispatch
status the host projects omits the native `lastRun` and `detail`. Until a typed export
exists, the assessment reports `causeTyping: not_available`.

If the lead wants cause typing, scope it as its own two-repository prerequisite with
separate review and acceptance: (a) a Hekate change that exports a closed terminal
classification (for example `verifier_uncertain`, `verifier_rejected`,
`worker_failed`, `pre_claim_refusal`) by allowlist, without prompts or free text; and
(b) a ChatAgent change that projects it through the dispatch status. Neither is
required for the first increment, and neither is to be mixed into this task.

## 8. Frozen tests

The oracle is `tests/unit/recoveryAssessment.test.ts` over fixtures in
`tests/fixtures/hekate/recovery-assessment/`. Fixtures are derived from the strict
plan-view schema and the real response shapes already in `tests/fixtures/hekate/`,
labelled synthetic where edited. The retained CA-ISSUE-035 metadata-only diagnostic
(`ready-plan-handoff-001/observer-schema-diagnostic.json`) may seed the `INVALID_RESPONSE`
case only if the lead confirms it holds no worker payload.

Cases (each asserts finding, action, authority, exit class and the absence of any
`forbidden` operation):

1. Outage versus source failure: each availability reason gives `faultClass`
   `availability`, `workerSource: unobserved`, and never a rejection or a retry
   recommendation. A real-shape `INVALID_RESPONSE` (the CA-035 class) gives `contract`
   and `repair_observer_or_contract`. A recorded `rejected` decision gives
   `rejected_current` with `causeTyping: not_available`. The two are never the same
   finding.
2. Every reason in the fixed set maps to exactly one class; an unknown reason is
   `unrecognized`; a reason string carrying a sentinel is never echoed.
3. Fence: each of root, node, attempt id, epoch, content revision and launch id altered
   in turn gives `stop_and_reread_authority` with that field named; a newer epoch than
   expected is a mismatch, not a new attempt to assess.
4. Decision matching: accepted at the current epoch, content and attempt is
   `accepted_current`; accepted at an older epoch is `decision_historical` and is never
   reported accepted; same epoch with a different content revision or attempt id is
   `decision_stale`; a decision epoch above the node's is `inconsistent`.
5. Content: an attempt whose pin differs from the task's revision is `pins_stale`.
6. Pre-claim versus claimed: `todo` with no attempt and the expected epoch is
   `claim: none_since_fence`; the same with a host `spec_pending` stop is still decided
   by the plan node; a node with an attempt id is `claimed_*`, split by claim linkage;
   `in_progress` alone never asserts a started worker.
7. Unknown outcomes: an uncertain launch or stop, an unresolved intent or a malformed
   journal record gives `reconcile_uncertain_effects` even beside `accepted_current` or
   `in_flight`, with the full `forbidden` list. An exited owner with the exact matching
   launch ID does not clear supplied journal uncertainty in this pure classifier;
   only the actual adapter reconciliation or explicit operator inspection can do so.
8. Owner: `in_flight` with a gone, unverified, exited, absent or other-node owner gives
   `escalate_operator`; with the owner dispatching this node, `wait_and_reobserve`;
   with no host, `wait_and_reobserve` plus `host_not_supplied` and no inferred
   liveness; `stop_requested` is never read as stopped.
9. Consistency: `stale` gives re-observation, not a classification; `partial` still
   classifies and records the reasons.
10. Review: `done` with no decision is `awaiting_review` and `lead_review_required`.
11. Output for every case: contains no `alive`, `idle`, `stalled`, `answered` or
    `healthy` state; `automaticAllowed` is `false`; `workerLiveness` and
    `usefulProgress` are `unknown`.
12. Privacy: a sentinel placed in activity text, a prompt, a trace record, a free
    reason, a host detail and an unlisted key appears nowhere in the extracted input,
    the JSON output or the human text. The extraction drops `activity` and
    `aiSnapshot`.
13. Determinism and non-mutation: inputs are deep-frozen; the same input yields
    byte-identical output twice; the clock, `Math.random`, `fs`, `child_process` and
    `fetch` are replaced by throwing doubles for the pure function.
14. Bounds: an oversized input, more than 32 reasons, a duplicate key, a non-integer
    number and a `__proto__` key are `input_invalid` with a non-echoing code.
15. Closed sets: every action has an authority and `automaticAllowed: false`; the
    summary comes only from the fixed templates.

CLI tests (lead-built, section 10): a fake loopback plan API records that only GET
requests occur, at most 8 per cycle, against the documented plan-contract paths; exit
codes 0, 4, 1, 2; a closed port gives `availability`; the deadline hard stop; no file
is written; the token and cookie are never read; replay makes no request.

**Old-source negatives.** The oracle must fail by assertion, not by import error, at
the prep commit (section 9), whose stub returns `input_invalid` for every input. It
must also reject each of these retained mutants of a correct implementation, each as a
named test failure:

- treats any 503 or `INVALID_RESPONSE` as a worker or source failure;
- treats a worker `rejected` decision as an observer fault;
- reports an older-epoch acceptance as accepted;
- ignores the content pin or the attempt id when matching a decision;
- ignores a fence field (one mutant per field);
- calls `in_progress` a started or live worker;
- infers pre-claim from a host code instead of the plan node;
- drops the uncertain-effects precedence;
- recommends or permits an automatic retry or relaunch;
- reads `activity`, `aiSnapshot` or any free string into the output;
- reads the wall clock or `Math.random`;
- accepts an input with a duplicate key or a float;
- reads a stopped owner from `stop_requested`.

## 9. The next task

**Title (draft):** Add the read-only recovery assessment that separates observation
failures from worker and source outcomes (CA-ISSUE-004, first bounded phase).

**Node:** `af690ee2-4e2e-5043-a71a-c0d126030971`. The task text, name and acceptance
are authored in Hekate with the profile in `docs/contracts/hekate-task-profile.json`;
this document supplies content, not the pin.

**Worker scope:** `src/integrations/hekate/recoveryAssessment.ts` and the bounded
`scripts/assessRecovery.ts`: the exported
types, the `extractAssessmentInput` function, and the pure `assessRecovery` function.
No runner, verifier, server or UI change; immutable contract and oracle files remain frozen.

**Prep (lead, before the task is authored):** a deliberate commit that adds the
module with the exact exported types and a conservative stub returning `input_invalid`
for everything (the doc 15 precedent), plus the frozen oracle and fixtures. The task
base is that commit. Oracle files are pinned by sha256 in the task spec.

**Acceptance oracle:** the cases in section 8 pass at the artifact and fail by
assertion at the base; the artifact's diff touches only the allowed file; typecheck,
the full suite and `npm run docs:check` pass under the pinned toolchain.

**Check commands** (the spec's pinned steps, not hand-typed; shown for review):

- `npx vitest run tests/unit/recoveryAssessment.test.ts`
- `npx tsc -p tsconfig.json --noEmit`
- `npx vitest run`
- `npm run docs:check`
- lead, independently, in a clean worktree at the exact artifact SHA:
  `npm run format:check` and `npm run lint`

Formatting follows the profile; formatting-only commits stay separate from functional
ones (`AGENTS.md`).

**Not in the worker task:** roadmap and runbook updates, any UI or route, or the
native prerequisite. The lead freezes meaningful classifier and CLI tests before
authoring; both pure logic and the usable bounded CLI must pass for this task to be accepted.

## 10. Auditability and integration

Each link records its own identifier and how it was checked; none stands in for
another:

1. Task: node id, content revision, spec sha256, oracle file hashes, prep commit.
2. Attempt: attempt id, epoch, claim key, executor reference.
3. Source SHA: the 40-hex artifact, its parent equal to the prep commit, and a diff
   confined to the allowed file.
4. Independent checks: command, exit code, counts and output hash, run by the lead in a
   clean worktree, separate from the native verifier report and its digest.
5. Decision: the PlanStore record (decision, attempt id, epoch, content revision,
   artifact, evidence reference), read back through the plan API. Acceptance is not
   integration.
6. Integration: the lead merges the exact artifact (path-limited blob equality with
   the artifact checked) as a `feat:` commit; the CLI is part of the same exact native artifact; documentation status updates
   follow separately; the roadmap records current work and
   limitations (`AGENTS.md`). Rejected or superseded artifacts are not merged.
7. Reload: a controlled restart of the product from the integrated commit, then an
   explicit read of the same task, attempt, epoch, content and decision. A reload sends
   no execution request and is not persistence.

Evidence stays outside the repository under the existing run-evidence directory
convention (`D:/hekate-coordinator/runs/`), with sanitized metadata only and no
persistent public raw log. A wrapper that launches or pins must stop on a nonzero child
exit and the lead must read back the pin before any ownership change (CA-ISSUE-036).

## 11. Live read-only rehearsal

Run only after integration and reload. Every step is a read; none uses a guessed
endpoint. The plan-contract paths are those `roleObservation.ts` issues; the product
routes are the two in `src/server.ts` named in section 4.

1. Final accepted task `21dcea12-cb65-54cf-8581-e2f896490139` with the fence epoch 4,
   content revision 3, attempt `pilot-11c9f94a6bef-r1`: expect `accepted_current`,
   action `none`, exit 0.
2. The same task with an epoch 3 fence: expect `fence mismatch` and
   `stop_and_reread_authority`, exit 4. Epoch 3 is the non-model operator preparation
   and is not this attempt.
3. Backlog task `af690ee2-…` before it is launched: expect `no_attempt` with
   `claim: none_since_fence`.
4. Observer outage: point the CLI at a loopback port with nothing listening (chosen by
   binding and closing a free port, not guessed). Expect `availability`, `unobserved`,
   exit 4. The live plan API and host are not touched or stopped.
5. UI cross-check: in the lead's own paired browser session, open the existing attempt
   progress panel for step 1's task and compare its identifiers (node, attempt, epoch,
   content revision, artifact, decision) with the CLI output. The panel does not show
   the assessment yet; this checks that both read the same record through the same
   service. The lead supplies a host status read from their authorized session as the
   optional host input and it is labelled `supplied`.

## 12. Lead review and prerequisite

The lead retains the original Athena proposal separately and accepts only this reviewed
contract. The live prerequisite check exposed CA-ISSUE-037: the genuine untouched
backlog has empty events with `historyStartsAtSeq: null`, which the existing observer
incorrectly rejects. The C# EventPage and upgrade tests explicitly support this null.
An actual separate Hermes repair must pass old-source negatives and a real pristine
backlog read before this contract uses the unattempted task as a live reference.
Planning is not implementation acceptance, and this read-only phase does not close
CA-ISSUE-004's unattended recovery requirement.

## 13. Ordered implementation checklist

1. Lead reviews and chooses the final contract; record any change to sections 5-9.
2. Pin the Hekate revision and re-verify the section 4 references against it.
3. Prep commit: stub module with the exported types, frozen oracle and fixtures;
   confirm the oracle fails at the base by assertion only.
4. Confirm `af690ee2-…` is the first ready node in sibling order in the current plan
   view; otherwise the dispatcher stops at an earlier unprepared node (`spec_pending`).
   Do not prepare or touch the other backlog tasks.
5. Author the single-task spec with `task_author` and the task profile; pin it, check
   the exit status and read back the pin and content revision (CA-ISSUE-036).
6. Run the prepared preflight and review the cache setting (`npmCacheDir`) and finite
   host limits. Check host; resolve any unknown outcome first (doc 16, 3).
7. Start the prepared plan once from the product UI. One feature at a time.
8. Read exact attempt progress while it runs; liveness and progress remain unknown.
9. On a result: verify the artifact SHA, parent and allowed-file diff; run the lead's
   independent checks in a clean worktree; wait for the recorded decision on this
   attempt and artifact.
10. Integrate the exact artifact; with the independently checked bounded CLI; update the runbook and roadmap limitations.
11. Controlled reload; run the section 11 rehearsal; store sanitized metadata outside
    the repository.
12. Record the task, attempt, source SHA, checks, decision, integration and reload
    identifiers as in section 10. Only then consider the next backlog task.

## 14. Execution mode and evidence boundary

The lead has selected supervised API/CLI execution for the first implementation:
one explicit PlanStore claim for the existing task, a finite CLI worker in an
isolated source worktree, and independent lead checks/review before any recorded
acceptance or exact merge. The retained input manifest pins the reviewed planning
artifact, source base and prompt hash. The proposed prepared TaskSpec path in
sections 9 and 13 remains a future automation path; it was not executed for this
implementation. Do not substitute manual checks for a claimed native verifier pass.

The native dispatcher yields on an independently in-flight task; a separate finite
LocalStore API owner keeps the retained store available under its existing exclusive
advisory lock. The native dispatcher's exited status and the API owner's heartbeat
remain separate evidence. The supervised CLI has local retained output and process
identity evidence, but no native captured attempt trace is claimed. A missing trace
must remain unknown/partial in the product, never inferred from the external PID.

## 15. Limitations

- One-shot and on demand. Nothing detects a stall by itself, wakes anyone, or acts.
- The assessment has no time thresholds. "Idle" is not decided; only recorded states
  are reconciled. Worker liveness and useful progress remain unknown.
- The cause of a rejection or an `uncertain` verdict is not available until the native
  prerequisite in section 7 is delivered; the assessment says so instead of guessing.
- The host input is supplied, not fetched or authenticated by the CLI.
- `INVALID_RESPONSE` cannot be attributed to consumer or producer.
- Claim linkage is cross-source correlation, not authenticated actor provenance.
- Lead-side idleness (bridge assignments) is not part of this assessment.
- The assessment is not shown in the browser or any server route yet.
- Checks establish this module's behaviour only; they establish no persistent recovery,
  schedule, AI wake-up, baseline or service-level objective.
