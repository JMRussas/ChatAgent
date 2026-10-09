# 16 — Hekate conversation operations runbook

Status: operator runbook for the maintained ChatAgent conversation workflow. It
describes behavior and boundaries; it records no test counts or run outcomes. The
contracts it relies on are in [13 — plan-node integration](13-hekate-plan-node-integration.md)
and [14 — local authentication](14-local-authentication.md). If this runbook and
those documents disagree, they win.

## 1. Trusted startup settings

Only the operator who starts the server sets these. A request, a browser field or a
URL can never supply or override them.

- `HEKATE_PLAN_API_URL`: the literal loopback plan API base. It is checked when the
  server is created, and an unsafe value stops startup. Without it the plan routes and
  panel are absent.
- `HEKATE_DISPATCH_CONFIG_PATH`: the reviewed DispatchHost configuration. It holds the
  host-level pins below. Treat it as trusted configuration, not as user input.

DispatchHost and TaskSpec pin separate layers.

**The DispatchHost configuration** pins the host and the native launch path. The server
refuses to launch when a pin does not match what is on disk:

- the maintained E1 source files, each by relative path and hash, plus the `uvLock`
  file by path and hash;
- the Python executable, by path, exact `--version` output and hash;
- the model executable, by path and hash, for each approved root;
- finite host limits: maximum duration, poll interval, heartbeat and node quota, plus
  output sizes, deadlines and the hashing budget;
- for each root, the fixed raw plan file and its hash, with the state and run paths;
- `traceRoot`: the approved directory where attempt traces are written and read back.
  Nothing outside it is read for progress.

**The prepared immutable TaskSpec** is pinned separately, when the task is authored
(see [13](13-hekate-plan-node-integration.md)). It pins the task, not the host:

- the Git anchor and task base, an exact Git SHA and not a branch name;
- the Node executable and the npm CLI, each by path, version and hash;
- the lockfile, the offline dependency install, the oracle and the formatter;
- the model, turn and budget bounds.

The dispatch configuration does not pin a Git revision or a Node or npm interpreter.
A Node, npm or lockfile change needs a new prepared TaskSpec, not a host edit.

Operator pairing is the browser session described in document 14. The paired session
carries the operator role through a same-origin cookie. Never place a credential,
pairing code, root identifier or token in a URL, query string, local storage or a
shared screenshot. The panel and the verifier below read the session; they never print it.

### Prepared-task cache: `npmCacheDir`

Tasks that install with `npm ci` need a warm npm cache.

- `npmCacheDir` is an optional absolute path to an operator-approved warm cache. Set it
  for every plan that contains an npm-ci task.
- The adapter passes it to the native command and task-runner environment only as
  `npm_config_cache`. It is not a credential for the model CLI worker, and ambient
  credentials and ambient npm configuration are excluded.
- The native side validates the directory and the offline dependency install in a
  preflight before claim. A missing cache fails that validation, so the refusal happens
  before claim: it does not start a worker, nothing is claimed, and there is no default
  location and no download fallback.

## 2. Explicit actions

There is no automatic execution from the page. Opening it, reloading it, retrying a
request or restoring a stored selection never executes, launches or stops anything.
Starting and stopping are buttons the operator presses.

One press of Start prepared plan arms a finite native dispatcher. It then polls and
advances approved ready nodes by itself, within its duration and node quotas, without a
new click per node. Nodes whose specs are blocked, awaiting review or already in flight
stay blocked. This is not persistent always-on recovery and not a perpetual AI
operator: the dispatcher ends at its quota, and nothing restarts it. Between clicks the
dispatcher and its observations do run.

- **Load/refresh.** A manual read of the plan status for the current user and
  conversation. The selection is scoped to that user and conversation, and a change of
  either clears the view and discards late results for the old scope. A failed refresh
  keeps the last good view under a banner that says it is no longer current.
- **Check host.** A manual read of the present host state. It reports what is recorded
  now and never invents an earlier success. If the journal is unresolved, malformed or
  uncertain, effects are blocked until an operator resolves it as described below.
- **Start prepared plan.** Launches the finite owner for the approved plan. Each press
  uses a fresh `operationId`. Never reuse one to retry; a repeated identifier is
  evidence of the earlier request, not a new request. A second launch while an owner
  exists is refused as a duplicate by the journal and store gates.
- **Stop.** A request to stop, see section 4.

## 3. Unknown outcomes

A network failure, timeout or lost response leaves the outcome unknown. Unknown does
not mean failure, cancellation or rollback. The operation may have taken effect.

