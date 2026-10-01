import {createHash} from "node:crypto";
import {z} from "zod";
import {groundedAnswerSchema,type AnswerEvidencePacket} from "./retrievalAnswerContract";
/** Scoped to an immutable issued result and original cell, never a reduced-table index. */
export function evidenceCitationId(resultId:string,row:number,column:number){
 return "c_"+createHash("sha256").update(JSON.stringify([resultId,row,column])).digest("hex").slice(0,16);
}
export function citationEvidenceView(packet:AnswerEvidencePacket,maxBytes:number){
 const view={version:"answer-evidence-v2" as const,scope:packet.scope,expiresAt:packet.expiresAt,limitations:packet.limitations,
  references:packet.references.map(({selectedRows,rows,...reference})=>({...reference,
   rows:rows.map((row,index)=>row.map((value,column)=>({citationId:evidenceCitationId(reference.resultId,selectedRows[index],column),value}))) }))};
 if(Buffer.byteLength(JSON.stringify(view))>maxBytes)throw Error("ANSWER_EVIDENCE_LIMIT");
 return view;
}
const handleAnswerSchema=z.discriminatedUnion("status",[
 z.object({status:z.literal("answer"),scope:z.literal("selected_rows"),claims:z.array(z.object({text:z.string().trim().min(1).max(2000),citations:z.array(z.string().regex(/^c_[a-f0-9]{16}$/)).min(1).max(10)}).strict()).min(1).max(20),limitations:z.array(z.string().min(1).max(1000)).max(30)}).strict(),
 z.object({status:z.literal("insufficient_evidence"),reason:z.string().trim().min(1).max(2000)}).strict()
]);
/** Resolve only issued, currently selected cells. Semantic entailment remains separately graded. */
export function resolveEvidenceCitations(output:unknown,packet:AnswerEvidencePacket){
 const answer=handleAnswerSchema.parse(output);
 if(answer.status==="insufficient_evidence")return answer;
 const cells=new Map<string,{resultId:string;row:number;column:number;quote:string}>();
 for(const reference of packet.references)reference.rows.forEach((row,index)=>row.forEach((quote,column)=>{
  const original=reference.selectedRows[index],id=evidenceCitationId(reference.resultId,original,column);
  if(cells.has(id))throw Error("ANSWER_CITATION_COLLISION");
  cells.set(id,{resultId:reference.resultId,row:original,column,quote});
 }));
 return groundedAnswerSchema.parse({...answer,claims:answer.claims.map(claim=>({...claim,citations:claim.citations.map(id=>{
  const cell=cells.get(id);if(!cell)throw Error("ANSWER_CITATION_INVALID");return {...cell};
 })}))});
}
