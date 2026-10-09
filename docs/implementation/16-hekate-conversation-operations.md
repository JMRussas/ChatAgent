# 16 — Hekate conversation operations runbook

Status: operator runbook for the maintained ChatAgent conversation workflow over a prepared Hekate
plan. It records no run outcome and no pass count. The contracts it summarizes are defined in
[13 — Hekate plan-node integration](13-hekate-plan-node-integration.md) and
[14 — Local authentication](14-local-authentication.md); where this page and those documents
differ, they win. Related: [11 — Conversation tasks](11-conversation-tasks.md) and
[15 — Stall detection](15-stall-detection.md).

## 1. Scope and what this runbook does not claim

The workflow lets an operator, from the paired ChatAgent page, check a prepared Hekate plan root,
start one finite native owner for it, read bounded progress of its attempt and request a graceful
stop. Every effect is an explicit click. ChatAgent never decides that work is correct, accepted or
integrated.

Not claimed anywhere below: worker liveness, useful progress, perpetual AI monitoring, restart
persistence, a metrics baseline or a service-level objective. Section 10 lists what is unfinished.

## 2. Trusted startup settings

Two settings are read once by `startServer`, before anything is allocated. They are trusted
operator configuration. No request, browser field, query string or conversation can supply or
override either one.

- `HEKATE_PLAN_API_URL`: the literal loopback `http` address of the Hekate plan API. It enables the
  plan status panel and attempt progress. Without it those routes answer `404` and the page
  carries no plan markup.
- `HEKATE_DISPATCH_CONFIG_PATH`: an absolute path to a regular JSON file of at most 128 KiB that
  holds the closed dispatch configuration. Unset keeps the dispatch routes and run controls
  disabled. The file is validated by the real `DispatchHost` constructor; an unknown key is
  refused, and the startup error names a field path, never a configured value.

The configuration pins what may run. Review each pin before every operating session:

- Source pin: the `source.e1Root` manifest of `{path, sha256}` files, including `pyproject.toml`,
  and `uv.lock`.
- Interpreter pin: the `python` path, its sha256 and its exact `--version` text.
- Model pin: the model executable path and sha256 for each root, plus the worker kind.
- Plan pin: the plan file and its hash, the import hash and the run-root binding.
- `traceRoot`: required by this workflow, absolute, the operator-approved root under which
  attempt traces are confined. It must contain every configured run root and must not contain the
  source root, the journal directory or any state directory. The Hekate API process has to be
  started with the same approved value; nothing in ChatAgent proves that it was.
- `npmCacheDir`: see section 3.

Every call re-hashes these pins before any native command. A mismatch is a typed refusal that
names only the failed check, such as `PIN_MISMATCH` or `HOST_MISMATCH`, and starts nothing.

Operator pairing: the browser is paired once through `/pair` with a short-lived single-use code
that travels in a request body. Pairing gives the installation owner both roles, and the page then
relies on its same-origin session cookie. Never place a pairing code, credential, token or plan
root in a URL, query string, `localStorage` or a shared screenshot. The page URL stays the bare
origin throughout. See [14 — Local authentication](14-local-authentication.md).

## 3. Prepared-task cache: `npmCacheDir`

Prepared tasks that install dependencies with `npm ci` need a warm cache. The optional
`npmCacheDir` is that cache: an absolute native path approved by the operator.

- The host forwards exactly that configured string to every native child as the lowercase
  `npm_config_cache` variable. Ambient `npm_config_cache` and `NPM_CONFIG_CACHE`, and every other
  npm, registry, proxy, authentication or token variable, are excluded and never forwarded.
- The native task runner validates the directory and the offline dependency availability before
  claim. A missing cache is refused as `npm_cache_required`, an invalid one as
  `npm_cache_invalid`. A refusal does not start a worker and claims nothing.
- There is no default cache, no download fallback, no shell or environment source and no request
  override. The launch and stop payload stays `operationId` only.
- A configuration without `npmCacheDir` stays valid for status, read, stop and tasks that do not
  use `npm ci`. It cannot launch an npm-ci task.

