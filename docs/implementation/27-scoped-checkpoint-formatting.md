# 27 — Scoped checkpoint formatting

Status: proposal pending Codex lead acceptance. Nothing here has been implemented, executed or tested; every test, gate and live proof below is a requirement for a later implementation, not a result. Planning acceptance, implementation acceptance, source integration and live proof stay separate gates. Line references are to the worktree at `c7402cc`.

## 1. Problem and one useful increment

Restricted coding workers cannot run `npm run format` (`package.json:37-38`). The finite coordinator in `src/checkpoint/checkpointContinuation.ts` snapshots the worker's raw source (`snapshotStep`, line 1236), finishes PlanStore (`finishStep`, line 1297) and only then runs `prettier --check` (`verifyStep`, line 1351, argv from `checkArguments`, line 440). A functionally correct candidate that is merely unformatted therefore ends at `needs_operator` after the finish, and the only repair has been a new operator epoch. This happened twice.

The increment: an operator-opted continuation takes the raw functional snapshot, formats only the declared, existing, supported files that the worker changed with the pinned Prettier and the pinned configuration, commits any resulting byte changes as a separate formatting-only commit, and then issues the single existing finish CAS against the final commit. The unchanged external checks then run on that final commit. Nothing is accepted, merged, retried, released or recovered automatically.

## 2. Source seams and path corrections

Two suggested paths do not exist and were used only as clues. The maintained continuation contract is `docs/implementation/22-checkpoint-continuation-manager.md`, and the maintained phase-visibility contract is `docs/implementation/24-checkpoint-phase-visibility.md`. There is no `checkpointContinuationProjection.ts`; the maintained projection is `src/integrations/hekate/checkpointContinuationView.ts` (`readContinuation` line 230, `continuationCurrency` line 175, `projectContinuation` line 342), consumed by `src/integrations/hekate/executiveOverview.ts` (`EXECUTIVE_OVERVIEW_SCHEMA_V4`, line 41) and validated by the page in `src/ui/executiveOverview.ts` (lines 354-358).

Reused unchanged:

- `runOwned` (`checkpointContinuation.ts:504`) with `processTreeTerminator` from `src/providers/cli/runner`: shell-free spawn, `windowsHide`, allowlisted `childEnv`, bounded time and output, awaited tree cleanup, `cleanupFailed` reporting.
- `pinnedExecutable`, `pinnedEntry`, `entryState`, `parseStatusZ`, `parseRawDiffZ`, `REGULAR_MODES`, the bounded `git` closure with command-local hooks, fsmonitor and signing disabled, `verifyLease`, `publish`, `matchesLeaf`, `matchesFinished`, `finishRequestBody`.
- `checkpointRecord.ts`: `parseBoundedJson`, `gateRecordSchema`, `deriveGateOutcome`, `GATE_CHECK_RESULTS`. The gate schema and `buildGate` (line 779) are not changed.
- `runCheckpoint` and the worker runner, `scripts/continueCheckpoint.ts` (expected unchanged; the implementer must confirm), `checkpointQueueService.ts` lifecycle.

Configuration inputs that define "normal formatting" are `.prettierrc.json` (tabWidth 2, printWidth 100, `endOfLine: lf`, `proseWrap: preserve`, `embeddedLanguageFormatting: off`, no plugins or overrides), `.prettierignore` (lines 1-24: generated output, `docs/measurements/`, byte-exact Hekate fixtures under `tests/fixtures/hekate/`, local review documents) and `.gitattributes` (`* text=auto eol=lf`, `-text` evidence and fixture paths). The pinned Prettier is `3.9.9` (`package.json:57`).

## 3. Scope freeze

Three sets are frozen in order and each must be a subset of the previous one.

- Declared set D: `manifest.files` (1-24 paths, roots `src/`, `scripts/`, `tests/`, `docs/`, enforced by `validRelativePath`, line 92). Unchanged.
- Changed set C: the paths in the raw candidate commit, as proven by the existing `collectChanges` (line 1203) and `diff-tree` recheck (lines 1273-1293). Declared new files, modifications and deletions are in C.
- Eligible set E: members of C that exist in the raw commit (not deleted) and whose lower-case extension is in the fixed list `.ts`, `.js`, `.mjs`, `.cjs`, `.json`, `.md`. Everything else is `unsupported`. `.d.ts` is `.ts`. The list is code, not manifest input, and widening it needs a new accepted contract.
- Formatted set F: the paths whose bytes Prettier actually changed. F must be a subset of E, with status modified only.

