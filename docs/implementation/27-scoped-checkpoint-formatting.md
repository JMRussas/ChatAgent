# 27 — Scoped checkpoint formatting

Status: accepted runtime contract after independent lead review and operator
finalization. The current implementation, checks, live proof and remaining limits
are recorded in the development roadmap; the gates below define the contract and
are not a substitute for their exact source-bound receipts.

## 1. Increment

Restricted workers cannot run `npm run format`. Today `snapshotStep` (1236) and `finishStep` (1297) precede `verifyStep` (1351, `checkArguments` 432), so correct but unformatted work ends `needs_operator` after the finish.

Under explicit optional manifest authority: format changed, existing, supported declared files with pinned Prettier and config, commit byte changes as a separate formatting-only commit, issue the one existing finish CAS against the final commit, then run the unchanged independent checks on it. No acceptance, merge, retry or recovery. No docs 22/24 pointer or roadmap closure now.

Reused unchanged: `runOwned` (504), `hashesHold`, `entryState`, `parseStatusZ`, `parseRawDiffZ`, `verifyLease`, `publish`, `matchesLeaf`, `finishRequestBody`, gate schema, `CONTINUATION_PHASES`.

## 2. Scope

D = `manifest.files`. C = paths in the raw commit (`collectChanges`, `diff-tree` recheck). E = C members that exist and have extension `.ts .js .mjs .cjs .json .md` (fixed in code; no dirs or globs). F = paths Prettier changed; F ⊆ E, modified only. Deleted and unsupported files never reach the formatter or the formatter-aware Prettier gate; they are counted, and deletions stay byte-exact. Ignored and evidence bytes are protected by the pinned ignore file, the exact before/after diff and raw/final scope.

## 3. Manifest and configuration guard

Optional strict `formatting: { mode: "prettier_write_declared/v1", configSha256, ignoreSha256, wallMs ≤120000, outputBytes ≤262144 }`. Absent means today's manifest, argv and v1 record exactly (legacy opt-out). `limits.wallMs` must also cover `formatting.wallMs`. No other authority is granted.

Guard, checked at preflight:

- Root `.prettierrc.json` and `.prettierignore`: regular, non-symlink, ≤16 KiB, SHA-pinned. Config is strict safe JSON: scalar option allowlist fixed in code, no `plugins`, `overrides`, `extends` or code.
- Root `package.json` allowed only as unchanged base source (undeclared, not in C, equal to base blob).
- Refuse any other root formatter config (`.prettierrc*`, `prettier.config*`, `.editorconfig`) and any such shadow/nested file in declared-path ancestors (not root `package.json`). Detect by bounded directory reads, so ignored or untracked files that appear are caught.
- Declared edits to config files are refused at parse; undeclared tracked edits already fail scope.
- All Prettier runs pass explicit root `--config`, `--no-editorconfig`, pinned `--ignore-path`.

Recheck the guard before and after the worker, before and after the formatter, and before the finish.

## 4. Flow (inside `snapshotting`)

After the verified raw commit, publish `rawRef`, `sourceRef` null, then:

1. Pre-checks: lease, current task/claim (`matchesLeaf`), HEAD = rawRef, parent = base, clean status, tool pins, guard. If E is empty, skip the formatter: state `unchanged`, `sourceRef = rawRef`.
2. `runOwned` with `[entry, --config, cfg, --no-editorconfig, --ignore-path, ignore, --write, --ignore-unknown, --no-error-on-unmatched-pattern, ...E]`, timeout `min(formatting.wallMs, remaining())`, output cap `formatting.outputBytes`. Nonzero exit is `format_failed`; launch, timeout or output failure is `format_unavailable`.
3. Pure classifier over status and `git diff --raw -z --no-renames HEAD`: only worktree-modified regular E paths with equal regular modes pass. Staged, untracked, outside-E, delete, mode/type change, symlink, gitlink or moved HEAD is `scope_violation`.
4. If changed: `lstat` fence, `git add -- F`, staged set equals F, fence recheck, `git commit --no-verify --no-gpg-sign`; verify parent = rawRef, `diff-tree` = F modifications with unchanged modes, clean tree. `sourceRef = HEAD`.
5. `finishStep(sourceRef)` once, after rechecking HEAD, tree and guard. When a formatting commit exists, only its final ref is posted; the raw ref does not satisfy `matchesFinished` for that final candidate. With no formatting change, final and raw refs are equal and the single finish may name that ref.
6. Checks (below), then `gateStep` bound to the final `sourceRef`.

