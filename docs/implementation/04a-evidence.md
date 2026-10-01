# 04A — Task classification checkpoint

2026-09-29. Implements the classification corpus required by spec 04 before wiring
dispatch. This checkpoint is not completion of spec 04.

`src/routing/taskClassifier.ts` exposes deterministic task classification and typed
requirements. Coding takes precedence over summary, extraction, reasoning and
conversation. Clarification requests use conversation without eventual-task output
requirements. JSON output requests add structuredOutput even when another task wins
precedence; mentioning JSON, tools or images does not itself request a capability.
This is lexical classification, not general semantic intent or negation detection.

## Acceptance evidence

All named cases are in `tests/unit/taskClassifier.test.ts` (52 passing tests):

| Requirement                                                                   | Evidence                                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Spec 04 acceptance 2: classification precedence and substring false positives | `spec 04 task classification corpus` table: 43 cases, including resource, encode, barcode, precedence, code fences and stack traces |
| Task identity independent of direct/deep route                                | `keeps short and complex coding task identity independent of route`                                                                 |
| Clarification uses conversation                                               | `uses conversation without eventual-task capabilities for clarification`                                                            |
| Explicit JSON output adds structuredOutput                                    | `requires structured output even when coding or summary wins precedence`                                                            |
| Ordinary mentions do not require action capabilities                          | `does not infer action capabilities from mentions of tools, images or JSON`                                                         |
| Validated input/output counts                                                 | `rejects invalid token counts` with negative, fractional, infinite, NaN and unsafe-integer inputs                                   |

Validation on Windows Node 24.15.0, invoked from WSL:

- Full Vitest suite: 351 tests in 52 files passed.
- Type checking and TypeScript build: passed.
- `verify:release` with `BENCH_MODE=simulate`, `BENCH_SIM_SEED=default-v1`: passed,
  including fixture evaluation and benchmark comparison. The generated timestamp-only
  benchmark diff was discarded; historical baselines were preserved.
- Live providers: not run; this pure classifier makes no model calls.

## Remaining spec 04 work

No registry, catalog-mode switch, selector, resource admission/reservation ledger,
fallback, per-candidate context preview, or per-binding telemetry is implemented by
this checkpoint. Acceptance 1 and 3–9 still require dispatch integration evidence;
passing unchanged fixed-mode regressions is not proof of catalog-mode behavior.

Keep existing runtime routing intact while implementing the remaining selection and
resource contracts. The old route classifiers still have substring-based external
lookup cues; these tests validate the new task classifier, not a correction to those
existing route classifiers. Do not claim tool execution, image input handling or
structured-output enforcement from task metadata alone.