- Do not blindly retry with a new `operationId` to "make sure". The conservative
  journal and store gates refuse a second owner while the outcome is unresolved, so a
  blind retry only adds a refusal to read; it resolves nothing.
- Run Check host and Load/refresh and read what is recorded.
- On an unconfirmed launch the native canonical launch ID is retained. Retaining it is
  not a claim that the launch succeeded.
- Reconcile only by one of two routes: the exact matching exited launch ID is recorded
  by the host, or an operator inspects the evidence explicitly and records the result
  while preserving the original uncertainty and its evidence.
- Never infer an outcome from age, elapsed time, a process ID, or the state of another
  owner. Never start a second owner to resolve doubt.

## 4. Stop, fencing and ownership

- A stop request is a request. The state `stop_requested` means the owner was asked.
  Only `stopped`, recorded by the native owner, means it stopped.
- The stop is delivered with the expected-launch-id fence. If the owner has changed
  the host answers `OWNER_CHANGED`. Do not retry the request against the new owner. A
  delayed request from an old owner is ignored and retained as evidence while the
  replacement owner's heartbeat advances.
- A finite native owner holds the sole API and database lock for the plan store. When
  quota, duration or `plan_done` ends it, the API closes, and the exact identity and
  history are retained before a controlled handoff to the next owner.

## 5. Reading attempt progress

Progress is a bounded, independent sample taken from the beginning of the attempt. It
is not incremental: each read starts over and does not continue from the last one.

- **Watch** is explicit and finite: 6 reads, a 5 s pause between them, 60 s in total.
  It ends by itself.
- The observer makes at most 8 GETs, reads at most 4 MiB, and stops after 10 s. The
  browser reads at most 1 MiB with a 10 s deadline.
- Only public assistant text and the fixed tool names Read, Glob, Grep, Edit and Write
  appear. Thinking, tool inputs, tool results, stderr and diagnostics are never shown.
- Worker statements are unverified claims and inert: nothing acts on them. Native
  checks and the recorded decision are separate facts shown separately.
- Worker liveness and useful progress are unknown. The host heartbeat shows that the
  owner runs; it is not worker progress.
- Every result cites the task, attempt, epoch, artifact, content revisions, evidence
  and observation time. A stale or historical decision from an older epoch is history,
  never the current result.
- The human panel and the AI observer share metadata identifiers. The aiSnapshot
  carries no arbitrary worker text.

## 6. Acceptance is not integration

Acceptance is not integration. A worker result accepted by the recorded decision has
not been merged. Integration is the lead's separate step: review the exact Git SHA,
run the relevant checks, perform the exact merge, then do a controlled reload or
restart. Conversation history is process-local, so a restart does not preserve it.
Do not describe a reload as persistence.

## 7. Read-only verifier

`scripts/check-conversation-rehearsal.mjs` is a headless, read-only check of the real
product through the lead's existing private browser session.

- It refuses to run unless the recorded proof file hashes to the pinned value.
- It reads the actual recorded status of the final task. The mode comes only from
  that status: an unattempted ready or blocked task is labelled `reference_preflight`,
  and a task with an attempt in a native state is `native_verification`.
- It writes sanitized metadata outside the repository.
- It cannot launch, stop or mutate anything, and it neither forges authentication
  nor mocks a route. Its result is a reading at one time, not a standing guarantee.

## 8. Remaining gaps

- A persistent role and recovery service is not implemented. Automatic service
  restarts and unattended recovery remain unfinished; the armed dispatcher keeps
  polling within its finite limits.
- A metrics baseline is not implemented, and there is no service-level objective.
- There is no perpetual AI monitoring. The finite dispatcher and its observations run
  while armed, but no AI operator watches the plan beyond that or beyond Watch
  sessions.

## 9. A finite delivery checklist

1. Confirm task readiness, approved cache and finite limits. Check host; an unknown
   outcome requires inspection and an exact owner check before another launch.
2. Start prepared plan once. The bounded dispatcher polls approved ready nodes;
   blocked inputs remain blocked. Read the exact task, attempt and epoch while work
   runs; worker liveness and useful progress remain unknown.
3. When native checks finish, wait for the recorded accepted decision for this
   attempt and artifact. Review the exact Git SHA and merge it only after the checks
   pass. Acceptance remains separate from source integration.
4. After controlled restart or reload, explicitly read the same recorded task,
   attempt, epoch, artifact and decision. Reload itself sends no execution request.
5. Request stop only for the observed owner. stop_requested is a request; confirm
   stopped and retain identity/history before a replacement. Never treat a failed
   observation or an unknown operation as permission to launch again.
