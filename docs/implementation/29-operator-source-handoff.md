# 29 - Operator source handoff

Status: lead-reviewed contract; implementation and live delivery gates remain open. CA-ISSUE-051 and CA-ISSUE-004 stay open; wake and unattended recovery are out of scope. Rejected candidate `9ab5bfd`, accepted repair `9913adf` and their model counters are preserved separately.

## 1. Context

Operator-reported, not product features: a root commit landed before the model verifier ended, so the source guard stopped with `source_changed` and wrote no gate. Root then raced the index lock with dependent Git commands. Recovery deleted no lock and reset nothing; one owned script awaited each Git child (result `3c6afd8`, tree-equal to reviewed `4a924e8`). Formatter source `3c6afd8` hosted required jobs now pass. Original counters, gates and archives stay immutable; no gate is adopted and no retry is inferred.

## 2. MVP and exclusions

In-process only: an owned completion handle plus a fixed sequential scoped mutator in new `src/checkpoint/operatorHandoff.ts`.

Excluded: any standalone mutation CLI; any authority from prior files, records, results, PIDs or exit assertions; adopting external already-closed CLI runs (operator preservation stays outside scope); start, claim, finish, decide, release, retry, recover, merge, push, deploy, wake; lock-age or PID takeover, deleting old continuation leases, a global lock, cross-process resurrection, preventing manual shell writes. The lead starts a NEW operator attempt externally.

## 3. Owned completion handle

Private module state: `const owned = new WeakMap<object, HandleState>()`. State: canonical worktree, prior `runId`, awaited `ContinuationResult`, `status` (`pending|settled|consumed|refused`). Handles are frozen, have no fields that carry authority and are never serialized; a structurally identical object is not in the map and is `forged`.

The only creator is the maintained factory `startOwnedContinuation(manifest, deps)`. It canonicalizes the worktree, itself calls `runContinuation(manifest, deps)` and stores the promise internally. There is no public constructor, no parameter accepting a result or a caller-resolved promise, and `deps.prior` is not accepted. The `WeakMap` entry is set to `settled` only inside the factory's own `.then` after the real invocation returns.

The mutator refuses: pending, foreign (other worktree or run), forged, consumed (one use, marked before the first effect) and persistence-uncertain handles. Eligible results only: exit 0, or exit 1 with a terminal record whose reason is not `cleanup_failed`, `lease_changed` or `internal_error`. Exit 4, exit 2 (refusal) and those reasons are refused. Code 0/1 alone is insufficient: the mutator also requires exact terminal result/record, record `baseRef`/source, and clean cleanup, rechecked by fresh readback. A failed prior verification is repair-eligible only if the invocation settled cleanly and the exact source, record and new operator fence hold; old failed gates and counters are unchanged.

Provenance is cooperative same-process only; there is no actor authentication claim.

## 4. What the wrapper does and does not prove

`runContinuation` returns `{exitCode, record}` from try/catch and its `finally` only clears its timer and abort listener (`checkpointContinuation.ts` ~2063-2094). `runOwned` awaits the root child `close`; on timeout, output limit or abort it calls the owned terminator, waits `closeGraceMs`, and sets `cleanupFailed` if the root has not closed (~832-930). It gives no guarantee that root descendants exited. So: a settled handle means the awaited root children closed or `cleanupFailed` was reported; a terminal record never means the owner process closed or its descendants exited. The mutator asserts no such thing and only the in-process settle plus fresh Git readback gate it.

## 5. Trusted manifest `operator-handoff-run/v1`

Strict, closed, local, <=16 KiB, never from a browser, task text or worker output. No arbitrary shell, argv or callback.

- `handoffId`, linked canonical isolated `worktree`, `recordDir` outside it, pinned Git/Node.
- Current operator fence (root, node, attempt, epoch, revisions, executor, `baseRef`) of a new claim, started externally. Prior and current claim identities are never implicitly adopted.
- `expectedHead` (= `baseRef`); the handle's prior source must equal it in the same worktree. Optional `resultTree`.
- `files`: exact relative paths, no globs, <=64 files, creates/modifies regular files only.
- `patch {path, sha256, bytes}`: regular non-symlink text outside the worktree, <=256 KiB. Refused: delete, mode, type, symlink, gitlink, binary, rename. Its path set must equal `files`; paths are scoped before the first effect and bytes rehashed.
- Optional `formatting` exactly as doc 27 (pinned Prettier, doc 27 guards).
- Optional `allowGithub: true`: accepts only a path whose first segment is exactly `.github` (actual root); any `.git` segment/metadata, case or separator variants remain forbidden. Worker `validRelativePath` and profile are not weakened.
- `limits {wallMs<=600000, outputBytes<=1 MiB}`; commit message <=200 ASCII bytes.

