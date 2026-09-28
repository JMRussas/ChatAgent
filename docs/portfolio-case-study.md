# ChatAgent engineering case study

**Author: Justin M Russas · September 2026**

ChatAgent investigates a practical problem: an assistant should remain available
for conversation while longer work progresses independently. Making the HTTP
handler asynchronous is only a starting point. The system also needs bounded
context, clear task ownership, cancellation, recovery rules and measurements at
the model boundary.

I built this project to learn LangChain and LangGraph through working software,
while applying experience designing production orchestration and regulated
software. It is independently runnable. The implementation, experiments and
results discussed here are all in this repository.

## Engineering ownership and use of AI

I set the direction, challenged assumptions, requested edge-case testing, and
reviewed the decisions as the project evolved. AI coding assistance contributed to
implementation, tests, documentation and analysis. The repository records the
resulting code and evidence so those contributions can be inspected.

The process treats generated code and model responses as proposals that require
verification. Examples include reproducing lifecycle faults before fixes, exercising
a real browser when unit tests missed a compiled-JavaScript bug, and preserving
an initially promising scheduling result when a better-controlled follow-up did
not support it. Passing software tests and generating plausible prose are different
checks; neither substitutes for evaluating whether an answer is supported.

## Separate conversation from task execution

The TypeScript runtime owns the interactive conversation: context snapshots,
streamed answers, per-attempt progress, retries and cancellation. A Python sidecar
owns optional documentation tasks. JSON-lines messages connect the processes
without putting user questions into shell commands.

A task has its own identity, state, budgets and conversation binding. Duplicate
start requests return the existing task when the request matches; conflicting
reuse is rejected. The UI shows task results separately from chat. This avoids
silently treating every completed answer as established conversation knowledge.

The current background bridge admits eight scheduled tasks and executes one task
at a time. That is a bounded local implementation, not a distributed scheduler or
a claim of eight simultaneous inference calls. [Implementation contract](implementation/11-conversation-tasks.md)

## Use frameworks for explicit responsibilities

LangChain provides the chat-model/message interfaces and tool schemas. The host
executes only the permitted documentation search/read operations and enforces
resource limits. Tool declarations alone do not provide that enforcement.

LangGraph expresses model invocation, tool execution, validation and continuation
as explicit state transitions. SQLite checkpointing supports resume from confirmed
pauses. The task manager adds lifecycle and ownership around those graph runs.

An abrupt process loss can leave uncertainty about an in-flight operation. The
system refuses automatic replay from that state instead of claiming exactly-once
execution. Code, dependency and source identities are checked on resume; changes
require explicit migration. [Graph design](../experiments/doc-agent/LANGGRAPH.md) ·
[Durability](../experiments/doc-agent/DURABILITY.md)

## Make context bounded and traceable

Foreground and deep chat receive a bounded snapshot of the conversation. Background
compression can retain source-linked memory while preserving the original records.
Pending or incomplete requests remain distinguishable from accepted answers.

The documentation agent retrieves additional context on demand using bounded
search/read tools. Answers reference source identities and retrieved evidence.
Those structures make review possible, but they do not prove that a citation
supports the claim. A planning pilot found a schema-valid answer citing the wrong
passage and overly broad claims about missing evidence. Planning therefore remains
optional. [Memory evidence](implementation/01b-evidence.md) ·
[Plan experiment](../reports/doc-agent/plan-findings-2026-09-28.md)

## Let experiments change the design

**Prompt organization.** A controlled experiment ran 600 scored calls across five
local model digests, 24 cases and five prompt conditions. On newly held-out cases,
Task / Guidelines / Response Framework headings scored 40/60 against 38/60 for
identical flat text, using about 4.7% more input tokens. That small difference did
not justify a universal formatting rule. The decision was to preserve configurable
rendering and distinguish content accuracy from strict output compliance.
[Protocol and results](../reports/prompt-contract/findings-2026-09-26.md)

**Shared inference.** A timing gateway observed both Node and Python calls to the
same Ollama model. It measured application admission wait, first answer text and
completion separately. The initial comparison suggested a priority benefit, but
it changed both serialization and priority and compared different foreground loads.

The revised test added FIFO and equal bursts. Overlap first-answer medians were
477 ms concurrent, 479 ms FIFO and 569 ms priority, with six requests per policy.
All 18 noncancelled documentation tasks completed. The priority policy remained
experimental. The result is useful because it prevented an unsupported default
change; it does not establish that priority scheduling is generally ineffective.
[Preserved runs and limitations](../reports/doc-agent/contention-findings-2026-09-28.md)

## Test failures at the boundaries

Fault injection reproduced five lifecycle gaps involving invalid budgets, status
races, cancellation of unsupported task versions, late provider completion and
cleanup exceptions. Fixes retain cancellation intent and refuse uncertain replay.
Additional tests kill an actual worker process and simulate persistence failures.
These are concrete failure tests, not a claim to cover every power-loss or storage
failure scenario. [Fault review](../reports/doc-agent/lifecycle-edge-cases-2026-09-27.md)

The September 28 verification checkpoint passed 258 TypeScript tests and 61 Python
agent/lifecycle tests. CI runs TypeScript verification and simulated regression
gates; live inference and Python runs have separate evidence. The real-browser
check also caught a missing compiler helper in serialized UI code that unit tests
had missed. [Evidence guide](results.md)

## Current limits and next decision

ChatAgent is a local prototype. It does not have production authentication,
distributed scheduling, automatic learning or durable chat history. Checkpointed
documentation tasks and in-memory conversation state have different lifetimes.

The next step is held-out evaluation of multi-part answers: requirement coverage,
citation support and appropriately scoped uncertainty. That evidence should guide
how completed task results become selectable conversation context. More agent
steps or more elaborate plans would not, by themselves, establish better answers.
