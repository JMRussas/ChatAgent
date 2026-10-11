# UI Plan

## Current direction: visible work and decisions (2026-10-10)

The [development roadmap](12-development-roadmap.md) records delivery status.
The workspace home now opens real projects, saved conversations and editable
plans. Direct controls, conversation actions and MCP use the same application
tools. Opening a plan never runs it. A step may use an API, a model, an agent or
human input; the plan describes its inputs, outputs and completion rules as data.

Claude Fable's review of the actual desktop and mobile views defines the next
layout. Implementers verify correctness; Fable assesses clarity against fresh
screens, and the user accepts the result. Technical checks alone do not establish
that the UI is understandable.

- Summary cards distinguish decisions, in-progress work, ready work and attention
  needed. Allocation is displayed separately from confirmed running state.
- Each work row names the next action and actor, or the pending question or last
  recorded outcome. Read errors never inflate the decision count.
- A visible detail summary explains status, next action and the scope of any
  approval. Pending instructions and a Respond action precede detailed steps.
- Step inputs, outputs, plan JSON and execution history remain available through
  drill-down. A completed run is not whole-task verification. An approved human
  result is labelled as approval of that step; older revisions are history.
- A bounded factual work digest supplies the same state to the UI, conversation
  tools and MCP. Full records remain available through the existing tools.
- Conversations show idle or reply-in-progress state and retain links to work
  while the live chat is open. Mobile history is legible from its first render.

Fable's acceptance review checks whether the screen immediately reveals how many
decisions are waiting and what the first asks, whether outstanding counts add up,
and whether each row explains who acts next and when the record changed. It also
checks truthful allocation/approval/history labels, accessible evidence, agreement
between tool summaries and the UI, and a fully visible mobile selection. Missing
source evidence remains unknown. Review uses real records; deterministic test
fixtures prove behavior separately and do not replace product data.

The first independent screen review returned **needs changes**. Its immediate
design correction makes Respond open the question and existing answer form first,
with plain answer, explicit approval and raw JSON choices. Full plan controls
remain separately available. Mobile selection and allocation wording also need
the reviewed corrections; their delivery status belongs in the roadmap.

The next Fable-designed increment is a create-only step form. Name the goal, add
ordered steps, choose who or what performs each one, provide its instructions or
tool inputs, and optionally specify a result check. It saves the existing plan
definition through `create_plan`; it does not introduce execution semantics.
Generic tools retain explicit JSON inputs and schema/binding hints. Saved-plan
editing and advanced definitions keep the JSON editor. Tool input validation at
execution is distinct from definition validation at save. Fresh real-data creation
and execution screens require independent review before claiming improved clarity.

## 2026-09-30 direction: topic and task workspace

Plan the NBA demo around league/team topics and task-related conversations, with
current queued/running/needs-input/complete/failed/cancelled states and unread results.
Keep layer 1 available while work runs. Historical latency buckets belong in optional
diagnostics, not the primary workspace. Quick follow-ups stay within their thread;
substantial investigations may become linked tasks. See [the demo plan](18-nba-briefing-demo.md).
This is planned, not a UI change in the current slice. Conversation indexing and
persistence must be addressed before promising durable threads. The current UI
already uses SSE and preserves answer phases; older polling/swap-only claims below
are historical. No UI restart or preview change is required for the planner slice.

Status: historical proposal, partially implemented. The current plan is
[the development roadmap](12-development-roadmap.md). The UI, SSE timeline updates,
automatic deep worker, provider readout, and message-correlated replies are now
implemented. Statements below about missing SSE or automatic workers describe
the original proposal, not the current application.

Built now:

1. `GET /` serves a static vanilla HTML/CSS/JS control-room page.
2. The page submits prompts to `/messages` and polls `/conversations/:id/events` and `/telemetry/latency`.
3. The chat thread shows provisional replies and swaps to refined replies when deep results land.

Remaining:

1. Provider comparison UX decision (read-only active providers vs runtime switch endpoint).
2. Optional transport upgrade from polling to push (SSE/WebSocket) if needed later.

## Why this exists

