# Model-specific references and evaluation workflow

Decision recorded 2026-09-27: consult published model guidance and established
benchmarks before designing new local prompting or tool-use experiments. Use local
tests to check transfer to our deployment and application, not to rediscover broad
results already studied elsewhere.

## Reference map

| Model or subject                    | Primary reference                                                                                                                          | Use and boundary                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen3, including the local 8B model | [Official function-calling guide](https://github.com/QwenLM/Qwen3/blob/main/docs/source/framework/function_call.md)                        | Template and tool-call integration guidance. Recommends Hermes-style tool use. Verify what the serving adapter actually renders.                                                                                  |
| Qwen3-Coder                         | [Official BFCL and Tau-Bench evaluation setup](https://github.com/QwenLM/Qwen3-Coder/blob/main/qwencoder-eval/tool_calling_eval/README.md) | Reuse evaluation methods; match the tested checkpoint and size before interpreting results for a local model.                                                                                                     |
| Claude                              | [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)                                                               | Tool discovery, tool-definition input examples and internal evaluations. Results apply to the documented Claude setup, not automatically to Ollama models. Check current API documentation before implementation. |
| Cross-model tool calling            | [Berkeley Function Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard)                                                       | Published comparisons and reproducible evaluation artifacts. Record benchmark version, category and harness revision; aggregate rank is not an examples-benefit score.                                            |
| Retrieval of examples               | [What Makes Good In-Context Examples for GPT-3?](https://aclanthology.org/2022.deelio-1.10/)                                               | Research basis for selecting relevant examples. Older GPT-3 task results do not establish gains for our deployed models.                                                                                          |
| General context design              | [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)                         | Clear sections, concise tools and canonical examples. Treat as design guidance whose application needs validation.                                                                                                |

The linked sources were consulted in the preceding research discussion. They are
living references, not frozen specifications. No published baseline matching our
exact local builds and example-selection conditions has been established here.

Exact model-specific guidance remains to be verified for the installed Gemma4,
Qwen3.5 and Qwen2.5-Coder builds. Do not substitute another generation's guide as
if it were authoritative for them. The local tags `latest` and `26b` alone are not
sufficient to match a published checkpoint; inspect installed metadata and digest.

## Before changing a model integration or running an experiment

1. Identify the exact model/checkpoint, size, quantization, digest and serving
   runtime/version. Treat a mutable tag as an alias, not a reproducible identity.
2. Read that model's official model card and applicable prompting/tool-use guide.
   Record source URL and access date. Confirm chat template, tool parser, thinking
   mode, generation settings and structured-output support for our adapter.
3. Find the closest published evaluation and record its model configuration,
   benchmark version, task category and execution setup. Mark mismatches explicitly.
4. State the remaining application-specific question. Prefer existing datasets and
   harnesses where they fit; use small local cases for our retrieval, citation,
   stopping and runtime requirements. Freeze criteria before inference.
5. Record actual settings, telemetry and evidence. Separate published results,
   recommended settings and locally measured outcomes. Recheck a reference when
   changing model generation, serving runtime or API behavior.

This is an engineering workflow, not an extra model prompt. These documents should
inform adapter configuration and experiment design; do not inject whole guides
into every inference request. Runtime context can use a small, verified instruction
or example selected for the task when evidence supports its value.

## Examples and tool definitions

Tool argument examples may belong alongside a tool's schema when the provider
supports them. Anthropic's `input_examples` is a concrete provider feature, not a
guarantee that arbitrary schema example fields reach or influence every local
model through LangChain/Ollama. Verify serialization before claiming support.
Multi-step examples about retrieval, interpretation and stopping belong in
separately selected task context. They are not interchangeable with argument examples.

Our [local examples comparison](../reports/doc-agent/examples-findings-2026-09-26.md)
keeps the variant optional: one additional structural pass across six pairs cost
39.3% more reported input tokens. It does not establish a general model ranking or
validate on-demand example selection, which is not implemented.

The [model catalog](13-model-catalog.md) remains deployment metadata. This guide
adds references and workflow, not new catalog fields or automatic routing behavior.
