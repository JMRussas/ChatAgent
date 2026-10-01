import {expect,it} from "vitest";
import {deliveryFixture} from "../helpers/deliveryFixture";
import {deliveryDigest,validateDeliveredAnswer} from "../../src/app/deliveredAnswer";
it("validates issued markers while retaining arbitrary bracketed prose",()=>{
 const {packet,checked,delivery}=deliveryFixture();expect(validateDeliveredAnswer(delivery,checked,packet).text).toContain("[77]");
});
it.each(["missing","duplicate","source","value","marker","column","url"])("rejects broken delivery: %s",kind=>{
 const {packet,checked,delivery}=deliveryFixture();
 switch(kind){case "missing":delivery.references.citations=[];break;case "duplicate":delivery.references.citations.push(delivery.references.citations[0]);break;case "source":delivery.references.citations[0].sourceId=999;break;case "value":delivery.references.citations[0].value="999";break;case "marker":delivery.text=delivery.text.replace(" [1]"," [2]");break;case "column":delivery.references.citations[0].column="Wrong";break;case "url":delivery.references.sources[0].url="https://example.invalid/other";break;}
 expect(()=>validateDeliveredAnswer(delivery,checked,packet)).toThrow();
});
it("binds references independently of object key order",()=>{
 const {delivery}=deliveryFixture();const before=deliveryDigest(delivery);
 expect(deliveryDigest({references:delivery.references,text:delivery.text,version:delivery.version})).toBe(before);
 delivery.references.sources[0].url="https://example.invalid/changed";expect(deliveryDigest(delivery)).not.toBe(before);
});
it("accepts insufficient-evidence delivery only with empty references",()=>{
 const {packet}=deliveryFixture();
 const checked={answer:{status:"insufficient_evidence" as const,reason:"No score available"},evidenceLimitations:["Selected rows only"],citationChecks:"not_applicable" as const,semanticGrounding:"ungraded" as const};
 const delivery={version:"delivered-answer-v1",text:"No score available\n\nLimitations: Selected rows only\n\nCitation checks: not_applicable. Factual quality: ungraded.",references:{version:"answer-references-v1",sources:[],citations:[]}};
 expect(validateDeliveredAnswer(delivery,checked,packet)).toEqual(delivery);
 expect(()=>validateDeliveredAnswer({...delivery,references:deliveryFixture().delivery.references},checked,packet)).toThrow("DELIVERY_ORPHAN_REFERENCE");
});
