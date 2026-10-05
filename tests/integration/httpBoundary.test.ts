import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { ChatService } from "../../src/app/chatService";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { createChatServer } from "../../src/server";

const LIMIT = 256;
const servers: Array<ReturnType<typeof createChatServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type ServerOptions = NonNullable<Parameters<typeof createChatServer>[1]>;

async function start(options: ServerOptions = { maxBodyBytes: LIMIT }) {
  const queue = new InMemoryTaskQueue();
  const timeline = new InMemoryConversationTimelineStore();
  const service = new ChatService(
    new ChatOrchestrator(new MockFastProvider(), queue, timeline),
    new DeepWorker(queue, new MockDeepProvider(), timeline),
    timeline
  );
  const server = createChatServer(service, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const userTexts = async (conversationId = "c") =>
    (await timeline.getEvents(conversationId)).filter((e) => e.type === "user").map((e) => e.text);
  return { server, port, userTexts, service };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: () => { code?: string; error?: string };
}

/** `end: false` leaves the request body open, as a client that is still uploading would. */
function send(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string | number>;
    chunks?: Array<string | Buffer>;
    end?: boolean;
  } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        agent: false,
        method: options.method ?? "GET",
        path: options.path ?? "/models",
        headers: options.headers
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => {
          req.destroy();
          const body = Buffer.concat(parts).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body)
          });
        });
      }
    );
    req.on("error", reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    if (options.end === false) req.flushHeaders();
    else req.end();
  });
}

const message = (text: string, conversationId = "c") =>
  JSON.stringify({ conversationId, userId: "u", text });
const json = { "Content-Type": "application/json" };

function expectTooLarge(reply: Reply) {
  expect(reply.status).toBe(413);
  expect(reply.json()).toEqual({
    error: "Request body too large",
    code: "REQUEST_BODY_TOO_LARGE"
  });
  expect(reply.headers.connection).toBe("close");
}

