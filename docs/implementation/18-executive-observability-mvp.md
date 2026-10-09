# 18 — Executive observability MVP (planning contract)

Status: **lead-reviewed implementation contract; implementation remains unverified.** Written
by Athena for management task execution under root `29141a72-9c9a-54f8-a357-fb6db74d84d9`.

## Purpose and priority

The operator needs one high-level page that shows outcomes, work under way, and where a human
or an AI should prod, then drills initiative → tasks → current attempt/evidence **in place**,
without navigating away. This is the highest-priority next feature. ChatAgent hosts the first
presentation, but the foundation is a **shared read-only data API** any other front end can use.

Estimate (provisional planning assumption, not a measured forecast): a first useful slice in
**2–4 focused hours today**; live acceptance follows after lead review. If the slice does not
fit, cut per [Deferred](#deferred), never per the safety rules.

## Facts this contract relies on

- All 7 original application tasks are accepted/integrated under root
  `b556d4ce-b813-50fa-8ac5-3633297518a6`.
- The 8-task reliability backlog root `d6450921-6673-5535-b495-07cc165ada2d` has its first
  read-only recovery phase accepted at exact source `34aa761667ceeca311a3b0a1910c948b713847eb`;
  the other 7 are TODO and unprepared.
- Management root `29141a72-9c9a-54f8-a357-fb6db74d84d9` holds the planning, repair and MVP tasks.
- **PlanStore acceptance does not prove source integration or deployment.** The view reports
  recorded acceptance; it never infers integration, deployment or real-world goal completion.
- Liveness is unknown. A host heartbeat is not worker useful progress. The recovery module is a
  read-only assessment, not an unattended service.
- This management task runs lead-supervised (API claim, bounded CLI, external evidence,
  independent lead review), not native trace/TaskSpec. Its drill-down will therefore show
  _no worker trace_, and that must render as a plain fact, not an error.

## Existing seams reused (no new framework)

- `fetchCoordinationStatus` / `coordinationStatus` in `src/integrations/hekate/devCoordination.ts`:
  strict JSON, loopback-only base (`planApiBase`), no redirects, deadline, byte cap, code-only
  errors. Its `LeafStatus`, `PlanProgress` and blocker shapes are the source of truth.
- `GET /development/plans/:rootId/nodes/:nodeId/progress` (`attempt-progress/v1`), already
  operator-only and opt-in, for on-demand drill-down.
- `ROUTES` in `src/auth/routePolicy.ts`, the `renderHomePageHtml` flags in `src/ui/homePage.ts`,
  and the inert-`textContent` rendering style of `planStatusPanel.ts` and `attemptProgress.ts`.

## Trusted configuration

- Server option `executiveOverview?: { roots: ExecutiveRoot[] }` on `createChatServer`, requiring
  `planApiUrl` (loopback, validated at construction by `planApiBase`). Absent: the route answers
  `404 EXECUTIVE_OVERVIEW_DISABLED` and the home page is byte-identical to today.
- `ExecutiveRoot = { rootId: GUID; label: string (1..60); goal?: string (1..200) }`.
- Startup wiring reads two environment variables, documented in `docs/runtime-reference.md`:
  `HEKATE_EXECUTIVE_OVERVIEW=1` (explicit enablement) and `HEKATE_EXECUTIVE_ROOTS_JSON`
  (JSON array of `ExecutiveRoot`). Also requires `HEKATE_PLAN_API_URL`.
- Validation is strict and fails startup with a stable code (`INVALID_EXECUTIVE_ROOTS`), never
  echoing the value: 1..8 entries, unknown keys refused, lowercase GUIDs, no duplicate root,
  no control characters in labels/goals, enablement without roots or without a plan URL refused.
- No browser-supplied root, URL or label. No discovery or crawl. The browser can only ask for the
  fixed overview, and for progress on `(rootId, nodeId)` pairs the overview returned.
- Deployment inventory includes the three real roots above, labelled by the operator (for example
  "Application delivery", "Reliability backlog", "Management/MVP"). **Goals are operator-written
  configuration**, displayed as "Goal (configured)", and are never presented as verified results.

## Shared DTO — `executive-overview/v1`

`GET /development/executive/overview`, no query, `Cache-Control: no-store`. New module
`src/integrations/hekate/executiveOverview.ts` exports the DTO type, a pure
`projectRoot(status, config)` and `collectExecutiveOverview(...)`.

```ts
interface ExecutiveOverview {
  schema: "executive-overview/v1";
  generatedAt: string; // ChatAgent server clock, ISO
  atomic: false; // roots are read independently; timestamps are not one snapshot
  roots: ExecutiveRootView[]; // configured order, always one entry per configured root
}
interface ExecutiveRootView {
  rootId: string; label: string; goal: string | null; // goal is configured, not verified
  observedAt: string; // when this root's read finished
  status: "ok" | "invalid" | "unavailable";
  reason: DevCoordinationErrorCode | null; // unavailable only; code, never message or URL
  invalidCodes: { code: string; nodeId: string | null }[]; // invalid only, max 20
  planState: PlanProgressState | null; // from existing PlanProgress
  acceptedCounts: { accepted: number; total: number } | null; // accepted leaves of all leaves
  counts: Partial<Record<LeafState, number>>;
  prods: Prod[]; // see below, max 8 per root, ordered
  tasks: ExecutiveTask[]; // max 100 per root
  tasksOmitted: number;
}
```

- `acceptedCounts` is a count of PlanStore-accepted leaves, never a percentage, effort or ETA. The UI
  states "accepted in PlanStore; source integration not proven by this view".
- `ExecutiveTask` carries the existing `LeafStatus` fields unchanged in meaning: `nodeId`, `name`,
  `state`, `attemptPins`, `gatesHold`, `upstreamChanged`, `scope`, `contentRevision`,
  `stateRevision`, `attemptId`, `attemptEpoch`, `executorRef`, `artifactRef`, the full
  `acceptance` record with `acceptanceHistorical`, and `blockers` (id, name, gate, reason, max 10).
  Add `prod` (one enum value, below), `checkpointGate` (`accepted`, `rejected`, `awaiting_review`, `not_verified`) derived only from the current projected state, and `budgetEvidence: "not_reported"`. A historical decision is never a current checkpoint gate. Text is clipped to 200 characters. Nothing else crosses.
- Historical decisions stay marked historical; a rejected or older-attempt decision is shown as
  history, never as the current outcome. `executionAcknowledged` stays `"unknown"`.
- Task order: needs-human states first, then blocked, ready, in progress, accepted, cancelled;
  ties by name then id. No hierarchy is invented: the existing projection lists leaves only.

### Prods (fixed vocabulary, no generated prose)

`Prod = { kind, count }` and a per-task `prod`, from a closed enum computed in code:

| Leaf state / condition           | Prod kind                 | Who                      |
| -------------------------------- | ------------------------- | ------------------------ |
| `review_pending`                 | `review_needed`           | human (lead review)      |
| `rejected`                       | `decide_rework`           | human                    |
| `stale`, or `attemptPins: stale` | `refresh_inputs`          | human or AI planner      |
| `blocked` (with blockers)        | `resolve_dependency`      | human or AI planner      |
| `ready`                          | `claim_available`         | human or supervisor      |
| `in_progress`                    | `confirm_worker_liveness` | human (liveness unknown) |
| root `inconsistent` or `invalid` | `investigate_plan_state`  | human                    |
| `accepted`, `cancelled`          | `none`                    | —                        |

`ready` means "readiness rules satisfied and claimable". Preparation, executable TaskSpec and worker start are **not established by this projection**. Say "Ready to claim; execution preparation unverified" rather than assert every ready task is unprepared.

## Collector behavior

- Reads configured roots concurrently with the existing `fetchCoordinationStatus`; one root's
  failure never changes another's result (`Promise.allSettled`). Per-root timeout 5 s, overall
  deadline 8 s, per-root upstream bytes 2 MiB, 100 tasks per root, 10 blockers per task,
  serialized response capped at 1 MiB (drop trailing tasks and raise `tasksOmitted`, never
  truncate JSON). Bounds are named constants shared with the UI and tests.
- A thrown `DevCoordinationError` becomes `status: "unavailable"` with its code only. An
  `invalid` projection keeps its readiness codes. Anything else becomes `reason: "UNAVAILABLE"`.
- The route answers `200` whenever the overview itself is well-formed, even if every root is
  unavailable, so partial results are always visible. `503` is reserved for the collector
  failing as a whole. The server stores no state; staleness is a browser concern.
- No POST, no claim/finish/decide, no dispatch interaction, no worker or trace read in this route.

## Route and authentication

- `ROUTES` gains exactly one rule: `rule("GET", "/development/executive/overview", "operator")`.
  Guest → 401, expired session → 401, client-only → 403 `OPERATOR_REQUIRED`, before any
  upstream read. POST/DELETE → default-deny 404. The `httpAuth.test.ts` route-inventory probes
  derive from `ROUTES`, so the new rule must appear there and the inventory in
  `docs/implementation/14-local-authentication.md` updates in the same change.
- Drill-down reuses the existing progress route (operator-only). The browser only requests pairs
  taken from the last overview. Narrowing that route to configured roots is deferred; it is
  operator-gated and read-only today.

## Inline UI

- A new `src/ui/executiveOverview.ts` (`executiveOverviewHtml()` / `executiveOverviewScript()`),
  rendered first on the home page behind a new `executiveOverview` flag appended to
  `renderHomePageHtml`. Default false, so the general chat flow and existing panels are
  byte-identical. The route stays the authority; the page itself is public, as today.
- Layout, all on one page: header with generated time and a **Refresh** button; one
  `<details>` card per root (label, configured goal, plan state, accepted task counts, counts, prods);
  inside it task rows ordered as above; each task is a nested `<details>` showing ids, revisions,
  claim (attempt, epoch, executor), pins, blockers, historical/current decision, artifact refs, checkpoint gate and unavailable budget evidence.
- **Expanding a task issues one GET** to the existing progress route (bounded: 10 s deadline,
  1 MiB, one in flight per task, max 3 concurrent) and renders a compact subset in place:
  `consistency`, task work/attempt/epoch, selected attempt scope, trace status/integrity/record
  count, acceptance decision and evidence refs, evidence citations (max 8), worker statements
  (max 5, labelled unverified claims). An absent trace shows "No worker trace recorded for this
  task (liveness unknown)". It is not an error.
- External Hekate links appear only if a known valid route is supplied by trusted configuration;
  otherwise plain identifiers. No link is fabricated.
- Every label, goal, task name, reason, ref and statement is written with `textContent`; no
  `innerHTML`, progress URLs are constructed only from validated root/node GUIDs; no arbitrary data URL is followed, no inline handlers from data.
- **No request on load or reload.** The page loads empty with "Press Refresh". Manual refresh is
  the MVP; no polling. The only automatic GET is task expansion. There is no POST anywhere.

### Failure, stale and scope rules

- Per-root states are rendered distinctly: ok, invalid (codes), unavailable (reason code), and
  "omitted n tasks". One unavailable root never hides the others.
- A failed refresh keeps the last good overview, scoped to the same operator/conversation scope,
  under a visible banner "Refresh failed; showing data last read at <browser time> /
  <generatedAt>". A scope change (user or conversation inputs) discards everything.
- A drill-down is bound to `(rootId, nodeId, attemptId, attemptEpoch, contentRevision, stateRevision)` from the
  overview. A later refresh that changes the binding, or any drill-down failure, replaces the
  evidence with an explicit "unavailable / changed, re-expand" line. Old attempt evidence is never
  left looking current. A late response for a superseded request is dropped.
- The server clock (`generatedAt`, `observedAt`) and the browser clock are labelled separately.
  The cross-root timestamp is explicitly non-atomic.

## Acceptance cases (frozen tests assert behavior, not strings of the implementation)

1. **Mixed roots:** three configured roots, one ok, one invalid, one upstream 500; all three
   present, in configured order, each with its own status; the 500's body never appears.
2. **State vs prod:** fixture leaves in `review_pending`, `stale`, `rejected`, dependency-blocked,
   and `ready`; each maps to the table's prod; `ready` is never labelled prepared/running; an
   older-attempt accepted decision renders as historical, not accepted.
3. **Unavailable root:** timeout, oversize and invalid-contract produce `unavailable` + code, with
   no upstream URL, body or freeform message.
4. **In-place nesting:** root → task → evidence on one page, with `location` unchanged and no
   navigation; the expanded task shows ids, revisions, claim and the typed decision.
5. **Current attempt:** expanding a task issues exactly one GET to the expected progress path;
   a changed `attemptId`/epoch/content revision/`stateRevision` on refresh drops the open evidence.
6. **Malicious names:** `<img onerror>`, `</script>`, very long and control-character values in
   label, goal, task name, reason and statements render inert and clipped; nothing executes.
7. **Refresh failure:** after a good load, a failing refresh keeps the view under the stale banner;
   a failing drill-down never leaves its previous evidence presented as current.
8. **No worker evidence:** a task with no trace or no attempt shows the plain "no worker trace"
   statement and keeps liveness "unknown".
9. **Zero POST / load execution:** a request log across load, reload, refresh and every expansion
   contains only `GET`s to the overview and progress paths; load and reload issue none at all.
10. **Auth:** guest 401, expired 401, client-only 403, operator 200; denied calls never reach the
    upstream; POST and unknown sibling paths do not leak; `ROUTES` inventory test passes.
11. **Startup config:** malformed JSON, 0 or 9 roots, duplicate or uppercase GUIDs, extra keys,
    over-long label, missing plan URL, and enablement without roots each fail startup with a
    stable code that does not echo the input. Non-loopback upstream is refused as today.
12. **Scope reset:** changing user or conversation clears overview, last-good and open evidence.
13. **Unchanged chat:** with the option absent, the home page bytes and chat flows are unchanged.

## Implementation clarifications

These record behavior the first slice fixed where the contract above left room. They add
no capability.

- `ExecutiveTask` also carries `blockersOmitted` (blockers beyond the 10 shown, counted
  exactly) so a clipped list is never silent.
- A `stale` state or `attemptPins: stale` yields `refresh_inputs` for every task that is not
  accepted or cancelled, taking priority over the other state prod.
- The UI validates the overview and every progress response against a closed schema before
  rendering; a body that only borrows the schema name is rejected. A task read must also
  match the overview's `(rootId, nodeId, attemptId, attemptEpoch, contentRevision,
stateRevision)`; otherwise the evidence is replaced by an "unavailable / changed" line.
- Collapsing a task aborts its read and clears its evidence; expanding always issues a fresh
  read. At most 3 reads are in flight; a fourth shows a "too many" line without a request.
- A failed refresh keeps the last good view and any open evidence under the stale banner. A
  successful refresh keeps evidence only for tasks whose binding is unchanged.
- Executable ready/prepared status, worker liveness and budget are never inferred. `ready`
  reads "Ready to claim; execution preparation unverified".

## Tests and verification

- Unit: `tests/unit/executiveOverview.test.ts` (projection, prods, bounds, config parsing),
  `tests/unit/executiveOverviewUi.test.ts` (script serialization, inert rendering, scope).
- Integration: `tests/integration/executiveOverviewHttp.test.ts` (mixed upstreams, auth, no
  POST), extended `httpAuth.test.ts` inventory.
- Browser: `tests/browser/executiveOverview.spec.ts` (nesting, stale banner, request log).
- The tests are frozen before implementation review and must not be weakened to pass.
- The lead runs `npm run format`, `npm run lint`, `npm run docs:check`, the focused suites
  below, and an appropriate full verification. Before acceptance/integration the lead performs
  real paired product UI checks of the three live roots. No result is claimed in this document.

## Deferred (not in this slice)

Unattended supervision, recovery or any service; polling or push updates; timelines, charts,
scheduling, effort or percentage metrics and baselines; auto-discovery of projects; browser
root/URL entry; AI-generated prose or summaries; container/subtree hierarchy; trace or worker
stream reading; any POST (claim, finish, decide, dispatch); narrowing the progress route to
configured roots; verification of source integration or deployment; deep links to Hekate.

**Source integration and deployment are unknown** for every accepted task. The MVP may display
PlanStore acceptance only. A later slice may add a trusted integration marker.

## Next implementation task

- Scope: the DTO, collector, config parser, one GET route, one inline UI module, docs and tests above.
- Files: new `src/integrations/hekate/executiveOverview.ts`, `src/config/executiveOverviewConfig.ts`,
  `src/ui/executiveOverview.ts`; edits to `src/server.ts`, `src/auth/routePolicy.ts`,
  `src/ui/homePage.ts`; docs `14-local-authentication.md`, `runtime-reference.md` and the roadmap.
- Useful commands:
  - `npx vitest run tests/unit/executiveOverview.test.ts tests/unit/executiveOverviewUi.test.ts`
  - `npx vitest run tests/integration/executiveOverviewHttp.test.ts tests/integration/httpAuth.test.ts`
  - `npx playwright test tests/browser/executiveOverview.spec.ts`
  - `npm run format`, `npm run lint`, `npm run docs:check`, then the full suite.

### Checkpoint management and delivery gates

Manage a coherent, verifiable change rather than every model tool call. Between gates,
observe bounded process/ownership/budget tripwires. Preserve failed work and evidence
in its isolated worktree; a verifier outage is not a source rejection or grounds to
spend another model retry. Model self-report does not satisfy a gate.

The MVP models a task's current recorded gate and explicitly unavailable budget
measurement. It does not fabricate consumed turns/cost, expected budgets or integration
proof from task counts, names, elapsed time, host heartbeats or untyped trace text.
The follow-on checkpoint execution task must make expected and hard budgets, tripwire
receipt, independent gate evidence and escalation typed product behavior. Existing
CLI launch envelopes already enforce finite cost/turn/time/output limits externally;
that alone does not establish a maintained checkpoint-management service.

1. **Contract** (15–30 focused minutes): lead verifies source seams, scope and acceptance
   cases and accepts its exact source artifact in Hekate.
2. **Working slice** (60–120 focused minutes): one coherent API/UI commit with meaningful
   tests, independent authentication/schema/browser checks and artifact-bound gate evidence.
3. **Live delivery** (30–60 focused minutes): exact accepted source integrated and real
   paired product UI verified on the three retained roots. Record integration/live evidence
   separately from PlanStore acceptance and revise the forecast from the result.

First useful slice target: today, in a provisional 2–4 focused hours including review.
No measured forecast or promise of unattended work. Re-estimate at each gate; defer
polish and automation rather than broadening this checkpoint.
