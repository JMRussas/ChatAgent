# ChatAgent Prototype: Fast Brain + Deep Brain

This repository is a test-driven starter for a dual-path chatbot:

- Fast path: immediate, low-latency user response
- Deep path: asynchronous analysis with refined follow-up response

The goal is a strong portfolio prototype that demonstrates architecture, measurement, and cross-provider portability (Azure + Bedrock + other model providers).

## Why this exists

Most chatbot demos are single-path. This prototype demonstrates:

1. Perceived-latency optimization
2. Async orchestration and routing
3. Provider abstraction beyond specific model families
4. Objective success metrics and evaluation gates

## Quickstart

1. Install dependencies:

```bash
npm install
```

2. Run tests:

```bash
npm test
```

3. Run local demo:

```bash
npm run dev
```

Server starts on `PORT` (default `3100`).

Open `http://localhost:3100/` to use the built-in prototype UI.

## HTTP API

Malformed JSON payloads on POST endpoints return `400` with error `Invalid JSON body`.
JSON bodies for POST endpoints must be non-null objects; `null`, arrays, and primitive values return `400`.

1. Submit message

```bash
curl -X POST http://localhost:3100/messages \
	-H "Content-Type: application/json" \
	-d '{"conversationId":"conv1","userId":"u1","text":"Find latest inflation data and cite sources"}'
```

2. Run deep worker once

```bash
curl -X POST http://localhost:3100/workers/deep/run-once
```

3. Get conversation timeline

```bash
curl http://localhost:3100/conversations/conv1/events
```

4. List deep-worker dead-letter records

```bash
curl http://localhost:3100/workers/deep/dead-letters
```

5. Replay a dead-letter task

```bash
curl -X POST http://localhost:3100/workers/deep/dead-letters/<taskId>/replay
```

6. Read latency telemetry and current routing policy

```bash
curl http://localhost:3100/telemetry/latency
```

Response now also includes `queueDepth` for the current in-memory deep-task queue.

7. Trigger policy auto-tune based on queue depth

```bash
curl -X POST http://localhost:3100/routing/policy/tune \
	-H "Content-Type: application/json" \
	-d '{"queueDepth":10}'
```

## TDD flow

Use this loop for each feature:

1. Write or update tests in `tests/`
2. Run `npm run test:tdd`
3. Implement minimal code in `src/`
4. Refactor while tests stay green

## Configuration and secrets

All configuration is read from environment variables. Nothing is hardcoded, and nothing sensitive is committed to the repository.

Local setup:

```bash
cp .env.example .env
# then edit .env with real values
```

`.env` is listed in `.gitignore` and is never committed. `.env.example` is the checked-in template: it lists every variable this app reads, with safe placeholder or empty values, and comments marking which ones are secrets.

Security rules this project follows:

1. **No secret ever lives in a committed file.** `AZURE_OPENAI_API_KEY` is the only credential this app reads directly, and it is only ever read from `process.env` at request time, never written to disk, logged, or echoed back in an HTTP response.
2. **AWS credentials are never handled by this app's own config.** For `CHAT_*_PROVIDER=bedrock`, only `BEDROCK_REGION` (not a secret) is read. Actual AWS credentials come from the standard AWS SDK credential chain (`aws configure`, an IAM role, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` set as real environment variables) — not from `.env`.
3. **A real environment variable always wins over `.env`.** `.env` is for local convenience only; in CI, a container, or a platform with a secret manager, set real environment variables and the `.env` file (if present at all) is ignored for any variable that's already set.
4. **Fail fast, not silently.** If a non-mock provider is selected but its required variables are missing, the server refuses to start and prints a clear error naming the missing variable — it never falls back to a placeholder value that would only fail later, mid-request.
5. **Startup logging is redacted by design.** The server logs which providers/models are active on startup (see `describeProviderConfig` in `src/config/providerConfig.ts`), but that summary is built to exclude anything that could be a credential, so it's always safe to leave in place and to ship to a log aggregator.
6. **This server has no built-in authentication.** It's a local prototype. Don't expose it to the public internet without adding an auth layer in front of it (reverse proxy, API gateway, etc).
7. **For a real deployment**, prefer your platform's secret manager (AWS Secrets Manager, Azure Key Vault, or your host's injected environment variables) over shipping a `.env` file at all.

## Provider configuration

Fast and deep layers are independently configurable. This allows mix-and-match across Azure, Bedrock, and Ollama.

Supported provider values:

1. `mock`
2. `azure`
3. `bedrock`
4. `ollama`

Core environment variables:

```bash
CHAT_FAST_PROVIDER=ollama
CHAT_FAST_MODEL=llama3.1:8b
CHAT_DEEP_PROVIDER=bedrock
CHAT_DEEP_MODEL=anthropic.claude-3-5-sonnet-20240620-v1:0
CHAT_FAST_TEMPERATURE=0.2
CHAT_DEEP_TEMPERATURE=0.2
```

Provider-specific settings:

```bash
# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_API_VERSION=2024-10-21

# AWS Bedrock
BEDROCK_REGION=us-east-1

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_FAST_TIMEOUT_MS=20000
OLLAMA_DEEP_TIMEOUT_MS=60000
OLLAMA_FAST_NUM_PREDICT=256
OLLAMA_DEEP_NUM_PREDICT=512
```

