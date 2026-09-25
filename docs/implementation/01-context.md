# 01 — Conversation context and grounding

Status: planned. Prerequisite: current timeline/message IDs. No live credentials
required. This is the next implementation task.

## Outcome and scope

“How do you know?” receives the preceding completed exchange. Both providers for
a turn see the same conversation snapshot. Later arrivals cannot change queued
work. No retrieval, summaries, vector database, automatic routing, tool execution,
or provider-managed conversation sessions in this milestone.

## Ownership and interfaces

Add `src/app/contextBuilder.ts` with a pure `buildContext` function and export its
types. Extend `UserMessage` provider input and `DeepTask` through an explicit
`context: ConversationContext` field rather than reading timeline state inside
adapters. Use:

```ts
interface ContextMessage { role: "user" | "assistant"; content: string; messageId: string }
interface ConversationContext {
  version: 1;
  snapshotId: string;
  capturedAtIso: string;
  systemInstruction: string; // frozen base instructions plus verified runtime facts
  roleInstructions: Readonly<{ fast: string; deep: string }>;
  messages: readonly ContextMessage[]; // completed history, then current user
  includedTurnIds: readonly string[];
  omittedTurnIds: readonly string[];
  estimatedInputTokens: number;
  budgetMethod: "utf8-conservative-v1";
}
```

`buildContext` accepts copied timeline events, current message/ID, trusted base
instructions/runtime facts, and a budget. It returns context or typed
`ContextBudgetError`. The orchestrator captures history once, before appending
the current user event; pass deep copies to fast input and queued task. Noop stores
produce current-message-only context. Legacy test tasks lacking context may use
an explicit current-prompt-only adapter fallback; all new orchestrated tasks must
carry context. Test this migration boundary.

Store model instructions separately from user/assistant history, but freeze them
inside the context object so worker-time configuration changes do not alter them. The provider
request consists of base instructions, verified runtime facts, role-specific
instructions, then context messages. `contextBuilder` budgets all those instructions
using the larger fast/deep instruction cost. Route-specific instructions may differ;
the conversation snapshot must not.

## History selection and concurrency

1. Timeline append order defines order; user-supplied timestamps do not.
2. Group events by messageId; ignore orphaned/legacy events without IDs for history.
3. Include at most one assistant answer per previous user turn: latest refined
   answer wins, otherwise a provisional event whose processingStatus is complete.
4. Exclude entire pending/failed/cancelled/incomplete turns and all activity events.
   Never send an unpaired historical user message. Current user appears exactly once.
5. Consider only events present at capture. If A is pending when B arrives, B omits
   A; if A finishes later, B's queued context stays unchanged. A later C can include A.
6. Keep newest contiguous eligible pairs within limits; drop oldest whole pairs.
   Do not shorten messages or split a pair. Use at most 12 previous pairs by default.
7. Claim conversation ownership on first submission using userId in an in-memory
   registry at ChatService. A different userId submitting to that conversation gets
   409 before reading context or appending events. This prevents accidental mixing,
   not authentication; the public timeline API remains a local-prototype limitation.

## Budget policy

Add validated environment settings `CONTEXT_WINDOW_TOKENS=8192`,
`CONTEXT_MAX_HISTORY_TURNS=12`, `CONTEXT_SAFETY_TOKENS=256`. Reject invalid values
at startup (positive integer window/turn count, nonnegative safety allowance).
8192 is an application working limit, not a statement of model capacity.

For the fixed pair use the minimum of the application window and any known
effective model windows, reserving the larger configured fast/deep output budget.
Add general `CHAT_FAST_MAX_OUTPUT_TOKENS=512` and
`CHAT_DEEP_MAX_OUTPUT_TOKENS=2048`. For Ollama, existing explicit
`OLLAMA_*_NUM_PREDICT` overrides its role budget for backward compatibility.
Pass the resolved output limits to all three live adapters using supported fields.
If output reserve + safety leaves no input space, fail startup with named settings.

Use UTF-8 byte length plus 16 per message plus 32 request overhead as the initial
input token estimate (including system content). Label it as an estimate: this is
not a provider tokenizer or a proof of fit. Keep estimation behind a TokenCounter
interface so provider tokenizers can replace it. If instructions plus current user
exceed budget, return 413 with stable code `CONTEXT_TOO_LARGE`, before appending
events/enqueuing/calling providers. Never silently truncate the current request.
Provider context overflow despite estimation is a typed terminal failure; no blind
retry with the same input. Store only budget counts and omitted IDs in telemetry.

## Provider mapping and grounding

Touch `interfaces.ts`, orchestrator, chatService, types, providerFactory and
Azure/Ollama/Bedrock adapters. Use role-based Azure messages and Bedrock messages
with a separate system instruction. Move Ollama to `/api/chat` and its message
response shape; update transport tests. Keep streaming off until spec 02.

Trusted facts include the actual configured provider/model and a server-generated
UTC timestamp. Only identify a host location if explicitly configured and verified;
do not infer cloud/local from the executable or model name. Do not pass hostname,
credentials, endpoints with secrets, or arbitrary environment variables.
Remove unconditional timezone instructions from unrelated prompts. Shared system
instructions require acknowledging missing sensory/factual evidence and not claiming
retrieval or tools that were not used. Model behavior remains probabilistic.

## Acceptance tests

Add `tests/unit/contextBuilder.test.ts`, provider request-shape cases and HTTP cases:

| Case | Required result |
|---|---|
| Completed direct answer followed by “why?” | Prior user/assistant pair then current user, once each |
| Provisional then refined for A | Only A's refined text enters B's history |
| A pending when B begins | A omitted; later A completion does not alter B fast/deep snapshots |
| Activities and failed turns | No activity/retry/failure text becomes model conversation |
| Three eligible pairs, budget for two | Oldest pair omitted; order and current text preserved |
| Non-ASCII input and large instructions | UTF-8 estimate includes both; overflow returns 413, zero calls |
| Mutation of fast-provider input | Deep task's copied snapshot stays unchanged |
| Same conversation, different userId | 409 and unchanged timeline/context |
| Empty/noop timeline | Current message works without fabricated history |
| Each adapter | Correct role order, output cap, and verified runtime facts in request |

Run common checks. Optional live follow-up exercise is separate evidence; do not
assert that system instructions alone eliminate hallucinations.
