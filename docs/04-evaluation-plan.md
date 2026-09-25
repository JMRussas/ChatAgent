# Evaluation Plan

## Dataset shape

Build a seed set of 60 prompts split evenly:

1. Direct-answer prompts
2. Retrieval-required prompts
3. Ambiguous prompts requiring clarification

## Metrics

1. Routing accuracy
- Did router pick expected route?

2. User-perceived latency
- Time to first meaningful response

3. Deep-answer quality
- Relevance (1-5)
- Factuality (1-5)
- Citation quality (binary + spot-check)

4. Cost efficiency
- Average tokens/request by route
- Provider cost estimate per 1K conversations

## Test protocol

1. Run fixed prompt set through each provider configuration
2. Capture route decision, latency, and outputs
3. Score via rubric (human + optional evaluator model)
4. Compare configurations:
- Azure-fast + Azure-deep
- Azure-fast + Bedrock-deep
- Bedrock-fast + Bedrock-deep

## Output artifact

Produce `reports/prototype-eval.md` with:

1. Metric table
2. Strengths and failure modes
3. Recommendation for default provider profile
