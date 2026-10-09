import { describe, expect, it, vi } from "vitest";
import {
  PLAN_RUN_LIMITS,
  planRunControlsHtml,
  planRunControlsScript
} from "../../src/ui/planRunControls";
import { planStatusScript } from "../../src/ui/planStatusPanel";

const ROOT = "11111111-2222-4333-8444-555555555555";
const OTHER_ROOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LID = "a".repeat(32);
const HOSTILE = '<img src=x onerror="window.pwned=1"></script><script>window.pwned=2</script>';

const body = () =>
  planRunControlsScript()
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");

class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  handlers = new Map<string, (event?: unknown) => unknown>();
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
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.own = "";
    this.children = [...nodes];
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
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
const reply = (status: number, payload: unknown): Reply => ({
  status,
  headers: { get: () => null },
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload))
});
const host = (over: Record<string, unknown> = {}, root = ROOT) => ({
  rootId: root,
  journal: null,
  lifecycle: "running",
  launchId: LID,
  heartbeatAt: "2026-10-08T10:00:00+00:00",
  stopReason: null,
  current: null,
  ...over
});

interface FetchInit {
  method?: string;
  cache?: string;
  credentials?: string;
  redirect?: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
type Responder = (url: string, init: FetchInit) => Promise<Reply> | Reply;

function mount(responder: Responder = () => reply(200, host())) {
  const elements = new Map<string, FakeElement>();
  const created: FakeElement[] = [];
  const get = (id: string) => {
    let node = elements.get(id);
    if (!node) {
      node = new FakeElement("div");
      node.value = id === "conversationId" ? "conv-a" : id === "userId" ? "user-a" : "";
      if (id === "planRoot") node.value = ROOT;
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
    setItem: (key: string, value: string) => void store.set(key, value)
  };
  const calls: Array<{ url: string; init: FetchInit; aborted: () => boolean }> = [];
  const fetch = vi.fn((url: string, init: FetchInit) => {
    calls.push({ url, init, aborted: () => init.signal.aborted });
    return new Promise<Reply>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal.aborted) return abort();
      init.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(responder(url, init)).then(resolve, reject);
    });
  });
  const timers: Array<{ ms: number; run: () => void; live: boolean }> = [];
  const windowHandlers = new Map<string, () => void>();
  let uuid = 0;
  const window = {
    addEventListener: (type: string, handler: () => void) => void windowHandlers.set(type, handler),
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`
    }
  };
  new Function(
    "document",
    "fetch",
    "window",
    "sessionStorage",
    "setTimeout",
    "clearTimeout",
    body()
  )(
    document,
    fetch,
    window,
    sessionStorage,
    (run: () => void, ms: number) => {
      timers.push({ ms, run, live: true });
      return timers.length - 1;
    },
    (id: number) => {
      if (timers[id]) timers[id].live = false;
    }
  );
  const click = async (id: string) => {
    const handler = get(id).handlers.get("click");
    expect(handler, `${id} has a click handler`).toBeDefined();
    void handler!();
    await Promise.resolve();
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    get,
    created,
    store,
    calls,
    timers,
    windowHandlers,
    click,
    settle,
    view: () => get("planRunView").textContent,
    note: () => get("planRunNote").textContent,
    unknownBox: () => get("planRunUnknown"),
    post: () => calls.filter((c) => c.init.method === "POST")
  };
}

describe("plan run controls markup and script", () => {
  it("parses, names the explicit buttons and holds no automatic trigger", () => {
    expect(() => new Function(body())).not.toThrow();
    const html = planRunControlsHtml();
    for (const label of ["Check host", "Start prepared plan", "Request stop"])
      expect(html).toContain(`>${label}</button>`);
    for (const id of ["planHostCheck", "planHostStart", "planHostStop", "planRunView"])
      expect(html).toContain(`id="${id}"`);
    const script = body();
    expect(script).not.toMatch(
      /setInterval|innerHTML|insertAdjacentHTML|localStorage|Authorization/
    );
    expect(script).not.toMatch(/document\.cookie|location\.|new Function|eval\(/);
    expect(script).toContain("JSON.stringify({ operationId: req.operationId })");
    expect(script).toContain(`DEADLINE_MS = ${PLAN_RUN_LIMITS.deadlineMs}`);
    expect(script).toContain(`MAX_BYTES = ${PLAN_RUN_LIMITS.maxResponseBytes}`);
  });

  it("leaves the read-only status panel script bytes alone", () => {
    expect(planStatusScript()).not.toContain("planHostStart");
    expect(planStatusScript()).not.toContain("dispatch");
  });
});

describe("plan run controls behaviour", () => {
  it("sends nothing at load", async () => {
    const page = mount();
    await page.settle();
    expect(page.calls).toEqual([]);
    expect(page.timers).toEqual([]);
  });

  it("checks the host with one exact GET and renders text", async () => {
    const page = mount(() =>
      reply(200, host({ current: { node: "n1", workerLiveness: "unknown" } }))
    );
    await page.click("planHostCheck");
    await page.settle();
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0].url).toBe(`/development/plans/${ROOT}/dispatch`);
    expect(page.calls[0].init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error"
    });
    expect(page.view()).toContain("Host running");
    expect(page.view()).toContain(LID);
    expect(page.view()).toContain("Worker liveness: unknown");
  });

  it("launches with exactly the operation ID and records bounded typed metadata", async () => {
    const page = mount((_url, init) =>
      reply(200, {
        code: "LAUNCHED",
        launchId: LID,
        host: "attached",
        operationId: (JSON.parse(init.body ?? "{}") as { operationId: string }).operationId,
        outcome: "launched"
      })
    );
    await page.click("planHostStart");
    await page.settle();
    const [call] = page.post();
    expect(call.url).toBe(`/development/plans/${ROOT}/dispatch/launch`);
    expect(call.init.body).toBe('{"operationId":"00000000-0000-4000-8000-000000000001"}');
    expect(page.view()).toContain("00000000-0000-4000-8000-000000000001");
    expect(page.view()).toContain(LID);
    const [[key, value]] = [...page.store.entries()];
    expect(key).toBe(`chatagent-plan-run:user-a:conv-a:${ROOT}`);
    expect(Object.keys(JSON.parse(value) as object).sort()).toEqual([
      "at",
      "code",
      "kind",
      "launchId",
      "operationId",
      "outcome",
      "root",
      "v"
    ]);
    expect(value.length).toBeLessThan(600);
  });

  it("sends a duplicate click once and disables the controls while busy", async () => {
    let release: (r: Reply) => void = () => undefined;
    const page = mount(() => new Promise<Reply>((resolve) => (release = resolve)));
    await page.click("planHostStart");
    await page.click("planHostStart");
    await page.click("planHostStop");
    expect(page.calls).toHaveLength(1);
    for (const id of ["planHostCheck", "planHostStart", "planHostStop"])
      expect(page.get(id).disabled).toBe(true);
    release(reply(200, "not json"));
    await page.settle();
  });

  it("never reports a stop request as stopped", async () => {
    const page = mount((_url, init) =>
      reply(202, {
        code: "STOP_REQUESTED",
        state: "stop_requested",
        exited: false,
        graceful: true,
        operationId: (JSON.parse(init.body ?? "{}") as { operationId: string }).operationId,
        outcome: "stop_requested"
      })
    );
    await page.click("planHostStop");
    await page.settle();
    expect(page.post()[0].url).toBe(`/development/plans/${ROOT}/dispatch/stop`);
    expect(page.note()).toContain("not proof the host stopped");
  });

  it("aborts on scope change and ignores the orphaned response", async () => {
    let release: (r: Reply) => void = () => undefined;
    const page = mount(() => new Promise<Reply>((resolve) => (release = resolve)));
    await page.click("planHostCheck");
    page.get("conversationId").value = "conv-b";
    void page.get("conversationId").handlers.get("change")!();
    expect(page.calls[0].aborted()).toBe(true);
    release(reply(200, host({ launchId: "c".repeat(32) })));
    await page.settle();
    expect(page.view()).not.toContain("c".repeat(32));
    expect(page.get("planHostCheck").disabled).toBe(false);
  });

  it("aborts on pagehide and keeps a mutation unknown rather than cancelled", async () => {
    const page = mount(() => new Promise<Reply>(() => undefined));
    await page.click("planHostStart");
    page.windowHandlers.get("pagehide")!();
    expect(page.calls[0].aborted()).toBe(true);
    const [[, value]] = [...page.store.entries()];
    expect(JSON.parse(value)).toMatchObject({ kind: "launch", outcome: "unknown", root: ROOT });
    expect(page.get("planHostStart").disabled).toBe(true);
  });

  it("treats a timeout as unknown, does not retry and needs a host check", async () => {
    const page = mount(() => new Promise<Reply>(() => undefined));
    await page.click("planHostStart");
    expect(page.timers[0].ms).toBe(PLAN_RUN_LIMITS.deadlineMs);
    page.timers[0].run();
    await page.settle();
    expect(page.note()).toContain("timed out");
    expect(page.unknownBox().hidden).toBe(false);
    expect(page.get("planHostStart").disabled).toBe(true);
    expect(page.get("planHostCheck").disabled).toBe(false);
    await page.click("planHostStart");
    expect(page.post()).toHaveLength(1);
  });

  it("keeps an unknown operation blocked when a host check has no journal evidence", async () => {
    let journal: unknown = null;
    const page = mount((_url, init) => {
      if (init.method === "POST") return Promise.reject(new Error("network failed"));
      return Promise.resolve(reply(200, host({ journal })));
    });
    await page.click("planHostStart");
    await page.settle();
    await page.click("planHostCheck");
    await page.settle();
    expect(page.get("planHostStart").disabled).toBe(true);
    expect(page.unknownBox().hidden).toBe(false);
    journal = {
      unresolvedIntent: false,
      uncertainLaunch: false,
      uncertainStop: false,
      malformedRecords: 0
    };
    await page.click("planHostCheck");
    await page.settle();
    expect(page.get("planHostStart").disabled).toBe(false);
    expect(page.post()).toHaveLength(1);
  });

  it("restores unknown state from storage without sending a request", async () => {
    const page = mount();
    page.store.set(
      `chatagent-plan-run:user-a:conv-a:${ROOT}`,
      JSON.stringify({
        v: 1,
        root: ROOT,
        kind: "launch",
        operationId: "00000000-0000-4000-8000-000000000009",
        launchId: null,
        outcome: "unknown",
        code: "LAUNCH_UNCERTAIN",
        at: "2026-10-08T10:00:00.000Z"
      })
    );
    page.get("conversationId").value = "conv-b";
    page.get("conversationId").value = "conv-a";
    void page.get("conversationId").handlers.get("change")!();
    expect(page.get("planHostStart").disabled).toBe(true);
    expect(page.unknownBox().textContent).toContain("00000000-0000-4000-8000-000000000009");
    expect(page.calls).toEqual([]);
  });

  it("ignores stored metadata that is not the typed record", () => {
    const page = mount();
    for (const raw of ["{", JSON.stringify({ v: 1, root: OTHER_ROOT }), "x".repeat(700)]) {
      page.store.set(`chatagent-plan-run:user-a:conv-a:${ROOT}`, raw);
      void page.get("userId").handlers.get("change")!();
      expect(page.get("planHostStart").disabled).toBe(false);
    }
  });

  it("refuses an unsupported or foreign projection instead of guessing", async () => {
    for (const payload of [
      host({ lifecycle: "teleporting" }),
      host({}, OTHER_ROOT),
      host({ launchId: "short" }),
      host({ current: { node: HOSTILE } }),
      "not json"
    ]) {
      const page = mount(() => reply(200, payload));
      await page.click("planHostCheck");
      await page.settle();
      expect(page.note()).toContain("not a supported projection");
      expect(page.view()).toContain("Host not checked");
    }
  });

  it("keeps hostile result text inert", async () => {
    const page = mount(() => reply(409, { code: HOSTILE, operationId: HOSTILE }));
    await page.click("planHostStart");
    await page.settle();
    expect(page.created.map((n) => n.tagName)).not.toContain("img");
    expect(page.created.map((n) => n.tagName)).not.toContain("script");
    expect(page.view()).not.toContain("onerror");
    expect(page.note()).not.toContain("onerror");
  });
});
