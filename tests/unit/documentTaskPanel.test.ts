import { expect, it, vi } from "vitest";
import { documentTaskScript } from "../../src/ui/documentTaskPanel";
it("emits a syntactically valid task script without innerHTML", () => {
  const script = documentTaskScript()
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  expect(() => new Function(script)).not.toThrow();
  expect(script).not.toContain("innerHTML");
});

it("explains an abandoned task's unknown external outcome", async () => {
  type Node = { textContent: string; children: Node[]; append: (...n: Node[]) => void };
  const element = (): Node & Record<string, unknown> => {
    const node = {
      textContent: "",
      value: "x",
      dataset: {},
      setAttribute: () => undefined,
      children: [] as Node[],
      append: (...n: Node[]) => node.children.push(...n),
      replaceChildren: () => (node.children = []),
      addEventListener: () => undefined
    };
    return node;
  };
  const elements: Record<string, ReturnType<typeof element>> = {};
  const document = {
    getElementById: (id: string) => (elements[id] ??= element()),
    createElement: () => element()
  };
  const tasks = [
    {
      taskId: "t",
      question: "How?",
      status: "abandoned",
      answer: null,
      error: null,
      scheduled: false,
      externalOutcome: "unknown"
    }
  ];
  const fetch = vi.fn(async () => ({ ok: true, json: async () => tasks }));
  const script = documentTaskScript()
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  new Function("document", "fetch", "setInterval", "window", "crypto", script)(
    document,
    fetch,
    () => 0,
    { addEventListener: () => undefined },
    {}
  );
  await vi.waitFor(() => expect(elements.thread.children).toHaveLength(1));
  const texts = elements.thread.children[0].children.flatMap((n) => [
    n.textContent,
    ...n.children.map((c) => c.textContent)
  ]);
  expect(texts).toContain("How?");
  expect(texts).toContain("Documentation task — abandoned");
  expect(texts.join(" ")).toMatch(/unknown, and no answer will be shown/);
  // No action is offered for an abandoned task.
  expect(texts).not.toContain("Resume");
  expect(texts).not.toContain("Cancel");
});