`docs/05-tdd-execution.md` lists 24 completed phases, all backend, testing, telemetry, and benchmarking. A UI was never in scope: it is not in `docs/01-product-scope.md`, and it is not called out as an explicit non-goal either — it simply was not considered. The demo script assumes a human reads curl output, which undercuts the "responds immediately, then improves itself" story this prototype exists to prove (see the architecture rationale in `docs/02-architecture.md`).

## The one requirement the UI has to satisfy

Make the fast-then-refined swap visible. That transition is the entire value proposition. If a viewer cannot see a provisional reply upgrade to a refined one, the dual-path architecture is invisible and the UI is just a chatbot.

## Recommended shape

**Two-panel layout**, not a plain chat window:

1. **Main panel — chat thread.** Each user turn gets a reply bubble tagged "provisional" the moment it lands (under a second for `direct`/`deep`), which visibly updates in place to "refined" with citation links when the deep result arrives. A brief highlight or fade on the swap makes the upgrade legible instead of silent.
2. **Side panel — live routing readout.** For the current turn: route decision (`direct` / `deep` / `clarify`) with its reasons, confidence score, fast-path latency estimate, and queue depth (from `GET /telemetry/latency`). This is what actually sells the architecture — it shows the router's reasoning, not just its output — and doubles as the source for the "Metrics slide" step in the demo script.

**Per-route visual treatment**, so the three paths read as three different mechanisms, not three colors of the same thing:

- `direct`: single bubble, done immediately, no provisional/refined split.
- `deep`: provisional bubble first, swaps to refined with citation links and a small latency readout (e.g. "answered in 640ms, refined in 2.1s").
- `clarify`: visually distinct (e.g. dashed border, different accent), so it does not read as a wrong answer.

## Open design question: provider comparison

Demo script step 4 ("flip provider config from Azure to Bedrock, re-run one deep prompt, compare metrics") assumes the UI can do this live. Today the provider is chosen once at server startup via `CHAT_FAST_PROVIDER` / `CHAT_DEEP_PROVIDER` env vars (`src/config/providerConfig.ts`), with no runtime switch. Two options, and this needs a decision before building that part of the UI:

- **A — read-only.** The UI shows which providers are currently active; switching still requires restarting the server with different env vars.
- **B — runtime switch.** Add an endpoint (e.g. `POST /providers/set`) that rebuilds the provider pair without a restart, and let the UI drive it.

Recommendation: ship with A first (near-zero cost, unblocks everything else), add B only if the live provider-swap demo moment turns out to matter more than the schedule allows for now.

## Hard dependency: the deep worker does not run on its own

Nothing drains the task queue today except a manual `POST /workers/deep/run-once` call (`src/server.ts`). The class map (`docs/10-class-map.html`) shows this as the `TaskQueue` port between `ChatOrchestrator` and `DeepWorker`; nothing currently polls the `dequeue()` side. Without a background loop, the UI's "watch it refine live" moment never happens on its own — a viewer would sit on "provisional" forever unless the UI itself silently calls the run-once endpoint behind the scenes, which is a real but low-quality workaround.

This was flagged independently in the code review (`docs/09-code-review-2026-09-25.md`, finding D1) and again here because the UI plan depends on it directly.

## Build approach

A single static HTML page with vanilla JS and CSS, served from a new `GET /` route on the existing server, polling `GET /conversations/:id/events` and `GET /telemetry/latency` roughly once a second. No framework, no build step — consistent with the rest of this stack (bare `node:http`, no bundler in `package.json`). Server-sent events or WebSockets would be a nicer later upgrade, not a first-cut requirement at this scale.

## Recommended build order

1. **Background deep worker loop.** A `setInterval`-driven loop in `src/server.ts` that calls the same logic as `POST /workers/deep/run-once`, with an env var to disable it so tests and the live benchmark (`src/bench/liveBenchmark.ts`) keep deterministic manual control. Own tests.
2. **`GET /` route + static page.** Chat thread, side panel, per-route styling, polling loop against the two endpoints above. Own tests for the new route; the page itself is manually verified per the demo script.
3. **Provider comparison** — deferred pending the A/B decision above.