Consequences. The formatter never receives a path outside E, never receives a directory, glob or `.`, and never runs repository-wide. Files outside C (historical evidence, other docs, excluded generated fixtures, ignored files) are never opened for writing. Deleted files are not passed to Prettier and a deletion in the raw commit is preserved byte-for-byte in the final commit. Unsupported files are excluded before spawning, so the "no parser inferred" failure cannot occur; they are recorded as a count, not as a failure. Files matched by `.prettierignore` are passed with `--ignore-unknown` and the pinned ignore path, so Prettier skips them silently; the post-run diff proves they were not touched, and the record does not claim a count of ignored files.

If E is empty, the formatter is not spawned and `formatting.state` is `unchanged` with `ran: false`.

## 4. Manifest change and operator authority

`checkpoint-continuation-run/v1` gains one optional strict field, `formatting`. Absent means exactly today's behavior: no formatter, v1 record, unchanged `checkArguments`. Old manifests parse and behave identically; a new manifest is rejected by old code through the existing strict schema, which fails closed.

```
formatting: {
  mode: "prettier_write_declared/v1",
  configSha256: sha256,    // bytes of <worktree>/.prettierrc.json
  ignoreSha256: sha256,    // bytes of <worktree>/.prettierignore
  wallMs: 1..120000,
  outputBytes: 1..262144
}
```

The field is explicit operator authority to run the already-pinned Prettier entry (`toolingSha256.prettier`) in write mode on E and to make one formatting-only commit. It grants no new path, command, profile, model, decision or retry authority. It cannot be set from browser, chat, task text or worker output.

Manifest refinements added beside the existing ones (`checkpointContinuation.ts:140-144`):

- `limits.wallMs` must exceed `run.hard.wallMs + limits.verifierWallMs + formatting.wallMs + reservedMs`. Queue admission already compares `m.limits.wallMs` (`checkpointQueueState.ts:370`), so it needs no change.
- With `formatting` set, a declared path whose basename is `.prettierrc` or begins `.prettierrc.`, `prettier.config.`, `.editorconfig`, `.prettierignore`, `package.json`, or whose lower-case basename is in that set, is refused at parse. Formatter inputs cannot be sourced from worker edits without a separate deliberate manifest change by the operator.

Preflight additions when `formatting` is set (all before any worker, refusal code `pin_mismatch` or `source_invalid`, nothing created):

- `.prettierrc.json` and `.prettierignore` at the worktree root are regular non-symlink files of at most 16 KiB whose bytes match the pins. The config parses with `parseBoundedJson` and contains only the nine keys listed in section 2 (no `plugins`, `overrides` or `extends`), so it cannot load code.
- No `.prettierrc*`, `prettier.config.*`, `.editorconfig` or `package.json` exists at base in the root or in any ancestor directory, inside the worktree, of any declared path. Checked with `entryState` and bounded directory reads of those ancestors only.

## 5. Record shape and compatibility

The wire shape is versioned, not widened. `checkpoint-continuation/v1` is unchanged and is written whenever the manifest has no `formatting`. When it has one, the coordinator writes `checkpoint-continuation/v2`, the v1 fields plus:

- `rawRef: gitRef | null`: the raw functional snapshot commit. Set when that commit is verified.
- `sourceRef`: unchanged meaning at the finish boundary, the commit the finish CAS and the gate bind. In v2 it stays null until the final commit is verified, so a source-bearing claim never names an unformatted or half-formatted commit.
- `formatting`: strict object with `mode`, `state` (`pending`, `running`, `unchanged`, `committed`, `failed`, `unavailable`), `ran`, `eligible`, `unsupported`, `changed` (counts only), `exitCode`, `signal`, `timedOut`, `outputLimited`, `outputBytes`, `outputSha256`, `startedAt`, `endedAt`, `configSha256`, `ignoreSha256`. No path, stdout or stderr is stored.

