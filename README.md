# ChatAgent — responsive chat and background AI workflows

ChatAgent explores how an AI assistant can keep a conversation available while
background agents retrieve evidence and execute bounded work. It combines streaming
chat, cancellation, context management, and a LangChain documentation agent with
LangGraph checkpointed execution.

Built by [Justin M Russas](https://github.com/JMRussas). This is a working local
engineering prototype with reproducible experiments, not a hosted production
service. The GitHub repository and internal package retain the name **ChatRuntime**.
No sibling repository or private project is required to run it.

**Start here:** [Engineering case study](docs/portfolio-case-study.md) ·
[Results and evidence](docs/results.md) · [Demo walkthrough](docs/07-demo-script.md) ·
[Run locally](#run-locally)

## What it demonstrates

- **Responsive interaction:** streamed foreground answers and asynchronous deep
  follow-ups, with visible progress, cancellation and explicit incomplete outcomes.
- **Bounded agent execution:** a Python/LangChain agent searches and reads repository
  documentation; host code enforces tool, retrieval and model-call limits.
- **Durable task boundaries:** LangGraph and SQLite preserve confirmed checkpoints.
  Independent tasks support status, cancellation and resume; uncertain in-flight
  execution is refused rather than automatically replayed.
- **Context engineering:** bounded conversation snapshots and background source-linked
  memory; original transcript records remain intact. Completed documentation tasks
  appear separately and are not automatically inserted into model context.
- **Evidence-based decisions:** controlled prompt experiments, lifecycle fault
  injection and real local-model contention measurements inform the design.

## Task-based model dispatch

`MODEL_ROUTING_MODE=fixed` preserves the configured fast/deep pair. Opt into
`catalog` with curated limits, fresh discovery and a local resource policy to select
bindings by task, retained context, matching evaluations and configured priority.
Selections and fallback reasons appear on each turn; `/telemetry/dispatch` separates
fast/deep attempt records and reservation states. See
[configuration and limits](docs/implementation/04-dispatch.md#configuration) and
[offline acceptance evidence](docs/implementation/04-evidence.md).

## Selected results

Measurements are dated **September 2026**. Each link includes methods and limits.

| Question | Evidence | Decision |
| --- | --- | --- |
| Does prompt structure help consistently? | [600 scored Ollama calls](reports/prompt-contract/findings-2026-09-26.md): five model digests × 24 cases × five conditions. On held-out cases, headings scored 40/60 versus 38/60 for identical flat text. | Keep renderers configurable; a two-answer difference does not establish a universal advantage. |
| Does foreground priority improve responsiveness? | [Controlled local pilot](reports/doc-agent/contention-findings-2026-09-28.md): overlap first-answer medians of **477 ms concurrent, 479 ms FIFO, 569 ms priority**, six samples per policy. **18/18** noncancelled background tasks completed. | Keep production scheduling unchanged; the candidate did not demonstrate a benefit. |
| Are failure boundaries exercised? | [Local verification](reports/doc-agent/contention-v2-2026-09-28/release-check.txt): **258 TypeScript tests**; [Python verification](reports/doc-agent/contention-v2-2026-09-28/python-check.txt): **61 agent/lifecycle tests**. [Fault review](reports/doc-agent/lifecycle-edge-cases-2026-09-27.md) reproduced and fixed five lifecycle gaps. | Test cancellation races, deadlines, persistence failures and process death explicitly. |

Live model measurements, deterministic software tests and simulated release checks
are separate evidence. Test counts do not measure model accuracy; these small local
latency samples are not a production SLA. See the [evidence guide](docs/results.md).

## Architecture

```mermaid
flowchart TD
    UI[Browser conversation and task panel] --> Chat[TypeScript chat service]
    Chat --> Context[Bounded context and source-linked memory]
    Chat --> Fast[Streaming foreground provider]
    Chat --> Deep[Asynchronous deep worker]
    UI --> Tasks[Conversation-scoped task API]
    Tasks --> Bridge[Node to Python JSON-lines bridge]
    Bridge --> Manager[Independent task lifecycle and budgets]
    Manager --> Graph[LangGraph workflow]
    Graph --> Model[LangChain ChatOllama]
    Graph --> Tools[Bounded documentation search and read]
    Graph <--> Checkpoints[(SQLite checkpoints)]
    Fast --> Providers[Ollama / Azure / Bedrock adapters]
    Deep --> Providers
    Model --> Ollama[Local Ollama]
```

The documentation agent is an explicit optional action. The bridge admits up to
eight scheduled documentation tasks and runs one at a time; foreground chat uses
its own path. Shared inference scheduling is experimental, not enabled by default.
Conversation history remains in memory; documentation checkpoints are durable.

## NBA briefing prototype

The next demo is a personalized league/team briefing with background work and
source-backed follow-ups. The first slice plans tasks offline:

```bash
npm run sports:plan -- data/nba-briefing-request.example.json
```

Pass an optional second argument to select a custom briefing profile; the default
is `data/sports/nba-profile.example.json`. Windows, tasks and source budgets are
configurable. This fixed-time example fetches no live data and asks for a team selection. See the
[demo plan](docs/18-nba-briefing-demo.md) for implemented scope and next steps. Run
`npm run sports:fixture -- data/sports/briefing-request.fixture.json` to collect
fictional evidence through the coordinator; this does not fetch live NBA data.
NFL is also supported via `npm run sports:nfl -- 168` and the configurable
`data/sports/nfl-games-profile.example.json`. Existing-key NFL access was verified
with one request; live briefing/UI integration remains separate.
For a public RSS news read, use
`npm run sports:news -- data/sports/espn-nfl-rss.example.json 24`.
Feed scope and fetch bounds are configurable. Articles preserve publisher attribution
and original links; RSS coverage/freshness remain partial/unknown, so exit 1 is expected.
This command does not use BALLDONTLIE quota.
To enable live background briefings, set
`SPORTS_BRIEFING_CONFIG_PATH=data/sports/nfl-live-briefing.example.json` and restart.
Use the [start/status/cancel HTTP commands](docs/runtime-reference.md#optional-sports-briefing-http-boundary)
to collect games and news. Startup performs no sports requests; the current UI has
an explicit evidence form for recognized sports questions. The shared games budget allows five starts per rolling minute, including bursts.
Further requests fail fast until capacity returns; cached reads remain available.
After editing that configuration file, `POST /briefings/config/reload` with `{}`
applies validated changes without restarting. New runs record the configuration
version; existing work and service request history survive reload. The API key and
configuration-file path still require a restart to change.
An explicit `npm run sports:games -- 24` command prepares the BALLDONTLIE games
path using `BALLDONTLIE_API_KEY` from local configuration. No key is bundled; partial
coverage and unknown freshness remain visible. See the demo plan before live use.

## Run locally

Use Node 20.19+, 22.12+, or 24+; CI is configured for Node 22.
With no provider overrides, the application uses **mock providers**, so this first
run needs no cloud credentials, Python environment or model download:

```bash
npm ci
npm test
npm run dev
```

Open **http://localhost:3100/**. Mock replies demonstrate the interaction and
lifecycle, not live model quality. Existing environment variables or a local `.env`
can override defaults; [.env.example](.env.example) documents the settings.

For live documentation retrieval, install the Python dependencies and enable the
optional worker using the [self-contained setup guide](docs/implementation/11-conversation-tasks.md#enable-and-use).
The published live runs used locally installed `gemma4:26b`; it is not downloaded
automatically. Node and Python must run on the same OS.

Further commands and API details: [runtime reference](docs/runtime-reference.md).

## Scope and next work

This prototype has no built-in authentication or production deployment hardening.
Conversation ownership checks are not authentication. Source IDs and valid output
schemas do not establish that every answer claim is supported by its citation.
Provider adapters exist for Azure and Bedrock, but the linked agent and contention
results are local Ollama measurements.

As of 2026-09-29, active development resumed on the numbered runtime spec
(spec 03 — provider discovery/inventory); the documentation-agent/learning
track referenced below is parked, not the active priority. Automatic
task-result insertion, timed triggers and automatic learning are not
implemented. Older planning documents are historical where they conflict with
this overview; the [current roadmap](docs/12-development-roadmap.md) tracks sequencing.

## Explore the engineering

- [Case study: architecture, tradeoffs and AI-assisted development](docs/portfolio-case-study.md)
- [Evidence guide: results, limitations and reproduction](docs/results.md)
- [LangChain agent and LangGraph learning slice](experiments/doc-agent/README.md)
- [Task lifecycle and cancellation](experiments/doc-agent/TASKS.md)
- [Durability and fail-closed recovery](experiments/doc-agent/DURABILITY.md)
- [Conversation context and memory evidence](docs/implementation/01b-evidence.md)
- [CI workflow](.github/workflows/verify.yml): TypeScript checks and simulated regression gates; live Ollama and Python evaluations run separately.
