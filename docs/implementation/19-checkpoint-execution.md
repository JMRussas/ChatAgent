# 19 — Checkpoint execution and budget record (planning contract)

Status: **lead-reviewed implementation contract; an implementation exists in the isolated
worktree but its tests, lint and live checks have not been run or verified by the author.**
Implementation notes: the argument list is `--print --output-format stream-json --verbose --model <m>
--tools <list> --allowedTools <list>` (plus `--max-budget-usd` only with a configured provider
cap), confirmed against the installed `--help` before the only spawn; the planning artifact below is
otherwise unchanged. Record `rootPid` is set only for `cleanup_failed`. Tripwire code
`authority_changed` and failure code `record_write_failed` are added to the closed enums; the
runner additionally refuses `run_exists` and `record_dir_invalid` without writing a record. Planning task `2f54ab05-7d58-5cc3-aa4f-0bd64c9f684d` prepares implementation task `94438651-ed00-5656-803d-d6097d4a4e40` under management
root `29141a72-9c9a-54f8-a357-fb6db74d84d9`, ready after accepted live delivery `77aca710`.

## Purpose and unit of management

The managed unit is a **checkpoint**: one coherent change, meaningful tests and one artifact, in
an isolated worktree so a retry or discard is cheap. It is not a tool call. Inside a checkpoint
the worker runs autonomously. Between gates only budget, process and ownership tripwires are
watched. There is no per-tool semantic or AI review.

The first executive API/UI (exact `98acbb0`, integrated `a52c1d5`, verified in the actual paired
UI over three roots including native artifact `0d1852940975241dd3367cef4299acf2911e5b86`) shows
the PlanStore-derived `checkpointGate` and `budgetEvidence: "not_reported"`. This increment makes
budget and gate evidence a typed, bounded, optional product input. It is not a service.

## Observed facts and non-claims

- One real Claude worker produced a working executive proposal in about 11.5 minutes for about
  2.89 USD (operator-reported, one sample). The gate then found two Unicode regex parse failures
  and two bad test fixtures (7 tracked lines, CA039). An independent gate found an attempt/decision
  linkage gap that caught three old-source cases (CA040). Failed gates were repaired in place; a
  failed gate does not mean rerun the whole feature, and failed source and checks are preserved.
- **CA038:** the installed CLI configured with `--max-turns 60` reported `num_turns` 97 and 94.
  Equivalence is not proven, public `--help` does not list `max-turns`, and the count of assistant
  stream records differs again from distinct message IDs. This contract therefore never certifies
  the hidden flag, and never treats provider `num_turns` as an independently enforced count.
- "Expected 30 / hard 60 agent turns" is a provisional heuristic, **not** a measured SLO. It is
  restated below in an explicitly defined observable unit and labelled as such in every record.

## Budget unit (frozen)

- Unit id `assistant_message_ids_distinct/v1`: the number of distinct `message.id` values (string,
  matching `^[\x21-\x7e]{1,128}$`) taken from newline-terminated, fully parsed `stream-json` stdout
  objects whose `type` is `assistant`. The same ID repeated across blocks counts once. A trailing
  line without a newline is never counted.
- The implementer first records the redacted field shape (names only) from the read-only smoke
  and freezes the parser to it. If the stream carries no reliable completeness marker, the unit is
  named exactly "distinct assistant message IDs seen" and the word "complete" is not used.
- Expected 30 and hard 60 in this unit are provisional defaults from configuration with
  `basis: "provisional_heuristic"`. The code cap on `hard.units` is 200.
- Provider-reported `num_turns` and `total_cost_usd` (read only from a parsed final `result`
  object) are stored under `providerReported` with `status: "unverified"`. They never feed a
  tripwire, a gate or an SLO. They are kept as a separate counter so divergence stays visible.
- Independent bounds: `hard.wallMs` (code cap 3,600,000), `hard.outputBytes` (stdout plus stderr,
  code cap 32 MiB) and `maxLineBytes` (code cap 4 MiB, default 1 MiB). A provider USD cap, if the
  installed release documents such a flag, is configuration only (`providerUsdCap`). ChatAgent
  adds no observed-cost tripwire in this increment, and the record states
  `cost.enforcement: "none" | "provider_cap_configured_unverified"`.
