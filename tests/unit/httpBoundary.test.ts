import { describe, expect, it } from "vitest";
import {
  checkLocalRequest,
  DEFAULT_MAX_BODY_BYTES,
  loadHttpBoundaryConfig
} from "../../src/config/httpBoundary";

describe("HTTP boundary configuration", () => {
  it("defaults to a loopback bind and a 1 MiB body limit", () => {
    expect(loadHttpBoundaryConfig({})).toEqual({
      host: "127.0.0.1",
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES
    });
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
