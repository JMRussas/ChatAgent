import { GenerationError } from "../domain/generation";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CapabilityTool } from "./capabilityChat";
import type { RunControls } from "./runControls";
const ids=z.array(z.string().min(1).max(500)).max(100).refine(v=>new Set(v).size===v.length,"Duplicate identifiers");
export const roleDefinitionSchema=z.object({
 id:z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),version:z.string().min(1).max(100),
 bindingId:z.string().min(1).max(500),instructions:z.string().min(1).max(8000),toolIds:ids,
 thinking:z.enum(["configured","on","off"]).default("configured"),
 contextPolicy:z.literal("conversation-and-selected-references").default("conversation-and-selected-references"),
 outputContract:z.literal("capability-plan-v1").default("capability-plan-v1"),
 maxToolCalls:z.number().int().min(0).max(3).default(3),maxInputTokens:z.number().int().min(256).max(1000000).default(8192),
 overrides:z.object({bindingIds:ids.default([]),thinking:z.boolean().default(false)}).strict().default({})
}).strict().refine(v=>v.maxToolCalls>0 || v.toolIds.length===0,"Zero-call roles must have no tools");
const catalogSchema=z.object({version:z.literal("role-catalog-v1"),roles:z.array(roleDefinitionSchema).min(1).max(100)}).strict()
 .refine(v=>new Set(v.roles.map(r=>r.id)).size===v.roles.length,"Duplicate role IDs");
export type RoleDefinition=z.infer<typeof roleDefinitionSchema>;
export type RoleExecution={plannerEngine?:import("./rolePlanner").RolePlannerEngine;definition:RoleDefinition;definitionHash:string;bindingId:string;thinking:RunControls["thinking"];toolIds:string[]};
/** Application-owned configuration. Snapshot selection performs no model or provider calls. */
export class RoleCatalog {
 private roles:z.infer<typeof catalogSchema>;
 constructor(value:unknown){this.roles=catalogSchema.parse(value);}
 replace(value:unknown){this.roles=catalogSchema.parse(value);}
 list(){return structuredClone(this.roles.roles);}
 resolve(controls:RunControls,registry:readonly CapabilityTool[],bindings:readonly string[]){
  const found=this.roles.roles.find(r=>r.id===controls.roleId);if(!found)throw new GenerationError("ROLE_NOT_FOUND",false);
  const definition=structuredClone(found);
  if(!bindings.includes(definition.bindingId) || definition.overrides.bindingIds.some(id=>!bindings.includes(id)))throw new GenerationError("ROLE_MODEL_UNAVAILABLE",false);
  if(definition.toolIds.some(id=>!registry.some(t=>t.id===id)))throw new GenerationError("ROLE_TOOL_UNAVAILABLE",false);
  const bindingId=controls.bindingId ?? definition.bindingId;
  if(bindingId!==definition.bindingId && !definition.overrides.bindingIds.includes(bindingId))throw new GenerationError("ROLE_MODEL_OVERRIDE_DENIED",false);
  const thinking=controls.thinking === "configured" ? definition.thinking : controls.thinking;
  if(thinking!==definition.thinking && !definition.overrides.thinking)throw new GenerationError("ROLE_THINKING_OVERRIDE_DENIED",false);
  const toolIds=controls.toolIds ?? definition.toolIds;
  if(toolIds.some(id=>!definition.toolIds.includes(id)))throw new GenerationError("ROLE_TOOL_OVERRIDE_DENIED",false);
  const exposed=controls.mode === "chat" ? toolIds : [];
  const execution:RoleExecution={definition,definitionHash:createHash("sha256").update(JSON.stringify(definition)).digest("hex"),bindingId,thinking,toolIds:[...exposed]};
  return {execution,tools:registry.filter(t=>exposed.includes(t.id)).map(t=>({...t,inputSchema:structuredClone(t.inputSchema)}))};
 }
}
export async function loadRoleCatalog(path?:string){
 if(!path?.trim())return undefined;
 try{return new RoleCatalog(JSON.parse(await readFile(path,"utf8")));}catch{throw new GenerationError("ROLE_CATALOG_INVALID",false);}
}
