import { expect, it } from "vitest";
import { documentTaskScript } from "../../src/ui/documentTaskPanel";
it("emits a syntactically valid task script that renders model text as text", () => {
  const script = documentTaskScript()
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  expect(() => new Function(script)).not.toThrow();
  expect(script).toContain("answer.textContent=task.answer.answer");
  expect(script).not.toContain("innerHTML");
});
