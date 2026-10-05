# Code review findings: uncommitted changes, 2026-10-05

This file is a handoff for another AI model. It records the result of a review of
the uncommitted working-tree changes in the ChatAgent repository so that the
findings can be verified, fixed, or extended without access to the original
review conversation.

## Scope

- Repository: ChatAgent (TypeScript, Node, vitest, Playwright browser tests).
- Base commit: `c9eeb7f` on `main`.
- Reviewed: the working-tree diff against `HEAD` (`git diff HEAD`) plus the new
  untracked file `src/config/discoveryLimits.ts`.
- The change set is about bounding retained memory: conversation retirement,
  payload release in the generation lifecycle, queue and tool-result byte bounds,
  inventory replacement, bounded discovery reads, telemetry save coalescing, and
  stream version checks.

## Verification status

| Check                | Result                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `tsc --noEmit`       | Passed                                                                  |
| Test suite (vitest)  | Not run. The vitest config rejects Node 24.15.0 and requires 24.21.0.   |
| Browser tests        | Not run                                                                 |
| Finding reproduction | Neither finding was reproduced at runtime. Both come from reading code. |

Line numbers below refer to the working tree at review time and may drift. Use
the quoted code to locate each site.

## Finding 1: changing the conversation ID mid-send re-enables Send

- Severity: low
- Confidence: high that the code path exists; not reproduced in a browser
- File: `src/ui/homePage.ts` (inline client script inside `renderHomePageHtml`)
- Introduced by: this uncommitted diff

### Evidence

`clearConversationNotice()` is new in this diff and enables the Send button
unconditionally (around line 598):

```js
function clearConversationNotice() {
  state.expired = false;
  $("conversationNotice").hidden = true;
  sendButton.disabled = false;
}
```

The diff also adds a call to it in the conversation-ID `change` handler (around
line 973):

```js
conversationIdInput.addEventListener("change", () => {
  state.conversationId = String(conversationIdInput.value || "").trim();
  clearConversationNotice();
  cancelRetries.clear();
  ...
```

The composer `submit` handler relies on the button state as its only re-entry
guard (around line 880), disables the button for the duration of the send, and
restores it in `finally`:

```js
composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sendButton.disabled) return;
  ...
  sendButton.disabled = true;
  ...
  try {
    const res = await fetch("/messages", { method: "POST", ...
  } finally {
    sendButton.disabled = state.expired;
  }
});
```

### Failure scenario

1. The user submits a message. Send is disabled while `POST /messages` is pending.
2. Before the request settles, the user edits the conversation ID field and
   commits the edit, which fires `change`.
3. `clearConversationNotice()` sets `sendButton.disabled = false`.
4. The user submits again. The guard passes, and a second submit runs while the
   first is still in flight. Both share `state.pendingMessageId`,
   `state.pendingUserText`, and the timeline stream.

Before this diff, the `change` handler did not touch the button, so it stayed
disabled until the send settled.

### Open question

The diff also adds a `newConversation` click handler (around line 967) that sets
`conversationIdInput.value` programmatically. It was not checked whether that
handler dispatches `change` or calls `clearConversationNotice()` by another
route. If it does, the same scenario is reachable from the New conversation
button.

### Suggested fix

Track an explicit in-flight flag in `state` (set before the first `await` in the
submit handler, cleared in `finally`). Have `clearConversationNotice()` leave the
button disabled while that flag is set, and have the submit guard check the flag
as well as the button. Add a case to `tests/browser/chat.spec.ts` or
`tests/unit/homePage.test.ts` covering an ID change during a pending send.

## Finding 2: a cancelled deep retry can stay queued when the queue lacks `removeMessage`

- Severity: low. Latent: no queue implementation in the repository is affected.
- Confidence: medium. The downstream consequence was not traced end to end.
- Files: `src/app/orchestrator.ts`, `src/app/chatService.ts`,
  `src/providers/interfaces.ts`

### Evidence

In `DeepWorker` in `src/app/orchestrator.ts` (around line 553), the retry path
re-enqueues the task and then, if the turn was cancelled during the awaits,
removes it again. The diff changed `requeued = true` to the lines below:

```ts
if (next.active) {
  await next.queued(true);
  await this.queue.enqueue(task);
  requeued = next.active;
  if (!requeued) this.queue.removeMessage?.(task.conversationId, messageId);
}
return undefined;
```

