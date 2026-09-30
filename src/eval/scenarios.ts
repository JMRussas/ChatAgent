import { z } from "zod";
import { datasetSchema } from "./recording/contract";
const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/);
export const scenarioSuiteSchema = z.object({
  version: id,
  scenarios: z.array(z.object({ id, turns: z.array(z.object({
    id, text: z.string().min(1).max(100000), expected: z.object({
      groundedness: z.string().min(1), taskCompletion: z.string().min(1)
    }).strict()
  }).strict()).min(2).max(20) }).strict()).min(1).max(100)
}).strict().superRefine((suite, ctx) => {
  if (new Set(suite.scenarios.map(s => s.id)).size !== suite.scenarios.length)
    ctx.addIssue({ code: "custom", message: "Duplicate scenario ID" });
  const dataset = datasetSchema.safeParse({ version: suite.version, prompts: suite.scenarios.flatMap(s => s.turns.map(({ id, text }) => ({ id, text }))) });
  if (!dataset.success) ctx.addIssue({ code: "custom", message: "Scenario turns require unique prompt IDs and texts" });
});
export function scenarioDataset(value: unknown) {
  const suite = scenarioSuiteSchema.parse(value);
  return { suite, dataset: datasetSchema.parse({ version: suite.version,
    prompts: suite.scenarios.flatMap(s => s.turns.map(({ id, text }) => ({ id, text }))) }),
    conversationGroups: suite.scenarios.flatMap(s => s.turns.map(() => s.id)) };
}
