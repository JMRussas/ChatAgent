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
