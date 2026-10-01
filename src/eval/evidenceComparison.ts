import {validateDeliveredAnswer,deliveryDigest} from "../app/deliveredAnswer";
import {citationEvidenceView} from "../app/evidenceCitations";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {CapabilityChat} from "../app/capabilityChat";
import {ContextManager} from "../app/contextManager";
import {RoleCatalog} from "../app/roleCatalog";
import {ToolResultStore} from "../app/toolResult";
import {prepareAnswerEvidence,retrievalAnswerPolicySchema} from "../app/retrievalAnswerContract";
import {InMemoryConversationTimelineStore} from "../app/timelineStore";
import {InMemoryTaskQueue,type FastModelProvider} from "../providers/interfaces";
import type {GenerationResult} from "../domain/generation";
export const evidenceDatasetSchema=z.object({version:z.literal("evidence-quality-v1"),partition:z.literal("development"),description:z.string(),cases:z.array(z.object({id:z.string().min(1),prompt:z.string().min(1),columns:z.array(z.string()).min(1).max(20),rows:z.array(z.array(z.string())).min(1).max(1000),selectedRows:z.array(z.number().int().nonnegative()).min(1).max(20),coverage:z.enum(["complete","partial"]),limitations:z.array(z.string()),expected:z.string()}).strict()).min(1).max(20)}).strict().refine(v=>new Set(v.cases.map(c=>c.id)).size===v.cases.length,"Duplicate cases");
export interface EvidenceCondition {id:string;provider:FastModelProvider;thinking:"configured"|"on"|"off"}
export const evidenceHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Serial, bounded development comparison through the production answer path; no automatic semantic judge. */
export async function runEvidenceComparison(datasetInput:unknown,conditions:EvidenceCondition[],options:{deadlineMs?:number;onCase?:(caseId:string,condition:string)=>void}={}){
 const dataset=evidenceDatasetSchema.parse(datasetInput);
 if(!conditions.length || conditions.length>4 || new Set(conditions.map(c=>c.id)).size!==conditions.length)throw Error("INVALID_CONDITIONS");
 const conditionPlan=conditions.map(c=>z.object({id:z.string().min(1).max(200).refine(v=>v===v.trim(),"Condition IDs must not have surrounding whitespace"),thinking:z.enum(["configured","on","off"])}).strict().parse({id:c.id,thinking:c.thinking}));
 const policy=retrievalAnswerPolicySchema.parse({version:"retrieval-answer-v1",maxModelCalls:1,maxToolCalls:0,deadlineMs:options.deadlineMs ?? 60000});
 // Validate every selection and payload before the first provider call.
 const specs=dataset.cases.map(c=>{
  const store=new ToolResultStore();const result=store.put("eval","validate",{version:"tool-result-v1",context:{status:"ready",summary:"Synthetic fixture",scope:"development fixture",coverage:c.coverage,limitations:c.limitations,expiresAt:new Date(Date.now()+600000).toISOString()},payload:{kind:"table",title:c.id,columns:c.columns,rows:c.rows},evidence:{sourceUrl:"https://example.invalid/synthetic",observedAt:new Date().toISOString(),revision:dataset.version}});
  citationEvidenceView(prepareAnswerEvidence(store,[{resultId:result.context.resultId,rows:c.selectedRows}],"eval","validate",policy,Date.now(),new AbortController().signal),policy.maxEvidenceBytes);
  return {test:c,template:result};
 });
 const records=[];
 for(const condition of conditions)for(const {test,template} of specs){
  options.onCase?.(test.id,condition.id);
  const conversationId=randomUUID(),store=new ToolResultStore(),timeline=new InMemoryConversationTimelineStore();
  const result=store.put("eval",conversationId,{...template,context:{...template.context,expiresAt:new Date(Date.now()+policy.deadlineMs+60000).toISOString()}});
  const selections=[{resultId:result.context.resultId,rows:test.selectedRows}];
  const packet=prepareAnswerEvidence(store,selections,"eval",conversationId,policy,Date.now(),new AbortController().signal);
  let generated:GenerationResult|undefined;let modelInput:unknown=null;let actual=condition.provider.metadata;
  const observe=(provider:FastModelProvider):FastModelProvider=>({metadata:provider.metadata,
   ...(provider.withThinking ? {withThinking:async (setting,control)=>observe(await provider.withThinking!(setting,control))} : {}),
   createProvisionalReply:async(input,control)=>{actual=provider.metadata;modelInput=structuredClone(input.context ?? null);generated=await provider.createProvisionalReply(input,control);return generated;}});
  const roles=new RoleCatalog({version:"role-catalog-v1",roles:[{id:"writer",version:"eval-v1",bindingId:"fixed",instructions:"Answer using the explicitly selected evidence only.",toolIds:[],maxToolCalls:0,maxInputTokens:12000,outputContract:"answer-evidence-v2",evidenceLimits:{deadlineMs:policy.deadlineMs},overrides:{thinking:true}}]});
  const chat=new CapabilityChat(observe(condition.provider),new InMemoryTaskQueue(),timeline,new ContextManager(timeline,{windowTokens:16384,maxHistoryTurns:0,safetyTokens:256,fastOutputTokens:2048,deepOutputTokens:2048}),()=>({fastProvider:"evaluation",fastModel:condition.id,deepProvider:"none",deepModel:"none",generatedAtIso:new Date().toISOString()}),()=>[],undefined,roles,"native",()=>store);
  const started=Date.now();let errorCode:string|null=null;
  try{await chat.handleUserMessage({conversationId,userId:"eval",messageId:randomUUID(),text:test.prompt,timestampIso:new Date().toISOString(),referenceSelections:selections,runControls:{roleId:"writer",mode:"answer-evidence",thinking:condition.thinking}});}
  catch(error){errorCode=error instanceof Error && "code" in error ? String(error.code) : "EVALUATION_EXECUTION_FAILED";}
  const event=(await timeline.getEvents(conversationId)).find(e=>e.groundedAnswer);
  const delivered=event ? {version:"delivered-answer-v1" as const,text:event.text,references:event.answerReferences} : null;
  const record={delivered,deliveryHash:delivered ? deliveryDigest(delivered):null,caseId:test.id,condition:condition.id,requestedThinking:condition.thinking,model:actual ?? null,modelInput,prompt:test.prompt,evidence:packet,expected:test.expected,generated:generated ?? null,answer:event?.groundedAnswer ?? null,errorCode,latencyMs:Date.now()-started};
  records.push({...record,responseHash:evidenceHash(record),semanticGrade:"ungraded" as const});
 }
 return {version:"evidence-comparison-v3" as const,partition:dataset.partition,datasetHash:evidenceHash(dataset),dataset,conditions:conditionPlan,createdAt:new Date().toISOString(),records};
}
export type EvidenceComparison=Awaited<ReturnType<typeof runEvidenceComparison>>;
const gradeSchema=z.object({judge:z.object({id:z.string().min(1),kind:z.enum(["human","model"])}).strict(),ratings:z.array(z.object({responseHash:z.string().regex(/^[a-f0-9]{64}$/),grade:z.enum(["pass","fail"]),rationale:z.string().min(1)}).strict())}).strict();
/** Bind independent ratings to the exact prompt, evidence, settings and output. */
export function gradeEvidenceComparison(value:unknown,input:unknown){
 const header=z.object({version:z.literal("evidence-comparison-v3"),partition:z.literal("development"),datasetHash:z.string(),dataset:evidenceDatasetSchema,conditions:z.array(z.object({id:z.string().min(1),thinking:z.enum(["configured","on","off"])}).strict()).min(1).max(4),records:z.array(z.object({caseId:z.string(),condition:z.string(),requestedThinking:z.enum(["configured","on","off"]),responseHash:z.string(),semanticGrade:z.literal("ungraded")}).passthrough())}).passthrough().parse(value);
 if(header.datasetHash!==evidenceHash(header.dataset))throw Error("DATASET_HASH_MISMATCH");
 if(new Set(header.conditions.map(c=>c.id)).size!==header.conditions.length)throw Error("DUPLICATE_CONDITION");
 const expected=new Set(header.conditions.flatMap(c=>header.dataset.cases.map(t=>JSON.stringify([c.id,t.id]))));
 const seen=new Set<string>();
 for(const row of header.records){
  const key=JSON.stringify([row.condition,row.caseId]);
  if(!expected.has(key) || seen.has(key))throw Error("CASE_COVERAGE_MISMATCH");
  seen.add(key);
  const test=header.dataset.cases.find(c=>c.id===row.caseId)!;
  if(row.requestedThinking!==header.conditions.find(c=>c.id===row.condition)!.thinking || row.prompt!==test.prompt || row.expected!==test.expected)throw Error("CASE_PLAN_MISMATCH");
 }
 if(seen.size!==expected.size)throw Error("CASE_COVERAGE_MISMATCH");
 // Hash the original records, not Zod's reconstructed objects: key order is part
 // of the existing v1 record hash contract.
 const report=value as EvidenceComparison;
 const grades=gradeSchema.parse(input);
 if(new Set(grades.ratings.map(r=>r.responseHash)).size!==grades.ratings.length)throw Error("DUPLICATE_GRADE");
 if(grades.ratings.some(r=>!report.records.some(row=>row.responseHash===r.responseHash)))throw Error("UNKNOWN_GRADE");
 const results=report.records.map(({responseHash,semanticGrade,...record})=>{
  if(evidenceHash(record)!==responseHash)throw Error("RESPONSE_HASH_MISMATCH");
  let deliveryValid=false;
  try{if(record.delivered && record.answer){validateDeliveredAnswer(record.delivered,record.answer,record.evidence);deliveryValid=deliveryDigest(record.delivered)===record.deliveryHash;}}catch{}
  const rating=grades.ratings.find(r=>r.responseHash===responseHash);
  return {caseId:record.caseId,condition:record.condition,responseHash,runtimePassed:deliveryValid && record.errorCode===null && record.generated?.finishReason==="stop" && !!record.answer,grade:rating?.grade ?? "ungraded",rationale:rating?.rationale ?? null};
 });
 return {version:"evidence-comparison-grading-v3" as const,judge:grades.judge,results,passed:results.length>0 && results.every(r=>r.runtimePassed && r.grade==="pass")};
}
