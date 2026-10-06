import { describe, expect, it } from "vitest";
import {
  assertStreamAdmission,
  DEFAULT_MAX_EVENT_STREAMS,
  DEFAULT_STREAM_STALL_TIMEOUT_MS,
  loadStreamAdmissionConfig
} from "../../src/config/streamAdmission";
import { createChatServer } from "../../src/server";
import { ChatService } from "../../src/app/chatService";
import { ChatOrchestrator, DeepWorker } from "../../src/app/orchestrator";
import { InMemoryTaskQueue } from "../../src/providers/interfaces";
import { InMemoryConversationTimelineStore } from "../../src/app/timelineStore";
import { MockDeepProvider, MockFastProvider } from "../../src/providers/mockProviders";

describe("event stream admission configuration", () => {
  it("defaults to 32 streams and a 30 second stall timeout", () => {
    expect(loadStreamAdmissionConfig({})).toEqual({
      maxEventStreams: DEFAULT_MAX_EVENT_STREAMS,
      streamStallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS
    });
    expect(DEFAULT_MAX_EVENT_STREAMS).toBe(32);
    expect(DEFAULT_STREAM_STALL_TIMEOUT_MS).toBe(30_000);
    expect(
      loadStreamAdmissionConfig({ HTTP_MAX_EVENT_STREAMS: " ", HTTP_STREAM_STALL_TIMEOUT_MS: "" })
    ).toEqual({ maxEventStreams: 32, streamStallTimeoutMs: 30_000 });
  });

  it("accepts boundary values and rejects invalid or excessive ones", () => {
    expect(
      loadStreamAdmissionConfig({
        HTTP_MAX_EVENT_STREAMS: "1",
        HTTP_STREAM_STALL_TIMEOUT_MS: "1000"
      })
    ).toEqual({ maxEventStreams: 1, streamStallTimeoutMs: 1000 });
    expect(
      loadStreamAdmissionConfig({
        HTTP_MAX_EVENT_STREAMS: "1000",
        HTTP_STREAM_STALL_TIMEOUT_MS: "600000"
      })
    ).toEqual({ maxEventStreams: 1000, streamStallTimeoutMs: 600_000 });
    for (const value of ["0", "-1", "1.5", "many", "1001"])
      expect(() => loadStreamAdmissionConfig({ HTTP_MAX_EVENT_STREAMS: value })).toThrow(
        /HTTP_MAX_EVENT_STREAMS/
      );
    for (const value of ["0", "999", "1.5", "soon", "600001"])
      expect(() => loadStreamAdmissionConfig({ HTTP_STREAM_STALL_TIMEOUT_MS: value })).toThrow(
        /HTTP_STREAM_STALL_TIMEOUT_MS/
      );
  });

  it("validates explicit limits the same way", () => {
    expect(assertStreamAdmission({ maxEventStreams: 2, streamStallTimeoutMs: 1000 })).toEqual({
      maxEventStreams: 2,
      streamStallTimeoutMs: 1000
    });
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])
      expect(() =>
        assertStreamAdmission({ maxEventStreams: value, streamStallTimeoutMs: 1000 })
      ).toThrow(/maxEventStreams/);
    for (const value of [0, 999, 1.5, Number.NaN, 600_001])
      expect(() =>
        assertStreamAdmission({ maxEventStreams: 1, streamStallTimeoutMs: value })
      ).toThrow(/streamStallTimeoutMs/);
  });

  it("refuses invalid explicit limits when the server is constructed", () => {
    const queue = new InMemoryTaskQueue(),
      timeline = new InMemoryConversationTimelineStore();
    const service = new ChatService(
      new ChatOrchestrator(new MockFastProvider(), queue, timeline),
      new DeepWorker(queue, new MockDeepProvider(), timeline),
      timeline,
      queue
    );
    expect(() => createChatServer(service, { maxEventStreams: 0 })).toThrow(/maxEventStreams/);
    expect(() => createChatServer(service, { streamStallTimeoutMs: 10 })).toThrow(
      /streamStallTimeoutMs/
    );
  });
});
