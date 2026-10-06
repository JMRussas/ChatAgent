import { describe, expect, it } from "vitest";
import {
  assertMaxConnections,
  checkLocalRequest,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_CONNECTIONS,
  loadHttpBoundaryConfig
} from "../../src/config/httpBoundary";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";
import { allowAllTestAuth } from "../helpers/testAuth";

describe("HTTP boundary configuration", () => {
  it("defaults to a loopback bind, a 1 MiB body limit and 128 connections", () => {
    expect(loadHttpBoundaryConfig({})).toEqual({
      host: "127.0.0.1",
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      maxConnections: DEFAULT_MAX_CONNECTIONS
    });
    expect(DEFAULT_MAX_CONNECTIONS).toBe(128);
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1048576);
    expect(loadHttpBoundaryConfig({ BIND_HOST: " " }).host).toBe("127.0.0.1");
  });

  it.each(["127.0.0.1", "::1", "localhost"])("accepts the loopback bind %s", (host) => {
    expect(loadHttpBoundaryConfig({ BIND_HOST: host }).host).toBe(host);
  });

  it.each(["0.0.0.0", "::", "192.168.1.20", "example.test", "127.0.0.2"])(
    "refuses the nonlocal bind %s",
    (host) => {
      expect(() => loadHttpBoundaryConfig({ BIND_HOST: host })).toThrow(/BIND_HOST must be one of/);
      expect(() => loadHttpBoundaryConfig({ BIND_HOST: host })).not.toThrow(/no authentication/);
    }
  );

  it("accepts an explicit body limit and rejects invalid or excessive values", () => {
    expect(loadHttpBoundaryConfig({ HTTP_MAX_BODY_BYTES: "2048" }).maxBodyBytes).toBe(2048);
    expect(loadHttpBoundaryConfig({ HTTP_MAX_BODY_BYTES: "16777216" }).maxBodyBytes).toBe(16777216);
    for (const value of ["0", "-1", "1.5", "many", "16777217"])
      expect(() => loadHttpBoundaryConfig({ HTTP_MAX_BODY_BYTES: value })).toThrow(
        /HTTP_MAX_BODY_BYTES/
      );
  });
});

describe("connection limit", () => {
  it("accepts decimal whole numbers from 1 to 4096 and defaults only when unset", () => {
    for (const [raw, value] of [
      ["1", 1],
      ["64", 64],
      ["0128", 128],
      ["4096", 4096]
    ] as const)
      expect(loadHttpBoundaryConfig({ HTTP_MAX_CONNECTIONS: raw }).maxConnections).toBe(value);
    expect(loadHttpBoundaryConfig({}).maxConnections).toBe(128);
  });

  it.each([
    "",
    " ",
    " 64",
    "64 ",
    "0",
    "-1",
    "+5",
    "1.5",
    "1e3",
    "0x40",
    "many",
    "4097",
    "99999999999999999999"
  ])("refuses HTTP_MAX_CONNECTIONS=%j", (raw) => {
    expect(() => loadHttpBoundaryConfig({ HTTP_MAX_CONNECTIONS: raw })).toThrow(
      /HTTP_MAX_CONNECTIONS must be an integer from 1 to 4096/
    );
  });

  it.each([null, "64", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4097, true, [64]])(
    "refuses the direct value %j",
    (value) => {
      expect(() => assertMaxConnections(value)).toThrow(/maxConnections must be an integer/);
    }
  );

  it("is validated before the server changes the service, then set natively", () => {
    const queue = new InMemoryTaskQueue(),
      timeline = new InMemoryConversationTimelineStore();
    const service = new ChatService(
      new ChatOrchestrator(new MockFastProvider(), queue, timeline),
      new DeepWorker(queue, new MockDeepProvider(), timeline),
      timeline,
      queue
    );
    for (const value of [null, 0, 4097, "8"])
      expect(() =>
        createChatServer(service, {
          auth: allowAllTestAuth,
          maxConnections: value as unknown as number
        })
      ).toThrow(/maxConnections/);
    expect(service.resolveReferences).toBeUndefined();
    expect(createChatServer(service, { auth: allowAllTestAuth }).maxConnections).toBe(128);
    expect(
      createChatServer(service, { auth: allowAllTestAuth, maxConnections: 7 }).maxConnections
    ).toBe(7);
  });
});

describe("local request policy", () => {
  it.each(["localhost", "localhost:3100", "127.0.0.1:3100", "[::1]:3100", "LOCALHOST:3100"])(
    "accepts the loopback Host %s",
    (host) => {
      expect(checkLocalRequest({ host })).toBeUndefined();
    }
  );

  it.each([
    undefined,
    "",
    "example.test",
    "example.test:3100",
    "localhost.example.test",
    "127.0.0.1.example.test:3100",
    "example.test@localhost",
    "localhost:3100/path",
    "192.168.1.20:3100",
    "0.0.0.0:3100"
  ])("rejects the Host %s", (host) => {
    expect(checkLocalRequest({ host })).toBe("HOST_NOT_ALLOWED");
  });

  it("accepts a same-origin Origin and rejects every other origin", () => {
    const host = "localhost:3100";
    expect(checkLocalRequest({ host, origin: "http://localhost:3100" })).toBeUndefined();
    expect(checkLocalRequest({ host, origin: "HTTP://LOCALHOST:3100" })).toBeUndefined();
    for (const origin of [
      "http://example.test",
      "http://localhost:5173",
      "http://127.0.0.1:3100",
      "https://localhost:3100",
      "http://localhost:3100.example.test",
      "null",
      ""
    ])
      expect(checkLocalRequest({ host, origin })).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("checks Host before Origin", () => {
    expect(checkLocalRequest({ host: "example.test", origin: "http://example.test" })).toBe(
      "HOST_NOT_ALLOWED"
    );
  });
});