`removeMessage` is optional on the `TaskQueue` interface in
`src/providers/interfaces.ts` (around line 31):

```ts
export interface TaskQueue {
  enqueue(task: DeepTask): Promise<void>;
  dequeue(): Promise<DeepTask | undefined>;
  /** Optional inspection used by identity retirement; absent means it cannot tell. */
  hasConversation?(conversationId: string): boolean;
  /** Removes queued entries only; dequeued work retains its lifecycle until physical settlement. */
  removeMessage?(conversationId: string, messageId: string): DeepTask[];
}
```

The cancel path in `src/app/chatService.ts` (around line 293) uses the same
optional call:

```ts
async cancelMessage(conversationId: string, messageId: string) {
  const result = await this.orchestrator.cancel(conversationId, messageId);
  const removed = this.queue?.removeMessage?.(conversationId, messageId) ?? [];
  await Promise.all(removed.map((task) => this.worker.discardQueued(task)));
  return result;
}
```

`InMemoryTaskQueue` in `src/providers/interfaces.ts` implements `removeMessage`,
so the shipped configuration behaves correctly.

### Failure scenario

With a `TaskQueue` implementation that omits `removeMessage`:

1. A deep task fails with a retryable error and is re-enqueued.
2. The message is cancelled, either during the `enqueue` await or later while the
   task is queued.
3. The optional call is a no-op, so the task remains in the queue. With
   `requeued` false, the worker releases what it was holding for that task (the
   review identified the task pin, dispatch snapshot, and dead-letter
   reservation).
4. A later `dequeue` returns the task. The review concluded that, once the
   settled turn has been pruned, this creates a fresh attempt and runs the deep
   provider for a cancelled message. Step 4 is the part that was not traced
   independently and should be verified first.

### Suggested fix

Pick one:

- Make `removeMessage` required on `TaskQueue`, since cancellation correctness now
  depends on it.
- Keep it optional and make the dequeue path check whether the message was
  cancelled before creating an attempt, discarding the task if so.

Either way, state in the interface comment what an absent `removeMessage` means
for cancellation, as the `hasConversation` comment already does for retirement.
A test with a minimal queue that lacks `removeMessage` would pin the behavior.

## Reviewed with no findings

These areas of the diff were read and no defect was identified. This is a
reading-level result, not a tested one:

- Conversation retirement
- Payload release in the generation lifecycle
- Queue and tool-result byte bounds
- Inventory replacement
- Bounded discovery reads
- Telemetry save coalescing
- Stream version checks

## Not reviewed

- `src/bench/sustainedMemory.ts`
- New tests: `tests/integration/conversationRetirement.test.ts`,
  `tests/unit/retainedBounds.test.ts`
- Modified tests under `tests/browser/`, `tests/integration/`, and `tests/unit/`
- Documentation changes (`README.md`, `docs/`, `.env.example`)
- Measurement artifacts under `docs/measurements/`
- `package.json` and `package-lock.json` changes

## Suggested next steps for the consuming model

1. Switch to Node 24.21.0 and run the test suite and `npm run lint` to establish
   a baseline for the uncommitted changes.
2. Verify step 4 of Finding 2 by tracing what `dequeue` consumers do with a task
   whose turn is cancelled and pruned.
3. Resolve the open question in Finding 1 about the `newConversation` handler.
4. Review the files listed under "Not reviewed", in particular whether the new
   tests exercise the retirement and bounds behavior they claim to.

Repository conventions that apply to any fix: run `npm run format` after edits
and `npm run lint` before handing off, keep formatting-only changes separate from
functional ones, use conventional commit prefixes, and update nearby tests and
`docs/12-development-roadmap.md` when behavior changes.

## Resolution — 2026-10-05

Both findings are fixed with regression coverage. The UI tracks submission state
through context refresh and request settlement, preserves the lock on conversation
changes, and ignores stale request errors. The new-conversation handler does
dispatch `change`, so it follows the same protection.

For custom queues without `removeMessage`, a cancelled retry keeps its task pin
and dependent resources until dequeue. This preserves the cancelled lifecycle
record and prevents a fresh attempt after pruning. The affected cancellation race
is during the retry awaits; cancellation after `requeued` becomes true already
preserved those resources. The regression holds retry enqueue open, cancels, then
checks retention and drains the task without a second provider call.

Validation on Node 24.21.0: 886 tests across 106 files and all 29 browser
tests pass, including both new regressions. Format and lint pass.