describe("request body limit", () => {
  it("accepts a body of exactly the limit and rejects one byte more", async () => {
    const { port, userTexts } = await start();
    const exact = message("at the limit").padEnd(LIMIT, " ");
    const accepted = await send(port, {
      method: "POST",
      path: "/messages",
      headers: { ...json, "Content-Length": LIMIT },
      chunks: [exact]
    });
    expect(accepted.status).toBe(200);

    const rejected = await send(port, {
      method: "POST",
      path: "/messages",
      headers: { ...json, "Content-Length": LIMIT + 1 },
      chunks: [message("over the limit").padEnd(LIMIT + 1, " ")]
    });
    expectTooLarge(rejected);
    expect(await userTexts()).toEqual(["at the limit"]);
  });

  it("rejects a declared oversized length before any body byte is sent", async () => {
    const { port, userTexts } = await start();
    const rejected = await send(port, {
      method: "POST",
      path: "/messages",
      headers: { ...json, "Content-Length": 10 * 1024 * 1024 },
      end: false
    });
    expectTooLarge(rejected);
    expect(await userTexts()).toEqual([]);
  });

  it("rejects chunked input when it crosses the limit, without waiting for the body to end", async () => {
    const { server, port, userTexts } = await start();
    const rejected = await send(port, {
      method: "POST",
      path: "/messages",
      headers: json,
      chunks: [message("x".repeat(LIMIT))],
      end: false
    });
    expect(rejected.headers["content-length"]).toBeDefined();
    expectTooLarge(rejected);
    expect(await userTexts()).toEqual([]);
    await vi.waitFor(() => expect(server.retentionStats().responses).toBe(0));
  });

  it("counts chunked input cumulatively across chunks", async () => {
    const { port, userTexts } = await start();
    const body = message("several chunks");
    const pieces = [body.slice(0, 10), body.slice(10, 30), body.slice(30)];
    const accepted = await send(port, {
      method: "POST",
      path: "/messages",
      headers: json,
      chunks: pieces
    });
    expect(accepted.status).toBe(200);

    const rejected = await send(port, {
      method: "POST",
      path: "/messages",
      headers: json,
      chunks: ['{"conversationId":"c","userId":"u","text":"', ..."abcd".split("")].concat(
        Array.from({ length: 4 }, () => "y".repeat(LIMIT / 4))
      ),
      end: false
    });
    expectTooLarge(rejected);
    expect(await userTexts()).toEqual(["several chunks"]);
  });

  it("measures bytes, not characters", async () => {
    const { port, userTexts } = await start();
    const body = message("é".repeat(LIMIT / 2));
    expect(body.length).toBeLessThan(LIMIT + 60);
    expect(Buffer.byteLength(body)).toBeGreaterThan(LIMIT);
    const fits = message("é".repeat(40));
    expect(fits.length).toBeLessThan(Buffer.byteLength(fits));
    expect((await send(port, { method: "POST", path: "/messages", chunks: [fits] })).status).toBe(
      200
    );
    expectTooLarge(await send(port, { method: "POST", path: "/messages", chunks: [body] }));
    expect(await userTexts()).toEqual(["é".repeat(40)]);
  });

  it.each(["declared", "chunked"])(
    "preserves body-limit errors on enabled routes for %s input",
    async (encoding) => {
      const operation = vi.fn(() => {
        throw new Error("Unexpected operation");
      });
      const briefings = {
        request: operation,
        startChat: operation,
        reload: operation,
        gameOperations: { search: operation, details: operation },
        close: () => undefined
      } as unknown as ServerOptions["briefings"];
      const documentTasks = {
        request: operation,
        close: () => undefined
      } as unknown as ServerOptions["documentTasks"];
      const { port, userTexts, service } = await start({
        maxBodyBytes: LIMIT,
        briefings,
        documentTasks
      });
      const claim = vi.spyOn(service, "claimConversation");
      const submit = vi.spyOn(service, "submitMessage");
      const oversized = JSON.stringify({ padding: "x".repeat(LIMIT) });
      for (const path of [
        "/messages",
        "/v1/conversations/3f0e8a52-9f0c-4d7e-8a54-0c3a5d4f8f10/messages",
        "/routing/policy/set",
        "/conversation-context",
        "/sports/games",
        "/sports/chat",
        "/document-tasks",
        "/briefings",
        "/briefings/config/reload"
      ]) {
        const reply = await send(port, {
          method: "POST",
          path,
          headers:
            encoding === "declared"
              ? { ...json, "Content-Length": Buffer.byteLength(oversized) }
              : json,
          chunks: encoding === "chunked" ? [oversized] : [],
          end: false
        });
        expectTooLarge(reply);
      }
      expect(operation).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(await userTexts()).toEqual([]);
    }
  );

  it("uses a 1 MiB default limit", async () => {
    const { port } = await start({});
    const rejected = await send(port, {
      method: "POST",
      path: "/messages",
      headers: { ...json, "Content-Length": 1048577 },
      end: false
    });
    expectTooLarge(rejected);
    const accepted = await send(port, {
      method: "POST",
      path: "/messages",
      headers: json,
      chunks: [message("default limit").padEnd(1048576, " ")]
    });
    expect(accepted.status).toBe(200);
  });

  it("reads only the declared length when Content-Length understates the bytes sent", async () => {
    const { port, userTexts } = await start();
    const body = message("declared");
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (part) => (received += part.toString("utf8")));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(
      `POST /messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
    await vi.waitFor(() => expect(received).toContain("HTTP/1.1 200"));
    // Bytes past the declared length are not body: the parser refuses them and closes.
    socket.write("x".repeat(4096));
    await closed;
    expect(received).toContain("HTTP/1.1 400");
    expect(await userTexts()).toEqual(["declared"]);
  });

  it("settles without accepting anything when Content-Length overstates and the client leaves", async () => {
    const { server, port, userTexts } = await start();
    const socket = connect(port, "127.0.0.1");
    socket.write(
      `POST /messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
        `Content-Length: 200\r\n\r\n${message("partial")}`
    );
    await vi.waitFor(() => expect(server.retentionStats().responses).toBe(1));
    socket.destroy();
    await vi.waitFor(() => expect(server.retentionStats().responses).toBe(0));
    expect(await userTexts()).toEqual([]);
  });
});

