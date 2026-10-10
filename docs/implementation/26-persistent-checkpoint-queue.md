# 26 — Bounded checkpoint queue with targeted starts

Status: operator recovery contract. Athena's first proposal is retained and rejected:
it preclaimed waiting work, which would misrepresent active tasks and cannot claim
dependency-blocked successors. Missing Hekate source inputs caused that planning
limitation. This revision uses an existing API; it introduces no claim endpoint.
Planning, implementation, integration and live delivery have separate gates.

## Useful increment and authority

One explicit operator invocation arms at most four pinned coding checkpoints. The
queue starts only its next approved node, runs the existing finite continuation,
waits for an independently recorded exact acceptance, then starts the next approved
node without another launch command or user message. Pending nodes remain TODO.
Only one worker runs. Mechanical checks never accept source. PlanStore owns tasks
and decisions; the queue record owns sequencing and admission only.

The operator manifest grants narrow authority for node-specific starts and the
existing continuation's finish. It grants no decide/revise/cancel/release, global
claim, retry, merge, deploy, notification, visibility or arbitrary-command authority.
Actor strings and local records remain supplied and unauthenticated. This is the
existing supervised loopback operator trust boundary, not a new authorization system.
An allowlisted recorded reviewer is sufficient for this bounded local pilot; it is
not proof of an authenticated human or AI. CA-ISSUE-004 remains open for independent
AI wake, reliable escalation delivery and unattended crash recovery.

## Source-backed targeted start

Hekate source `4fa65283862ead9181cfb5530fa5b8861516a5f9`:

- `context-store/Api/PlanContractEndpoints.cs:115-125,497-501` exposes
  `POST /api/plan-contract/v1/nodes/{nodeId}/transition` with `to`, `attemptId`,
  `executorRef`, `operationKey`, `expectedStateRevision` and `actor`.
- `PlanContracts/PlanRules.cs:322-361` starts that exact leaf, rechecks predecessor
  gates and pins content/prerequisites; it increments the attempt epoch.
- `PlanRules.cs:508-520` checks the node revision and increments it; content and
  dependency changes also advance that revision. `PlanStore.cs:203-207` performs
  the mutation under its existing transaction/project lock.

For an unstarted item, the continuation template specifies the future attempt ID,
epoch and state revision. Before start require TODO (`ready`, gates holding), exact
content revision, previous epoch = template epoch minus one, previous node revision
= template state revision minus one. These are frozen at approval, never replaced
with convenient fresh values. POST only that node, `to: in_progress`, with the frozen
previous revision and deterministic queue/item operation key. A 409, timeout or
unavailable response never causes replay or launch. After a 200, reread PlanStore
and require exact template attempt, epoch, content, state revision, executor,
current pins and satisfied gates before running anything.

The global first-ready `/claims` route is never called. An unrelated ready sibling
cannot be selected. No future task appears in progress merely because it is queued.
Preapproved bases are independent, in distinct clean worktrees. Tasks needing a
previous candidate integrated into their source require a later operator-prepared
manifest; source acceptance alone does not prove integration or deployment.

## Closed input and records

`checkpoint-queue-service-manifest/v1`: strict JSON, at most 32 KiB, duplicate/unsafe
keys rejected using existing bounded parsers. Fields: `schema`, `queueId` (GUID),
`queueDir` (canonical existing directory outside worktrees), `planApiUrl` (loopback),
`actor`, `acceptors` (1–4 unique bounded ASCII tokens), `items` (1–4 entries containing
canonical `manifestPath` and `manifestSha256`), and `limits` (`wallMs` <= 7,200,000,
`pollMs` 1,000–30,000, `reviewWaitMs` <= 1,800,000, `totalUnits`, `totalOutputBytes`,
`totalProviderCapMicros`). Every item parses as the existing continuation manifest,
has profile coding and a declared provider cap, the same API URL, unique run/node
and worktree identities, distinct declared file scopes and enough queue wall for
its aggregate continuation bound plus 30 seconds. Sum of item hard units/output
and provider caps rounded UP to micros must fit queue admission limits. Provider
caps are configured but enforcement and usage remain unverified provider metadata.

Pin item bytes before effects; verify executable, prompt, tooling and source pins
before starting a node, using bounded reads and fixed shell-free Git checks.
Reject invalid/dirty/moved sources without a start POST. A fresh run slot also requires
no budget, gate, continuation record or continuation lease and no unchanged-runner
`.claim-<key>.lease`; no lease is ever removed. A later race is also checked
by unchanged continuation preflight and becomes needs_operator, never a retry.

