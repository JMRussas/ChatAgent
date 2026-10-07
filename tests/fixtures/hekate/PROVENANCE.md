# Hekate claim response fixtures

Raw `POST /api/plan-contract/v1/plans/{root}/claims` response bodies, captured by
the Hekate lead without re-serialization from a disposable database at Hekate
commit `bb2af8b` (2026-10-06, relayed in agent-bridge messages 760 and 763). The
database was dropped afterwards; no production data was involved.

They are copied byte-for-byte (no trailing newline) and excluded from formatting
in `.prettierignore`. Do not edit them; capture new ones instead.

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `claim-claimed.json`       | `5c2212745225afccceb6601f7d6a4cacabd5b813e889727432a8672d65688999` |
| `claim-replayed.json`      | `1ce4fb7365321314c4a5c9aba8e46040a920597e09359f1ebf799c16d45e564c` |
| `claim-no-ready-work.json` | `d5fd8a6e8695b7ad0de1a9cbf518acb2ed62a3743a046b98cb5d91fc0bf760d5` |

Variants built in tests from these bodies (for example a nested prerequisite
`attemptEpoch` of 0, or non-null content) are synthetic and labelled as such.

## Plan status fixture

`c1-plan-status.raw.json` is a raw `GET /api/plan-contract/v1/plans/{root}` response
body for root `e3f9c48e-1338-492a-b6c4-a9fbb1525957`, captured by codex-chatagent
without re-serialization (agent-bridge message 1075) from a clean `git archive` of
Hekate `d0ed671` running in an isolated harness API and disposable database, using
`capture_c1.py` under `uv run --locked` with CPython 3.13.13. The database and API
were removed afterwards; no shared service was changed. It holds four leaves (ready,
in progress, done awaiting review, accepted) and the root container.

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `c1-plan-status.raw.json` | `4224bc2245afd13f1ee76281c2d7f72954d18b1f982e5f131cb521ded8853d91` |

Other plan-view variants in `tests/unit/devCoordination.test.ts` are synthetic edits
of this body and are labelled as such.

The capture script lives outside this repository (it imports Hekate's
`scripts/local/supervisor_e1` harness). To recapture, run it from that directory
against a clean archive with the harness's own API and database, never a shared
service:

1. Create a managed plan with a fresh root, then add four children named `Ready`,
   `In progress`, `Awaiting review` and `Accepted`, each with
   `attributes.scope = "fixture only; base: 93f3624"`.
2. Move children 2–4 to `in_progress` with attempt ids `fixture-attempt-<n>` and
   executor `fixture:worker`; move children 3–4 to `done` with artifact
   `git:` followed by 40 `a` characters.
3. Record `accepted` on child 4 against its current content revision, artifact and
   attempt epoch, with evidence `fixture:checks`.
4. Write the bytes of `GET /api/plan-contract/v1/plans/{root}` unchanged, record
   their SHA-256, and stop the harness, keeping its work only on failure.

A recapture has new identifiers and a new hash, so it replaces this fixture and
its table row together; tests name the root and leaf ids directly.

## E2e offline consumer bundle

`e2e-consumer-v0/` was copied byte-for-byte from Hekate's reviewed bundle on
2026-10-07 (lead handoff, bridge message 1340). Its `INDEX.sha256` has SHA-256
`6093034b04c0762daf55eace33ba6ea226966591016a4fd56a780b50458daf0b`;
all 26 indexed files were checked before and after copying. Git text conversion
and Prettier are disabled for the entire directory.

The producer is Hekate `d0ed671` plus the accepted E2c/E2d/E2e fixture overlay.
Plan 034 revision 3 has SHA-256
`17273a5194ccec681a7b9eca7089db84cf20fe3489e64f3729130059cd2ab9db`;
the accepted plan 035 evidence including this bundle has SHA-256
`90a270904ff1490ce60ea594189368ba6528047bf190080631ab6cbfa8574cc6`.
Hekate's lead independently replayed all 17 cases against the pinned consumer.
The real H1 renderer used ChatAgent `5255daacfc670a4919f61439eb12adcb6a401920`
and Windows Node 24.21.0; prior-conversation sources are explicitly synthetic.

The bundle's `fresh.json` is historical fixture evidence, never current authority.
Policies are test stubs. The imported Python generation/replay scripts are retained
as provenance artifacts and are not ChatAgent runtime code or test prerequisites.
Use the bundle README, raw byte files and recorded expectations for offline
consumer validation; do not regenerate or reserialize them in place.

## E2e byte-compatibility supplement

`e2e-byte-compat-v0/` was copied byte-for-byte from Hekate's reviewed supplement
(`scripts/local/supervisor_e1/fixtures/e2e-byte-compat-v0`) on 2026-10-07 (lead
assignment, bridge message 1378). Its `INDEX.sha256` has SHA-256
`5ee9ff709b6210a95427319a649a67fbff0ca6dee3d72e1a051ffe7b03792605`; all 93
indexed files were checked after copying, and no unlisted file is present. Git
text conversion and Prettier are disabled for the entire directory.

It supplements, and never replaces, the golden bundle above: 34 generic JSON byte
vectors (not deliveries) and 5 producer-reachable deliveries whose receipts and
as-of proofs are synthetic and whose H1 builder is the H1-shaped stub, not
ChatAgent's real H1. Its Python generation/replay scripts are provenance only.
