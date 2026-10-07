import { describe, expect, it } from "vitest";
import type { Principal, Role } from "../../src/auth/authenticator";
import { checkExactOrigin, extractCredentials, SESSION_COOKIE } from "../../src/auth/credentials";
import { PAIRING_MAX_FAILURES, PAIRING_TTL_MS, PairingController } from "../../src/auth/pairing";
import { ROUTES, classifyRoute, decideAccess } from "../../src/auth/routePolicy";

const principal = (...roles: Role[]): Principal => ({
  principalId: "local:p",
  roles: new Set(roles),
  via: "bearer"
});

/** One concrete request per inventoried route (docs/implementation/14-local-authentication.md). */
const INVENTORY: [string, string, "public" | "client" | "operator"][] = [
  ["GET", "/", "public"],
  ["GET", "/pair", "public"],
  ["POST", "/pair", "public"],
  ["GET", "/auth/session", "public"],
  ["POST", "/briefings", "client"],
  ["POST", "/document-tasks", "client"],
  ["POST", "/sports/games", "client"],
  ["GET", "/sports/team-directories", "client"],
  ["POST", "/conversation-context/detach", "client"],
  ["POST", "/conversation-context", "client"],
  ["POST", "/sports/conversations", "client"],
  ["POST", "/sports/teams", "client"],
  ["POST", "/sports/results", "client"],
  ["POST", "/sports/chat", "client"],
  ["POST", "/messages", "client"],
  ["POST", "/conversations/c1/messages/m1/cancel", "client"],
  ["GET", "/telemetry/latency", "client"],
  ["GET", "/run-controls", "client"],
  ["GET", "/run-controls/thinking", "client"],
  ["GET", "/models", "client"],
  ["GET", "/conversations/c1/events", "client"],
  ["GET", "/conversations/c1/events/stream", "client"],
  ["POST", "/v1/conversations/c1/messages", "client"],
  ["GET", "/v1/conversations/c1/events/stream", "client"],
  ["POST", "/v1/conversations/c1/messages/m1/cancel", "client"],
  ["POST", "/pair/reissue", "operator"],
  ["GET", "/telemetry/evaluation", "operator"],
  ["POST", "/briefings/config/reload", "operator"],
  ["GET", "/workers/document-tasks/status", "operator"],
  ["POST", "/workers/document-tasks/restart", "operator"],
  ["GET", "/workers/document-tasks/recovery-candidates", "operator"],
  ["POST", "/workers/document-tasks/inspect", "operator"],
  ["POST", "/workers/document-tasks/abandon", "operator"],
  ["POST", "/workers/deep/run-once", "operator"],
  ["GET", "/workers/deep/dead-letters", "operator"],
  ["DELETE", "/workers/deep/dead-letters/t1", "operator"],
  ["POST", "/workers/deep/dead-letters/t1/replay", "operator"],
  ["GET", "/telemetry/dispatch", "operator"],
  ["GET", "/telemetry/context", "operator"],
  ["POST", "/routing/policy/tune", "operator"],
  ["POST", "/routing/policy/set", "operator"],
  ["POST", "/routing/quota-envelopes/declare", "operator"],
  ["GET", "/conversations/retention", "operator"],
  ["DELETE", "/conversations/c1/identity", "operator"]
];