- A malformed complete line, an oversize line, a missing or invalid ID on an `assistant` object, a
  duplicate JSON key, or an unterminated final line makes the counter **uncertain**. The runner
  stops with `counter_uncertain`, records `counterState: "lower_bound"`, and never guesses
  consumption. Non-assistant objects that parse are ignored. Stdout content is discarded after
  parsing; only the ID set (at most hard.units + 1, never over 201 IDs) and the final-result numbers are kept.

## Seams reused and what stays untouched

- `CliRunner` keeps `answerOnly` and `CLI_AUTOMATION_UNSUPPORTED` exactly. The answer-only adapter
  is not a coding worker, and chat or catalog data never constructs an executable.
- Reused from `src/providers/cli/runner.ts`: the exported `processTreeTerminator` (taskkill `/T /F`
  on Windows, process-group SIGKILL elsewhere), the `shell: false`, `windowsHide`, `detached`
  spawn posture, stdin prompt delivery, `StringDecoder` line splitting, and count-and-discard
  stderr. `observedTreeTerminator` from `claudeAcceptance.ts` is reused by tests only.
- Reused from `src/integrations/hekate/devCoordination.ts`: `fetchCoordinationStatus`,
  `planApiBase`, `LeafStatus`, `DevCoordinationError`. Existing `parseStrictJson` permits safe integers only: use a feature-local bounded duplicate-key/unsafe-key-refusing JSON parser admitting finite decimals for valid provider costs. Schemas still require safe integers for identity, budget and counter fields. Never weaken the plan parser.
- The scoped coding path is a **separate trusted module**, not a mode of `CliRunner`.

## Trusted run input: `checkpoint-run/v1`

A JSON file named only on the operator-invoked command line, at most 16 KiB, strict (unknown keys
and duplicate keys refused). Nothing comes from chat, a catalog, a browser or worker text.

- `runId` (lowercase GUID), `unit`, `profile` (`readonly_smoke` or `coding`).
- `identity`: `rootId`, `nodeId`, `attemptId`, `attemptEpoch`, `contentRevision`,
  `stateRevision`, `executorRef`, and `baseRef` (exact git SHA).
- `executable` (absolute canonical path and exact executable SHA-256 pin; normalize platform separators before canonical comparison), `worktree` (absolute directory whose `.git`
  is a file, i.e. a linked worktree, never the main checkout), `promptFile` with `promptSha256`
  (read as bytes, verified, sent on stdin), `gitExecutable` and its SHA-256 pin (fixed shell-free Git commands only), `recordDir` (absolute, outside the worktree, not
  inside it after `realpath`), `model`.
- `expected` and `hard` as above, `planApiUrl` (loopback, via `planApiBase`).
- **Not configurable:** the argument list and tool allowlist. They are code constants per profile,
  limited to flags documented by the installed release's public `--help`, recorded in a test, and
  fail closed: if a documented flag or tool name cannot be confirmed, that profile refuses to
  start with `profile_unsupported`. `readonly_smoke` allows read and search tools only. `coding`
  allows only `Read,Grep,Glob,Edit,Write`; `readonly_smoke` allows only `Read,Grep,Glob`. No shell, test command, network or MCP tool is granted to the worker; independent tests run outside the worker at the gate. `--max-turns` is not used and nothing relies on it.

## Preflight authority (before any spawn)

One bounded read-only GET through `fetchCoordinationStatus` (existing 5 s deadline, 2 MiB cap)
must show the leaf `in_progress` with `attemptId`, `attemptEpoch`, `contentRevision` and
`executorRef` equal to the pins, `attemptPins: "current"`, and `stateRevision` equal to the pinned
value at start only. Any mismatch, outage or invalid contract ends with a typed refusal
(`authority_mismatch`, `authority_unavailable`) and **no process is started**. The runner never
claims, never retries, never writes PlanStore state and never restarts an unknown owner. It also
verifies prompt/executable/Git hashes, exact worktree HEAD baseRef, linked worktree shape and record directory writability. Reserve the run record exclusively before spawn; refuse existing run IDs rather than overwrite or duplicate a worker. The
`input` check itself is the only place that may refuse for configuration.