## 6. Fixed awaited sequence

One `runOwned` child at a time, each awaited to close before the next. Source status, expected stage/head, exact file identity, lease, fresh current leaf, pins and guard are rechecked after every awaited lookup and immediately before each effect.

1. `git apply --check` scoped, then `git apply` scoped.
2. Status: exactly `files` modified, nothing staged, no untracked/undeclared escape.
3. Raw commit (`add -- files`, staged equals `files`, `commit --no-verify --no-gpg-sign`) -> `rawRef`.
4. Optional pinned Prettier write; if bytes change, a separate formatting-only commit -> `finalRef`. No-op formatting gives `finalRef == rawRef`. rawRef and finalRef are otherwise separate commits.
5. Readback: parent chain from `expectedHead`, `diff-tree` equals `files`, clean tree, `resultTree` if pinned.

Reuse or behavior-neutrally export existing doc 27 guards, `runOwned`, `parseStatusZ`, `parseRawDiffZ`, `entryState` and the fixed transport (`fetchCoordinationStatus`). `matchesLeaf` is module-private today and is not public; the work either exports it behavior-neutrally or implements an equivalent leaf check. No nonexistent helper is assumed.

## 7. Lease, phases, reasons

Own cooperative lease tied to the canonical worktree and the new claim, exclusive create; refusal if pending or conflicting. No takeover. Closed phases: `refused`, `applying`, `committing`, `formatting`, `verified`, `needs_operator`. Closed reasons: `handle_invalid`, `prior_not_settled`, `source_changed`, `index_lock`, `lease_changed`, `scope_violation`, `child_failed`, `cancelled`, `cleanup_failed`, `outcome_unknown`. Exits: 0 verified, 1 operator outcome, 2 refusal before effect, 4 persistence/cleanup uncertainty.

Abort, nonzero exit, lease replacement or uncertain outcome stop at once and preserve patch, source, index and locks: no reset, clean, restore, retry or automatic gate adoption. The record `operator-handoff-record/v1` is `supplied_not_authenticated`, `modelBudget: not_applicable`. Independent external checks and lead acceptance are separate existing tools; the mutator grants neither.

## 8. Scope of work

New `src/checkpoint/operatorHandoff.ts`; behavior-neutral exports from existing modules only if necessary; focused unit and integration tests; roadmap, open-issue and runtime docs after verification. No script, `package.json`, queue, routes, gate schema or UI changes. Commits are split: functional patch, then formatting-only.

## 9. Objective gates (future, real output)

- A pending genuine owner invocation and forged terminal records or lookalike handles cannot authorize mutation; a handle from another worktree/run, or replayed, is refused; failed, stale or uncertain lookups are refused.
- A real owned child waits holding `index.lock`: no dependent child starts before close.
- Real Git: stale head, stale current claim, same-path-byte race, config hash drift, scope escapes, abort, nonzero exit, lease replacement all refuse.
- Negative controls or policy counterexamples where applicable; no old-source test against a nonexistent mutator.
- `npm run lint` and `npm test`. Before closing CA-ISSUE-051: retained-store proof of a same-process prior continuation, a separately started new operator attempt and independent final Prettier, TypeScript and Vitest checks.

## 10. Lead clarification and execution units

The production factory cannot accept a caller-resolved promise or arbitrary replacement for `runContinuation`. Any fixture seams are trusted test dependencies outside the wire. Its rejection handler and `finally` settle the handle refused on throws or uncertainty; no unhandled promise rejection may manufacture a successful completion.

The cooperative conflict lease keys the canonical worktree independently of `handoffId` or `recordDir`, with the new operator claim in its owned token. Different IDs or record directories must not bypass that conflict check. It is not an authenticated or global filesystem lock.

Implement two independently checked changes: first the actual-invocation completion wrapper and pending/forged/foreign/replay/uncertain-completion tests; then the fixed scoped mutator, lease/source/current-claim guards and real retained-store proof. Acceptance of the wrapper alone does not deliver source mutation or close CA-ISSUE-051. Neither change grants automatic semantic acceptance.
