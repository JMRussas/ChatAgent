# 09 — Task / Guidelines / Response Framework contract

Status: implemented as a standalone experimental Python contract and renderer.
Production TypeScript integration and LangChain adapters remain future work.

Completed evidence: [experiment 2 findings](../../reports/prompt-contract/findings-2026-09-26.md)
cover 600 live local calls, fixed scoring, per-model results and the token tradeoff.
The modest mixed result supports retaining a configurable contract boundary,
not asserting that TGR or a serialization universally improves model accuracy.

## Purpose and boundary

The minimum instruction contract has three responsibilities:

- **Task:** the objective and what counts as success for this invocation.
- **Guidelines:** constraints, evidence requirements, permitted behavior and
  handling of unknowns.
- **Response Framework:** the deliverable's contents and structure, not a
  prescription to reveal internal reasoning.

Context sources are separate referenced inputs. The context manager chooses
them; the renderer presents them. Rendering does not fetch more information,
decide task priority, compress semantics, or select a model.

## Experimental implementation

[`PromptPackage`](../../experiments/prompt-contract/contract.py) is a validated,
frozen dataclass with `task`, ordered `guidelines`, ordered `response_framework`,
ordered `context` and a version. Each `ContextSource` has an ID, revision and
content. Empty mandatory fields, duplicate source IDs and unsupported package
versions are rejected. The contract's implementation language is experimental;
do not introduce Python as a dependency of the TypeScript chat runtime.

Readable TGR, flat text, JSON and XML renderers preserve identical full-word
strings and source order. Renderer/package versions go to telemetry. JSON and
XML use nested objects/elements, not shortened logical expressions. XML escapes
reserved characters; source content is retained without semantic rewriting.

Model-facing messages keep a native system/user boundary. The experiment requests
the same JSON output in all conditions without a provider-enforced JSON schema.
The future application renderer must also preserve native tool-message structure.

## Controls and evidence

The [second local experiment](../../experiments/prompt-contract/README.md) compares:

1. Legacy prose for continuity with pilot 1, with its original system instruction.
2. Flat unsectioned contract text as an identical-content control.
3. The same text with TGR headings: the primary organization comparison.
4. JSON and XML with the same values: secondary serialization comparisons.

Legacy differs in wording and instruction placement. Treat improvement against
legacy as a whole-prompt change, not proof that TGR headings caused improvement.
The primary endpoint is new held-out case accuracy, paired TGR versus flat.
Scoring, data, rendered packages and implementation hashes are frozen before
inference. Original pilot artifacts remain unchanged.

Telemetry includes model digest, contract/renderer/scorer versions, source
references and hashes, exact request, final answer, terminal outcome, token counts,
timings and artifact links. This demonstrates traceability; it does not implement
automatic learning or certify context correctness.

## Application integration gate

After reviewing experiment results, define the corresponding TypeScript contract
and one explicit adapter boundary. Keep renderer choice configurable and retain
a prose fallback. Do not choose a global format solely from a small synthetic
benchmark. The production integration must demonstrate:

- Mandatory constraints, source references and revision information survive.
- Final serialized messages fit the model-specific budget including output reserve.
- Existing frozen fast/deep context and accepted-history rules remain intact.
- Streaming, cancellation, retry-before-output, terminal outcomes and provider
  metadata retain existing behavior.
- Telemetry identifies actual inputs without exposing credentials or internal
  reasoning through public events.

A later bounded LangChain integration should replace one provider implementation
behind the existing interface, with parity coverage. It is not part of this
experiment. LangGraph/Hekate orchestration and layer-specific context policy
remain governed by [ADR 0002](../adr/0002-layered-context-and-orchestration.md).
