import { z } from "zod";
export const runControlsSchema = z
  .object({
    roleId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,79}$/)
      .optional(),
    toolIds: z
      .array(z.string().min(1).max(500))
      .max(100)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    bindingId: z.string().min(1).max(500).optional(),
    thinking: z.enum(["configured", "on", "off"]).default("configured"),
    mode: z.enum(["chat", "review", "revise", "answer-evidence"]).default("chat"),
    reviewScope: z.enum(["text-only", "selected-evidence"]).optional(),
    targetMessageId: z.string().min(1).max(200).optional()
  })
  .strict()
  .superRefine((v, c) => {
    if (v.toolIds && !v.roleId)
      c.addIssue({ code: "custom", message: "Tool overrides require a role" });
    if ((v.mode === "review" || v.mode === "revise") && !v.targetMessageId)
      c.addIssue({ code: "custom", message: "Select an answer to review or revise" });
  });
export type RunControls = z.infer<typeof runControlsSchema>;