Azure and Ollama HTTP calls use bounded request timeouts so a hung upstream cannot block the fast path indefinitely.
If local Ollama models are large or cold-start slowly on your hardware, increase `OLLAMA_FAST_TIMEOUT_MS` and `OLLAMA_DEEP_TIMEOUT_MS`.
If a model emits long reasoning traces and returns empty final text at low token budgets, increase `OLLAMA_FAST_NUM_PREDICT` and `OLLAMA_DEEP_NUM_PREDICT`.

Evaluation reliability thresholds (optional env vars):

```bash
EVAL_MAX_DEAD_LETTER_RATE_DEEP=0.1
EVAL_MAX_AVG_RETRIES_DEEP=1
```

Adaptive routing threshold (optional env var):

```bash
ROUTING_MAX_FAST_P95_MS=1000
TELEMETRY_STORE_PATH=data/latency-telemetry.json
TELEMETRY_SAVE_INTERVAL_MS=5000
DEEP_WORKER_AUTO_RUN=true
DEEP_WORKER_INTERVAL_MS=500
```

Telemetry snapshots are schema-validated on load/save. Invalid or malformed snapshot files are ignored with warnings, and snapshot writes use atomic file replacement.
`ROUTING_MAX_FAST_P95_MS` and `TELEMETRY_SAVE_INTERVAL_MS` are normalized and clamped to safe ranges during startup.
When `DEEP_WORKER_AUTO_RUN=true`, the server drains one deep task per interval tick so provisional replies can refine automatically without manual `/workers/deep/run-once` calls.

UI behavior:

1. `GET /` serves a static control-room page (vanilla HTML/CSS/JS) for desktop and mobile.
2. The page posts to `/messages` and polls `/conversations/:id/events` plus `/telemetry/latency` once per second.
3. Deep-route turns render provisional replies first and then swap in-place to refined replies when background processing completes.

Adaptive routing behavior:

1. Classifies prompt complexity, ambiguity, external-data need, and size band.
2. Seeds provider/model priors for latency percentiles by route and size.
3. Blends priors with live observations as traffic increases.
4. Uses p95 guardrail to escalate moderate requests to deep path when fast-path tail latency is predicted to breach SLO.

## Benchmarking

Run profile benchmark report generation:

```bash
npm run bench:run
```

Set an explicit simulation seed for reproducible benchmark candidates:

```bash
BENCH_SIM_SEED=default-v1
npm run bench:run
```

Run benchmark in live mode against a running local server:

```bash
BENCH_MODE=live
BENCH_BASE_URL=http://localhost:3000
npm run bench:run
```

`BENCH_MODE` must be either `simulate` or `live`; invalid values fail fast.
Benchmark prompt files are validated for non-empty `{ id, text }` records with unique ids.
The benchmark runner executes only when called as a CLI entrypoint, so importing it in tests does not trigger benchmark runs.

Compare candidate benchmark run to baseline with gates:

```bash
npm run bench:compare
```

Compare also enforces benchmark context compatibility (mode, prompt digest, profile digest, and simulation seed when available).
It also requires full profile-set parity (no missing/extra profile names between baseline and candidate).

Optional compare thresholds/env:

```bash
BENCH_BASELINE_PATH=reports/benchmark-summary-baseline.json
BENCH_CANDIDATE_PATH=reports/benchmark-summary.json
BENCH_COMPARE_OUT=reports/benchmark-compare.md
BENCH_MAX_FIRST_P95_REGRESSION_MS=150
BENCH_MAX_FINAL_P95_REGRESSION_MS=300
BENCH_MAX_DEAD_LETTER_REGRESSION=0.05
BENCH_MIN_QUALITY_DELTA=-0.05
```

Threshold values are validated at runtime; invalid values fail compare with explicit configuration errors.

## Release Verification

Run the full release gate in one command:

```bash
npm run verify:release
```

This runs:

1. tests
2. type-check
3. evaluation report generation
4. benchmark run
5. benchmark compare gates

Artifacts:

1. `reports/benchmark-summary.json`
2. `reports/benchmark-summary.md`
3. `reports/benchmark-compare.md`

Examples:

1. Fast on Ollama, deep on Bedrock

```bash
CHAT_FAST_PROVIDER=ollama
CHAT_FAST_MODEL=llama3.1:8b
CHAT_DEEP_PROVIDER=bedrock
CHAT_DEEP_MODEL=anthropic.claude-3-5-sonnet-20240620-v1:0
```

2. Fast on Azure, deep on Ollama

```bash
CHAT_FAST_PROVIDER=azure
CHAT_FAST_MODEL=gpt-4o-mini
CHAT_DEEP_PROVIDER=ollama
CHAT_DEEP_MODEL=qwen2.5:14b
```

## Project docs

- Product and scope: `docs/01-product-scope.md`
- Architecture: `docs/02-architecture.md`
- Success metrics: `docs/03-success-criteria.md`
- Evaluation methodology: `docs/04-evaluation-plan.md`
- TDD execution plan: `docs/05-tdd-execution.md`
- Model/provider strategy: `docs/06-model-strategy.md`
- Demo script: `docs/07-demo-script.md`
- Engineering decision log: `docs/08-engineering-decision-log.md`
- Code review (2026-09-25): `docs/09-code-review-2026-09-25.md`
- Class map (open in a browser): `docs/10-class-map.html`
- UI plan (proposed, not yet built): `docs/11-ui-plan.md`
