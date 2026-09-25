# Product Scope (Prototype)

## Objective

Build a chatbot prototype that behaves as two coordinated cognitive layers:

1. Fast brain: instant response and routing analysis
2. Deep brain: asynchronous refinement using tools/retrieval

## In scope

1. Message normalization and lightweight grammar cleanup
2. Intent/complexity routing to `direct`, `deep`, or `clarify`
3. Async deep-task queue and worker
4. Follow-up refined message with confidence and citations
5. Provider-agnostic interface with at least two concrete adapters in next phase

## Out of scope (prototype phase)

1. Full production auth and RBAC
2. Multi-tenant data isolation
3. Advanced policy engine
4. Large-scale load testing

## Core user journey

1. User sends prompt
2. Fast response appears in <1s target
3. If deep route selected, status indicates analysis in progress
4. Refined response arrives asynchronously and updates timeline