## Fences: CAS identity versus `stateRevision`

`attemptId`, `attemptEpoch` and `contentRevision` are the **identity fence**. They decide whether
a budget or gate record belongs to the current checkpoint. `stateRevision` legitimately advances
through claim, review and acceptance, so it is recorded as `observedStateRevision` and is never
a freshness test after start. A record whose fence differs from the current task is stale,
whatever its `stateRevision`.

## Lifecycle and tripwires

`preflight` → `running` → `ended`. A refused preflight writes an `ended` record with
`stop.kind: "refused"` and the code. While `running`, the runner observes stdout bytes only, and
checks, with no model call. A fixed bounded authority re-read at least every five seconds also stops this owned worker on a changed current claim/pins; an unavailable authority is uncertainty, not a source failure:

- distinct units `> hard.units` → `hard_units`; elapsed `>= hard.wallMs` → `hard_wall`; output
  bytes `> hard.outputBytes` → `hard_output`; uncertain counter → `counter_uncertain`.
- `expected.units` reached sets `expectedExceeded: true` (visible, no stop).
- Operator cancel (programmatic abort, plus SIGINT/SIGTERM and Windows SIGBREAK where Node
  delivers them) → `cancelled`.
- A tripwire stops the owned process tree through the terminator, waits at most 10 s for `close`,
  then writes the final record. Failure to confirm termination is `cleanup_failed`, with the
  root PID, and is never reported as a clean stop. Spawn error is `spawn_failed`.
- Exit status is recorded as `exit: {code, signal}` but never selects the stop cause. A process
  that exits 0 is `exited`, a nonzero exit without a tripwire is `exited_nonzero`; a kill the
  runner issued is attributed to the tripwire, not to the exit code.
- Detection can lag the stream, so `consumed` is the observed amount at stop, a lower bound. Units
  already in flight past the hard limit are not hidden: consumed may exceed `hard.units`.

The runner exit code is `0` only for observed zero worker exit (still unverified), `1` for nonzero worker/spawn/cleanup failure, `3` tripwire or cancel, `2` refused, `4` record write failure. None of them is a gate result.

## Record: `checkpoint-budget/v1`

Atomic write (temp file in `recordDir` then rename) of at most 16 KiB. Written at start, after a
change at most every 5 s, and at end. Public, presentation-independent fields only:

- `schema`, `runId`, `identity` (rootId, nodeId, attemptId, attemptEpoch, contentRevision,
  `observedStateRevision`, executorRef), `baseRef`, `profile`, `state: "running" | "ended"`.
- `unit`, `expected {units, basis}`, `hard {units, wallMs, outputBytes}`.
- `consumed {units, wallMs, outputBytes, counterState: "exact_observed" | "lower_bound"}`,
  `expectedExceeded`, `providerReported {numTurns|null, costUsd|null, status: "unverified"}`,
  `cost {enforcement}`.
- `stop {kind, code}` where `kind` is `none | refused | tripwire | cancelled | exited |
failed`, with a closed `code` enum from this document.
- `startedAt`, `updatedAt`, `endedAt|null`, `writer: "runner_record"`, `recordTrust: "supplied_not_authenticated"`, `writerLiveness: "unknown"`.
- `artifactRef` (exact source SHA the lead names after the run, or `null`).

Never captured or published: prompts, thinking, tool inputs or results, assistant text, stderr,
credentials, environment, raw lines, file contents, URLs or links from worker text.

## Gate evidence: `checkpoint-gate/v1` (lead-supplied, no verifier engine)

The first producer is the lead, not an automated engine. After running independent checks the lead
writes `<runId>.gate.json` (at most 16 KiB) next to the record:

- `runId`, the same `identity` fence, `sourceRef` (exact SHA checked), `suppliedBy: "lead"`,
  `recordedAt`, `evidenceRefs` (at most 8 opaque refs, no paths or URLs followed).
- `checks` (at most 16): `{name, result: "pass" | "fail" | "unavailable"}`.
- `outcome`: `checks_passed`, `source_failed`, `partial` or `verifier_unavailable`.

