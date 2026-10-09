# 25 — Local Hekate work disposition

Source HEAD `10163d97820cda2b739943981de662ea29d854b8`; published Hekate main
`4fa65283862ead9181cfb5530fa5b8861516a5f9`. Machine-readable record:
[25-local-hekate-work-disposition.json](25-local-hekate-work-disposition.json)
(`local-hekate-disposition/v1`).

**Result: no implementation task is opened.** The six groups yield 0 Keep, 3 Extract
(groups 2–4, as design reference), 2 RetainEvidence (groups 5–6) and 1 Retire (group 1). Deferred semantic-edge and LangGraph work stays archived
and out of the MVP.

## Preservation status

`proof.json` supplies `restoreFsckPassed: true`, `originalStatusUnchanged: true`, 4,357
files and 42,139,328 bytes (group counts sum correctly). These are operator-supplied.
This assessment ran no restore, fsck or hash check, so it does not assert successful
preservation. Those gates stay independent. Original local work was not modified.

## Decision table

| #   | Group                                                          | Disposition    | Reason                                                                                                                                                                                                | Implementation |
| --- | -------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | `.gitignore` checkpoint pattern                                | Retire         | Only ignores `checkpoints.sqlite*` for the group 4 prototype, which is not integrated. Published `.gitignore` has no such rule. Patch stays preserved.                                                | No             |
| 2   | `Program.cs` + `CodeService.cs` rebuild-edges endpoint/service | Extract        | Thin wrapper over group 3; absent from published main. Returns `ex.Message` via `Results.Problem`, runs as one long request, and bypasses the `FinalizeDecomposition` sequence. Reference shape only. | No             |
| 3   | `SemanticEdgeResolver.cs`                                      | Extract        | Real gap versus substring-based `EdgeSeeder`, but untested and with source-visible defects (below). Roadmap already defers semantic edges.                                                            | No             |
| 4   | `Odin/langgraph_engine/` (17 files)                            | Extract        | Not safe wholesale: second task ledger, best-effort domain writes, no claim fence, unbounded cost, fail-open verifier, permission-skipping executor without isolation. Reuse ideas only.              | No             |
| 5   | `LOCAL-PLANNING-HANDOFF.md`                                    | RetainEvidence | Dated 2026-10-06 proposal. Managed PlanStore workflow is now documented and wired in published main. Keep as history, not current instructions.                                                       | No             |
| 6   | `.review_tmp/` (4,335 files)                                   | RetainEvidence | Preserved review evidence needing later deduplication; not product source. Contents not opened and may be sensitive. Hash preservation does not show it is throwaway.                                 | No             |

## Source-backed findings

Paths are under `.review-inputs/cleanup-loop-001/`.

### Groups 2–3: semantic edges

- Published has no `rebuild-edges` route or `RebuildSemanticEdges` method
  (`published/context-store/Api/Program.cs:382-424, 477`;
  `published/.../Services/CodeService.cs:34-102`).
- The gap is real: `EdgeSeeder` matches names by substring inside one file
  (`published/.../EdgeSeeder.cs:8-9, 60, 75, 89`).
- Resolver defects (`local/.../SemanticEdgeResolver.cs`):
  - Keys are name plus parameter count, so same-arity overloads collide (238, 295);
    lookup writes are plain assignments, so duplicates keep the last node (295-308).
  - Edge failures are swallowed yet the result reports `ok` (198, 210-214).
  - Dedup is per run only (120), so reruns depend on `CreateEdge` idempotency.
  - Metadata references come from the host's loaded assemblies (103-109).
  - Edges are written directly; published `Program.cs` drains a graph outbox
    (203-207) and reports `outbox_pending` (145). Whether `AgeLayer.CreateEdge`
    uses the outbox is **unknown**: `AgeLayer`/`AgeGraphService` are not in the
    published pack, so no absence claim is made.
- Useful idea: Roslyn `SemanticModel` over one compilation for cross-file CALLS and
  REFERENCES. Tested behavior: none.

### Group 4: LangGraph prototype

- README says it was never executed end to end (`README.md:232-235`);
  `test_engine.py` covers only pure logic (gates, reducer, ready selection, routing).
  Not run here.
- **Authority:** `db.py:110-158` writes legacy `projects/plans/tasks/task_deps`
  rows, a competing ledger next to the managed PlanStore (`published/README.md:33-36`).
- **Checkpoint vs domain state:** checkpoints are a separate SQLite file
  (`README.md:220-223`); domain writes are best-effort (`db.py:14-18, 79-86`).
  Divergence is silent.
- **Ownership:** no claim, epoch or attempt fence in the package. A checkpoint resume
  does not prove an effect is safe to repeat.
- **Retries/cost:** retry re-runs the same executor in the same directory with
  verifier text in the prompt (`mimir.py:87-100`, `hermes.py:68-75`). `cost_usd` is
  recorded but never enforced; only `max_retries` and a 50-round cap bound it
  (`odin.py:30`).
- **Verification:** Mimir is a lenient LLM judge (`mimir.py:24-26`) and passes at
  confidence 0.0 when the verifier fails (`mimir.py:66-75`). That is automatic
  semantic acceptance without external tests.
- **Execution safety:** CLI executor uses `--dangerously-skip-permissions` and
  `Bash(*)` in the caller's directory with no worktree (`hermes.py:145-152`); timeout
  kills only the child (`hermes.py:167-169`). The tool allowlist includes `python`,
  `git`, `npm`, `node`, `dotnet`, `pip` (`tools.py:29-32`), so it is not a sandbox.
- **Roles:** it re-implements Athena/Odin/Mimir/Hermes/Hephaestus as graph nodes,
  overlapping the existing CLI roles and the checkpoint design where Hermes is the
  coding worker and Mimir the external check role
  (`docs/implementation/22-checkpoint-continuation-manager.md` §2).
- **Reusable ideas (not tested behavior):** replace-by-id reducer (`state.py:70-81`),
  plan gate rejecting cycles/unknown/duplicate dependencies, typed Plan/Verdict
  schemas, readable graph shape.

### Group 5

Published README documents the managed PlanStore, claim receipts, attempt identities
and acceptance decisions (`README.md:33-36`), and `Program.cs:45, 110` registers the
schema and endpoints. The handoff's suggestion to adapt LangGraph was not what was
delivered. Correspondence of individual requirements was not tested.

## Limits

The published pack holds only six selected files, so unavailable files support no
absence claim. No build, test or runtime was executed. No runtime, deployment,
full-history or public-readiness claim is made. Acceptance of this document is a
separate lead decision.

## Next checkpoint

1. Operator completes restore/fsck and source-hash verification against
   `inventory.json` and `source-manifest.json` and records the result.
2. Lead reviews this disposition.
3. Keep groups 3 and 4 archived; open no implementation task. If semantic edges are
   later prioritized, use one bounded checkpoint with compile-backed fixtures and an
   explicit edge-write/outbox decision.
4. Optional: deduplicate `.review_tmp` hashes against retained evidence before any
   deletion decision.