describe("route policy", () => {
  it("classifies exactly the 44 inventoried routes, each once", () => {
    expect(ROUTES).toHaveLength(44);
    expect(INVENTORY).toHaveLength(44);
    const used = new Set<string>();
    for (const [method, path, access] of INVENTORY) {
      const rule = classifyRoute(method, path);
      expect(rule?.access, `${method} ${path}`).toBe(access);
      used.add(rule!.name);
    }
    expect(used.size).toBe(ROUTES.length);
  });

  it("decides access by role for every route", () => {
    for (const [method, path, access] of INVENTORY) {
      const rule = classifyRoute(method, path);
      const anonymous = decideAccess(rule, undefined);
      const client = decideAccess(rule, principal("client"));
      const operator = decideAccess(rule, principal("client", "operator"));
      if (access === "public") {
        expect([anonymous, client, operator].every((d) => d.allow)).toBe(true);
        continue;
      }
      expect(anonymous).toEqual({ allow: false, status: 401, code: "UNAUTHENTICATED" });
      expect(operator).toEqual({ allow: true });
      expect(client).toEqual(
        access === "client"
          ? { allow: true }
          : { allow: false, status: 403, code: "OPERATOR_REQUIRED" }
      );
    }
  });

  it("denies unknown routes, wrong methods and loosely matching paths", () => {
    const odd: [string, string][] = [
      ["GET", "/conversations/a/b/events"],
      ["GET", "/conversations//events"],
      ["GET", "/conversations/a/events/"],
      ["GET", "/conversations/a/events/stream/x"],
      ["POST", "/workers/deep/dead-letters/a/b/replay"],
      ["POST", "/workers/deep/dead-letters//replay"],
      ["DELETE", "/workers/deep/dead-letters"],
      ["GET", "/messages"],
      ["PUT", "/messages"],
      ["GET", "/v1/conversations/c1/messages"],
      ["GET", "/admin"],
      ["GET", "//"],
      ["GET", "/Pair"],
      ["POST", "/pair/"],
      ["GET", "/telemetry/latency/"]
    ];
    for (const [method, path] of odd) {
      const rule = classifyRoute(method, path);
      expect(rule, `${method} ${path}`).toBeUndefined();
      // Unauthenticated callers cannot tell an unknown route from a protected one.
      expect(decideAccess(rule, undefined)).toMatchObject({ status: 401 });
      expect(decideAccess(rule, principal("client", "operator"))).toMatchObject({ status: 404 });
    }
  });

  it("prefers a literal route over a parameterized one", () => {
    expect(classifyRoute("GET", "/conversations/retention")?.access).toBe("operator");
    expect(classifyRoute("DELETE", "/conversations/retention/identity")?.name).toBe(
      "DELETE /conversations/:conversationId/identity"
    );
  });

  it("refuses a principal without the client role on client routes", () => {
    expect(decideAccess(classifyRoute("POST", "/messages"), principal())).toMatchObject({
      status: 403
    });
  });
});

describe("credential extraction", () => {
  it("takes one Authorization header and exactly one session cookie", () => {
    expect(extractCredentials({ authorization: ["Bearer abc"] })).toEqual({
      authorization: "Bearer abc"
    });
    expect(extractCredentials({ cookie: [`theme=dark; ${SESSION_COOKIE}=tok; x=1`] })).toEqual({
      sessionToken: "tok"
    });
    // Separate Cookie headers are combined before the session cookie is found.
    expect(extractCredentials({ cookie: ["theme=dark", `${SESSION_COOKIE}=tok`] })).toEqual({
      sessionToken: "tok"
    });
    expect(extractCredentials({})).toEqual({});
  });

  it("treats ambiguous, malformed or oversized credentials as absent or unusable", () => {
    for (const cookie of [
      // Two session cookies, for example one scoped to another path.
      [`${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b`],
      [`${SESSION_COOKIE}=a`, `${SESSION_COOKIE}=b`],
      // A bare or empty session cookie next to a valid one is still ambiguous.
      [`${SESSION_COOKIE}; ${SESSION_COOKIE}=valid`],
      [`${SESSION_COOKIE}=; ${SESSION_COOKIE}=valid`],
      [`${SESSION_COOKIE}=valid; ${SESSION_COOKIE}`],
      [`${SESSION_COOKIE}=`],
      [`${SESSION_COOKIE}=${"x".repeat(9000)}`],
      // Similar names are not the session cookie.
      [`x${SESSION_COOKIE}=a; ${SESSION_COOKIE}x=b`]
    ])
      expect(extractCredentials({ cookie }), cookie.join(" | ")).toEqual({});
    // A present but unusable Authorization header blocks any cookie fallback.
    expect(
      extractCredentials({ authorization: ["x".repeat(300)], cookie: [`${SESSION_COOKIE}=tok`] })
    ).toEqual({ authorization: "", sessionToken: "tok" });
    expect(extractCredentials({ authorization: ["Bearer a", "Bearer b"] })).toEqual({
      authorization: ""
    });
    expect(extractCredentials({ authorization: [] })).toEqual({ authorization: "" });
  });
});

