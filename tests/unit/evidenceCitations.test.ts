import {expect,it} from "vitest";
import {ToolResultStore} from "../../src/app/toolResult";
import {prepareAnswerEvidence,retrievalAnswerPolicySchema} from "../../src/app/retrievalAnswerContract";
import {citationEvidenceView,resolveEvidenceCitations,evidenceCitationId} from "../../src/app/evidenceCitations";
function setup(){
 const store=new ToolResultStore();
 const result=store.put("u","c",{version:"tool-result-v1",context:{status:"ready",summary:"fixture",scope:"test",coverage:"partial",limitations:[],expiresAt:new Date(Date.now()+60000).toISOString()},payload:{kind:"table",title:"Test",columns:["value"],rows:[["PRIVATE"],["selected second"],["selected third"]]},evidence:{sourceUrl:"https://example.invalid",observedAt:new Date().toISOString(),revision:"test"}});
 const packet=prepareAnswerEvidence(store,[{resultId:result.context.resultId,rows:[2,1]}],"u","c",retrievalAnswerPolicySchema.parse({version:"retrieval-answer-v1"}),Date.now(),new AbortController().signal);
 return {packet,result};
}
it("maps copied handles to original cells despite reordered selection",()=>{
 const {packet,result}=setup(),view=citationEvidenceView(packet,16000);
 expect(JSON.stringify(view)).not.toContain("PRIVATE");expect(JSON.stringify(view)).not.toContain("selectedRows");
 const citations=view.references[0].rows.map(row=>row[0].citationId);
 expect(resolveEvidenceCitations({status:"answer",scope:"selected_rows",claims:[{text:"Claim",citations}],limitations:[]},packet)).toMatchObject({claims:[{citations:[{resultId:result.context.resultId,row:2,column:0,quote:"selected third"},{row:1,column:0,quote:"selected second"}]}]});
});
it("rejects unselected and foreign-result handles and bounds the expanded view",()=>{
 const {packet,result}=setup(),foreign=setup();
 for(const id of [evidenceCitationId(result.context.resultId,0,0),citationEvidenceView(foreign.packet,16000).references[0].rows[0][0].citationId]){
  expect(()=>resolveEvidenceCitations({status:"answer",scope:"selected_rows",claims:[{text:"Claim",citations:[id]}],limitations:[]},packet)).toThrow("ANSWER_CITATION_INVALID");
 }
 const size=Buffer.byteLength(JSON.stringify(citationEvidenceView(packet,16000)));
 expect(()=>citationEvidenceView(packet,size)).not.toThrow();
 expect(()=>citationEvidenceView(packet,size-1)).toThrow("ANSWER_EVIDENCE_LIMIT");
});