Two reasons are added to `CONTINUATION_REASONS` (line 155): `format_failed` (formatter ran and exited nonzero) and `format_unavailable` (launch error, timeout, output cap, tool or config pin lost). The v1 schema refines them out so a v1 record can never carry them. `checkpointQueueState.ts:5,198` reuses this enum for `continuationReason`, so the queue record accepts them without a schema change.

v2 refinements: `review_pending` requires `formatting.state` to be `unchanged` or `committed`, `rawRef` and `sourceRef` non-null, `rawRef === sourceRef` for `unchanged` and different for `committed`. A v2 record is the only place `rawRef` or `formatting` may appear. All other fixed trust literals are unchanged.

`parseClosed` (line 300) currently treats any schema in the family not ending in `/v1` as `unsupported_schema` (line 319). It gains an explicit supported-version list per family: manifests `["…/v1"]`, records `["…/v1", "…/v2"]`. `parseContinuationRecord` returns the union. An old reader meeting v2 reports `unsupported_schema`, which `readContinuation` already turns into an explicit unavailable view, never a current phase.

No relabelling: existing v1 records, gates and PlanStore artifacts are never rewritten, reinterpreted or upgraded. A v1 record has no formatting statement, so every consumer shows `formatting: not_configured`, meaning "no formatter phase was recorded", and never "formatted" or "unformatted". Raw and final identities are separate fields (`rawRef`, `sourceRef`) and a raw ref is never recorded as the artifact.

## 6. Lifecycle with formatting enabled

Phases are unchanged. Raw snapshot, formatting and the formatting commit all happen inside `snapshotting`, before any PlanStore mutation. Adding a seventh phase would widen `CONTINUATION_PHASES` (line 147), `ITEM_RANK` and the per-phase counts in the view (`checkpointContinuationView.ts:329,347`) and the closed enums in the page; the `formatting.state` field carries that detail instead.

1. Preflight, reserve, `runWorkerStep`: unchanged.
2. `snapshotStep` up to the verified raw commit: unchanged checks (authority, base HEAD, `collectChanges`, staged-set equality, parent equals base, clean tree). Then publish `{ rawRef, formatting: pending }` with `sourceRef` null.
3. `formatStep` pre-checks, all fail closed: lease; `readLeaf` and `matchesLeaf(leaf, input, false)` (current claim, no start revision); `HEAD === rawRef`, `HEAD^ === baseRef`, empty `statusEntries()`; node and Git pins; Prettier entry pin through `hashesHold`; config and ignore bytes equal the manifest pins and are still regular non-symlink files; no config-named path in C. Compute E; if empty publish `unchanged`.
4. Publish `formatting: running`, then `verifyLease`, `live()`, and spawn through `runOwned` with fixed argv `[entry, "--config", <worktree>/.prettierrc.json, "--no-editorconfig", "--ignore-path", <worktree>/.prettierignore, "--write", "--ignore-unknown", "--no-error-on-unmatched-pattern", ...E]`, `cwd` the worktree, `capture: false`, the shared abort signal, `timeoutMs = min(formatting.wallMs, remaining())`, `maxOutputBytes = formatting.outputBytes`, existing `closeGraceMs`. Nonzero exit is `format_failed`; launch error, timeout, output cap or abort is `format_unavailable`, `deadline_exceeded` or `cancelled` as the shared deadline dictates; `cleanupFailed` is `cleanup_failed` and is exit class 4 as today.
5. Post-run classification, a pure function over `statusEntries`, `parseRawDiffZ` of `git diff --raw -z --no-renames --no-abbrev HEAD`, and `entryState`: every entry must be kind ` M` (worktree-modified, nothing staged, nothing untracked), its path in E, `status === "M"`, `oldMode === newMode`, both in `REGULAR_MODES`, and the file a regular non-symlink. Anything else is `scope_violation` and nothing is staged. Also `HEAD` must still equal `rawRef`.
6. If there are no entries, publish `unchanged`, `sourceRef = rawRef`. Otherwise record an `lstat` fence (size, mtime, inode) for each path in F, then `git add -- <F>` (mutating, lease-checked), compare the cached diff set to F exactly, re-check the fence, `git commit --no-verify --no-gpg-sign --quiet -m "checkpoint: format candidate"`, and verify `HEAD != rawRef`, `HEAD^ === rawRef`, `diff-tree` paths equal F, and a clean tree. Publish `committed` with `sourceRef = HEAD`.
7. `finishStep(sourceRef)` with one added precondition for this path: `HEAD === sourceRef`, clean tree and the expected parent, checked immediately before its existing `readLeaf` and CAS read. Exactly one POST, bound to the final commit through the unchanged `finishRequestBody`. The raw ref is never posted. A raw ref later found as the PlanStore artifact does not satisfy `matchesFinished` (line 719) for the final candidate.
8. `verifyStep` and `gateStep` run unchanged on the final commit. The Prettier check argv and its existing-changed list (derived from C) are unchanged, as is `gateStep`'s head and clean-tree recheck (line 1430). The gate binds the final `sourceRef`.

