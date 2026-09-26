# 01 extension — Internal compression and source-linked memory

Revision 2, 2026-09-25. Normative extension to 01-context.md. Implementation checkpoint: 01B is implemented in ChatAgent; see
[acceptance evidence](01b-evidence.md). The requirements below remain normative. Summarization is a context-management operation;
it must never create a user-visible chat reply or replace original transcript text.

## Safe continuation for an implementation already underway

01A keeps the original bounded-history builder, provider message mappings, budget
checks, ownership boundary and immutable task snapshots. Add the v2 memory/task
fields (memory null initially), plus pending task selection. Then implement 01B
below. Commit these independently. Spec 02 can start after 01A; do not claim the
whole context milestone complete until 01B tests pass. If v1 snapshots already
exist in code, normalize them to v2 with null memory/empty task arrays on consumption;
never reread live history to enrich an existing queued snapshot.

No implementation changes should be discarded because the plan revision arrived.
Existing tests expecting all pending requests to disappear need the specific
expectation changed; tests preventing provisional answers from becoming accepted
history must remain.

## State boundaries and types

The context manager prepares four distinct inputs: exact recent exchanges,
derived older memory, unresolved task state, and trusted runtime facts. Keep the
original message/tool records as the evidence layer. No vectors or database are
required in this milestone. An in-memory SourceStore has an explicit interface;
its lifetime matches current conversation storage. Do not claim restart persistence.
Future retention/deletion must invalidate dependent summaries and source references.

```ts
interface SourceRef {
  conversationId: string;
  eventId: string;
  messageId: string;
  contentHash: string;
}
interface MemoryItem {
  id: string;
  kind: "goal" | "decision" | "constraint" | "open-question" | "claim";
  text: string;
  provenance: "user-stated" | "tool-observed" | "assistant-claimed";
  sources: readonly SourceRef[];
  status: "active" | "superseded" | "disputed";
  supersedes?: string;
}
interface ContextMemory {
  id: string;
  revision: number;
  coveredThroughSequence: number;
  sourceDigest: string;
  items: readonly MemoryItem[];
  method: "extractive-v1" | "model-v1";
}
interface ActiveTaskContext {
  messageId: string;
  requestText: string;
  state: "queued" | "running" | "retrying" | "failed" | "cancelled" | "incomplete";
  source: SourceRef;
}
```

Add stable eventId and monotonically increasing per-conversation sequence in
timelineStore now (spec 02 reuses them). SourceStore indexes immutable records by
conversationId/eventId; SHA-256 of canonical content supplies contentHash. Reads
are scoped to conversation ownership and return copies. Replays/refinements add
events, never edit old source content. Lookup of another conversation or missing/
hash-mismatched source returns an explicit unavailable result, never substitute text.

`ContextManager.prepare()` captures one immutable event snapshot then calls the
pure builder with the latest valid memory derived entirely from that snapshot's
prefix. `SummaryStore` holds versioned memory per conversation. A
`ContextSummarizer.summarize(records, signal)` port returns schema-validated items.
No adapter looks up history independently. The public /messages request cannot
inject memory, fact provenance, source refs or trusted runtime fields.

## Pending work and facts

Pending requests matter even though their unfinished answers are untrusted.
Include up to four most recent unresolved turns, ordered by user-event sequence,
in activeTasks. Failed/cancelled/incomplete turns stay unresolved until a new
successful completion/replay for that message, or until displaced by this bound.
This is awareness, not permission to cancel/change tasks. Prior unfinished answers,
provider errors and activity prose never enter these request records.

Whole request records only; exclude records that do not fit and list their IDs
in omittedActiveTaskIds. Do not relabel old failures as work still running. Models
must acknowledge unavailable details instead of inventing them.

Memory provenance describes who supplied information, not its truth. A user claim
is not verified by repetition; an assistant answer is not a verified fact. Tool
observations must cite actual tool records (there are none today; do not synthesize
them). Prefer user constraints over inferred preferences. Conflicting records remain
disputed until an explicit correction; a supersedes link requires cited evidence
of correction. Never infer a global preference from one task-specific instruction.

## Compression policy and source checking

Add validated settings:

