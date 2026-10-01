import {expect,it,vi} from "vitest";
import dataset from "../../data/evals/evidence-quality.v1.json";
import {runEvidenceComparison,gradeEvidenceComparison} from "../../src/eval/evidenceComparison";
it("keeps expected answers out of inference and requires independent hash-bound grades",async()=>{
 const generate=vi.fn(async()=>({text:JSON.stringify({status:"insufficient_evidence",reason:"Not enough evidence"}),finishReason:"stop" as const}));
 const report=await runEvidenceComparison(dataset,[{id:"fixture",thinking:"configured",provider:{createProvisionalReply:generate}}]);
 expect(generate).toHaveBeenCalledTimes(3);expect(report.records.every(r=>r.errorCode===null)).toBe(true);
 expect(JSON.stringify(generate.mock.calls)).not.toContain(dataset.cases[0].expected);
 expect(gradeEvidenceComparison(report,{judge:{id:"reviewer",kind:"human"},ratings:[]}).passed).toBe(false);
 const ratings=report.records.map(r=>({responseHash:r.responseHash,grade:r.caseId==="insufficient-recap" ? "pass":"fail",rationale:"Independent task completion assessment"}));
 expect(gradeEvidenceComparison(report,{judge:{id:"reviewer",kind:"human"},ratings}).passed).toBe(false);
 const tampered=structuredClone(report);tampered.records[0].prompt="different prompt";
 expect(()=>gradeEvidenceComparison(tampered,{judge:{id:"reviewer",kind:"human"},ratings})).toThrow("CASE_PLAN_MISMATCH");
});
it("validates all evidence before any model invocation",async()=>{
 const generate=vi.fn();const invalid=structuredClone(dataset);invalid.cases[2].selectedRows=[999];
 await expect(runEvidenceComparison(invalid,[{id:"fixture",thinking:"configured",provider:{createProvisionalReply:generate}}])).rejects.toThrow();expect(generate).not.toHaveBeenCalled();
});

it("rejects omitted, duplicated and unplanned records instead of grading a subset",async()=>{
 const provider={createProvisionalReply:async()=>({text:JSON.stringify({status:"insufficient_evidence",reason:"Not enough evidence"}),finishReason:"stop" as const})};
 const report=await runEvidenceComparison(dataset,[{id:"fixture",thinking:"configured",provider}]);
 const grades={judge:{id:"reviewer",kind:"human"},ratings:report.records.map(r=>({responseHash:r.responseHash,grade:"pass",rationale:"Reviewed"}))};
 expect(gradeEvidenceComparison(report,grades).passed).toBe(true);
 for(const records of [report.records.slice(1),[...report.records,report.records[0]],[{...report.records[0],caseId:"unknown"},...report.records.slice(1)]]){
  expect(()=>gradeEvidenceComparison({...report,records},grades)).toThrow("CASE_COVERAGE_MISMATCH");
 }
 expect(()=>gradeEvidenceComparison({...report,version:"evidence-comparison-v1"},grades)).toThrow();
 const tampered=structuredClone(report);tampered.records[0].generated!.text="changed";
 expect(()=>gradeEvidenceComparison(tampered,grades)).toThrow("RESPONSE_HASH_MISMATCH");
 expect(()=>gradeEvidenceComparison(report,{...grades,ratings:[grades.ratings[0],grades.ratings[0]]})).toThrow("DUPLICATE_GRADE");
});

it("rejects invalid condition IDs before provider calls",async()=>{
 const generate=vi.fn();
 await expect(runEvidenceComparison(dataset,[{id:" fixture ",thinking:"configured",provider:{createProvisionalReply:generate}}])).rejects.toThrow("surrounding whitespace");
 expect(generate).not.toHaveBeenCalled();
});
