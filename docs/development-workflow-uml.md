# ChatAgent and Hekate development architecture

ChatAgent provides the conversation UI and application runtime. Hekate provides
the supervised development runner and its durable execution evidence. The agent
bridge carries coordination messages between the development agents. These are
separate responsibilities: a delivered message does not prove execution, and a
successful worker test does not finish integration review.

Status on 2026-10-08: the UI history corrections, bridge readers and one-shot CLI
are integrated. The activity classifier is a conservative stub in main; its
reviewed reference is being prepared as a supervised task. Hekate's resolution
guard and pure recovery projection are integrated. Live recovery collection and
automatic agent resumption remain proposed work.

## Conversation and documentation execution

```mermaid
sequenceDiagram
    actor User
    participant UI as ChatAgent conversation UI
    participant Chat as Chat service
    participant Tasks as Document task service
    participant Python as Python task manager
    participant Graph as Documentation LangGraph
    User->>UI: Send an ordinary message
    UI->>Chat: Submit message
    Chat-->>UI: Chat response and timeline
    User->>UI: Ask project docs
    UI->>Tasks: Create documentation task
    Tasks->>Python: Submit task through supervised bridge
    Python->>Graph: Execute documentation workflow
    Tasks-->>UI: Task identity and status
    loop While the task runs
        UI->>Tasks: Read task status
        Tasks-->>UI: Progress, result or failure
    end
    UI->>UI: Project chat and task turns into ordered history
    Note over UI,Tasks: Task execution status and answer outcome are separate
```

The documentation workflow can run asynchronously and return evidence and
citations. Its questions and results belong in the user's visible conversation,
even though tasks and chat events have separate stores. The UI orders task turns
by their persisted creation time so completion, reload and conversation switching
do not scramble the history. This documentation workflow is separate from
Hekate's development worker.

Sources: [conversation UI](../src/ui/homePage.ts),
[task history projection](../src/ui/documentTaskPanel.ts),
[chat service](../src/app/chatService.ts),
[Python task adapter](../src/app/documentTasks.ts),
[task supervisor](../src/app/documentTaskSupervisor.ts),
[Python task manager](../experiments/doc-agent/task_manager.py) and
[documentation graph](../experiments/doc-agent/graph_agent.py).

## Evidence readers and reports

This UML class diagram describes responsibility boundaries. The readers and
classifier are functions and modules, rather than service classes instantiated
at runtime.

```mermaid
classDiagram
    class AgentBridge {
        +message evidence
        +reply links
        +recorded outcomes
    }
    class ClaudeTranscript {
        +conversation metadata
        +tool call and result IDs
    }
    class BridgeReader {
        +readAssignments()
    }
    class TranscriptReader {
        +readTranscript()
    }
    class ActivityClassifier {
        <<in preparation>>
        +classifyActivity()
    }
    class ActivityReport {
        +assignment response state
        +session observation
        +incomplete evidence
    }
    class JournalObservation {
        +stream states
        +intent and outcome records
        +outstanding reservations
    }
    class RecoveryProjection {
        +project()
    }
    class RecoveryReport {
        +intent status
        +unknown effects
        +missing evidence
    }
    BridgeReader ..> AgentBridge : reads
    TranscriptReader ..> ClaudeTranscript : reads
    ActivityClassifier ..> BridgeReader : uses sanitized metadata
    ActivityClassifier ..> TranscriptReader : uses sanitized metadata
    ActivityClassifier --> ActivityReport : produces
    RecoveryProjection ..> JournalObservation : consumes sanitized input
    RecoveryProjection --> RecoveryReport : produces
```

The activity report answers whether a role recorded a reply explicitly correlated
with an assignment. A fetch or acknowledgement is delivery evidence, not proof
that a model read the assignment or is working. Transcript observations provide
corroboration, with incomplete or truncated input classified as unknown. The CLI
reads named assignments once; it does not resume agents or monitor in the
background.

