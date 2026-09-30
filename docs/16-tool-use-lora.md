# Tool-use LoRA: proposed learning experiment

Status: design only, after evaluation mode and the sports tool baseline. The user
asked for the reasoning behind this approach; no training run or model choice is
made here. Claude CLI acceptance and resource-policy work remain ahead of it.

## What would be learned

LoRA trains small weight updates while freezing the original model weights.
It is a parameter-efficient adaptation method, not a retrieval system or tool
executor. See [PEFT's LoRA description](https://huggingface.co/docs/peft/main/en/conceptual_guides/lora).
Our proposed target is a trainable local model. Claude can remain a separately
evaluated reference system; our subscription CLI is not a local LoRA training path.

Teach the model to choose the next action from the request, available tool schemas
and evidence so far: answer, clarify, call a tool, recover from a failure or stop.
Scores and schedules remain external data. Credentials, permissions, deterministic
validation, quota limits and cancellation remain runtime responsibilities.

Example desired behavior for “Giants last weekend”:

1. Resolve team, date interval and timezone from context, or ask a clarification.
2. Request matching games using validated identifiers and dates.
3. Select the intended game from the returned candidates; do not invent a game ID.
4. Fetch the appropriate details, respecting scheduled/postponed/final status.
5. Explain only what the retrieved records support and cite the evidence.

Train different valid wordings and trajectories. Requiring an unnecessary tool
sequence can punish a valid direct lookup or cause redundant calls.

## Proposed examples and training objective

Preserve tool-schema versions, user messages, assistant tool calls, tool results
and the reviewed assistant continuation. Include no-tool questions, clarification,
empty results, ambiguous matches, stale records, malformed responses, timeouts,
conflicting evidence and untrusted instructions embedded in tool text. Pair failures
with corrected continuations rather than label incorrect actions as SFT targets.

TRL supports tool-call conversations with a tools/schema column and PEFT adapters.
See [SFT tool calling and adapter training](https://huggingface.co/docs/trl/sft_trainer).
Use the chosen model's actual chat template and train on assistant outputs,
including tool-call tokens. Verify loss masking: user content and returned tool
records are context, not targets the model should learn to fabricate. Inspect
tokenized examples and truncation so complete call/result boundaries survive.

Start with supervised fine-tuning on curated demonstrations. Preference training
or outcome-based reinforcement learning is a later option if measured failures
warrant it and a reliable execution environment/reward exists. Lower training loss
is not evidence of better tool use.

Use permissioned synthetic or approved real examples; evaluation logs do not
automatically become training data. Remove secrets and sensitive payloads, retain
provenance and label review status. If another model proposes examples, verify
them against tool execution/reference facts and human review. Do not assume access
to another model's hidden reasoning or use private reasoning as a training target.

## Evaluation before training

First measure a capable unchanged model with clear schemas, a few examples and
runtime validation. Fix tool/API design when that is the root cause. Establish
separate train, development and untouched test sets before collecting variations.
Group related games, evidence records and prompt templates into one split; random
paraphrase splits leak cases. Add held-out dates, entities, schema variations and
failure combinations to test generalization.

Compare unchanged model, improved-prompt baseline and LoRA on the same cases with
matched tools, evidence, budgets and decoding settings. Keep thinking/effort fixed
for the initial LoRA comparison; test interactions with reasoning settings later.
Version base checkpoint, adapter, tokenizer/template, quantization, tool schemas,
dataset and rubric. Validate the deployed quantized/merged variant separately.

Measure:

- Executed task success and factual correctness, not just valid JSON.
- Tool selection, argument correctness, clarification and unnecessary-call rates.
- Recovery, unsupported-claim rate and policy violations.
- End-to-end latency, tokens, tool calls, inference resources and training cost.
- Regression on ordinary conversation and tools outside the training distribution.

Use code graders for structured facts and execution outcomes, calibrated model
graders for explanation quality, and human adjudication for ambiguous cases. Do
not use the same model's generation and uncalibrated grading as a closed quality
loop. Prespecify improvement/regression thresholds from the baseline before a run.
Promote an adapter only if held-out gains justify training/deployment overhead.

## Tradeoffs

Potential upside: a smaller model may learn our tool conventions and recurring
decisions more reliably with fewer prompt examples. This is a hypothesis to test,
not a guaranteed latency or accuracy gain.

Risks: overfitting tool names/templates, copying teacher mistakes, losing general
capabilities, unnecessary tool calls, weaker behavior on changed schemas, and
training on fabricated results. Local capacity constraints still apply: training
can contend with chat inference. Dataset quality and evaluation are likely to be
more consequential than choosing adapter rank early.
