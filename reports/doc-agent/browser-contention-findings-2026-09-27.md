# Browser and shared Ollama validation — 2026-09-27

The real browser check found and reproduced a rendering bug that HTTP and unit
tests had missed. After fixing it, the browser flow passed. A small latency probe
then measured slower foreground replies during background documentation work.

## Browser finding and fix

The first run remained on **Sending** even after the HTTP request succeeded.
Evaluating `renderThread()` in Chrome identified `ReferenceError: __name is not
defined` inside the embedded `deriveTurns` function. The `tsx` development
transform adds a module-scoped naming helper to a locally assigned function.
Serializing the outer function with `toString()` copied the helper reference but
not its definition into the page. Vitest's transform had not reproduced this.

`turnViewModel.ts` now selects the latest fast/deep attempts directly, avoiding
that local function and its compiler helper. A regression test launches Node with
`--import tsx`, serializes the projection, and executes it in a fresh JavaScript
scope with a completed turn. Longer term, shipping a built browser module would
remove this serialization fragility; this change retains the current architecture.

The [failed run](browser-contention-v1-2026-09-27/results.json) preserves the
timeout; its early harness version did not persist browser exceptions. The error
above was collected separately through Chrome's evaluation endpoint during that
run. No latency samples were collected in the failed run.

The [successful run](browser-contention-v2-2026-09-27/results.json) used isolated
headless Chrome, an ephemeral HTTP server, the real Python/LangGraph worker and
local Ollama. Foreground inference was mocked for this browser phase. It verified:

- Loading the page and starting a documentation task.
- Send staying enabled and accepting foreground chat during background work.
- Starting and cancelling a second task through the rendered controls.
- Displaying a completed answer and its source reference.
- Clearing old task rows when switching conversation scope.
- No uncaught browser JavaScript exceptions.

The [viewport capture](browser-contention-v2-2026-09-27/browser.png) shows the
composer; the result JSON preserves the task panel text. This is not an exhaustive
accessibility, mobile, reconnect, restart/resume or multi-browser test.

## Foreground latency during background work

After the browser check, the same harness switched foreground requests to the
real `OllamaFastProvider`. Both foreground and background used installed
`gemma4:26b`, digest `5571076f3d70050487b26b341705799e0ab29b808164f90d20d4cf84f699d251`.
The result records the Ollama version and loaded-model observations. Ollama
reported the model's full loaded size in VRAM and a 32,768-token context.

Foreground configuration: temperature 0, thinking off (verified against local
metadata), 64 output tokens, 120-second request timeout, fresh conversation per
sample. Every request asked the same short arithmetic question and returned
“Two plus two is four.” with HTTP 200. Background work used the existing worker's
documentation question, tools and resource limits. No deep conversational worker
ran. No existing development process, model installation or server settings changed.

| Condition | Samples | Full HTTP response times (ms) | Median (ms) |
| --- | ---: | --- | ---: |
| Baseline before | 3 | 244, 293, 273 | 273 |
| Background task running | 3 | 829, 888, 893 | 888 |
| Baseline after | 3 | 546, 308, 298 | 308 |
| Combined baseline | 6 | Above baseline samples | 295 |

One warmup request (543 ms) was excluded. All three background tasks completed;
each was running immediately before and after its foreground sample. The overlap
median was about **3.0 times** the combined baseline median, still below one second
for this tiny prompt. This supports investigating shared inference scheduling.

Limits: these are full HTTP durations, not time to first token or GPU execution
traces. Task-running status does not prove simultaneous GPU kernels. Queueing,
prompt evaluation and cache effects are not separated. Conditions ran in fixed
order, prompts were repeated, and the sample is too small for p95 or general
performance claims. There is no comparison across models or separate foreground
and background model residency. The 120-second harness deadline differs from the
default foreground adapter deadline; no request approached either deadline.

## Verification and reproduction

All 248 TypeScript tests across 44 files passed, including the new compiler-boundary
regression. Type check and build passed. See [test output](browser-contention-v2-2026-09-27/tests.txt)
and [source hashes](browser-contention-v2-2026-09-27/source-hashes.json).
Python implementation did not change in this increment.

From the repository root with Windows Node, supply installed Python and Chrome
paths and a new output directory:

```powershell
node --import tsx experiments/doc-agent/browser_contention.ts `
  D:/Git/LangChain/lca-lc-foundations/.venv/Scripts/python.exe `
  'C:/Program Files/Google/Chrome/Application/chrome.exe' `
  reports/doc-agent/browser-contention-new-run
```

The harness creates a temporary browser profile, records failures as well as
successes, closes its server/browser and ignores task databases. It uses no
browser automation dependency or downloaded browser.

## Next bounded increment

Measure first-token latency and time waiting for model admission, with varied
foreground prompts and several queued background tasks. Define a responsiveness
target before choosing a shared admission/priority policy across Node and Python.
Pausing between model calls could prioritize new foreground work; it would not
preempt an inference already executing. Keep result-to-conversation context
selection and scheduled triggers as separate work.