On failure the raw commit, dirty tree and artifacts are preserved. No reset, clean, stash, auto retry, accept, merge or recovery. Record: `needs_operator`, `finish: not_attempted`, no gate, no POST.

## 5. Checks under opt-in

`verifyStep` uses E and the same pinned options: `[entry, --config, cfg, --no-editorconfig, --ignore-path, ignore, --check, --ignore-unknown, ...E]`. It is a real independent `--check` on final source; nothing is precomputed from the write run, and TypeScript and Vitest are not weakened. Empty E records Prettier as not run with result `pass` (as the deletion-only branch at 1362), and TypeScript and Vitest still run. Without `formatting`, the argv and list are byte-identical to today.

## 6. Records, view, queue (runtime MVP)

- Continuation record `v1` unchanged. With `formatting`, write `v2` = v1 plus nullable `rawRef` and a bounded `formatting` object: `mode`, `state` (`pending running unchanged committed failed unavailable`), `ran`, counts `eligible unsupported changed`, exit/signal/timeout/output facts, config and ignore hashes. No paths or output. `sourceRef` is null until the final commit is verified.
- Reasons `format_failed`, `format_unavailable` exist only in v2. v2 `review_pending` needs state `unchanged` (rawRef = sourceRef) or `committed` (different).
- `parseClosed` (300) gets explicit supported versions: manifest `v1`, record `v1`/`v2`. Old v1 records are never rewritten.
- `checkpointContinuationView.ts` parses v2 but projects only the existing v4 phase/gate/source shape: no `rawRef` or formatting keys, no schema v5 or added page fields. The existing closed page reason list must recognize `format_failed` and `format_unavailable`, with failure rendering tests; this is a compatibility correction, not formatter detail enrichment. A formatter run shows as `snapshotting`. CLI JSON exposes exact raw/final detail. Page enrichment and an overview schema bump are a separately gated next checkpoint, not delivered here.
- `checkpointQueueService.ts`: pin preflight (426) includes config and ignore; `confirmedCandidate` (679) accepts a stored v2 (`unchanged`/`committed`, consistent refs, final ref equals gate ref); manifests without `formatting` still require v1.

## 7. Safety limits

Verify current task, HEAD, clean status and lease before every effect. Staged equality and re-read checks are cooperative detection, not locks; races between a check and the next call remain. No atomic filesystem/API, power-loss or authentication claim; Prettier dependencies are unauthenticated repository code. Config outside the worktree is not searched; explicit flags make the write ignore it.

## 8. Scope of work

- Source: `checkpointContinuation.ts` (manifest field, guard, v2, pure `partitionEligible`/`formatArguments`/`classifyFormatResult`, `formatStep`, opt-in check path). In `snapshotStep`, the candidate closure and `changes` list must separate raw from final: set `rawRef` and leave `sourceRef` null, then recompute the list against the final commit so verification and the gate match the final ref. Also `checkpointContinuationView.ts` (parse only) and `checkpointQueueService.ts`.
- UI scope: add only the two format reason tokens to the existing closed reason enum in `src/ui/executiveOverview.ts` and verify those failure views render. No new fields or schema.
- Unchanged: `package.json`, Prettier config files, gate schema, overview sources, routes, profiles.
- Tests: `tests/helpers/continuationFixtures.ts` (labelled stub Prettier modes), `tests/unit/checkpointFormatting.test.ts`, `tests/integration/checkpointContinuationFormatting.test.ts`, updates to existing tests. `docs/runtime-reference.md` only after implementation acceptance.

## 9. Gates (future, reported with real output)

Unit tests of pure helpers (absent `formatting` equals legacy, schema, `partitionEligible`, argv, classifier). Process fixtures use labelled stubs over real Git. Regression coverage: actual success, noop, unsupported, ignored, deletion; tampered tool, config, authority, HEAD, scope, stage; timeout, failure and owned cleanup; legacy behavior; v2 queue currency; one-shot finish; v2 view projects v4 shape with no new keys. Then `npm run lint` and `npm test`; failures are reported and repaired.

## 10. Live proof (before delivery is claimed)

Separate clean worktree, real claimed checkpoint in the retained store, real model worker, real pins. The worker must intentionally produce unformatted source: raw `--check` fails; formatted output proves only `unchanged` and does not count. Required: final external Prettier, TypeScript and Vitest pass; one finish artifact naming the final commit; formatting commit parent exactly the raw commit with diff confined to F; reviewer accepts separately.

## 11. Lead decisions

Accept the fixed extension list, the opt-in check argv, and v2 with v4 projection now and page enrichment later. Nothing here grants acceptance, merge, retry or recovery authority.
