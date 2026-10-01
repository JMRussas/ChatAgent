import {expect,it} from "vitest";
import {deliveryFixture} from "../helpers/deliveryFixture";
import {reviewEvidenceMapping} from "../../src/app/reviewEvidence";
import {formatEvidenceAnswer} from "../../src/app/answerReferences";
import type {ChatTimelineEvent} from "../../src/domain/types";
it("maps original markers across sources and reordered rows while marking partial review",()=>{
 const {packet,checked}=deliveryFixture();
 const first=packet.references[0];
 first.selectedRows=[4,2];first.rows=[["101"],["102"]];
 packet.references.push({...structuredClone(first),resultId:"other",selectedRows:[7],rows:[["103"]]});
 checked.answer={status:"answer",scope:"selected_rows",claims:[{text:"Three cells",citations:[{resultId:first.resultId,row:4,column:0,quote:"101"},{resultId:"other",row:7,column:0,quote:"103"},{resultId:first.resultId,row:2,column:0,quote:"102"},{resultId:first.resultId,row:4,column:0,quote:"101"}]}],limitations:[]};
 const target={type:"provisional",text:"",messageId:"m",createdAtIso:new Date().toISOString(),groundedAnswer:checked,answerReferences:formatEvidenceAnswer(checked,packet).references} as ChatTimelineEvent;
 const all=reviewEvidenceMapping(target,packet,16000);expect(all.markers.map(m=>m.marker)).toEqual([1,2,3]);expect(all.unreviewedMarkers).toEqual([]);
 const selected={...packet,references:[{...first,selectedRows:[2],rows:[["102"]]}]};
 const partial=reviewEvidenceMapping(target,selected,16000);expect(partial.markers.map(m=>m.marker)).toEqual([3]);expect(partial.unreviewedMarkers).toEqual([1,2]);
 expect(()=>reviewEvidenceMapping(target,{...packet,references:[{...first,resultId:"unrelated"}]},16000)).toThrow("REVIEW_EVIDENCE_MISMATCH");
 expect(()=>reviewEvidenceMapping(target,{...packet,references:[{...first,rows:[["changed"],["102"]]}]},16000)).toThrow("REVIEW_EVIDENCE_MISMATCH");
 expect(()=>reviewEvidenceMapping(target,packet,10)).toThrow("REVIEW_EVIDENCE_LIMIT");
});
