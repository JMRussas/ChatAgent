# Architecture

2026-09-26: the components below describe the existing prototype. [ADR 0002](adr/0002-layered-context-and-orchestration.md) defines the proposed broader boundaries: responsive conversation here, persistent orchestration evaluated in Hekate, layer-specific context, dynamic retrieval, structured prompt rendering and telemetry for separate analysis. These are not implemented by this documentation update.

## Components

1. Ingress/API
- Receives user message
- Calls orchestrator
- Returns fast response immediately

2. Fast analyzer/router
- Normalizes prompt
- Decides route: `direct`, `deep`, `clarify`
- Assigns confidence and reason codes

3. Fast provider
- Generates immediate user-facing response

4. Task queue
- Buffers deep-analysis work

5. Deep worker
- Executes deeper retrieval/tool reasoning
- Produces refined answer and citations

6. Conversation timeline store
- Stores user, provisional, and refined events

## Provider abstraction

Use two interfaces:

1. `FastModelProvider`
2. `DeepModelProvider`

Examples to support:

1. Azure OpenAI model family
2. AWS Bedrock model family
3. Optional: OpenAI/Anthropic direct APIs or local model runtime

## Event flow

1. `UserMessage` -> Orchestrator
2. Orchestrator returns `FastResponse`
3. If deep route, enqueue `DeepTask`
4. Worker consumes task -> emits `DeepResult`
5. Client timeline updates with refined answer
