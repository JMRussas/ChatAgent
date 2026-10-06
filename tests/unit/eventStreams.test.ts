import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStreamRegistry, StreamCapacityError } from "../../src/app/eventStreams";
import { FakeResponse } from "../helpers/fakeResponse";

const limits = { maxEventStreams: 2, streamStallTimeoutMs: 1000 };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("event stream registry", () => {
  it("refuses a stream at capacity and admits again once one closes", () => {
    const registry = new EventStreamRegistry(limits);
    const a = new FakeResponse(),
      b = new FakeResponse();
    registry.open(a.asResponse());
    registry.open(b.asResponse());
    const refused = new FakeResponse();
    expect(() => registry.open(refused.asResponse())).toThrow(StreamCapacityError);
    // Refusal attaches nothing to the response.
    expect(refused.listenerCount("close")).toBe(0);
    a.destroy();
    expect(registry.stats()).toEqual({ streams: 1, settlingStreams: 0 });
    registry.open(new FakeResponse().asResponse());
    expect(registry.stats().streams).toBe(2);
  });

  it("releases a slot exactly once whichever way the response ends", () => {
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    stream.close();
    stream.close();
    res.end();
    res.destroy();
    expect(registry.stats().streams).toBe(0);
    registry.open(new FakeResponse().asResponse());
    registry.open(new FakeResponse().asResponse());
    expect(() => registry.open(new FakeResponse().asResponse())).toThrow(StreamCapacityError);
  });
});

