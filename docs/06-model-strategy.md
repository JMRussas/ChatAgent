# Model Strategy (Provider-Agnostic)

This prototype should avoid binding to a single model pair. Use capability-based routing.

## Encapsulation rule

Application code should depend only on:

1. `FastModelProvider`
2. `DeepModelProvider`

All provider-specific setup must be isolated in the provider factory. The orchestrator should not change when switching providers.

## Capability profiles

1. Fast profile
- Low latency
- Good instruction following
- Lower cost

2. Deep profile
- Strong reasoning and synthesis
- Better long-context handling
- Tool and retrieval integration

## Candidate providers

1. Azure OpenAI
- Fast: smaller/cheaper deployment
- Deep: stronger reasoning deployment

2. AWS Bedrock
- Fast: lightweight model option
- Deep: higher-capability model option

3. Optional alternatives
- OpenAI direct APIs
- Anthropic APIs
- Local OSS model runtime for cost-sensitive demo mode

4. Ollama for local test loops
- Fast iteration with local models
- Useful when validating routing and async behavior without cloud spend

## Selection policy

Choose profiles by scenario:

1. Interview demo mode
- Prioritize stable latency and deterministic behavior

2. Cost mode
- Prefer cheaper fast profile, stricter deep-route thresholds

3. Quality mode
- Increase deep-route usage and citation requirements

## Mix-and-match examples

1. Fast: Ollama, Deep: Bedrock
2. Fast: Azure, Deep: Ollama
3. Fast: Bedrock, Deep: Azure

This enables independent tuning of latency, quality, and cost profiles.
