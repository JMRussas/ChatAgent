/**
 * A deliberately tiny DOM for running the generated page scripts under vitest. It supports
 * only what the executive overview script uses, records every created tag, and refuses
 * innerHTML so a script that tried to parse data as markup fails the test.
 */
export class FakeEl {
  kids: (FakeEl | string)[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  hidden = false;
  open = false;
  disabled = false;
  value = "";
  style: Record<string, string> = {};
  parent: FakeEl | null = null;
  constructor(
    readonly tag: string,
    private readonly created?: string[]
  ) {
    created?.push(tag);
  }
  get textContent(): string {
    return this.kids.map((kid) => (typeof kid === "string" ? kid : kid.textContent)).join("");
  }
  set textContent(value: string) {
    this.detachAll();
    this.kids = [String(value)];
  }
  get childNodes() {
    return [...this.kids];
  }
  set innerHTML(_value: string) {
    throw new Error("innerHTML must not be used");
  }
  private detachAll() {
    for (const kid of this.kids) if (typeof kid !== "string") kid.parent = null;
    this.kids = [];
  }
  append(...nodes: (FakeEl | string)[]) {
    for (const node of nodes) {
      if (typeof node !== "string") {
        node.parent?.kids.splice(node.parent.kids.indexOf(node), 1);
        node.parent = this;
      }
      this.kids.push(node);
    }
  }
  replaceChildren(...nodes: (FakeEl | string)[]) {
    this.detachAll();
    this.append(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string) {
    delete this.attrs[name];
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type: string) {
    for (const listener of this.listeners[type] ?? []) listener({ type });
  }
  /** A click; a summary then toggles its details as a browser does after the click event. */
  click() {
    this.dispatch("click");
    if (this.tag === "summary" && this.parent?.tag === "details")
      this.parent.open = !this.parent.open;
  }
  findAll(predicate: (el: FakeEl) => boolean): FakeEl[] {
    const found: FakeEl[] = [];
    for (const kid of this.kids) {
      if (typeof kid === "string") continue;
      if (predicate(kid)) found.push(kid);
      found.push(...kid.findAll(predicate));
    }
    return found;
  }
}

export class FakeDoc {
  readonly createdTags: string[] = [];
  private readonly byId = new Map<string, FakeEl>();
  constructor(ids: Record<string, Partial<FakeEl> & { tag?: string }>) {
    for (const [id, init] of Object.entries(ids)) {
      const el = new FakeEl(init.tag ?? "div");
      Object.assign(el, { ...init, tag: el.tag });
      this.byId.set(id, el);
    }
  }
  getElementById(id: string) {
    return this.byId.get(id) ?? null;
  }
  createElement(tag: string) {
    return new FakeEl(tag, this.createdTags);
  }
  el(id: string) {
    return this.byId.get(id)!;
  }
}

/** A controllable fetch: every call waits until the test answers or the signal aborts. */
export function controlledFetch() {
  const calls: {
    url: string;
    method: string;
    signal?: AbortSignal;
    respond(body: unknown, status?: number): void;
    respondRaw(body: string, status?: number): void;
  }[] = [];
  const fetch = (url: string, init: { method?: string; signal?: AbortSignal } = {}) =>
    new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError"))
      );
      calls.push({
        url,
        method: init.method ?? "GET",
        signal: init.signal,
        respond: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
        respondRaw: (body, status = 200) => resolve(new Response(body, { status }))
      });
    });
  return { fetch, calls };
}

export const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