A verifier or environment outage is `unavailable` and `verifier_unavailable`, never `fail` or
`source_failed`, and spends no model retry. Process exit, an agent claim or a stopped tripwire is
not a gate. The overview labels this as "supplied by the lead, not verified by ChatAgent". It does
not change the PlanStore `checkpointGate`. Gate evidence is **current** only when the fence matches
the task and `sourceRef` equals the task's current `artifactRef`; a match on the fence alone with a
different `sourceRef` is `history`. Missing, wrong or old evidence is explicit, never silently
empty.

## Read side: overview wiring

- Optional trusted startup input `HEKATE_CHECKPOINT_RECORDS_JSON` (requires the overview): an
  array of at most 16 `{rootId, nodeId, recordPath}`; absolute paths, strict, duplicate-free,
  validated at startup with a stable code that never echoes the value. No project crawl, no
  discovery, and no browser-supplied path.
- Per overview refresh, only tasks explicitly in the registry (including accepted tasks, so their gate evidence does not disappear) get one lookup of their record and gate file: `lstat` (a symlink or non-regular file is
  refused), at most 16 KiB, 500 ms deadline, the feature-local bounded strict JSON parser, then the closed schema. Fractional provider USD is valid metadata, never an integer identity or budget count.
- The fence must equal the task's current `attemptId`, `attemptEpoch` and `contentRevision`. Otherwise
  the record is **quarantined**: its numbers are not shown and the reason is `stale_identity`.
- New optional task field `checkpointBudget`: `{ state: "reported", record } | { state:
"unavailable", reason }` where `reason` is `missing | unreadable | too_large | invalid |
unsupported_schema | stale_identity | timeout`. A task that is not in the registry keeps no
  field. A running record is shown "as last recorded; owner liveness unknown", and one past
  `startedAt + hard.wallMs` plus grace without an end is `overdue_unreported`.
- **Compatibility:** with no registry the response is byte-identical to today's
  `executive-overview/v1` and `budgetEvidence` stays `"not_reported"`. With a registry the schema
  is `executive-overview/v2`, `budgetEvidence` becomes `"not_reported" | "reported" | "unavailable"`,
  and the UI's closed schema accepts both versions. Older v1 clients keep working without the
  registry. Costs and counters are never turned into an SLO, percent, ETA or integration claim.
- The inline UI shows the record under the task: unit label verbatim, expected, hard and consumed,
  stop code, `providerReported` labelled unverified, owner "supplied runner record; liveness unknown", gate evidence with its current or history label, all via `textContent`. No new request
  is issued on load, no POST exists, and no execution route is added.

## Isolation, discard and what is deliberately absent

The worker edits only the pinned linked worktree. The runner never runs `git clean`, reset or
checkout and never deletes the worktree, so failed source and checks are preserved. Discard is an
operator action on that worktree. There is no public execution POST, auto-root claim, retry,
acceptance, integration, unknown-owner restart, or unattended wake in this increment.

## Frozen tests

Unit and integration tests use an injected program (an owned Node fixture child that may spawn a
grandchild) in place of Claude. Production code does not accept an injected executable.

1. Repeated stream blocks with the same message ID count once; distinct IDs count separately.
2. Hard units stop the actual owned fixture and its grandchild (both gone, checked by PID); the
   record says `hard_units` with consumed units above hard, and the exit code does not set the cause.
3. Malformed line, oversize line, missing ID, duplicate key and unterminated tail each give
   `counter_uncertain` and `lower_bound`, never a guessed number.
4. `hard_wall` and `hard_output` stop a fixture that emits no assistant IDs, proving they do not
   depend on provider output.
5. Preflight with a wrong attempt, epoch, content revision, executor, `attemptPins`, or an
   unreachable API leaves a fixture-side marker absent (nothing spawned) and writes a refusal.
6. `stateRevision` advancing after start does not make a matching record stale; a record from an
   older attempt or content revision is quarantined with `stale_identity`.
7. Cancel via `AbortSignal` cleans up everywhere. SIGINT/SIGTERM cleanup runs where the platform
   supports it and carries an explicit capability skip on Windows otherwise.
8. Partial metadata: no final `result`, a non-integer `num_turns` or a negative cost yield `null`
   provider fields while observed consumption stays intact.
9. Gate evidence: fence plus `sourceRef` match is current; fence match with a different `sourceRef`
   is history; an unavailable verifier maps to `verifier_unavailable`, not `source_failed`.
