# ChatAgent demo walkthrough

A five-minute technical walkthrough for hiring conversations. State which parts
use mocks and which use live Ollama. Do not promise a latency bound, current web
research, verified citations or automatic self-improvement.

## 1. Explain the problem (30 seconds)

“An assistant should remain available while longer tasks run. This prototype
separates the conversation from independent, bounded documentation work, and tests
what happens at cancellation, recovery and shared-model boundaries.”

Show the [README architecture](../README.md#architecture). Explain that conversation
state is in memory while documentation tasks have SQLite-backed checkpoints.

## 2. Show the interaction (one minute)

Run `npm run dev` and open http://localhost:3100/. With no provider overrides this
uses mocks; explicitly label this as an interaction demo, not an AI-quality demo.

- Send “Explain event sourcing briefly.” Show the response and its activity details.
- Point out the conversation scope and Stop control.
- Explain that incomplete/failed responses are distinguishable from accepted answers.

A fast mock may finish before Stop can be clicked. Use the recorded cancellation
tests rather than presenting a failed click as a cancellation demonstration.

## 3. Run a real documentation task (two minutes, optional)

Prerequisite: [enable the Python worker](implementation/11-conversation-tasks.md#enable-and-use)
and verify the configured Ollama model is installed. Prepare this before the demo.

Enter:

> Does the implemented ContextManager wait for a new background summary before
> answering? What happens to the original transcript?

Choose **Run documentation task**. While it runs, send an ordinary chat message.
Show that Send remains available, then inspect the task's status and final source
references. If foreground providers are still mocks, say so: this configuration
uses live inference for the documentation task only.

Open the cited source passage and compare it with the answer. A valid citation
identifier is not enough to establish support. If the model produces a weak answer,
show that limitation and the evidence-quality work queued next.

The [recorded browser findings](../reports/doc-agent/browser-contention-findings-2026-09-27.md)
provide a fallback when a live model is unavailable. They describe exactly which
parts of the browser check used mocks.

## 4. Show a decision backed by measurements (one minute)

Open [the contention comparison](../reports/doc-agent/contention-findings-2026-09-28.md).
Explain the six-sample-per-policy result: 477 ms concurrent, 479 ms FIFO, 569 ms
priority median first-answer latency during background work. All 18 background
tasks completed, but the candidate did not demonstrate a foreground benefit, so
it was not made the runtime default.

Then open [the evidence guide](results.md) to distinguish live model measurements,
deterministic tests and simulated CI checks. The engineering point is that a
plausible optimization was evaluated before deployment.

## Close (30 seconds)

Next work evaluates held-out multi-part answers for coverage, citation support
and scoped uncertainty before bringing completed-task evidence into conversation
context. ChatAgent is a local prototype with explicit limits, not a claim of
production-ready autonomous orchestration.