Revalidation before and after effects: PlanStore claim before the formatter (step 3) and again before the finish (step 7); HEAD, parent, scope and clean tree before the formatter, after it, after the commit and before the finish.

A failure after step 2 leaves the raw commit in place and does not roll back, reset, stash, clean or delete anything. A dirty tree after a failed or tampered formatter run is retained as evidence. The record is `needs_operator` with `rawRef` set, `sourceRef` null, `finish: not_attempted`, no gate and no POST. A fresh invocation never resumes. A crash can leave Git ahead of the last record; the operator inspects.

## 7. Fail-closed conditions

Each of these ends in `needs_operator` (or a refusal in preflight) with no POST, no gate and no automatic follow-up:

- staged or unstaged changes at the format boundary; any path outside E changed, created or deleted (including undeclared paths and unsupported declared paths); a deletion, rename or type change; a mode change; a symlink, directory, submodule gitlink (`160000`) or other non-regular entry.
- HEAD or its parent changed since the raw commit; a second commit appeared; another process touched the index or files (caught by status, diff, fence and re-read, not by an atomic lock).
- Prettier entry, Node or Git pin mismatch; config or ignore bytes changed, replaced by a link, or no longer matching the pin; a config-named path in C or an ancestor config appearing.
- PlanStore claim, pins, gates or attempt changed before the formatter or before the finish; unavailable authority; lease replaced; deadline or cancellation observed.
- formatter nonzero exit, timeout, output cap, launch failure, cancel or failed tree cleanup.

## 8. Budget

Formatting is bounded by its own `formatting.wallMs` and `formatting.outputBytes` and by the shared continuation `remaining()`, so it is inside the existing aggregate wall. It consumes none of `verifierWallMs` or `verifierOutputBytes`, which stay the independent budget for the three external checks. Worker bounds in `run.hard` are untouched. Gate schema, gate outcomes and `deriveGateOutcome` are untouched. No time bound here is a performance SLO or liveness proof.

## 9. Projection and queue

`checkpointContinuationView.ts`: the reported view gains `rawRef` (nullable) and `formatting`, either `{ state: "not_configured" }` or a closed object with `state`, `ran`, `eligible`, `unsupported`, `changed`, `exitCode`, `timedOut`, `outputLimited`. No path, hash or output is copied. `sourceRef` keeps its meaning: null until a final commit exists. `continuationCurrency` is unchanged; the task artifact must equal the final `sourceRef` for source-bearing phases, so a task whose artifact is the raw ref reads `stale_source`. Phase stays honest: a v2 record in `snapshotting` with `formatting.state: running` is shown exactly so, never as verifying or success, and a `format_failed` record is `needs_operator` with `failureAttribution` still `unattributed`. Nothing here asserts `source_failed`; that needs lead evidence outside this process.

Overview: a new `executive-overview/v5` is v4 plus those two per-task fields, opened under the same condition as v4 (a registry entry configures `continuationRecordPath`). `src/ui/executiveOverview.ts` keeps v1-v4 validation, adds v5, rejects the new fields under older schemas, and writes values with `textContent`. This is the one compatibility cost of the change and is a decision for the lead (section 12).

