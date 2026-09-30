import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { scenarioDataset } from "../../src/eval/scenarios";
it("versions expected outcomes separately from the prompts sent to the model", async () => {
  const plan = JSON.parse(await readFile("data/grounding-followup-scenarios.json", "utf8"));
  const { dataset, conversationGroups } = scenarioDataset(plan);
  expect(dataset.prompts).toHaveLength(10);
  expect(conversationGroups).toEqual(plan.scenarios.flatMap((s: { id: string }) => [s.id, s.id]));
  expect(dataset.prompts.every(p => Object.keys(p).sort().join() === "id,text")).toBe(true);
  expect(JSON.stringify(dataset)).not.toContain("taskCompletion");
  plan.scenarios[1].id = plan.scenarios[0].id;
  expect(() => scenarioDataset(plan)).toThrow("Duplicate scenario");
});
it("rejects duplicate turn identity and one-turn scenarios", async () => {
  const plan = JSON.parse(await readFile("data/grounding-followup-scenarios.json", "utf8"));
  const duplicate = structuredClone(plan);
  duplicate.scenarios[1].turns[0].id = duplicate.scenarios[0].turns[0].id;
  expect(() => scenarioDataset(duplicate)).toThrow("unique prompt");
  plan.scenarios[0].turns.pop();
  expect(() => scenarioDataset(plan)).toThrow();
});
