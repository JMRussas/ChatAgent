import { z } from "zod";
export const runControlsSchema = z.object({
  bindingId:z.string().min(1).max(500).optional(),
  thinking:z.enum(["configured","on","off"]).default("configured"),
  mode:z.enum(["chat","review","revise"]).default("chat"),
  targetMessageId:z.string().min(1).max(200).optional()
}).strict().superRefine((v,c)=>{if(v.mode !== "chat" && !v.targetMessageId)c.addIssue({code:"custom",message:"Select an answer to review or revise"});});
export type RunControls = z.infer<typeof runControlsSchema>;
