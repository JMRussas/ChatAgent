# 05 — Subscription CLI execution

Status: planned. Depends on generation lifecycle, inventory, and dispatch (02–04).
The particular CLI product and account have not been selected. Do not invent a
subscription entitlement or pick a billed fallback implicitly.

## Two deliverables

**05A: offline runner and adapter contract** can be implemented now after dependencies.
**05B: one real adapter** requires the user to name the CLI and account profile,
and the implementer to verify its supported automation/authentication interface.
These are separate completion states. Commit the offline harness without claiming
subscription execution works. No install, subscription purchase or login automation
is part of the offline deliverable.

## Contract and ownership

Add `src/providers/cli/runner.ts`, `adapter.ts`, and registry integration.

```ts
interface CliAdapter {
  id: string;
  inspect(profile: string, signal: AbortSignal): Promise<CliReadiness>;
  generate(request: CliGenerationRequest): AsyncIterable<CliGenerationEvent>;
}
```

CliGenerationRequest contains bindingId, frozen spec 01 context, output budget,
AbortSignal and validated workingDirectory. CliGenerationEvent normalizes to spec
02 answer deltas, completion/length/cancel and safe failures. CliReadiness includes
installed version, authenticated yes/no/unknown, automation supported/unsupported/
unknown, quota available/exhausted/unknown, observedAt and expiresAt. Do not expose
login artifacts in HTTP responses or persist CLI session output as conversation.

Adapter code maps an allowlisted ID to executable and fixed argument construction.
Catalog and prompts cannot supply command strings or executable paths. Use
`spawn`/`execFile` with argument arrays and shell disabled. Send context through
stdin or a private temporary file according to the supported CLI protocol, never
through shell interpolation. Refuse tools requiring an interactive TTY until an
explicit noninteractive mode is implemented. Detect login prompts and return
AUTH_REQUIRED with instructions to authenticate outside the app.

Initial adapter supports **answer-only execution**. Confirm it actually disables
file edits/tools; otherwise mark it unsupported, even if the catalog claims it.
Agent execution is a future separate task requiring explicit workspace and tool
authorization. A coding request alone does not permit arbitrary terminal actions.

## Process and quota behavior

- Config: `CLI_TIMEOUT_MS=120000`, `CLI_MAX_OUTPUT_BYTES=1048576`,
  `CLI_MAX_CONCURRENCY=1`, validated positive integers. Limit per quotaPoolId, not
  per model; fall back to accountProfile + adapterId when no pool is given.
- Await stdout/stderr incrementally. Parse documented JSON/JSONL formats; plain-text
  output is allowed only for an adapter that can reliably separate diagnostics.
  Do not treat reasoning, tool logs, ANSI banners or stderr as an answer.
- Buffer limits apply to combined stdout/stderr bytes; overflow aborts the process
  and returns OUTPUT_TOO_LARGE. Exit code 0 without a valid final answer is failure.
- Cancellation and timeout terminate the process tree started by this invocation,
  including children on Windows. Isolate platform-specific termination behind an
  interface and test child-process cleanup. Never kill by process name globally.
- Exit/nonzero/quota/login errors become typed failures. Retries/fallback remain
  owned by the dispatcher, not hidden inside the CLI adapter.
- `wait` on quota exhaustion emits queued activity and waits until the documented
  reset time, subject to `CLI_QUOTA_MAX_WAIT_MS=30000`. Unknown reset or longer wait
  returns QUOTA_EXHAUSTED immediately with available reset metadata. Cancellation
  must interrupt waits. `fail` returns immediately; `approved-fallback` delegates
  only to the dispatcher's permitted fallback list. usageBillingFallbackAllowed=false
  excludes separately billed API access. Missing quota data never means unlimited.

## Acceptance

05A uses a small Node fixture executable under tests/fixtures, not a real CLI:

1. Prompt with quotes, dollar signs and command-like text reaches stdin unchanged;
   no shell interpretation or extra process occurs.
2. Chunked output maps to deltas/final answer; banners/errors cannot become text.
3. Timeout/cancellation kills fixture child and grandchild; no task retry follows cancel.
4. Nonzero exit, empty success, malformed JSON and output overflow are distinct failures.
5. Two model entries sharing quotaPoolId never run concurrently at default limit.
6. Login expiry/quota limits yield explicit activity/terminal outcomes; paid fallback
   is excluded when forbidden and unknown reset does not wait forever.
7. Context and authentication artifacts are absent from diagnostic logs/catalog JSON.

05B records the selected CLI/version, official automation reference, profile name,
supported output protocol, authentication mode and observed quota behavior. Run one
small authorized live answer and one cancellation check. If required information
is unavailable, mark that live acceptance case blocked, not passed. Change adapter
status from not-implemented only after its implementation and tests are present.
