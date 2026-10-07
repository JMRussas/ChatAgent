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
