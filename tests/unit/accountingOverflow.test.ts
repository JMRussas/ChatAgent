import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {decimalTelemetry,decimalUnits} from "../../src/routing/decimalAccounting";
import {ResourceAdmission} from "../../src/routing/resourceAdmission";
import {dispatchPolicySchema} from "../../src/config/dispatchConfig";
import {FileLatencyTelemetryStore,validateRoutingTelemetrySnapshot} from "../../src/telemetry/latencyTelemetryStore";
import {resources,evidence,now} from "../helpers/dispatchFixtures";
const exactDoubleMax="35953862697246314"+"0".repeat(292);
const snapshot=(accounting:unknown)=>({estimator:{priors:[],samples:[]},policy:{maxFastP95Ms:1000},dispatch:{attempts:[],reservations:[],accounting}});
it("exports overflowing spend and quota through JSON and persisted telemetry",async()=>{
 const policy=dispatchPolicySchema.parse({maxIncrementalUsd:null});
 const ledger=new ResourceAdmission(policy,()=>Date.parse(now));
 const r=resources({incremental:{currency:"USD",maxInvocationUsd:Number.MAX_VALUE,evidence},quota:{poolId:"shared",unit:"requests",remaining:Number.MAX_VALUE,evidence}});
 const ids=ledger.reserve([0,1].map(()=>({resources:r,inputTokens:1,outputTokens:1})));
 for(const id of ids){await ledger.begin(id,new AbortController().signal);ledger.finish(id,{usd:Number.MAX_VALUE,quotaUnits:Number.MAX_VALUE});}
 const accounting=ledger.accounting();
 expect(accounting).toMatchObject({completedUsd:null,completedUsdOverflow:true,completedUsdExact:exactDoubleMax,
  quotaPools:[{poolId:"shared",units:null,unitsOverflow:true,unitsExact:exactDoubleMax}]});
 const wire=JSON.parse(JSON.stringify(snapshot(accounting)));
 expect(validateRoutingTelemetrySnapshot(wire).dispatch?.accounting).toEqual(accounting);
 const dir=await mkdtemp(join(tmpdir(),"ledger-overflow-"));
 try{const store=new FileLatencyTelemetryStore(join(dir,"telemetry.json"));await store.save(wire);expect((await store.load())?.dispatch?.accounting).toEqual(accounting);}
 finally{await rm(dir,{recursive:true,force:true});}
 // Telemetry projection must not feed back into admission or clear consumption.
 policy.maxIncrementalUsd=Number.MAX_VALUE;
 expect(()=>ledger.reserve([{resources:r,inputTokens:1,outputTokens:1}])).toThrow("SPEND_LIMIT");
});
it("preserves normal and legacy telemetry and formats fractional overflow exactly",()=>{
 expect(decimalTelemetry(decimalUnits(0.3))).toEqual({value:0.3,overflow:false});
 expect(decimalTelemetry(decimalUnits(Number.MAX_VALUE)*2n+decimalUnits(0.1))).toEqual({value:null,overflow:true,exact:exactDoubleMax+".1"});
 const accounting={completedUsd:0.3,unsettledCount:1,reportedCount:0,unpricedCount:0,quotaPools:[{poolId:"p",units:0.2}]};
 expect(validateRoutingTelemetrySnapshot(snapshot(accounting)).dispatch?.accounting).toEqual(accounting);
 expect(validateRoutingTelemetrySnapshot({...snapshot(accounting),dispatch:{attempts:[],reservations:[]}}).dispatch?.accounting).toBeUndefined();
});
it.each([
 {completedUsd:null},
 {completedUsd:null,completedUsdOverflow:true},
 {completedUsd:null,completedUsdOverflow:true,completedUsdExact:"Infinity"},
 {completedUsd:null,completedUsdOverflow:true,completedUsdExact:"1"},
 {completedUsd:1,completedUsdOverflow:true,completedUsdExact:exactDoubleMax},
 {completedUsd:1,quotaPools:[{poolId:"p",units:null}]},
 {completedUsd:1,quotaPools:[{poolId:"p",units:null,unitsOverflow:true,unitsExact:"-1"}]}
])("rejects inconsistent overflow telemetry %j",fields=>{
 expect(()=>validateRoutingTelemetrySnapshot(snapshot({unsettledCount:0,reportedCount:0,unpricedCount:0,quotaPools:[],...fields}))).toThrow();
});
