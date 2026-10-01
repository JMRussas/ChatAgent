import {createHash} from "node:crypto";
import {z} from "zod";
import {formatEvidenceAnswer} from "./answerReferences";
import {groundedAnswerSchema,type AnswerEvidencePacket} from "./retrievalAnswerContract";
const positive=z.number().int().positive();
export const referencesSchema=z.object({version:z.literal("answer-references-v1"),sources:z.array(z.object({id:positive,resultId:z.string(),title:z.string(),url:z.string().url(),observedAt:z.string().datetime(),revision:z.string()}).strict()),citations:z.array(z.object({id:positive,sourceId:positive,row:z.number().int().nonnegative(),columnIndex:z.number().int().nonnegative(),column:z.string(),value:z.string()}).strict())}).strict();
export const deliveredAnswerSchema=z.object({version:z.literal("delivered-answer-v1"),text:z.string(),references:referencesSchema}).strict();
const checkedSchema=z.object({answer:groundedAnswerSchema,evidenceLimitations:z.array(z.string()),citationChecks:z.enum(["passed","not_applicable"]),semanticGrounding:z.literal("ungraded")}).strict();
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v && typeof v==="object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
export const deliveryDigest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
/** Structural delivery verification. It does not decide whether a claim follows from a cell. */
export function validateDeliveredAnswer(value:unknown,checkedInput:unknown,packet?:AnswerEvidencePacket){
 const delivery=deliveredAnswerSchema.parse(value),checked=checkedSchema.parse(checkedInput),refs=delivery.references;
 if(new Set(refs.sources.map(s=>s.id)).size!==refs.sources.length || new Set(refs.sources.map(s=>s.resultId)).size!==refs.sources.length || new Set(refs.citations.map(c=>c.id)).size!==refs.citations.length)throw Error("DELIVERY_DUPLICATE_ID");
 const used=new Set<number>(),sources=new Set<number>();
 const answer=checked.answer;
 if(checked.citationChecks!==(answer.status==="answer" ? "passed":"not_applicable"))throw Error("DELIVERY_CHECK_MISMATCH");
 const body=answer.status==="insufficient_evidence" ? answer.reason : answer.claims.map(claim=>{
  const markers=claim.citations.map(c=>{
   const matches=refs.citations.filter(r=>r.row===c.row && r.columnIndex===c.column && refs.sources.find(s=>s.id===r.sourceId)?.resultId===c.resultId);
   if(matches.length!==1 || matches[0].value!==c.quote)throw Error("DELIVERY_CITATION_MISMATCH");
   used.add(matches[0].id);sources.add(matches[0].sourceId);return matches[0].id;
  });return claim.text+" ["+[...new Set(markers)].join(", ")+"]";
 }).join("\n\n");
 if(used.size!==refs.citations.length || sources.size!==refs.sources.length)throw Error("DELIVERY_ORPHAN_REFERENCE");
 const limitations=[...checked.evidenceLimitations,...(answer.status==="answer" ? answer.limitations:[])];
 const text=body+"\n\nLimitations: "+[...new Set(limitations)].join(" ")+"\n\nCitation checks: "+checked.citationChecks+". Factual quality: ungraded.";
 if(text!==delivery.text)throw Error("DELIVERY_TEXT_MISMATCH");
 if(packet){const expected=formatEvidenceAnswer(checked,packet);if(deliveryDigest({version:"delivered-answer-v1",...expected})!==deliveryDigest(delivery))throw Error("DELIVERY_EVIDENCE_MISMATCH");}
 return delivery;
}