The recovery report enumerates intents whose records remain available. An intent
is a recorded operation that may still need its outcome. A released reservation
does not prove the operation had no effects. Compacted records cannot be
enumerated, so the report marks that evidence incomplete. The pure projection
accepts caller-supplied sanitized observations and labels their hashes unverified;
it grants no recovery authority and performs no database or filesystem work.

Sources: [activity contract](implementation/15-stall-detection.md),
[bridge reader](../src/integrations/bridge/bridgeReader.ts),
[transcript reader](../src/integrations/bridge/transcriptReader.ts),
[classifier seam](../src/integrations/bridge/activity.ts) and
[one-shot CLI](../scripts/agentStalls.ts). Hekate sources are
`scripts/local/supervisor_e1/e1/evidence.py`, `durable.py`, `handoff.py` and
`recovery_manifest.py` in the sibling repository.

## Supervised development execution

```mermaid
sequenceDiagram
    actor User
    participant Lead as Codex lead
    participant Claude as Claude implementer
    participant Author as Hekate task author
    participant Runner as Hekate runner
    participant Worker as Bounded model worker
    participant Verifier as Independent verifier
    participant Repo as Main repository
    User->>Lead: Set objective and authorize development
    Lead->>Claude: Assign scope and acceptance criteria
    Claude->>Lead: Frozen tests and reference implementation
    Lead->>Lead: Review contract, source and baseline failures
    Lead->>Author: Author reviewed task
    Author-->>Lead: Pinned task and reference proof
    Lead->>Runner: Authorize bounded execution
    Runner->>Worker: Task in isolated checkout
    Worker-->>Runner: Candidate commit
    Runner->>Verifier: Verify against frozen criteria
    alt Verification fails within correction budget
        Verifier-->>Runner: Specific failures
        Runner->>Worker: Correction round
    else Verification passes
        Verifier-->>Lead: Candidate and retained evidence
        Lead->>Lead: Review source and integration behavior
        Lead->>Repo: Integrate reviewed changes
        Lead->>Claude: Assign next ready increment
    else Execution or review remains uncertain
        Runner-->>Lead: Stop with evidence preserved
    end
```

Frozen acceptance tests establish the required behavior before the worker starts.
The reference demonstrates that the task is satisfiable. Hekate bounds execution
and verifies the resulting candidate; the lead then reviews source and integration
behavior. The Windows identity task passed worker verification but still required
two helper corrections during integration review. A stopped run preserves its
uncertainty until a supported recovery path exists.

The development Claudes implement assigned increments. The bounded model worker
is a separate execution inside Hekate's supervised task runner. PlanStore holds
task state; the bridge carries messages and does not replace that store.

Sources: [development workflow](agent-bridge-development-workflow.md),
[Hekate integration contract](implementation/13-hekate-plan-node-integration.md)
and Hekate's `e1/task_author.py`, `task_runner.py`, `plan_run.py`, `pilot_real.py`
and `cli_worker.py` under `scripts/local/supervisor_e1/`.

## Initial response classification

This is the reviewed classifier contract; main still contains the unknown-only
stub until the supervised task is verified and integrated.

```mermaid
stateDiagram-v2
    [*] --> Evaluate
    state Evaluate <<choice>>
    Evaluate --> Unknown: Evidence incomplete or invalid
    Evaluate --> ReplyObserved: Explicit correlated reply
    Evaluate --> WithinThreshold: No reply, age within threshold
    Evaluate --> Unfetched: Past threshold, no recorded fetch
    Evaluate --> FetchedWithoutReply: Past threshold, fetch recorded
    state "Unknown" as Unknown
    state "Correlated reply observed" as ReplyObserved
    state "Within threshold" as WithinThreshold
    state "Unfetched past threshold" as Unfetched
    state "Fetched, no correlated reply" as FetchedWithoutReply
```

The classifier evaluates incomplete input first, then explicit correlation, then
age and delivery evidence. These states distinguish a delivery problem from a
missing recorded response without claiming that an agent is alive, stalled or
finished. Automatic resumption, escalation and detection of stalls after an
initial reply require later increments.