Queue: `checkpointQueueService.ts` `confirmedCandidate` (lines 679-738) additionally requires, for an item whose manifest has `formatting`, a stored v2 record with `formatting.state` of `unchanged` or `committed` and `rawRef`/`sourceRef` consistent; and for an item without it, a stored v1 record. The tooling loop at line 422 gains the config and ignore pin check. Queue lifecycle, admission and the acceptance wait are otherwise unchanged; a queue item does not gain automatic acceptance.

## 10. Exact changes (one commit)

- `src/checkpoint/checkpointContinuation.ts`: `CONTINUATION_RECORD_SCHEMA_V2`; limits `maxFormatWallMs` 120000, `maxFormatOutputBytes` 262144, `configBytes` 16384; optional `formatting` in the manifest schema and refinements; `format_failed` and `format_unavailable` reasons; v1/v2 record schemas and refinements; per-family version list in `parseClosed`; pure `partitionEligible`, `formatArguments` and `classifyFormatResult`; `formatStep` between `snapshotStep` and `finishStep`; `snapshotStep` sets `rawRef` instead of `sourceRef` when formatting is enabled; the extra pre-finish candidate check in the formatting path only.
- `src/integrations/hekate/checkpointContinuationView.ts`, `src/integrations/hekate/executiveOverview.ts`, `src/ui/executiveOverview.ts`: the section 9 projection and v5.
- `src/checkpoint/checkpointQueueService.ts`: the section 9 queue checks. `checkpointQueueState.ts` needs no schema change.
- Tests (section 11) and `tests/helpers/continuationFixtures.ts`: stub Prettier gains `format`, `format-noop`, `format-extra`, `format-untracked`, `format-chmod`, `format-symlink`, `format-delete`, `format-fail` modes besides the existing `ok`, `fail`, `hang`, `flood`; `Fixture` gains a `formatting` manifest option and pins for the fixture's own config and ignore files. The stub keeps writing its argv to `tools.log`.
- Docs: `docs/runtime-reference.md` section "Finite checkpoint verification continuation" (line 700) and a one-line pointer from docs 22 and 24 to this document, only after acceptance of the implementation. No `package.json`, `.prettierrc.json`, `.prettierignore`, Hekate source, runner profile, HTTP route or pilot manifest change.

## 11. Verification gates

Unit, in `tests/unit/checkpointContinuation.test.ts` and a new `tests/unit/checkpointFormatting.test.ts`:

- Absent `formatting` parses to exactly the old object and `checkArguments("prettier", …)` is byte-identical; v1 records still round-trip.
- `formatting` closed: unknown keys, bad hashes, zero or oversized limits, an aggregate wall that omits `formatting.wallMs`, and config-named declared paths are refused. A v1 record carrying `rawRef`, `formatting` or a format reason is refused; v2 pairing rules hold; an unknown record version is `unsupported_schema`.
- `partitionEligible`: `.ts`, `.d.ts`, `.json`, `.md` eligible; `.txt`, `.yml`, `.png`, extension-less and upper-case variants handled as specified; deleted paths never eligible; empty E.
- `formatArguments`: exact fixed argv, no shell metacharacter path can be introduced.
- `classifyFormatResult` rejects staged, untracked, outside-E, `D`, `T`, `A`, rename-shaped, mode-changed, `160000` gitlink and symlink inputs, and accepts only modified regular E paths.

Integration, new `tests/integration/checkpointContinuationFormatting.test.ts` over real Git, real Node and real subprocess stubs, in the style of `tests/integration/checkpointContinuation.test.ts`:

- Unformatted worker output: one worker, a raw commit on the base, a formatting commit whose parent is the raw commit, exactly one POST with `artifactRef` equal to the final commit and not the raw commit, tool order `prettier` (write argv), `prettier` (check argv), `typescript`, `vitest`, v2 record `committed`, gate bound to the final ref, the base branch untouched, `leadAcceptance: pending`.
- Already formatted output: `unchanged`, no second commit, `sourceRef === rawRef`. Deletion-only and all-unsupported changes: formatter not spawned. A mixed set: unsupported file never appears in formatter argv and is not a failure.
- Old-source negatives: the raw ref never reaches the POST body; a PlanStore leaf whose artifact is the raw ref does not satisfy the final-candidate confirmation; a task artifact equal to the raw ref reads `stale_source` in the view; a v1 record from an unformatted run is never displayed as formatted; a manifest without `formatting` produces v1, the old argv and no formatter process.
- Fail-closed cases, each asserting no POST, no gate, `finish: not_attempted`, the raw commit preserved and a typed reason: formatter nonzero, hang (grandchild terminated), output flood, abort mid-run, terminator failure, stub that edits an undeclared file, creates an untracked file, chmods, replaces a file with a symlink, deletes a file, stages a change, or advances HEAD; tool-entry hash change, config or ignore change, and a nested config appearing after preflight; PlanStore claim changed before the formatter (formatter never spawned) and after the formatting commit before the finish (no POST); lease replaced.
- Real pinned Prettier test: the worktree links `node_modules` to the repository's, the pins are computed from the repository's real Prettier entry, and a deliberately unformatted declared TypeScript and Markdown file are formatted to the repository's configuration while a declared file matched by the pinned `.prettierignore` is byte-identical afterwards. This test is skipped with an explicit message, not silently, where the link cannot be created.
- Queue, view and UI: a v2 `committed` and `unchanged` item reaches `waiting_review`; `failed` and a v1-for-formatting mismatch do not; the view shows `snapshotting` with `formatting.running`, `needs_operator` with `format_failed`, and `not_configured` for v1; v5 validation in `tests/unit/checkpointContinuationUi.test.ts` and `tests/browser/executiveOverview.spec.ts`; the v4 assertions at `tests/unit/executiveOverview.test.ts:530`, `tests/integration/checkpointRecordsHttp.test.ts:248` and `tests/integration/executiveOverviewHttp.test.ts:215` updated to the chosen schema with absent-config compatibility retained.

Gates the implementer must run and report with real output, none claimed here: the focused files above; `npm run lint` (`format:check` plus `tsc -p tsconfig.json --noEmit`); `npm test`; `npm run test:browser` for the page change. A failure is reported and repaired, not gated around.

## 12. Retained-store proof

Required before the lead may call this delivered, using a separate linked worktree at an exact clean base, a real claimed coding checkpoint in the retained PlanStore, a real coding worker (not a stub) and a manifest with real pins for Node, Git, TypeScript, Vitest, Prettier, `.prettierrc.json` and `.prettierignore`:

- The operator separately shows that the raw commit fails `prettier --check` with the repository configuration and that the worker's source was not hand-formatted. If the worker happens to produce formatted source, that run proves only the `unchanged` path and does not satisfy this proof; it is preserved and a new attempt is prepared.
- The retained record shows `rawRef` differing from `sourceRef`, `formatting.state: committed`, the formatting commit's parent equal to `rawRef`, and a diff between them confined to declared supported existing files.
- The PlanStore request log and receipts show exactly one finish transition for the attempt, with `artifactRef` equal to the final formatted commit, CAS state revision read after the formatting commit, and no transition naming `rawRef`.
- The three external checks pass on the final commit, the gate binds the final ref, the continuation ends `review_pending`, the executive overview shows the phase, raw and final refs and formatting facts inline, and the task stays at `review_pending` until the lead decides.

Failed live attempts are retained and repaired through a new explicit operator attempt, never by editing a completed artifact or reusing a run identity.

## 13. Limits and decisions for the lead

- Prettier is repository code run by the host; the entry and config pins do not authenticate its dependencies and this is not a sandbox, as in document 22. Records and the lease remain supplied and cooperative; the `lstat` fence and status checks detect interference, they are not an atomic lock.
- Parent-directory configuration or `.editorconfig` outside the worktree is not detectable cheaply. The write step ignores it (`--no-editorconfig`, explicit `--config`), while the unchanged external check does not pass those flags, so such interference can only make the check fail, which is the intended direction. Decision: whether to add the same pinned flags to the check argv under opt-in. Recommendation: no, keep the gate untouched.
- Decision: `executive-overview/v5` (recommended, the page and tests are in this repository) versus leaving the overview at v4 and showing only phase and reason, which would hide raw versus final identity.
- Decision: the seventh `formatting` phase is rejected here for blast radius; revisit only if operators need it in counts.
- Nothing in this proposal grants lead acceptance, merge, release, retry, claim, recovery, notification or any task authority, and none is implied by a passing check or a committed formatting change.
