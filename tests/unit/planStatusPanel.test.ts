import { describe, expect, it, vi } from "vitest";
import {
  PLAN_STATUS_LIMITS,
  planStatusPanelHtml,
  planStatusScript
} from "../../src/ui/planStatusPanel";

const ROOT = "11111111-2222-4333-8444-555555555555";
const OTHER_ROOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HOSTILE = '<img src=x onerror="window.pwned=1"></script><script>window.pwned=2</script>';

const body = () =>
  planStatusScript()
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");

class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  handlers = new Map<string, (event?: unknown) => unknown>();
  dataset: Record<string, string> = {};
  className = "";
  value = "";
  hidden = false;
  disabled = false;
  private own = "";
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  get textContent(): string {
    return this.own + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.children = [];
    this.own = String(value);
  }
  set href(value: string) {
    this.attrs.href = value;
  }
  set src(value: string) {
    this.attrs.src = value;
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.own = "";
    this.children = [...nodes];
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    this.handlers.set(type, handler);
  }
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

interface Reply {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

function reply(status: number, payload: unknown, headers: Record<string, string> = {}): Reply {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => text
  };
}

function leaf(over: Record<string, unknown> = {}) {
  return {
    nodeId: "n1",
    name: "Leaf one",
    state: "ready",
    executionAcknowledged: "unknown",
    gatesHold: true,
    upstreamChanged: false,
    attemptPins: "none",
    scope: "src/a.ts",
    contentRevision: 3,
    stateRevision: 4,
    attemptId: null,
    attemptEpoch: 0,
    executorRef: null,
    artifactRef: null,
    acceptance: null,
    blockers: [],
    ...over
  };
}

function ok(leaves: unknown[], over: Record<string, unknown> = {}, root = ROOT) {
  return {
    status: "ok",
    rootId: root,
    progress: {
      state: "ready",
      rootCompletion: "incomplete",
      rootAcceptance: "none",
      leafCounts: {}
    },
    leaves,
    ...over
  };
}

function withProgress(state: string, leaves: unknown[] = [], leafCounts = {}) {
  return ok(leaves, {
    progress: { state, rootCompletion: "incomplete", rootAcceptance: "none", leafCounts }
  });
}

interface FetchInit {
  method?: string;
  cache?: string;
  credentials?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

type Responder = (url: string, init: FetchInit) => Promise<Reply> | Reply;

function mount(responder: Responder = () => reply(200, ok([]))) {
  const elements = new Map<string, FakeElement>();
  const created: FakeElement[] = [];
  const get = (id: string) => {
    let node = elements.get(id);
    if (!node) {
      node = new FakeElement("div");
      node.value = id === "conversationId" ? "conv-a" : id === "userId" ? "user-a" : "";
      elements.set(id, node);
    }
    return node;
  };
  const document = {
    getElementById: get,
    createElement: (tag: string) => {
      const node = new FakeElement(tag);
      created.push(node);
      return node;
    }
  };
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  };
  const calls: Array<{ url: string; init: FetchInit }> = [];
  const fetch = vi.fn((url: string, init: FetchInit) => {
    calls.push({ url, init });
    return new Promise<Reply>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve(responder(url, init)).then(resolve, reject);
    });
  });
  const timers: Array<{ ms: number; run: () => void; live: boolean }> = [];
  const setTimeoutFake = (run: () => void, ms: number) => {
    timers.push({ ms, run, live: true });
    return timers.length - 1;
  };
  const clearTimeoutFake = (id: number) => {
    if (timers[id]) timers[id].live = false;
  };
  const windowHandlers = new Map<string, () => void>();
  const window = {
    addEventListener: (type: string, handler: () => void) => void windowHandlers.set(type, handler)
  };
  new Function(
    "document",
    "fetch",
    "window",
    "sessionStorage",
    "setTimeout",
    "clearTimeout",
    body()
  )(document, fetch, window, sessionStorage, setTimeoutFake, clearTimeoutFake);
  const fire = async (id: string, type: string, event?: unknown) => {
    const handler = get(id).handlers.get(type);
    expect(handler, `${id} has a ${type} handler`).toBeDefined();
    // Not awaited: a pending read must not block the test driving the next event.
    void handler!(event);
    await Promise.resolve();
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    get,
    created,
    store,
    calls,
    fetch,
    timers,
    windowHandlers,
    fire,
    settle,
    view: () => get("planStatusView").textContent,
    note: () => get("planStatusNote").textContent,
    banner: () => get("planStatusStale"),
    all: () => get("planStatusView").all(),
    async load(root = ROOT) {
      get("planRoot").value = root;
      await fire("planRefresh", "click");
      await settle();
    },
    async switchScope(conversationId: string, userId = "user-a") {
      get("conversationId").value = conversationId;
      get("userId").value = userId;
      await fire("conversationId", "change");
    }
  };
}