The first ready product dispatch was refused before claim for exactly this reason, because the
adapter omitted the maintained cache requirement. The adapter repair is accepted and frozen. The
refused package and run are retained as evidence, and no prior native attempt was claimed. Original
node identities and the six accepted predecessors are unchanged.

## 4. Scoped, manual actions

The run controls are scoped to the user, conversation and plan root shown in the page. Changing
any of them, editing the root field or leaving the page aborts the browser request and discards a
late response. Aborting a browser request does not cancel anything on the server.

- Load/refresh reads the plan status for the root. It is manual (button or Enter), with no timer.
- Check host reads the present dispatch state with a same-origin `GET`. It reports what the native
  host says now. It does not invent a prior success and does not resolve an old uncertainty by
  itself.
- Start prepared plan sends `POST` with exactly `{"operationId":"<uuid>"}`. Every click allocates
  a fresh `operationId`; an old one is never reused to retry.
- Request stop sends the same body shape to the stop route (section 6).

There is no automatic execution, polling, retry or launch on page load, reload or scope change.
After a reload the page restores the root text and last typed metadata from `sessionStorage` and
sends nothing until a click. At most one request is outstanding and all buttons are disabled while
it runs, so a duplicate click sends once. Requests carry cookie credentials only, no redirects, a
10 s deadline and a 1 MiB body bound.

## 5. Unknown outcomes and the journal

A timeout, network failure, oversized body or unrecognized response to a start or stop is an
unknown outcome. Unknown does not mean failure, cancellation or rollback: the request may have
reached the native host and may be running. The page records the outcome as `unknown` and keeps
start and stop disabled, also across a reload, until an explicit Check host succeeds. The next
click then uses a new operation ID.

The adapter writes a journal record before every spawn and completes it afterwards. The same
operation ID replays its recorded result and never spawns twice. These conditions block further
effects and are never cleaned up by age, timing or the adapter:

- an unresolved intent, such as a crash between intent and completion;
- a malformed, foreign, oversized or unreadable record, shown as `journal.malformedRecords`;
- an uncertain launch (`journal.uncertainLaunch`) or an uncertain stop (`journal.uncertainStop`);
- a leftover lock file.

A blocked journal is resolved by an operator, not by retrying. Inspect the journal directory and
the native status, keep the original record and its evidence, and record what you inspected.

An unconfirmed launch answers `202 UNCONFIRMED` with an unknown child status. It is never reported
as a successful launch. The adapter retains the native canonical launch ID on that record when the
native result supplies a well-formed 32 digit lowercase hex ID, without echoing it publicly. The
record clears only in one of two ways:

1. a later native status shows an exited owner carrying exactly that launch ID, which reconciles it
   and keeps the original uncertain result beside the resolution; or
2. an explicit operator inspection, which preserves the original uncertainty and evidence.

Never infer the answer from age, elapsed time, a PID or a different owner, and never start a second
owner to find out. If the record has no ID it stays blocking until inspected.

## 6. Stop is a request

Request stop asks the native host to stop gracefully. The status label stays `stop_requested` while
the host is still running, and becomes `stopped` only after the native status shows an exited owner
with that reason. A request is a recorded request, not proof that the owner saw or obeyed it.

The stop is fenced. The adapter reads the running owner and sends the native command with the
literal expected-launch-id of that owner. If a different owner has replaced it, the native host
refuses with `OWNER_CHANGED` and nothing is stopped. Do not retry the request against the new
owner. Observe the status, confirm which owner is running now, and decide again; any new request
uses a new operation ID. A running owner with no verifiable launch ID is refused as
`OWNER_UNVERIFIED` before any native call. A duplicate launch while an owner runs is refused as
`OWNER_PRESENT`, so a second owner is never started.

A delayed stop request addressed to an old owner is ignored and retained while the replacement's
heartbeat advances. This was observed in the paired product UI: a finite owner was launched, exact
accepted native progress was read, a duplicate launch was refused, a fenced graceful stop was
delivered, and a delayed old-owner request was ignored and retained. Those are observations of one
rehearsal, not guarantees for later runs.

## 7. Reading attempt progress

Attempt progress is an operator-only, read-only projection of one bounded role observation.