10. Privacy: sentinel strings in fixture prompt, assistant text, tool results and stderr never
    appear in the record, the overview body or the rendered UI.
11. Read side: symlink, oversize, slow, invalid JSON, duplicate keys, unknown schema and a missing
    file each give the typed reason; an unregistered task gets no field; the request log shows only
    `GET`s, load issues none, and `ROUTES` is unchanged.
12. Compatibility: no registry gives byte-identical v1 output; a registry gives v2 and the UI renders both.

Live checks, after review and run by the lead outside the repository tests: first one actual
read-only Claude checkpoint smoke through the `readonly_smoke` profile, if the CLI is installed and
authenticated (otherwise recorded `unavailable`, not a failure of the source), comparing observed
distinct IDs with provider `num_turns` as an observation only; then a controlled tripwire on an
owned fixture with a tiny hard limit. Source, artifact and tests are verified externally by the lead.

## Next implementation task (one bounded feature)

- Scope: the unit, record, preflight, tripwires, lead-supplied gate file and optional read-side
  wiring above. Target tens of minutes of generation plus lead verification. If the CLI flag
  inspection or stream shape forces a native Hekate prerequisite, stop and split repositories
  rather than combine them.
- Files: new `src/checkpoint/checkpointRun.ts` (runner), `src/checkpoint/checkpointRecord.ts`
  (schemas, strict parse, atomic write), `src/integrations/hekate/checkpointBudget.ts` (bounded
  read and fence match), `src/config/checkpointRecordsConfig.ts`, `scripts/runCheckpoint.ts` (entry,
  following the `scripts/assessRecovery.ts` pattern); edits to `executiveOverview.ts`,
  `src/ui/executiveOverview.ts`, `src/server.ts`; docs `runtime-reference.md` and the roadmap.
  Tests as listed above under `tests/unit` and `tests/integration`.
- Checks: the focused new suites and the existing `executiveOverview*`, `cliRunner` and
  `httpAuth` suites with `npx vitest run`, then `npm run format`, `npm run lint`,
  `npm run docs:check` and the full suite. Failing output is reported as failing.
- Acceptance: every frozen test passes unweakened; `CliRunner` behavior and `ROUTES` are unchanged;
  the lead independently reviews the source and runs the live checks; the exact artifact is
  accepted in Hekate by the lead. Integration and live evidence are recorded separately from
  PlanStore acceptance. This document claims no result.

## Deferred

Persistent service, wake or unattended supervision, auto-claim, retry or integration, a public
execution route, an automatic gate verifier, observed-cost enforcement, per-tool or AI review,
polling, hierarchy, native `task_runner`/`task_spec` adoption (not read here, not required), and
any measured SLO. Revisit expected budgets only after several recorded checkpoints exist.

Generic nonzero verifier exit has unattributed cause: classify partial/unavailable as appropriate rather than infer source failure. A lead-supplied source-failure attribution needs explicit evidence; no automatic causal retry or reset is authorized.

Lead gate correction: the fixed profile includes restricted mode, acceptEdits, strict empty MCP, no session persistence and no slash commands. Pinned prompts are regular files read within 256 KiB before allocation. Worker elapsed consumption uses a monotonic clock and excludes preparation, while UTC record timestamps use the process wall clock. Final termination verdict waits for the owned cleanup operation; uncertainty is retained. A persistent exclusive lease keyed by root/node/attempt/epoch/content prevents a different run ID from starting a second worker for the same claim in its declared record namespace. That namespace stays fixed for the project; moving/deleting leases or migrating it is an explicit operator recovery outside this increment. A new run ID alone is never a retry fence.

Gate records carry `failureAttribution` (`unattributed` by default, or `source`). A generic failed check remains `partial`; `source_failed` requires an explicit lead source attribution, at least one failed check, no unavailable checks, and retained evidence references. These supplied references do not authenticate the lead or prove cause by themselves. The inline view validates this same outcome contract. This does not automate retries or acceptance.

The feature-local record parser permits finite integral decimal representations only for `providerReported.costUsd` and `providerUsdCap`. Integer identity and budget fields retain strict token checks; the shared PlanStore parser remains unchanged.
