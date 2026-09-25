# UI Plan

Status: partially implemented (Phase 26 complete).

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
