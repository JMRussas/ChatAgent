import type {AnswerEvidencePacket,validateGroundedAnswer} from "./retrievalAnswerContract";
/** Display payload only. Sources and cited cells appear once, independent of claim count. */
export interface AnswerReferences {
 version:"answer-references-v1";
 sources:{id:number;resultId:string;title:string;url:string;observedAt:string;revision:string}[];
 citations:{id:number;sourceId:number;row:number;columnIndex?:number;column:string;value:string}[];
}
export function formatEvidenceAnswer(checked:ReturnType<typeof validateGroundedAnswer>,packet:AnswerEvidencePacket){
 const references:AnswerReferences={version:"answer-references-v1",sources:[],citations:[]};
 const sourceIds=new Map<string,number>(),cellIds=new Map<string,number>();
 const answer=checked.answer;
 const body=answer.status==="insufficient_evidence" ? answer.reason : answer.claims.map(claim=>{
  const markers=claim.citations.map(cite=>{
   const key=JSON.stringify([cite.resultId,cite.row,cite.column]);
   const existing=cellIds.get(key);if(existing)return existing;
   const ref=packet.references.find(r=>r.resultId===cite.resultId)!;
   let sourceId=sourceIds.get(cite.resultId);
   if(!sourceId){sourceId=references.sources.length+1;sourceIds.set(cite.resultId,sourceId);references.sources.push({id:sourceId,resultId:cite.resultId,title:ref.title,url:ref.evidence.sourceUrl,observedAt:ref.evidence.observedAt,revision:ref.evidence.revision});}
   const id=references.citations.length+1;cellIds.set(key,id);
   references.citations.push({id,sourceId,row:cite.row,columnIndex:cite.column,column:ref.columns[cite.column],value:cite.quote});return id;
  });
  return claim.text+" ["+[...new Set(markers)].join(", ")+"]";
 }).join("\n\n");
 const limitations=[...checked.evidenceLimitations,...(answer.status==="answer" ? answer.limitations : [])];
 return {text:body+"\n\nLimitations: "+[...new Set(limitations)].join(" ")+"\n\nCitation checks: "+checked.citationChecks+". Factual quality: ungraded.",references};
}
