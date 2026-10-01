/** Explicit local Ollama development evaluation. Never invoked by the test suite. */
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve,join} from "node:path";
import {execFileSync} from "node:child_process";
import {OllamaFastProvider} from "../providers/ollamaProviders";
import {runEvidenceComparison,gradeEvidenceComparison} from "./evidenceComparison";
const [command,...args]=process.argv.slice(2);
if(command==="grade"){
 const [reportPath,ratingsPath]=args;if(!reportPath || !ratingsPath || args.length!==2)throw Error("Usage: grade REPORT RATINGS");
 const report=JSON.parse(await readFile(reportPath,"utf8"));
 const graded=gradeEvidenceComparison(report,JSON.parse(await readFile(ratingsPath,"utf8")));
 await writeFile(reportPath+".graded.json",JSON.stringify(graded,null,2),{flag:"wx"});
 console.log(JSON.stringify(graded,null,2));if(!graded.passed)process.exitCode=1;
}else if(command==="run"){
 const [model,outputRoot]=args;if(!model || !outputRoot || args.length!==2)throw Error("Usage: run MODEL OUTPUT_DIRECTORY");
 const root=resolve(outputRoot);await mkdir(root,{recursive:false});
 const dataset=JSON.parse(await readFile("data/evals/evidence-quality.v1.json","utf8"));
 const manifest={codeRevision:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),dirty:!!execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim(),temperature:0,maxOutputTokens:2048,deadlineMs:60000,repetitions:1,engine:"native",admission:"isolated serial fixture run; production catalog quotas not exercised",usage:null,cost:null};
 const report=await runEvidenceComparison(dataset,["off","on"].map(thinking=>({id:model+":"+thinking,thinking:thinking as "on"|"off",provider:new OllamaFastProvider("http://localhost:11434",model,0,60000,2048)})),{onCase:(id,condition)=>console.log(condition+" / "+id)});

 await writeFile(join(root,"report.json"),JSON.stringify({...report,manifest},null,2),{flag:"wx"});
 await writeFile(join(root,"ratings-template.json"),JSON.stringify({judge:{id:"REPLACE_WITH_INDEPENDENT_REVIEWER",kind:"human"},ratings:report.records.map(r=>({responseHash:r.responseHash,grade:"ungraded",rationale:""}))},null,2),{flag:"wx"});
 console.log(JSON.stringify({root,cases:report.records.map(r=>({caseId:r.caseId,condition:r.condition,error:r.errorCode,semanticGrade:r.semanticGrade}))},null,2));
 if(report.records.some(r=>r.errorCode))process.exitCode=1;
}else throw Error("Usage: evidenceComparisonCli run MODEL OUTPUT_DIRECTORY | grade REPORT RATINGS");