describe("event stream backpressure", () => {
  it("stops writing, reading and pinging while blocked, and resumes once on drain", async () => {
    vi.useFakeTimers();
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    let reads = 0;
    res.allowance = 0;
    await stream.start(async () => {
      reads++;
      stream.write(`event: tick\ndata: ${reads}\n\n`);
    }, vi.fn());
    stream.every(100, () => void stream.pump());
    stream.heartbeat(150);
    expect(reads).toBe(1);
    expect(res.chunks).toHaveLength(1);
    // A blocked stream refuses writes instead of adding to the buffer, and says so.
    expect(stream.write("event: extra\ndata: 1\n\n")).toBe("blocked");
    await vi.advanceTimersByTimeAsync(900);
    expect(reads).toBe(1);
    expect(res.chunks).toHaveLength(1);
    res.drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(2);
    // The stall timer was cleared by the drain.
    await vi.advanceTimersByTimeAsync(2000);
    expect(res.destroyed).toBe(false);
    expect(res.text).toContain(": ping");
    stream.close();
  });

  it("destroys a stream that stays blocked past the stall timeout and frees its slot", async () => {
    vi.useFakeTimers();
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    res.allowance = 0;
    expect(stream.write("event: big\ndata: 1\n\n")).toBe("full");
    await vi.advanceTimersByTimeAsync(999);
    expect(res.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(res.destroyed).toBe(true);
    expect(registry.stats().streams).toBe(0);
  });

  it("runs one deferred step when drain arrives during a read, never more", async () => {
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    const gate = deferred();
    let reads = 0;
    res.allowance = 0;
    const step = stream.start(async () => {
      reads++;
      if (reads > 1) return;
      expect(stream.write("event: first\ndata: 1\n\n")).toBe("full");
      await gate.promise;
    }, vi.fn());
    // The client catches up while the first step is still awaiting its read.
    res.drain();
    // Polls during the read do not request another run.
    void stream.pump();
    void stream.pump();
    expect(reads).toBe(1);
    gate.resolve();
    await step;
    await vi.waitFor(() => expect(reads).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(2);
    stream.close();
  });

  it("finishes without a last frame while blocked, and with it otherwise", () => {
    const registry = new EventStreamRegistry(limits);
    const blocked = new FakeResponse();
    const s1 = registry.open(blocked.asResponse());
    blocked.allowance = 0;
    s1.write("event: big\ndata: 1\n\n");
    s1.finish("event: last\ndata: 1\n\n");
    expect(blocked.text).not.toContain("event: last");
    expect(blocked.writableEnded).toBe(true);
    const idle = new FakeResponse();
    registry.open(idle.asResponse()).finish("event: last\ndata: 1\n\n");
    expect(idle.text).toContain("event: last");
    expect(registry.stats().streams).toBe(0);
  });
});

describe("event stream lifecycle", () => {
  it("clears timers immediately on close but holds the slot until an in-flight read settles", async () => {
    vi.useFakeTimers();
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    const gate = deferred();
    let reads = 0;
    const step = stream.start(async () => {
      reads++;
      await gate.promise;
      stream.write("event: late\ndata: 1\n\n");
    }, vi.fn());
    stream.every(100, () => void stream.pump());
    res.destroy();
    expect(registry.stats()).toEqual({ streams: 1, settlingStreams: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(1);
    gate.resolve();
    await step;
    // The stale continuation could not write after close.
    expect(res.chunks).toHaveLength(0);
    expect(registry.stats()).toEqual({ streams: 0, settlingStreams: 0 });
  });

  it("tracks a pre-header read so an abort cannot free the slot early", async () => {
    const registry = new EventStreamRegistry({ ...limits, maxEventStreams: 1 });
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    const gate = deferred();
    const read = stream.read(() => gate.promise);
    res.destroy();
    expect(() => registry.open(new FakeResponse().asResponse())).toThrow(StreamCapacityError);
    gate.resolve();
    await read;
    expect(registry.stats().streams).toBe(0);
    registry.open(new FakeResponse().asResponse());
  });

  it("contains synchronous and error-handler failures without leaking the read", async () => {
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    const onError = vi.fn();
    await stream.start(() => {
      throw new Error("sync");
    }, onError);
    expect(onError).toHaveBeenCalledOnce();
    // The step is runnable again: the read flag was reset.
    let ran = false;
    await stream.start(async () => {
      ran = true;
    }, onError);
    expect(ran).toBe(true);
    await stream.start(
      async () => {
        throw new Error("async");
      },
      () => {
        throw new Error("handler");
      }
    );
    expect(res.destroyed).toBe(true);
    expect(registry.stats().streams).toBe(0);
  });

  it("shutdown ends idle streams and destroys blocked or pre-header ones at once", async () => {
    const registry = new EventStreamRegistry({ ...limits, maxEventStreams: 3 });
    const idle = new FakeResponse(),
      blocked = new FakeResponse(),
      preHeader = new FakeResponse();
    const s1 = registry.open(idle.asResponse());
    idle.flushHeaders();
    s1.every(10, () => void s1.pump());
    const s2 = registry.open(blocked.asResponse());
    blocked.allowance = 0;
    s2.write("event: big\ndata: 1\n\n");
    registry.open(preHeader.asResponse());
    registry.closeAll();
    expect(idle.writableEnded).toBe(true);
    expect(idle.destroyed).toBe(false);
    expect(blocked.destroyed).toBe(true);
    expect(preHeader.destroyed).toBe(true);
    expect(registry.stats().streams).toBe(0);
  });

  it("leaves no timer behind when an idle stream finishes synchronously", async () => {
    vi.useFakeTimers();
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    res.flushHeaders();
    stream.every(100, () => void stream.pump());
    stream.heartbeat(150);
    stream.finish("event: last\ndata: 1\n\n");
    expect(res.writableEnded).toBe(true);
    expect(registry.stats().streams).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(res.destroyed).toBe(false);
  });

  it("keeps the slot and a stall deadline for an ended stream until it flushes", async () => {
    vi.useFakeTimers();
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    res.flushHeaders();
    // end() is requested, but the client never reads: writableEnded without 'finish'.
    res.end = function (this: FakeResponse) {
      this.writableEnded = true;
      return this;
    } as FakeResponse["end"];
    res.allowance = 0;
    stream.finish("event: last\ndata: 1\n\n");
    expect(res.text).toContain("event: last");
    expect(registry.stats().streams).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.destroyed).toBe(true);
    expect(registry.stats().streams).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shutdown destroys a blocked stream that was already ended but has not flushed", () => {
    const registry = new EventStreamRegistry(limits);
    const res = new FakeResponse();
    const stream = registry.open(res.asResponse());
    res.flushHeaders();
    res.allowance = 0;
    stream.write("event: big\ndata: 1\n\n");
    // Ending a response that cannot flush leaves it ended but unfinished.
    res.end = function (this: FakeResponse) {
      this.writableEnded = true;
      return this;
    } as FakeResponse["end"];
    stream.finish();
    expect(res.writableEnded).toBe(true);
    registry.closeAll();
    expect(res.destroyed).toBe(true);
    expect(registry.stats().streams).toBe(0);
  });
});