Record `checkpoint-queue-service/v1`: strict, <= 32 KiB, queue/manifest identity,
generation, invocation count (max 4), phase, reason, timestamps, index, worst-case
admitted units/output/cap, and <= 4 items with exact task fence, run ID, sourceRef,
item state, start outcome and continuation outcome. Keep <= 64 transitions; overflow
stops rather than truncating evidence. Fixed trust fields: supplied_not_authenticated,
writerLiveness unknown, semanticReview not_performed, delivery not_sent, wake none,
integration not_observed. Store no prompts, raw output, tool results or secrets.
State and reason identify whether to review the current candidate, inspect uncertain
ownership, prepare source or resume a cleanly stopped queue.

An exclusive random-token `<queueId>.service.lock` and exclusive initial record
serialize a cooperative namespace. Atomic publication checks the lock token. Never
take over by PID or age. Cross-namespace duplication also fails the exact PlanStore
start CAS and existing continuation/runner leases. No global lock claim is made.

## Lifecycle and restart boundaries

1. Parse/pin/preflight. Create lock and initial record exclusively. Fresh PlanStore
   reads require each listed node is TODO at its frozen content/revision/epoch;
   later nodes may be dependency-blocked. No mutation at arm.
2. For the next item, require any previous item still accepted at exact source,
   attempt/content/epoch, current pins and allowlisted decidedBy. Check admission,
   remaining wall, source pins and readiness. Pending/blocked work stays pending.
3. Publish `starting` and reserve worst-case admission BEFORE the one targeted POST.
   Validate the fresh resulting fence; publish `running`; invoke runContinuation
   once with a fresh item monotonic start and the shared abort signal.
4. Only a terminal matching review_pending continuation with checks_passed and a
   current matching gate/source enters `waiting_review`. Failures, uncertainty,
   malformed records or moved fences enter needs_operator. No automatic retry.
5. Poll bounded GETs. Exact accepted source advances; rejection, wrong artifact,
   stale attempt/content/pins or a nonallowlisted reviewer stop with a typed reason.
   An older attempt's decision is history: beside an exact current review_pending
   source it neither accepts nor ends the wait, and any other historical decision
   never advances. The final acceptance publishes the last accepted item, phase
   `completed` and `all_accepted` as one record (one terminal transition).
   Unavailable reads advance nothing. Review timeout cleanly stops for attention.
6. Stop sentinel permits the current bounded continuation to settle, then starts
   nothing else. Stop, wall and signal are rechecked after the source preflight and
   before the durable intent; this narrows but is not an atomic filesystem-to-HTTP
   guarantee. Signals/deadline abort only owned work. Finally release only the
   owned lock. Preserve the record and all child evidence.

`--manifest <path>` plus exactly one of `--arm`, `--resume`, `--stop`, `--show`.
Show strictly reads retained metadata and performs no mutation or API request.
Stop creates the queue-specific sentinel. Resume requires no retained lock and a
cleanly stopped record at a settled waiting boundary; revalidate every pin and
exact prior acceptance. Persisted admission never resets. No resume from starting,
running, needs_operator or completed; no repeated start, finish, checks or worker.
A crash-retained lock requires separate confirmed operator recovery. Lifetime is
bounded per invocation, with max four invocations; this is durable sequencing,
not an always-on service. Time bounds are not performance SLOs or liveness evidence.

## Implementation and external gates

New `src/checkpoint/checkpointQueueState.ts`,
`src/checkpoint/checkpointQueueService.ts`, `scripts/runCheckpointQueue.ts`;
new meaningful unit and process integration tests; a nearby runtime-reference
section. Reuse continuation and runner unchanged, devCoordination bounded reads,
existing pure parsing, fixed owned-process/Git patterns and signal handling.
No UI, native-dispatcher, Hekate source, package or pilot-manifest change is needed.
Register child budget/continuation records in the existing inline overview; queue
metadata is also available through the CLI to any permitted human/AI consumer.

Verify: blocked TODO successor remains inactive; unrelated ready sibling receives
no mutation; exactly one targeted start and finish per item; stale node/content/
source causes no launch; moved predecessor and wrong accepted source stop;
duplicate owners and replaced lock tokens; kill between intent/POST/worker with
no replay; clean stopped resume with admission retained; malformed/changed pins;
budget/wall/output tripwires; unavailable API; graceful stop; two real process
checkpoints where an external acceptance of A triggers B without a user message.
Use real linked worktrees and loopback request logs. Passing tests are independent
of the worker; source acceptance remains lead review. Run focused regression,
format/lint/docs checks, then appropriate full checks and retained-store live proof.
Expose a failure and write a repair task instead of weakening a gate.
