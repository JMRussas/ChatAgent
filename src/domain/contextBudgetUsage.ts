import { z } from "zod";
const count = z.number().int().nonnegative();
export const contextBudgetUsageSchema = z
  .object({
    method: z.literal("utf8-conservative-v1"),
    windowTokens: count,
    outputReserve: count,
    safetyReserve: count,
    availableInputTokens: count,
    totalInputTokens: count,
    instructions: count,
    tools: count,
    references: count,
    currentMessage: count,
    history: count,
    activeTasks: count,
    memory: count,
    handoffView: count.optional(),
    roleInputLimit: count.optional()
  })
  .strict();
export type ContextBudgetUsage = z.infer<typeof contextBudgetUsageSchema>;
