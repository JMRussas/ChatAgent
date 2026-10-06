import { randomBytes, randomUUID } from "node:crypto";
import { Agent, request, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { LocalAuthenticator } from "../../src/auth/authenticator";
import type { LocalIdentity } from "../../src/auth/localIdentity";

// The native connection limit over real sockets, with real authentication. Every
// kind of open connection counts the same: an incomplete raw client, an event
// stream and an idle keep-alive connection.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const secret = () => randomBytes(32).toString("base64url");
const identity: LocalIdentity = {
  version: 1,
  principalId: `local:${randomUUID()}`,
  sessionKey: secret(),
  clientToken: secret(),
  operatorToken: secret(),
  epoch: 0
};
const client = { authorization: `Bearer ${identity.clientToken}` };

async function start(maxConnections: number, maxEventStreams: number) {
  const queue = new InMemoryTaskQueue(),
    timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline,
    queue
  );
  const server = createChatServer(service, {
    auth: new LocalAuthenticator(identity),
    maxConnections,
    maxEventStreams
  });
  const drops: unknown[] = [];
  server.on("drop", (data) => drops.push(data));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  // The same shutdown steps as the runtime handle.
  const stop = () =>
    new Promise<void>((done) => {
      server.closeStreams();
      server.close(() => done());
      server.closeIdleConnections();
      server.closeAllConnections();
    });
  cleanups.push(() => (server.listening ? stop() : undefined));
  const connections = () =>
    new Promise<number>((done, fail) =>
      server.getConnections((error, count) => (error ? fail(error) : done(count)))
    );
  return { server, port, drops, connections, stop };
}

/** A raw client: what it received and whether it has closed. */
function raw(port: number, text?: string) {
  const socket = connect(port, "127.0.0.1");
  const seen = { data: "", closed: false, socket };
  socket.on("data", (chunk) => (seen.data += chunk.toString("latin1")));
  socket.on("error", () => undefined);
  socket.on("close", () => (seen.closed = true));
  cleanups.push(() => void socket.destroy());
  if (text) socket.on("connect", () => socket.write(text));
  return seen;
}

function get(
  port: number,
  path: string,
  agent: Agent | false,
  headers: Record<string, string> = {}
) {
  return new Promise<IncomingMessage>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, agent, headers }, done);
    req.on("error", fail);
    req.end();
  });
}
const body = async (res: IncomingMessage) => {
  let text = "";
  for await (const chunk of res) text += chunk;
  return text;
};

describe("connection limit", () => {
  it("closes an excess connection before HTTP, reuses a slot after a real close and leaves admitted requests unchanged", async () => {
    const s = await start(3, 1);
    // 1: a raw client that has sent nothing.
    const incomplete = raw(s.port);
    // 2: an admitted event stream.
    const streamAgent = new Agent({ keepAlive: false });
    cleanups.push(() => streamAgent.destroy());
    const stream = await get(
      s.port,
      `/conversations/${randomUUID()}/events/stream`,
      streamAgent,
      client
    );
    expect(stream.statusCode).toBe(200);
    // 3: an idle keep-alive connection after an answered request.
    const keepAlive = new Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => keepAlive.destroy());
    const first = await get(s.port, "/run-controls", keepAlive, client);
    expect(first.statusCode).toBe(200);
    await body(first);
    await vi.waitFor(async () => expect(await s.connections()).toBe(3));

    // A fourth connection is closed without a single HTTP byte.
    const excess = raw(s.port, "GET /run-controls HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await vi.waitFor(() => expect(excess.closed).toBe(true));
    expect(excess.data).toBe("");
    expect(s.drops).toHaveLength(1);

    // Admitted connections behave as before: authentication and Host checks.
    for (const [headers, status] of [
      [client, 200],
      [{}, 401],
      [{ ...client, host: "example.test" }, 403]
    ] as const) {
      const res = await get(s.port, "/run-controls", keepAlive, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(status);
      await body(res);
    }
    expect(s.drops).toHaveLength(1);

    // A slot frees only when a connection actually closes.
    incomplete.socket.destroy();
    await vi.waitFor(async () => expect(await s.connections()).toBe(2));
    const reused = raw(
      s.port,
      `GET /run-controls HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${client.authorization}\r\nConnection: close\r\n\r\n`
    );
    await vi.waitFor(() => expect(reused.closed).toBe(true));
    expect(reused.data).toMatch(/^HTTP\/1\.1 200 /);

    // With a connection free, the stream limit still answers with its own 429.
    await vi.waitFor(async () => expect(await s.connections()).toBe(2));
    const second = raw(
      s.port,
      `GET /conversations/${randomUUID()}/events/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${client.authorization}\r\nConnection: close\r\n\r\n`
    );
    await vi.waitFor(() => expect(second.data).toMatch(/^HTTP\/1\.1 429 /));
    expect(second.data).toContain("STREAM_CAPACITY");
    expect(s.drops).toHaveLength(1);
    stream.destroy();
  });

  it("shuts down with every slot held", async () => {
    const s = await start(3, 2);
    const held: Socket[] = [];
    const incomplete = raw(s.port);
    held.push(incomplete.socket);
    const agent = new Agent({ keepAlive: true, maxSockets: 2 });
    cleanups.push(() => agent.destroy());
    const stream = await get(s.port, `/conversations/${randomUUID()}/events/stream`, agent, client);
    expect(stream.statusCode).toBe(200);
    const idle = await get(s.port, "/run-controls", agent, client);
    await body(idle);
    await vi.waitFor(async () => expect(await s.connections()).toBe(3));
    const streamClosed = new Promise<void>((done) => stream.on("close", () => done()));
    stream.resume();
    await s.stop();
    await streamClosed;
    await vi.waitFor(() => expect(incomplete.closed).toBe(true));
    expect(s.server.listening).toBe(false);
  });
});
