import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
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
  return { base, path, scope, post, events, service, server };
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

// Raw frames with their SSE ids, opened with any headers (an array value sends the
// header line more than once, as a repeated header).
async function openStream(
  h: Awaited<ReturnType<typeof setup>>,
  query: string,
  headers: Record<string, string | string[]> = {}
) {
  return new Promise<{
    status: number;
    body: string;
    next(): Promise<{ id?: number; event: string; data: any }>;
    close(): void;
  }>((resolve, reject) => {
    const req = request(
      `${h.base}${h.path}/events/stream?${h.scope}&${query}`,
      { headers },
      (res) => {
        let buffer = "";
        const waiting: Array<() => void> = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          waiting.splice(0).forEach((wake) => wake());
        });
        cleanups.push(async () => void req.destroy());
        const frames = {
          status: res.statusCode!,
          get body() {
            return buffer;
          },
          async next() {
            while (!buffer.includes("\n\n"))
              await new Promise<void>((wake, fail) => {
                waiting.push(wake);
                res.once("end", () => fail(new Error("EOF")));
              });
            const end = buffer.indexOf("\n\n");
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const field = (name: string) =>
              frame
                .split("\n")
                .find((line) => line.startsWith(name + ": "))
                ?.slice(name.length + 2);
            const id = field("id");
            return {
              id: id === undefined ? undefined : Number(id),
              event: field("event")!,
              data: JSON.parse(field("data") ?? "null")
            };
          },
          close: () => req.destroy()
        };
        if (res.statusCode === 200) resolve(frames);
        else res.on("end", () => resolve(frames)).resume();
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Turn frames until the terminal fast frame of the given message. */
async function turnsUntil(stream: Awaited<ReturnType<typeof openStream>>, messageId: string) {
  const frames: { id: number; data: any }[] = [];
  for (;;) {
    const frame = await stream.next();
    if (frame.event !== "turn") continue;
    frames.push({ id: frame.id!, data: frame.data });
    if (frame.data.messageId === messageId && frame.data.type === "terminal") return frames;
  }
}

it("v1 resumes after Last-Event-ID on a reconnect, without replay, loss or duplicates", async () => {
  const h = await setup({
    createProvisionalReply: async (_input, control) => {
      await control!.onDelta("part");
      return { text: "answer", finishReason: "stop" };
    }
  });
  const first = randomUUID(),
    second = randomUUID();
  await h.post("one", first);
  await h.post("two", second);
  const original = await openStream(h, "afterSequence=0");
  expect((await original.next()).event).toBe("ready");
  const all = await turnsUntil(original, second);
  // The connection drops part-way: the client last received the first terminal.
  original.close();
  const last = all.find((f) => f.data.messageId === first && f.data.type === "terminal")!.id;
  // A native EventSource reconnects to the original URL with Last-Event-ID.
  const resumed = await openStream(h, "afterSequence=0", { "Last-Event-ID": String(last) });
  expect(resumed.status).toBe(200);
  expect((await resumed.next()).event).toBe("ready");
  // Live events arriving around the replay point are delivered once, in order.
  const third = randomUUID();
  const live = h.post("three", third);
  const replayed = await turnsUntil(resumed, third);
  await live;
  const ids = replayed.map((f) => f.id);
  expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
  expect(ids[0]).toBeGreaterThan(last);
  expect(ids.slice(0, all.filter((f) => f.id > last).length)).toEqual(
    all.filter((f) => f.id > last).map((f) => f.id)
  );
  expect(replayed.at(-1)!.data).toMatchObject({ messageId: third, type: "terminal" });
  resumed.close();
});

it("v1 takes the later of afterSequence and Last-Event-ID", async () => {
  const h = await setup({
    createProvisionalReply: async () => ({ text: "a", finishReason: "stop" })
  });
  const one = randomUUID(),
    two = randomUUID();
  await h.post("one", one);
  await h.post("two", two);
  const all = await turnsUntil(await openStream(h, "afterSequence=0"), two);
  const low = all[0].id,
    high = all[all.length - 2].id;
  for (const [query, header] of [
    [high, low],
    [low, high]
  ]) {
    const s = await openStream(h, `afterSequence=${query}`, { "Last-Event-ID": String(header) });
    await s.next();
    expect((await turnsUntil(s, two))[0].id).toBeGreaterThan(Math.max(query, header));
    s.close();
  }
});

it.each([
  ["a word", "abc"],
  ["a negative", "-1"],
  ["a fraction", "1.5"],
  ["an exponent", "1e2"],
  ["a sign", "+1"],
  ["internal whitespace", "1 2"],
  ["an empty value", ""],
  ["an unsafe integer", "9007199254740992"],
  ["a list", "1, 2"],
  ["a repeated header", ["1", "1"]]
])("v1 refuses %s as Last-Event-ID before admission or any read", async (_, value) => {
  const h = await setup({
    createProvisionalReply: async () => ({ text: "a", finishReason: "stop" })
  });
  await h.post();
  const reads = vi.spyOn(h.service, "getTimeline");
  const s = await openStream(h, "afterSequence=0", { "Last-Event-ID": value });
  expect(s.status).toBe(400);
  expect(JSON.parse(s.body)).toMatchObject({ code: "INVALID_CURSOR" });
  expect(reads).not.toHaveBeenCalled();
  expect(h.server.retentionStats()).toMatchObject({ streams: 0 });
});

it("v1 applies its cursor and runtime checks to Last-Event-ID", async () => {
  const h = await setup({
    createProvisionalReply: async () => ({ text: "a", finishReason: "stop" })
  });
  await h.post();
  const beyond = await openStream(h, "afterSequence=0", { "Last-Event-ID": "999" });
  expect(beyond.status).toBe(409);
  expect(JSON.parse(beyond.body)).toMatchObject({ code: "CURSOR_UNAVAILABLE" });
  const restarted = await openStream(h, "afterSequence=0&runtimeId=old", { "Last-Event-ID": "1" });
  expect(restarted.status).toBe(409);
  expect(JSON.parse(restarted.body)).toMatchObject({ code: "RUNTIME_RESTARTED" });
  // Zero is a valid cursor: everything from the start.
  const zero = await openStream(h, "afterSequence=0", { "Last-Event-ID": "0" });
  expect(zero.status).toBe(200);
  zero.close();
  await vi.waitFor(() => expect(h.server.retentionStats()).toMatchObject({ streams: 0 }));
});

it("v1 pumps copy only events after the cursor, so idle pumps copy none", async () => {
  const h = await setup({
    createProvisionalReply: async () => ({ text: "a", finishReason: "stop" })
  });
  const one = randomUUID();
  await h.post("one", one);
  await h.post("two");
  const original = h.service.getTimelineAfter.bind(h.service);
  const full = vi.spyOn(h.service, "getTimeline");
  const after = vi.spyOn(h.service, "getTimelineAfter");
  const copied: number[] = [];
  after.mockImplementation(async (id, cursor) => {
    const events = await original(id, cursor);
    copied.push(events.length);
    return events;
  });
  const stream = await openStream(h, "afterSequence=0");
  await stream.next();
  await turnsUntil(stream, one);
  const total = (await h.service.getTimeline(full.mock.calls[0][0])).length;
  full.mockClear();
  copied.length = 0;
  await new Promise((r) => setTimeout(r, 350));
  // Several idle pumps: none read the whole timeline, and none copied an event.
  expect(full).not.toHaveBeenCalled();
  expect(copied.length).toBeGreaterThanOrEqual(2);
  expect(copied.every((n) => n === 0)).toBe(true);
  expect(total).toBeGreaterThan(0);
  // New history: the next pump copies only the new events.
  const three = randomUUID();
  await h.post("three", three);
  await turnsUntil(stream, three);
  expect(Math.max(...copied)).toBeLessThan(total);
  stream.close();
});
