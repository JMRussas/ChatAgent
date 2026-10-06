import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import {
  InMemoryTaskQueue,
  type DeepModelProvider,
  type FastModelProvider
} from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider } from "../../src/providers/mockProviders";
import { ContextManager } from "../../src/app/contextManager";
import { loadContextBudgetConfigFromEnv } from "../../src/config/contextConfig";
import type { GenerationControl } from "../../src/domain/generation";
import { allowAllTestAuth } from "../helpers/testAuth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function setup(
  provider: FastModelProvider,
  deep: DeepModelProvider = new MockDeepProvider(),
  maxConcurrentTurns?: number
) {
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    new ChatOrchestrator(
      provider,
      queue,
      timeline,
      undefined,
      new ContextManager(timeline, loadContextBudgetConfigFromEnv({}))
    ),
    new DeepWorker(queue, deep, timeline),
    timeline,
    queue,
    undefined,
    undefined,
    { maxConcurrentTurns }
  );
  const server = createChatServer(service, { auth: allowAllTestAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const conversation = randomUUID();
  const path = `/v1/conversations/${conversation}`;
  const scope = "accountId=a&projectId=p";
  const post = (text = "hello", messageId = randomUUID(), projectId = "p", conv = conversation) =>
    fetch(`${base}/v1/conversations/${conv}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "1.0",
        accountId: "a",
        projectId,
        messageId,
        text,
        clientTimestampIso: new Date().toISOString()
      })
    });
  async function events(after = 0, query = scope) {
    const response = await fetch(`${base}${path}/events/stream?${query}&afterSequence=${after}`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel().catch(() => undefined));
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      async next(): Promise<any> {
        while (!buffer.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("EOF");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        const end = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return JSON.parse(
          frame
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        );
      },
      close: () => reader.cancel()
    };
  }
  return { base, path, scope, post, events, service };
}

it("v1 preserves capacity refusal when the message ID already has a terminal event", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(
    {
      createProvisionalReply: async (input) => {
        if (input.message.text === "hold") await held;
        return { text: "answer", finishReason: "stop" };
      }
    },
    new MockDeepProvider(),
    1
  );
  const messageId = randomUUID();
  expect((await h.post("hello", messageId)).status).toBe(200);
  const occupant = h.post("hold");
  try {
    await vi.waitFor(() => expect(h.service.retentionStats().activeTurns).toBe(1));
    const refused = await h.post("hello", messageId);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.json()).toMatchObject({ code: "TURN_CAPACITY" });
  } finally {
    release();
    await occupant;
  }
  expect((await h.post("hello", messageId)).status).toBe(409);
});

it("v1 preserves two-turn context, deduplicates submission, and isolates declared scopes and conversations", async () => {
  const inputs: any[] = [];
  const h = await setup({
    createProvisionalReply: async (input) => {
      inputs.push(input);
      return { text: "answer", finishReason: "stop" };
    }
  });
  const id = randomUUID();
  expect((await h.post("hello", id)).status).toBe(200);
  expect((await h.post("hello", id)).status).toBe(409);
  expect((await h.post("again")).status).toBe(200);
  expect(JSON.stringify(inputs[1])).toContain("hello");
  await h.post("isolated", randomUUID(), "other");
  expect(JSON.stringify(inputs[2])).not.toContain('"hello"');
  await h.post("separate", randomUUID(), "p", randomUUID());
  expect(JSON.stringify(inputs[3])).not.toContain('"hello"');
  const stream = await h.events();
  expect(await stream.next()).toHaveProperty("runtimeId");
  const first = await stream.next();
  expect(first).toMatchObject({ protocolVersion: "1.0", messageId: id, phase: "fast" });
  await stream.close();
});

it("v1 streams before POST completes, resumes after cursor and cancels without late output", async () => {
  let control: GenerationControl | undefined;
  const h = await setup({
    createProvisionalReply: async (_input, c) => {
      control = c!;
      await c!.onDelta("partial");
      await new Promise<void>((_, reject) =>
        c!.signal.addEventListener("abort", () => reject(c!.signal.reason), { once: true })
      );
      return { text: "late", finishReason: "stop" };
    }
  });
  const id = randomUUID();
  let finished = false;
  const pending = h.post("hello", id).then((r) => {
    finished = true;
    return r;
  });
  await vi.waitFor(() => expect(control).toBeDefined());
  const stream = await h.events();
  const ready = await stream.next();
  let event;
  do {
    event = await stream.next();
  } while (event.type !== "delta");
  expect(finished).toBe(false);
  expect(event.text).toBe("partial");
  await stream.close();
  expect(
    (
      await fetch(`${h.base}${h.path}/messages/${id}/cancel?accountId=a&projectId=other`, {
        method: "POST"
      })
    ).status
  ).toBe(404);
  expect(
    (await fetch(`${h.base}${h.path}/messages/${id}/cancel?${h.scope}`, { method: "POST" })).status
  ).toBe(200);
  expect((await (await pending).json()).fastResponse.processingStatus).toBe("cancelled");
  await control!.onDelta("late");
  const resumed = await h.events(event.sequence, h.scope + `&runtimeId=${ready.runtimeId}`);
  await resumed.next();
  expect(await resumed.next()).toMatchObject({
    type: "terminal",
    finishReason: "cancelled",
    text: "partial"
  });
  await resumed.close();
  for (const query of ["afterSequence=-1", "afterSequence=999", "runtimeId=old"]) {
    expect(
      (await fetch(`${h.base}${h.path}/events/stream?${h.scope}&${query}`)).status
    ).toBeGreaterThanOrEqual(400);
  }
});

it("projects the shared Iris fixture without losing terminal outcomes", async () => {
  const { readFile } = await import("node:fs/promises");
  const { projectTurnEvent } = await import("../../src/app/protocolV1");
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/protocol-v1-turn.json", import.meta.url), "utf8")
  );
  for (const wire of fixture) {
    const event = { ...wire, type: wire.type === "answer" ? "refined" : wire.type };
    expect(JSON.parse(JSON.stringify(projectTurnEvent(wire.conversationId, event)))).toEqual(wire);
  }
});

it("an accepted fast failure remains replayable with its partial answer", async () => {
  const { GenerationError } = await import("../../src/domain/generation");
  const h = await setup({
    createProvisionalReply: async (_input, control) => {
      await control!.onDelta("useful partial");
      throw new GenerationError("INVALID_STREAM", false);
    }
  });
  const response = await h.post();
  expect(response.status).toBe(200);
  expect((await response.json()).fastResponse).toMatchObject({
    processingStatus: "failed",
    provisionalReply: "useful partial"
  });
  const stream = await h.events();
  await stream.next();
  let event;
  do {
    event = await stream.next();
  } while (event.type !== "terminal");
  expect(event).toMatchObject({ finishReason: "error", text: "useful partial" });
  await stream.close();
});

it.each([false, true])(
  "v1 cancels queued/running deep work without retries (running=%s)",
  async (running) => {
    let control: GenerationControl | undefined;
    const deep = vi.fn(async (_task, c?: GenerationControl) => {
      control = c!;
      await c!.onDelta("deep partial");
      await new Promise<void>((_, reject) =>
        c!.signal.addEventListener("abort", () => reject(c!.signal.reason), { once: true })
      );
      throw new Error("unreachable");
    });
    const h = await setup(
      { createProvisionalReply: async () => ({ text: "early", finishReason: "stop" }) },
      { resolveDeepTask: deep }
    );
    const id = randomUUID();
    const result = await (await h.post("Find latest news", id)).json();
    expect(result.deepTask).toHaveProperty("taskId");
    const work = running ? h.service.runDeepWorkerOnce() : undefined;
    if (running) await vi.waitFor(() => expect(control).toBeDefined());
    expect(
      (await fetch(`${h.base}${h.path}/messages/${id}/cancel?${h.scope}`, { method: "POST" }))
        .status
    ).toBe(200);
    await work;
    await h.service.runDeepWorkerOnce();
    expect(deep).toHaveBeenCalledTimes(running ? 1 : 0);
    if (control) await control.onDelta("late");
    const stream = await h.events();
    await stream.next();
    let event;
    do {
      event = await stream.next();
    } while (event.type !== "terminal" || event.phase !== "deep");
    expect(event.finishReason).toBe("cancelled");
    expect(event.text).toBe(running ? "deep partial" : "");
    await stream.close();
  }
);