describe("local request boundary", () => {
  const stream = "/conversations/c/events/stream";
  const v1Stream =
    "/v1/conversations/3f0e8a52-9f0c-4d7e-8a54-0c3a5d4f8f10/events/stream?accountId=a&projectId=p";
  const routes: Array<{ method: string; path: string; body?: string }> = [
    { method: "GET", path: "/" },
    { method: "GET", path: "/models" },
    { method: "GET", path: "/conversations/c/events" },
    { method: "GET", path: stream },
    { method: "GET", path: v1Stream },
    { method: "GET", path: "/conversations/retention" },
    { method: "GET", path: "/workers/deep/dead-letters" },
    { method: "POST", path: "/messages", body: message("cross-origin") },
    { method: "POST", path: "/conversations/c/messages/m/cancel" },
    { method: "POST", path: "/workers/deep/run-once" },
    { method: "POST", path: "/briefings/config/reload", body: "{}" },
    { method: "POST", path: "/routing/policy/set", body: '{"maxFastP95Ms":500}' },
    { method: "DELETE", path: "/conversations/c/identity" },
    { method: "DELETE", path: "/workers/deep/dead-letters/t" }
  ];

  it("rejects reads, streams and mutations from another origin", async () => {
    const { server, port, userTexts } = await start();
    for (const origin of ["http://example.test", `http://localhost:${port + 1}`, "null"])
      for (const route of routes) {
        const reply = await send(port, {
          method: route.method,
          path: route.path,
          headers: { ...json, Origin: origin },
          chunks: route.body ? [route.body] : []
        });
        expect([route.path, reply.status]).toEqual([route.path, 403]);
        expect(reply.json().code).toBe("ORIGIN_NOT_ALLOWED");
        expect(reply.headers["content-type"]).toBe("application/json");
      }
    expect(await userTexts()).toEqual([]);
    expect(server.retentionStats().streams).toBe(0);
  });

  it("rejects requests addressed to a non-loopback Host", async () => {
    const { server, port, userTexts } = await start();
    for (const host of ["example.test", `rebound.example.test:${port}`, `192.168.1.20:${port}`])
      for (const route of routes) {
        const reply = await send(port, {
          method: route.method,
          path: route.path,
          headers: { ...json, Host: host },
          chunks: route.body ? [route.body] : []
        });
        expect([route.path, reply.status]).toEqual([route.path, 403]);
        expect(reply.json().code).toBe("HOST_NOT_ALLOWED");
      }
    expect(await userTexts()).toEqual([]);
    expect(server.retentionStats().streams).toBe(0);
  });

  it("rejects before reading the request body", async () => {
    const { port } = await start();
    const reply = await send(port, {
      method: "POST",
      path: "/messages",
      headers: { ...json, Origin: "http://example.test", "Content-Length": 100 },
      end: false
    });
    expect(reply.status).toBe(403);
  });

  it("serves same-origin browser requests and clients that send no Origin", async () => {
    const { port, userTexts } = await start();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const headers = { ...json, Host: host, Origin: `http://${host}` };
      expect((await send(port, { path: "/", headers })).status).toBe(200);
      expect((await send(port, { path: "/conversations/c/events", headers })).status).toBe(200);
      const posted = await send(port, {
        method: "POST",
        path: "/messages",
        headers,
        chunks: [message(host)]
      });
      expect(posted.status).toBe(200);
    }
    expect((await send(port, { path: "/models" })).status).toBe(200);
    expect(await userTexts()).toEqual([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

    const controller = new AbortController();
    const opened = await fetch(`http://127.0.0.1:${port}${stream}`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
      signal: controller.signal
    });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });
});