- `CONTEXT_SUMMARY_MODE=extractive` (off/extractive/model).
- `CONTEXT_SUMMARY_TRIGGER_RATIO=0.8` (greater than 0, at most 1).
- `CONTEXT_SUMMARY_MAX_TOKENS=1024` (positive).
- `CONTEXT_SUMMARY_TIMEOUT_MS=5000` (positive).

Compute usable input allowance after spec 01 system/role/output/safety reserves.
Trigger background compression when uncompressed eligible history exceeds 80%
of that allowance, or more than the configured max-history-turns eligible pairs
would be retained. Keep the newest four completed pairs out of compression where
possible; if fewer than five exist, do not create a summary. The current turn
never waits for new summary generation: use the latest valid memory or bounded
history. Schedule one job per conversation over a captured older prefix. Coalesce
later demand and cancel superseded jobs; publish by compare-and-swap on expected
summary revision so stale results cannot overwrite newer memory.

Default extractive summarization selects verbatim source-backed excerpts from the
older prefix, newest-first within the memory allowance; mark them kind claim with
their actual provenance. It must not pretend to infer goals/decisions. Optional
model mode can produce the richer structured kinds, but requires an explicitly
configured existing summarization provider, instruction/input/output budget and
deadline. Missing configuration fails startup in model mode; it must not quietly
call the deep provider or incur extra model calls in extractive mode.

Summarize original records, not previous summaries alone. Chunk oversized prefixes
into bounded requests; validate each result and merge by source identity. Budget
all internal requests separately and record failure/latency/counts without text.
No recursive orchestration: summary requests bypass ChatService and never enqueue
chat tasks or emit provisional/refined events. Invalid output, timeout or missing
sources retains the prior still-valid memory; otherwise use bounded history.

Validate every cited ID/hash against captured sources, provenance against event
origin, coveredThroughSequence against input, and item/schema size. Model-generated
paraphrases remain derived claims even after these structural checks. A referenced
message's later refined answer invalidates affected memory for future preparations;
exclude that stale memory until rebuilt. Already queued snapshots remain unchanged.

Input allocation order after mandatory instructions/current user:
reserve up to 20% of remaining space for active task records; then newest complete
pairs up to four; then valid memory up to min(summary max, 25% of usable input);
then additional recent pairs up to max-history-turns. Exclude memory items whose
sources are already present verbatim. Omit whole records that cannot fit. Recount
the final serialized request; memory is expendable, current user is not.

Expose internal `resolveSources(refs, snapshot)` for direct source-ID checking, not
semantic search. Limit a call to four refs and the available input allowance.
When a turn explicitly asks to check a remembered claim, the context manager can
include original excerpts for up to four newest included memory items, replacing
those items within the same memory budget. Detect the initial narrow trigger via
whole phrases “how do you know”, “check that”, “verify that”, or “what did I say”.
This is bounded verification support, not a claim of universal intent detection.
Record which refs were resolved/unavailable in snapshot metadata; never perform
uncapped recursive retrieval. Both providers receive the same resolved snapshot.

## Required acceptance tests for 01B

1. Under threshold: no summary job, recent messages exact, no visible summary bubble.
2. Over threshold: older-prefix job scheduled; current response need not wait; newest
   four pairs remain eligible as exact history. Off mode makes no summary calls.
3. Extractive mode makes zero model calls; model mode without provider fails startup.
4. Fake summarizer returns sourced items; immutable original records remain retrievable.
5. Wrong/missing/cross-conversation refs, wrong hashes/provenance, malformed output,
   timeout and oversized result are rejected without losing original history.
6. Competing revisions complete out of order; only the current eligible revision publishes.
7. A refinement/correction invalidates affected future memory without changing queued tasks.
8. User-stated and assistant-claimed material are distinct; conflicting constraints
   survive as disputed, not silently rewritten as a verified fact.
9. Source-check prompt receives bounded exact excerpts; missing sources are explicit;
   no duplicate current user or activity prose appears in provider messages.
10. Pending A is visible as request/state to B, but no incomplete answer is accepted.
11. Memory/task/data blocks containing instruction-like source text remain data,
    never promoted into trusted system instructions; final serialization fits budget.
12. Summary jobs are cancelled and awaited by shutdown (wire into spec 06 lifecycle).

Use fake clocks/deferred summarizers for deterministic tests. Model summary quality
requires separate live evaluation; passing provenance checks alone does not prove
that a paraphrase faithfully represents its sources.