describe("exact origin", () => {
  it("accepts only one Origin equal to http://<one Host>", () => {
    const host = "127.0.0.1:3000";
    expect(checkExactOrigin({ host: [host], origin: [`http://${host}`] })).toBe("same-origin");
    expect(checkExactOrigin({ host: [host] })).toBe("missing");
    for (const origin of [
      "null",
      "http://127.0.0.1:3001",
      "http://localhost:3000",
      "https://127.0.0.1:3000",
      `http://${host}/`,
      "http://evil.example",
      ""
    ])
      expect(checkExactOrigin({ host: [host], origin: [origin] }), origin).toBe("mismatch");
    expect(checkExactOrigin({ origin: [`http://${host}`] })).toBe("mismatch");
    // Repeated Origin or Host headers are ambiguous.
    expect(checkExactOrigin({ host: [host], origin: [`http://${host}`, `http://${host}`] })).toBe(
      "mismatch"
    );
    expect(checkExactOrigin({ host: [host, "evil.example"], origin: [`http://${host}`] })).toBe(
      "mismatch"
    );
  });
});

describe("pairing controller", () => {
  it("issues a 50-bit grouped code that pairs once", () => {
    const pairing = new PairingController();
    const code = pairing.issue();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(pairing.attempt(code)).toBe("paired");
    // Single use: a replay finds no code.
    expect(pairing.attempt(code)).toBe("no-code");
  });

  it("compares exactly, without normalization", () => {
    const pairing = new PairingController();
    const code = pairing.issue();
    // Five wrong variants: each is refused, and together they discard the code.
    const variants = [`${code.slice(0, -1)}#`, code.replace("-", ""), ` ${code}`, undefined, 42];
    expect(variants).toHaveLength(PAIRING_MAX_FAILURES);
    for (const variant of variants) expect(pairing.attempt(variant)).toBe("invalid");
    expect(pairing.attempt(code)).toBe("no-code");
    const fresh = pairing.issue();
    expect(pairing.attempt(fresh.toLowerCase())).toBe(
      fresh === fresh.toLowerCase() ? "paired" : "invalid"
    );
  });

  it("expires after ten minutes using the injected clock", () => {
    let now = 1_000_000;
    const pairing = new PairingController(() => now);
    const code = pairing.issue();
    now += PAIRING_TTL_MS - 1;
    expect(pairing.hasActiveCode).toBe(true);
    now += 1;
    expect(pairing.hasActiveCode).toBe(false);
    expect(pairing.attempt(code)).toBe("no-code");
  });

  it("discards the code after five wrong attempts and never re-issues on its own", () => {
    const pairing = new PairingController();
    const code = pairing.issue();
    for (let i = 1; i < PAIRING_MAX_FAILURES; i++)
      expect(pairing.attempt("WRONG-CODE0")).toBe("invalid");
    expect(pairing.hasActiveCode).toBe(true);
    expect(pairing.attempt("WRONG-CODE0")).toBe("invalid");
    expect(pairing.hasActiveCode).toBe(false);
    expect(pairing.attempt(code)).toBe("no-code");
    expect(pairing.attempt("WRONG-CODE0")).toBe("no-code");
  });

  it("an explicit re-issue replaces the previous code and resets failures", () => {
    const pairing = new PairingController();
    const first = pairing.issue();
    pairing.attempt("WRONG-CODE0");
    const second = pairing.issue();
    expect(pairing.attempt(first)).toBe(first === second ? "paired" : "invalid");
    expect(pairing.attempt(second)).toBe(first === second ? "no-code" : "paired");
  });

  it("refuses inputs of the wrong length, including multibyte ones, without throwing", () => {
    const pairing = new PairingController();
    const code = pairing.issue();
    // Same number of characters as the code, more bytes.
    expect(pairing.attempt("é".repeat(code.length))).toBe("invalid");
    expect(pairing.attempt("x".repeat(100_000))).toBe("invalid");
    expect(pairing.attempt(code)).toBe("paired");
  });

  it("discards an expired code once it is noticed", () => {
    let now = 0;
    const pairing = new PairingController(() => now);
    pairing.issue();
    now = PAIRING_TTL_MS;
    expect(pairing.hasActiveCode).toBe(false);
    now = 0;
    // Moving the clock back cannot revive it: the secret is gone.
    expect(pairing.hasActiveCode).toBe(false);
  });

  it("clear forgets the code", () => {
    const pairing = new PairingController();
    const code = pairing.issue();
    pairing.clear();
    expect(pairing.hasActiveCode).toBe(false);
    expect(pairing.attempt(code)).toBe("no-code");
  });

  it("produces varied codes", () => {
    const pairing = new PairingController();
    expect(new Set(Array.from({ length: 200 }, () => pairing.issue())).size).toBe(200);
  });
});
