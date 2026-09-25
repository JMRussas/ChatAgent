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

Server starts on `PORT` (default `3000`).

## HTTP API

1. Submit message

```bash
curl -X POST http://localhost:3000/messages \
	-H "Content-Type: application/json" \
	-d '{"conversationId":"conv1","userId":"u1","text":"Find latest inflation data and cite sources"}'
```

2. Run deep worker once

```bash
curl -X POST http://localhost:3000/workers/deep/run-once
```

3. Get conversation timeline

```bash
curl http://localhost:3000/conversations/conv1/events
```

4. List deep-worker dead-letter records

```bash
curl http://localhost:3000/workers/deep/dead-letters
```

5. Replay a dead-letter task

```bash
curl -X POST http://localhost:3000/workers/deep/dead-letters/<taskId>/replay
```

6. Read latency telemetry and current routing policy

```bash
curl http://localhost:3000/telemetry/latency
```

7. Trigger policy auto-tune based on queue depth

```bash
curl -X POST http://localhost:3000/routing/policy/tune \
	-H "Content-Type: application/json" \
	-d '{"queueDepth":10}'
```

## TDD flow

Use this loop for each feature:

1. Write or update tests in `tests/`
2. Run `npm run test:tdd`
3. Implement minimal code in `src/`
4. Refactor while tests stay green

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
```

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
```

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

Run benchmark in live mode against a running local server:

```bash
BENCH_MODE=live
BENCH_BASE_URL=http://localhost:3000
npm run bench:run
```

Compare candidate benchmark run to baseline with gates:

```bash
npm run bench:compare
```

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