- Each read is an independent sample taken from the beginning of the trace; it is not incremental
  and does not continue from the previous read. Two reads can differ and are not atomic across
  each other. The projection states its consistency and `observedAt`.
- The Read button is explicit. Watch is also explicit and finite: 6 reads, a 5 s pause between
  them and 60 s in total. It stops on any scope or binding change.
- Bounds: the observer makes at most 8 GETs, reads at most 4 MiB and runs for at most 10 s. The
  browser applies a 1 MiB body bound and a 10 s deadline.
- Only public assistant text and the fixed tool names Read, Glob, Grep, Edit and Write are shown.
  Thinking, tool inputs and results, user and system content, stderr, Hekate diagnostics and
  malformed or cut records never leave the module.

How to read what you see:

- Worker statements are unverified, inert claims. They do not change state and do not equal the
  recorded decision or a native check.
- Worker liveness and useful progress are unknown, always. The host heartbeat shown by Check host
  is host-only and is not worker progress.
- When you cite a result, cite the task, attempt id, attempt epoch, artifact reference, content and
  state revisions, evidence hashes and the observation time. A stale or historical decision from an
  older attempt epoch is history, not the current result.
- The human panel and the AI observer snapshot share the same identifiers and metadata. The
  `aiSnapshot` is a distinct schema with its own timestamp and carries no arbitrary worker text.

## 8. Read-only rehearsal verifier

`scripts/check-conversation-rehearsal.mjs` is a read-only, headless, finite check of the real
product UI through the lead's already paired private browser state. It cannot launch, stop or
mutate anything, mocks no route and forges no authentication. It never touches the model or the
native host.

- It refuses to run unless the recorded preflight proof matches the exact pinned hash, and the
  four preflight flags (actual UI launch, duplicate refusal, graceful stop, late old request
  ignored) are true. An unpinned or altered proof is refused.
- It loads the page, confirms that no `/development` request happens on load or reload, then
  performs explicit refresh and progress reads only, and refuses any request outside the allowed
  GET paths or any request to a message route.
- It reads the actual recorded status of the final task and derives the mode only from that. A
  task with no attempt that is ready or blocked is labelled `reference_preflight`. A task with a
  recorded attempt in progress, review pending or accepted is labelled `native_verification`.
  Anything else is refused. Nothing the caller passes can change the label.
- It checks the progress sample for current consistency, matching attempt and epoch, verified
  trace, unknown liveness and useful progress, untrusted activity and fixed tool names. An
  acceptance counts only when the recorded decision names the same attempt, epoch, content
  revision and artifact.
- It writes sanitized metadata and one screenshot to a new directory outside the repository,
  beside the working directory. The report states what it does not claim: integration, worker
  liveness, useful progress and final acceptance before a recorded decision.

The verifier is the lead's or supervisor's tool; it needs private browser state that a worker does
not have. Its output is evidence about the product at the time it ran, not a pass count in this
document.

## 9. Acceptance is not integration

Acceptance is not integration. A recorded acceptance decision says the reviewed attempt content was
accepted. Integration is separate work by the lead:

1. review the exact Git SHA of the accepted work and the relevant checks;
2. perform the exact merge;
3. perform the controlled reload or restart, so the running product contains it.

Conversation history in the page and server is process-local. It is not restart persistence; a
restart does not carry it over, and a reload only restores the typed metadata described in
section 4.

The native owner is finite. It holds the sole API and database lock while it runs. When a quota,
duration limit or `plan_done` ends it, the API closes. Capture the exact identities and history
(launch ID, operation IDs, attempt and artifact references, observation times) before a controlled
handoff, because later Check host reads show the new state, not the old one.

## 10. Remaining gaps

- A persistent role and recovery service is not implemented. Nothing wakes a stalled lead, resumes
  an interrupted launch or watches a plan unattended.
- A metrics baseline is not implemented, and there is no service-level objective. No claim is made
  about latency, availability or detection time.
- No perpetual AI monitoring exists. The watch is a finite, human-started sample.
- Installed packages in the interpreter environment are trusted, not hash-pinned. The journal has
  no integrity signature. See [13 — Hekate plan-node integration](13-hekate-plan-node-integration.md)
  for the full limitations.