describe("plan status panel markup and script", () => {
  it("parses and exposes only the read-only controls", () => {
    expect(() => new Function(body())).not.toThrow();
    const html = planStatusPanelHtml();
    for (const id of [
      "planStatusPanel",
      "planRoot",
      "planRefresh",
      "planStatusNote",
      "planStatusStale",
      "planStatusView"
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toMatch(/<form|<a[\s>]|href=|<script/i);
    expect(PLAN_STATUS_LIMITS).toEqual({
      maxLeaves: 200,
      maxTextChars: 200,
      deadlineMs: 10_000,
      maxResponseBytes: 1_048_576
    });
  });

  it("has no HTML sink, token handling, write verb or second network call", () => {
    const script = body();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(script).not.toMatch(/Authorization|localStorage|document\.cookie|location\./i);
    expect(script).not.toMatch(/['"](POST|PUT|PATCH|DELETE)['"]/);
    expect(script).not.toMatch(/setInterval|EventSource|WebSocket|sendBeacon|XMLHttpRequest/);
    expect(script.match(/\bfetch\(/g)).toHaveLength(1);
    expect(script).toContain("'/development/plans/' + value + '/status'");
  });
});

describe("plan status requests", () => {
  it.each([
    ["empty", ""],
    ["uppercase", "abcdefab-2222-4333-8444-555555555555".toUpperCase()],
    ["a path", `${ROOT}/../x`],
    ["a query", `${ROOT}?x=1`],
    ["a fragment", `${ROOT}#x`],
    ["a URL", `http://evil.example/${ROOT}`],
    ["a short id", "1234"],
    ["trailing junk", `${ROOT}x`]
  ])("refuses %s before any request and stores nothing", async (_name, root) => {
    const panel = mount();
    await panel.load(root);
    expect(panel.fetch).not.toHaveBeenCalled();
    expect(panel.note()).toBe("Invalid plan root.");
    expect(panel.store.size).toBe(0);
  });

  it("issues one same-origin GET for the trimmed root and stores only the GUID", async () => {
    const panel = mount();
    await panel.load(`  ${ROOT}  `);
    expect(panel.calls).toHaveLength(1);
    const { url, init } = panel.calls[0];
    expect(url).toBe(`/development/plans/${ROOT}/status`);
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      "authorization"
    );
    expect([...panel.store.values()]).toEqual([ROOT]);
    const [key] = panel.store.keys();
    expect(key).toContain("conv-a");
    expect(key).toContain("user-a");
    expect(panel.timers.map((t) => t.ms)).toContain(PLAN_STATUS_LIMITS.deadlineMs);
  });

  it("also loads from the Enter key but not from other keys", async () => {
    const panel = mount();
    panel.get("planRoot").value = ROOT;
    await panel.fire("planRoot", "keydown", { key: "a" });
    expect(panel.fetch).not.toHaveBeenCalled();
    await panel.fire("planRoot", "keydown", { key: "Enter" });
    await panel.settle();
    expect(panel.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps one request in flight and ignores a second refresh", async () => {
    let release!: (r: Reply) => void;
    const panel = mount(() => new Promise<Reply>((resolve) => (release = resolve)));
    panel.get("planRoot").value = ROOT;
    await panel.fire("planRefresh", "click");
    await panel.fire("planRefresh", "click");
    expect(panel.fetch).toHaveBeenCalledTimes(1);
    expect(panel.get("planRefresh").disabled).toBe(true);
    release(reply(200, ok([leaf()])));
    await panel.settle();
    expect(panel.get("planRefresh").disabled).toBe(false);
    await panel.fire("planRefresh", "click");
    await panel.settle();
    expect(panel.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("plan status rendering", () => {
  it("renders hostile response text only as text", async () => {
    const hostileLeaf = leaf({
      name: HOSTILE,
      scope: HOSTILE,
      executorRef: HOSTILE,
      artifactRef: HOSTILE,
      attemptId: HOSTILE,
      state: "blocked",
      blockers: [
        { ownerId: "n1", predecessorId: "n0", gate: "g", reason: HOSTILE, predecessorName: HOSTILE }
      ]
    });
    const panel = mount(() => reply(200, ok([hostileLeaf])));
    await panel.load();
    expect(panel.view()).toContain("<img src=x");
    const allowed = new Set(["div", "span", "code", "p", "strong", "article"]);
    for (const node of panel.created) {
      expect(allowed.has(node.tagName), node.tagName).toBe(true);
      expect(Object.keys(node.attrs)).toEqual([]);
    }
    expect(panel.created.some((n) => n.tagName === "script" || n.tagName === "img")).toBe(false);
  });

  it("truncates every displayed string to the character limit", async () => {
    const long = "x".repeat(5000);
    const panel = mount(() =>
      reply(200, ok([leaf({ name: long, scope: long, executorRef: long, artifactRef: long })]))
    );
    await panel.load();
    const fields = panel.all().filter((n) => n.tagName === "code" || n.tagName === "strong");
    expect(fields.length).toBeGreaterThan(0);
    for (const node of fields) expect(node.textContent.length).toBeLessThan(400);
    expect(panel.view()).not.toContain("x".repeat(PLAN_STATUS_LIMITS.maxTextChars + 1));
    expect(panel.view()).toContain("x".repeat(PLAN_STATUS_LIMITS.maxTextChars));
  });

  it.each([
    ["complete", /Plan complete/],
    ["inconsistent", /inconsistent — neither complete nor incomplete is claimed/],
    ["active", /allocated \(recorded state\)/],
    ["awaiting_review", /awaiting review/],
    ["ready", /ready to be claimed/],
    ["stuck", /Nothing is ready/],
    ["invented", /unrecognized state/],
    ["__proto__", /unrecognized state/]
  ])("labels plan progress %s", async (state, pattern) => {
    const panel = mount(() => reply(200, withProgress(state)));
    await panel.load();
    expect(panel.view()).toMatch(pattern);
    // Only the complete verdict may claim completion.
    const claimsComplete = /Plan complete/.test(panel.view());
    expect(claimsComplete).toBe(state === "complete");
  });

  it("shows allocated work without claiming a worker started or is alive", async () => {
    const panel = mount(() =>
      reply(200, withProgress("active", [leaf({ state: "in_progress", attemptPins: "current" })]))
    );
    await panel.load();
    const text = panel.view();
    expect(text).toContain("Allocated/in progress (recorded state)");
    expect(text).toContain("Worker start: unknown");
    expect(text).toContain("Liveness and useful progress: not reported");
    expect(text).not.toMatch(/alive|running|started|accepted|healthy|working/i);
  });

  it("does not present an older attempt's decision as acceptance", async () => {
    const panel = mount(() =>
      reply(
        200,
        withProgress("awaiting_review", [
          leaf({
            state: "review_pending",
            acceptanceHistorical: true,
            acceptance: { decision: "accepted" }
          })
        ])
      )
    );
    await panel.load();
    expect(panel.view()).toContain(
      "Awaiting review — prior decision from an older attempt (historical)"
    );
    expect(panel.view()).not.toMatch(/accepted/i);
  });

  it("shows Accepted only for an accepted leaf with no historical decision", async () => {
    const panel = mount(() =>
      reply(
        200,
        ok([
          leaf({ nodeId: "a", state: "accepted" }),
          leaf({ nodeId: "b", state: "accepted", acceptanceHistorical: true })
        ])
      )
    );
    await panel.load();
    const leaves = panel.all().filter((n) => n.tagName === "article");
    expect(leaves[0].textContent).toContain("Accepted");
    expect(leaves[1].textContent).not.toContain("Accepted");
    expect(leaves[1].textContent).toContain("unrecognized state");
  });

  it.each([
    ["current", "inputs current"],
    ["stale", "inputs changed — stale"],
    ["unknown", "inputs unknown (attempt recorded without pins)"],
    ["none", "no attempt"],
    ["fresh", "inputs unrecognized"]
  ])("maps attempt pins %s", async (pins, label) => {
    const panel = mount(() => reply(200, ok([leaf({ attemptPins: pins })])));
    await panel.load();
    expect(panel.view()).toContain(label);
  });

  it("maps every leaf state and refuses to guess unknown ones", async () => {
    const states = [
      "ready",
      "blocked",
      "in_progress",
      "review_pending",
      "accepted",
      "rejected",
      "stale",
      "cancelled"
    ];
    const panel = mount(() =>
      reply(
        200,
        ok(
          [...states, "thriving", "constructor"].map((state, i) => leaf({ nodeId: `n${i}`, state }))
        )
      )
    );
    await panel.load();
    const leaves = panel.all().filter((n) => n.tagName === "article");
    const labels = leaves.map((n) => n.children[1].textContent);
    expect(labels).toEqual([
      "Ready",
      "Blocked",
      "Allocated/in progress (recorded state)",
      "Awaiting review",
      "Accepted",
      "Rejected",
      "Stale",
      "Cancelled",
      "unrecognized state",
      "unrecognized state"
    ]);
  });

  it("lists current blockers by name, falling back to the id, and draws no links", async () => {
    const blockers = [
      {
        ownerId: "n1",
        predecessorId: "p1",
        gate: "accepted",
        reason: "not accepted",
        predecessorName: "Build core"
      },
      {
        ownerId: "n1",
        predecessorId: "p2",
        gate: "accepted",
        reason: "not accepted",
        predecessorName: null
      }
    ];
    const panel = mount(() => reply(200, ok([leaf({ state: "blocked", blockers })])));
    await panel.load();
    expect(panel.view()).toContain("waits on Build core (not accepted)");
    expect(panel.view()).toContain("waits on p2 (not accepted)");
    expect(panel.view()).toContain("Current blockers only");
    expect(panel.created.every((n) => n.attrs.href === undefined && n.tagName !== "a")).toBe(true);
  });

  it("shows identities for people to copy and match against the AI snapshot", async () => {
    const panel = mount(() =>
      reply(
        200,
        ok([
          leaf({
            attemptId: "attempt-7",
            attemptEpoch: 2,
            executorRef: "exec-1",
            artifactRef: "art-1",
            state: "review_pending"
          })
        ])
      )
    );
    await panel.load();
    const codes = panel
      .all()
      .filter((n) => n.tagName === "code")
      .map((n) => n.textContent);
    expect(codes).toEqual(
      expect.arrayContaining([ROOT, "n1", "attempt-7", "2", "exec-1", "art-1", "3", "4"])
    );
  });

  it("renders an invalid plan as readiness errors with no leaf states", async () => {
    const panel = mount(() =>
      reply(200, {
        status: "invalid",
        rootId: ROOT,
        errors: [
          { code: "CYCLE", nodeId: "n9" },
          { code: "ORPHAN", nodeId: null }
        ]
      })
    );
    await panel.load();
    expect(panel.view()).toContain("CYCLE (n9)");
    expect(panel.view()).toContain("ORPHAN");
    expect(panel.view()).toContain("No leaf state is shown");
    expect(panel.all().some((n) => n.tagName === "article")).toBe(false);
  });

  it("caps rendered leaves and says how many are hidden", async () => {
    const leaves = Array.from({ length: 250 }, (_, i) => leaf({ nodeId: `n${i}` }));
    const panel = mount(() => reply(200, ok(leaves)));
    await panel.load();
    expect(panel.all().filter((n) => n.tagName === "article")).toHaveLength(200);
    expect(panel.view()).toContain("50 more not shown");
  });

  it.each([
    ["a different root", ok([leaf()], {}, OTHER_ROOT)],
    ["an unknown status", { status: "weird", rootId: ROOT }],
    ["a non-object", [1, 2]],
    [
      "missing leaves",
      { status: "ok", rootId: ROOT, progress: { state: "ready", leafCounts: {} } }
    ],
    ["a malformed leaf", ok(["not-a-leaf"])],
    ["non-JSON text", "<html>proxy error</html>"]
  ])("refuses %s as unrecognized without rendering it", async (_name, payload) => {
    const panel = mount(() => reply(200, payload));
    await panel.load();
    expect(panel.note()).toBe("Plan status response was not recognized.");
    expect(panel.view()).toBe("");
    expect(panel.banner().hidden).toBe(true);
  });
});

describe("plan status failures", () => {
  it.each([
    [403, "Operator access required to view plan status."],
    [404, "Plan status is not configured."],
    [400, "Invalid plan root."],
    [401, "Pairing is required to view plan status."],
    [500, "Plan status request failed (HTTP 500)."]
  ])("maps HTTP %s", async (status, message) => {
    const panel = mount(() => reply(status, { code: "WHATEVER", error: HOSTILE }));
    await panel.load();
    expect(panel.note()).toBe(message);
    expect(panel.view()).toBe("");
    expect(panel.note()).not.toContain("<");
  });

  it("names a recognized 503 reason and echoes nothing else", async () => {
    const known = mount(() => reply(503, { code: "PLAN_STATUS_UNAVAILABLE", reason: "TIMEOUT" }));
    await known.load();
    expect(known.note()).toBe("Plan status unavailable (reason: TIMEOUT).");
    for (const reason of [HOSTILE, "NOT_A_CODE", "__proto__", 7, null]) {
      const panel = mount(() => reply(503, { code: "PLAN_STATUS_UNAVAILABLE", reason }));
      await panel.load();
      expect(panel.note()).toBe("Plan status unavailable (reason: unrecognized).");
    }
    const garbage = mount(() => reply(503, "not json"));
    await garbage.load();
    expect(garbage.note()).toBe("Plan status unavailable (reason: unrecognized).");
  });

  it("keeps the last good view under a browser-clock stale banner after a failed refresh", async () => {
    let next: Reply = reply(200, ok([leaf({ name: "Still here" })]));
    const panel = mount(() => next);
    await panel.load();
    expect(panel.view()).toContain("Still here");
    expect(panel.banner().hidden).toBe(true);
    for (const failing of [
      reply(503, { code: "PLAN_STATUS_UNAVAILABLE", reason: "UNAVAILABLE" }),
      reply(403, {}),
      reply(200, "garbage")
    ]) {
      next = failing;
      await panel.fire("planRefresh", "click");
      await panel.settle();
      expect(panel.view()).toContain("Still here");
      expect(panel.view()).not.toMatch(/Plan complete/);
      expect(panel.banner().hidden).toBe(false);
      expect(panel.banner().textContent).toMatch(
        /^Last successful read at \d{4}-\d\d-\d\dT.+ \(browser clock, not Hekate's\) — now unavailable$/
      );
    }
    next = reply(200, ok([leaf({ name: "Recovered" })]));
    await panel.fire("planRefresh", "click");
    await panel.settle();
    expect(panel.view()).toContain("Recovered");
    expect(panel.view()).not.toContain("Still here");
    expect(panel.banner().hidden).toBe(true);
  });

  it("never shows another root's view after switching roots and failing", async () => {
    let next: Reply = reply(200, ok([leaf({ name: "Root one" })]));
    const panel = mount(() => next);
    await panel.load();
    next = reply(503, { reason: "TIMEOUT" });
    await panel.load(OTHER_ROOT);
    expect(panel.view()).toBe("");
    expect(panel.banner().hidden).toBe(true);
  });

  it("rejects a response over the byte limit without rendering it", async () => {
    const huge = JSON.stringify(
      ok([leaf({ name: "y".repeat(PLAN_STATUS_LIMITS.maxResponseBytes) })])
    );
    const panel = mount(() => reply(200, huge));
    await panel.load();
    expect(panel.note()).toBe("Plan status response is too large to display.");
    expect(panel.view()).toBe("");
  });

  it("rejects a declared length over the limit and aborts the read", async () => {
    const panel = mount(() =>
      reply(200, ok([leaf()]), {
        "content-length": String(PLAN_STATUS_LIMITS.maxResponseBytes + 1)
      })
    );
    await panel.load();
    expect(panel.note()).toBe("Plan status response is too large to display.");
    expect(panel.calls[0].init.signal.aborted).toBe(true);
  });

  it("counts bytes, not characters, against the limit", async () => {
    // Multi-byte text within the character limit but over the byte limit.
    const text = "€".repeat(Math.ceil(PLAN_STATUS_LIMITS.maxResponseBytes / 3) + 1);
    expect(text.length).toBeLessThan(PLAN_STATUS_LIMITS.maxResponseBytes);
    const panel = mount(() => reply(200, text));
    await panel.load();
    expect(panel.note()).toBe("Plan status response is too large to display.");
  });

  it("aborts at the client deadline and keeps the stale view", async () => {
    let hang = false;
    const panel = mount(() =>
      hang ? new Promise<Reply>(() => undefined) : reply(200, ok([leaf({ name: "Before" })]))
    );
    await panel.load();
    hang = true;
    await panel.fire("planRefresh", "click");
    await panel.settle();
    const deadline = panel.timers.filter((t) => t.live && t.ms === PLAN_STATUS_LIMITS.deadlineMs);
    expect(deadline).toHaveLength(1);
    deadline[0].run();
    await panel.settle();
    expect(panel.calls[1].init.signal.aborted).toBe(true);
    expect(panel.note()).toBe("Plan status request timed out.");
    expect(panel.view()).toContain("Before");
    expect(panel.banner().hidden).toBe(false);
    expect(panel.get("planRefresh").disabled).toBe(false);
  });

  it("clears the deadline timer when a request settles", async () => {
    const panel = mount();
    await panel.load();
    expect(panel.timers.filter((t) => t.live)).toHaveLength(0);
  });
});

describe("plan status scope", () => {
  it("restores only a valid stored root for the visible conversation, without a request", async () => {
    const panel = mount();
    await panel.load();
    await panel.switchScope("conv-b");
    expect(panel.get("planRoot").value).toBe("");
    expect(panel.view()).toBe("");
    await panel.switchScope("conv-a");
    expect(panel.get("planRoot").value).toBe(ROOT);
    expect(panel.note()).toContain("Press Load");
    expect(panel.fetch).toHaveBeenCalledTimes(1);
    const [key] = panel.store.keys();
    panel.store.set(key, "<script>");
    await panel.switchScope("conv-c");
    await panel.switchScope("conv-a");
    expect(panel.get("planRoot").value).toBe("");
  });

  it("clears the view, aborts the read and drops its late result on a conversation change", async () => {
    let release!: (r: Reply) => void;
    let first = true;
    const panel = mount(() => {
      if (first) {
        first = false;
        return reply(200, ok([leaf({ name: "Old scope" })]));
      }
      return new Promise<Reply>((resolve) => (release = resolve));
    });
    await panel.load();
    expect(panel.view()).toContain("Old scope");
    await panel.fire("planRefresh", "click");
    await panel.switchScope("conv-b");
    expect(panel.calls[1].init.signal.aborted).toBe(true);
    expect(panel.view()).toBe("");
    expect(panel.get("planRefresh").disabled).toBe(false);
    release(reply(200, ok([leaf({ name: "Late old scope" })])));
    await panel.settle();
    expect(panel.view()).toBe("");
    expect(panel.banner().hidden).toBe(true);
  });

  it("treats a user change like a conversation change", async () => {
    const panel = mount();
    await panel.load();
    await panel.switchScope("conv-a", "user-b");
    expect(panel.view()).toBe("");
    expect(panel.get("planRoot").value).toBe("");
  });

  it("drops a late result even when the scope changed without a change event", async () => {
    let release!: (r: Reply) => void;
    const panel = mount(() => new Promise<Reply>((resolve) => (release = resolve)));
    panel.get("planRoot").value = ROOT;
    await panel.fire("planRefresh", "click");
    panel.get("conversationId").value = "conv-silent";
    release(reply(200, ok([leaf({ name: "Wrong scope" })])));
    await panel.settle();
    expect(panel.view()).toBe("");
  });

  it("starts a fresh read after a scope switch aborted the previous one", async () => {
    const releases: Array<(r: Reply) => void> = [];
    const panel = mount(() => new Promise<Reply>((resolve) => releases.push(resolve)));
    panel.get("planRoot").value = ROOT;
    await panel.fire("planRefresh", "click");
    await panel.switchScope("conv-b");
    panel.get("planRoot").value = OTHER_ROOT;
    await panel.fire("planRefresh", "click");
    expect(panel.fetch).toHaveBeenCalledTimes(2);
    releases[0](reply(200, ok([leaf({ name: "Stale one" })])));
    releases[1](reply(200, ok([leaf({ name: "Fresh one" })], {}, OTHER_ROOT)));
    await panel.settle();
    expect(panel.view()).toContain("Fresh one");
    expect(panel.view()).not.toContain("Stale one");
  });

  it("aborts an in-flight read when the page is hidden", async () => {
    const panel = mount(() => new Promise<Reply>(() => undefined));
    panel.get("planRoot").value = ROOT;
    await panel.fire("planRefresh", "click");
    panel.windowHandlers.get("pagehide")!();
    expect(panel.calls[0].init.signal.aborted).toBe(true);
  });
});

it("keeps the allowlisted panel source formatted under the pinned repository config", async () => {
  const { readFile } = await import("node:fs/promises");
  const prettier = await import("prettier");
  const file = "src/ui/planStatusPanel.ts";
  const raw = await readFile(file, "utf8");
  const config = await prettier.resolveConfig(file);
  expect(await prettier.format(raw, { ...config, filepath: file })).toBe(raw);
});
