import { expect, it } from "vitest";
import { createChatServer } from "../../src/server";
import { createRuntimeHandle } from "../../src/app/runtimeHandle";
import { entry, runtime } from "../helpers/dispatchFixtures";
import { GenerationError } from "../../src/domain/generation";
import { runLiveBenchmark } from "../../src/bench/liveBenchmark";

it("retains provider failure and retry evidence through the real HTTP error response", async () => {
  const r = runtime([entry("a")], { a: { fast: { createProvisionalReply: async () => {
    throw new GenerationError("PROVIDER_UNAVAILABLE", true);
  } } } });
  const server = createChatServer(r.service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const handle = createRuntimeHandle(server, r.service, { config: { graceMs: 0, timeoutMs: 1000 },
    stopBackground: () => {}, stopInternal: () => r.manager.shutdown(), persist: async () => {} });
  try {
    const [record] = await runLiveBenchmark([{ id: "hello", text: "Hello" }], {
      baseUrl: `http://127.0.0.1:${handle.address.port}`, pollIntervalMs: 5, deadlineMs: 3000
    });
    expect(record).toMatchObject({ outcome: "error", httpStatus: 502, errorCode: "PROVIDER_UNAVAILABLE",
      routeDecision: "clarify", retryCount: 2, cancellation: "not-requested" });
    expect(record.attempts).toHaveLength(3);
    expect(record.attempts.every(a => a.bindingId !== null && a.finishReason === "error")).toBe(true);
    expect(record.finalObservedMs).not.toBeNull();
  } finally { await handle.shutdown(); }
});
