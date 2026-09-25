# Implementation handoff

Specification baseline: `7f03beb` (2026-09-25). These documents describe planned
changes, not existing APIs. Read the current source before editing; do not restore
the baseline over newer work. The last implementation check was 119 passing tests
across 29 files plus type checking. No live quality pass is claimed.

## Execution order

| Spec | Dependency | Deliverable |
|---|---|---|
| [01 Context](01-context.md) | Existing baseline | Shared, bounded per-turn conversation snapshot |
| [02 Generation](02-generation.md) | 01 | Thinking controls, streamed answers, cancellation |
| [03 Inventory](03-inventory.md) | Existing catalog; integrate after 02 | Connections and fresh provider observations |
| [04 Dispatch](04-dispatch.md) | 01–03 | Deterministic task-based model selection |
| [05 CLI](05-cli.md) | 02–04; product/account selection for live adapter | Subscription execution via a registered adapter |
| [06 Verification](06-verification.md) | 01–04; include 05 when enabled | Shutdown, honest benchmarks, browser and live gates |

Implement one numbered spec at a time, in this order. Do not implement later
milestones as incidental refactoring. Each spec has a scope boundary and named
acceptance cases; completion requires the cases, not merely new types or metadata.
03's interfaces can be designed independently, but this handoff does not require
parallel agents. Production deployment and retrieval are separate future scopes.

## Common contracts and rules

- `messageId` identifies a user turn, `taskId` a queued deep job. Retries retain both;
  each execution attempt receives a separate `attemptId`. Never correlate by text
  or timestamps. Preserve existing HTTP fields during incremental migration.
- Keep UI timeline events separate from provider conversation messages. Activities,
  partial deltas and diagnostic metadata are never assistant conversation content.
- Orchestrator owns context and selection; adapters translate requests and emit
  results; workers execute frozen tasks; the UI displays persisted facts.
- No provider credentials, login tokens, hidden reasoning text, full environment
  dumps, or arbitrary shell command strings in public events/catalog endpoints.
- Use mock/deferred providers for deterministic tests. Network, cloud provisioning,
  subscriptions and billed inference are not requirements of an offline test pass.
- Update `.env.example`, README and the roadmap when behavior/configuration changes.
  Preserve historical reports. Mark checks as run, failed, or not run with a reason.
- Provider-specific protocol facts must be verified against installed versions and
  current official documentation during implementation. Record the source/date in
  adapter notes. Do not guess CLI switches, regional availability or model limits.

## Verification and commits

For each code milestone: run its focused tests, then `npm test`, `npm run lint`,
`npm run build`. Before declaring the integrated handoff complete, run
`npm run verify:release` with `BENCH_MODE=simulate` and
`BENCH_SIM_SEED=default-v1`. On PowerShell set these with `$env:NAME = 'value'`;
shell `NAME=value command` syntax is not portable to this workspace.

Read existing Git status first and preserve unrelated work. Commit each coherent
milestone with implementation, tests and documentation together. Do not overwrite
benchmark baselines merely to make gates pass. Investigate and explain legitimate
changes before versioning a replacement baseline. No remote is configured.

The development server does not watch source changes. Verify its process/port
before restarting; report that in-memory conversations will reset. Do not kill
unrelated Node/Ollama processes. Keep local secrets out of commits.

## Reusable task prompt

> Read docs/implementation/README.md and the next numbered spec. Check its
> prerequisites against the actual code. Implement only that spec, including its
> failure cases and acceptance tests. Preserve unrelated changes. Run the required
> checks, update the roadmap with evidence and remaining limitations, and commit
> the completed milestone. If an external prerequisite is missing, complete the
> independent offline work and report the exact blocked live acceptance case;
> do not substitute a mock result for live verification.
