# ADR 0002: Layered context, orchestration boundaries and evidence collection

Scope clarification from subsequent discussion: this is primarily a learning
project and a standalone assistant implementation. Hekate is an optional reuse
candidate, not a required runtime owner or integration milestone. The immediate
exercise is [spec 10's documentation agent](../implementation/10-doc-retrieval-agent.md),
followed by explicit LangGraph state transitions. Ownership proposals below are
future options; they do not require an audit or migration before local progress.

Status: Proposed architecture, reflecting the 2026-09-26 design discussion.
The standalone prompt-encoding experiment is implemented separately. This ADR
does not claim Hekate migration, durable scheduling, dynamic retrieval,
LangChain/LangGraph adoption, or automatic learning is implemented.

## Intent

The intended assistant stays conversationally responsive while several tasks
execute, wait for dependencies or user input, or are scheduled for later.
A fast response is an ongoing interface to this work; background execution is
not limited to generating a deeper answer to the most recent message.

Software development is an initial domain. Hekate's specialized gods are a
candidate foundation for planning, execution and independent verification.
ADR 0001 documents that its gods pipeline is separate from its chat path; that
is an integration observation, not a prohibition on connecting them.

## Ownership direction

| Concern | Proposed owner |
|---|---|
| Conversation, streaming, conversational context and generation lifecycle | ChatRuntime |
| Persistent objectives, scheduling, priorities, dependencies and specialist coordination | Hekate, subject to a current source audit |
| Presentation and explicit user actions | Iris/web clients |
| Durable source records and retrieval infrastructure | Pluggable backend; evaluate existing Hekate context-store |
| Interpretation of telemetry and proposals for improved policies | Separate evaluation process, initially alongside orchestration |

Prefer evaluating Hekate's existing architecture before creating another
orchestration repository. Do not copy its gods into ChatRuntime or move working
chat behavior into Hekate incidentally. Current implementation work remains in
ChatAgent; changes in sibling repositories require their own bounded tasks.

Separate conversation IDs, message IDs, persistent objective/task IDs, execution
IDs and attempt IDs. ADR 0001's current `taskId` identifies a queued deep reply;
it must not silently become the identity of a multi-message persistent objective.
Define an additive task contract for creation, status, revision, cancellation,
schedule and result events. Scheduling distinguishes start-not-before from
completion deadline. Acknowledging a future commitment requires stored acceptance.

Reserve capacity for conversation and bound background concurrency. Five active
tasks need not imply five simultaneous model calls. Track conflicting resource
access, objective revisions and obsolete results. Durable recovery and duplicate
side-effect prevention are distinct requirements from checkpointing a graph.

## Context policies by layer

| Layer | Required context | Retrieval policy |
|---|---|---|
| Fast response | Recent dialogue, constraints, concise actual task status, unresolved questions | Small bounded lookups; avoid mandatory planning calls |
| Orchestration | Objectives, revisions, dependencies, deadlines, capabilities and resource budgets | Retrieve detailed task evidence and relevant experience on demand |
| Specialist | Assignment, acceptance criteria, relevant artifacts, domain evidence and tools | Deeper bounded iterative retrieval |
| Verification | Original requirements, actual outputs, source evidence and independent checks | Retrieve evidence needed to challenge the result |

Use separate managers or strategies over common identity, provenance, scope
and storage contracts. Do not assemble one global prompt for all agents.
Downward handoffs carry objectives, constraints, acceptance criteria and source
references; upward handoffs carry status, results, evidence and unresolved issues.
Role identity and selected model identity are independent.

Mandatory instructions and known required artifacts are supplied automatically.
Additional information can be retrieved as gaps emerge, using exact source IDs,
text/symbol search, relationships, semantic search or external tools as appropriate.
Vector retrieval is an option, not a universal requirement. Retrieved source
content remains distinguishable from authoritative instructions.

Keep originals authoritative and summaries/indexes derived. Context for each
model invocation is a versioned snapshot; refresh at execution boundaries and
check for changed objectives. Preserve today's identical frozen fast/deep
snapshot guarantee until an explicit contract revision and regression coverage
replace it. Do not mutate an in-flight prompt.

## Structured meaning and prompt translation

Minimum prompt contract clarified after pilot 1: **Task, Guidelines, Response
Framework**, with context supplied separately through versioned references.
[Spec 09](../implementation/09-prompt-contract.md) defines this experimental
boundary. [Experiment 2](../../experiments/prompt-contract/README.md) holds the
semantic strings constant while testing section headings and JSON/XML rendering;
it does not implement production prompt translation.

Separate context selection, optional semantic compression, prompt rendering and
provider transport. A typed context package describes objective, role,
constraints, acceptance criteria, state, evidence relationships and actions.
Deterministic renderers can express that package as prose, concise text, JSON
or XML while retaining native system/user/tool message boundaries.

The hypothesis is that compact wording and explicit relationships can preserve
meaning with less input. XML/JSON is not assumed to use fewer tokens or improve
quality. Preserve negation, exceptions, scope, identity and revision semantics;
check the budget after rendering. Compression that changes an obligation is a
semantic error, even if the prompt is shorter. A separate LLM translator is not
required for the initial implementation.

Inspect Hekate's existing structured prompt generation before selecting shared
schemas or porting code. The remembered linguistic research motivates a
hypothesis; it is not evidence that a particular LLM encoding wins.

## Telemetry now; learning separately

The runtime records observations. It does not decide that context was correct
or infer causes of failures. Capture:

- Correlation across scope, task revision, role, step, attempt and handoff.
- Model binding and prompt, renderer, context-policy and tool versions.
- Context source IDs/versions, ordering, transformations, truncation and budgets.
- Retrieval query references, filters, candidate ranks, selections, omissions,
  timings and errors, including unavailable instrumentation.
- Tool/result artifact references, checks, review findings, user corrections,
  retries, cancellation, latency and reported usage; unknown is not zero.

Retain recoverable versioned artifacts behind references; hashes alone do not
reconstruct old content. Keep scoped payload storage separate from ordinary logs.
Do not record hidden reasoning as public telemetry. Record missing/sampled/dropped
events so absence of a record is not mistaken for absence of an action.

An agent's claim, test result, reviewer judgment, user acceptance and later defect
are different evidence types. Preserve attribution and artifact version. Neither
agent agreement nor task completion proves correctness. Included evidence does
not prove the model used or understood it.

Future analysis may retrieve experience, compare policies or propose model and
review-depth choices. It should evaluate proposals on separate cases with
comparable difficulty before a versioned rollout. Model training and automated
policy promotion remain separate decisions. Telemetry collection must not depend
on having solved these evaluation questions.

## Framework learning direction

Learning LangChain and LangGraph is an explicit project objective. Evaluate
LangChain for model/tool integration and LangGraph for stateful role workflows,
branches, checkpoints and resumptions. Retain application contracts and compare
behavior with the current implementation. Frameworks do not determine success
criteria, appropriate context, or the correctness of learned policies.

Introduce one bounded integration at a time, preserving context, streaming,
cancellation and retry invariants. Keep educational explanation outside source
control in the user's sibling `ChatAgent-learning` folder. Repository docs record
decisions, implementation plans and reproducible evidence.

## Immediate experiment and next boundaries

1. Run a standalone paired prompt-encoding pilot on installed local Ollama models.
   Compare prose, concise text, JSON and XML using answer-based grading. Preserve
   raw prompts, responses, model digests and generation metadata. Report individual
   models and an equal-model aggregate; document limits and errors.
2. Inspect the results before choosing a renderer. Expand task difficulty and
   repeats if the pilot exposes ceiling effects or unstable differences.
3. Define versioned context-package and telemetry contracts. Keep layer-specific
   assembly rules and distinguish observations from later evaluations.
4. In an explicitly scoped Hekate investigation, trace gods, prompt builders,
   provider ownership, handoffs, persistence and outcome records before reuse.
5. Add a bounded framework adapter with parity tests, then demonstrate concurrent
   tasks through an orchestration contract. Scheduling and recovery require a
   separate durability milestone, not an extension of the in-memory reply queue.

Existing specs 03–06 remain future implementation work. This discussion does not
authorize incidental inventory, dispatch, CLI or cross-repository migrations.

## References and evidence

- [ADR 0001 and implementation checkpoint](0001-chat-runtime-ownership.md)
- [Iris slice evidence](../implementation/07-iris-slice-evidence.md)
- [Prompt encoding experiment](../../experiments/prompt-encoding/README.md)
- [LangChain overview](https://docs.langchain.com/oss/javascript/langchain/overview)
- [LangGraph overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
