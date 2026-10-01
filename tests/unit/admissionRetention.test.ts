import {afterEach,expect,it,vi} from "vitest";
import {ResourceAdmission} from "../../src/routing/resourceAdmission";
import {dispatchPolicySchema} from "../../src/config/dispatchConfig";
import {resources,evidence,now} from "../helpers/dispatchFixtures";
const request=(r=resources())=>({resources:r,inputTokens:100,outputTokens:50});
const limits={maxCompleted:2,completedTtlMs:10,maxMetrics:2};
const signal=()=>new AbortController().signal;
afterEach(()=>vi.useRealTimers());
it("compacts completed requests while retaining spend and quota after TTL",async()=>{
 let clock=0;
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({maxIncrementalUsd:3}),()=>Date.parse(now),limits,()=>clock);
 const r=resources({incremental:{currency:"USD",maxInvocationUsd:1,evidence},quota:{poolId:"shared",unit:"requests",remaining:3,evidence}});
 for(let i=0;i<3;i++){
  const [id]=ledger.reserve([request(r)]);await ledger.begin(id,signal());ledger.finish(id);
  ledger.finish(id,{usd:0,quotaUnits:0});ledger.release(id); // Repeated cleanup cannot refund or double-count.
 }
 expect(ledger.retentionStats()).toEqual({active:0,recent:2,computePools:0,quotaPools:1});
 clock=11;expect(ledger.snapshot()).toEqual([]);
 expect(ledger.accounting()).toMatchObject({completedUsd:3,unsettledCount:3,quotaPools:[{poolId:"shared",units:3}]});
 expect(()=>ledger.reserve([request(r)])).toThrow("SPEND_LIMIT");
 const zero=resources({quota:r.quota});
 expect(()=>ledger.reserve([request(zero)])).toThrow("QUOTA_EXHAUSTED");
 expect(()=>ledger.reserve([request(resources({quota:{...r.quota!,remaining:10}}))])).toThrow("QUOTA_SNAPSHOT_CONFLICT");
});
it("reported usage replaces estimates and unstarted releases consume nothing",async()=>{
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({maxIncrementalUsd:2}),()=>Date.parse(now),limits);
 const r=resources({incremental:{currency:"USD",maxInvocationUsd:1,evidence},quota:{poolId:"tokens",unit:"tokens",remaining:300,evidence}});
 for(let i=0;i<5;i++){const [id]=ledger.reserve([request(r)]);ledger.release(id);}
 const [a]=ledger.reserve([request(r)]);await ledger.begin(a,signal());ledger.finish(a,{usd:0.5,quotaUnits:25});
 const [b]=ledger.reserve([request(r)]);await ledger.begin(b,signal());ledger.finish(b);
 expect(ledger.accounting()).toMatchObject({completedUsd:1.5,reportedCount:1,unsettledCount:1,quotaPools:[{poolId:"tokens",units:175}]});
 expect(()=>ledger.reserve([request(r)])).toThrow("SPEND_LIMIT");
 expect(()=>ledger.reserve([request(resources({quota:r.quota}))])).toThrow("QUOTA_EXHAUSTED");
});
it("keeps live reservations through pressure and removes idle compute pool keys",async()=>{
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({}),()=>Date.parse(now),limits);
 const [held]=ledger.reserve([request(resources({compute:{poolId:"held",concurrency:1}}))]);await ledger.begin(held,signal());
 for(let i=0;i<100;i++){
  const [id]=ledger.reserve([request(resources({compute:{poolId:`pool-${i}`,concurrency:1}}))]);
  await ledger.begin(id,signal());ledger.finish(id);
 }
 expect(ledger.retentionStats()).toEqual({active:1,recent:2,computePools:1,quotaPools:0});
 expect(ledger.snapshot().find(c=>c.id===held)?.status).toBe("reserved");
 ledger.finish(held);expect(ledger.retentionStats().computePools).toBe(0);
});
it("rejects an atomic batch without changing completed accounting",async()=>{
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({maxIncrementalUsd:2}),()=>Date.parse(now),limits);
 const r=resources({incremental:{currency:"USD",maxInvocationUsd:1,evidence}});
 const [id]=ledger.reserve([request(r)]);await ledger.begin(id,signal());ledger.finish(id);
 const before=ledger.accounting();expect(()=>ledger.reserve([request(r),request(r)])).toThrow("SPEND_LIMIT");
 expect(ledger.accounting()).toEqual(before);expect(ledger.retentionStats().active).toBe(0);
});
it("does not revive a released reservation waiting for compute",async()=>{
 vi.useFakeTimers();
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({quotaExhaustionAction:"wait",waitTimeoutMs:100}),()=>Date.parse(now),limits);
 const r=resources({compute:{poolId:"gpu",concurrency:1}});
 const [a,b]=ledger.reserve([request(r),request(r)]);await ledger.begin(a,signal());
 const waiting=expect(ledger.begin(b,signal())).rejects.toThrow("INVALID_RESERVATION");
 ledger.release(b);ledger.finish(a);await vi.advanceTimersByTimeAsync(10);await waiting;
 expect(ledger.retentionStats().active).toBe(0);expect(ledger.accounting().unsettledCount).toBe(1);
});
it("records unknown cost explicitly without retaining full requests",async()=>{
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({maxIncrementalUsd:null,unknownCostAction:"allow-unpriced"}),()=>Date.parse(now),limits);
 const [id]=ledger.reserve([request({...resources(),incremental:undefined})]);await ledger.begin(id,signal());ledger.finish(id);
 expect(ledger.accounting()).toMatchObject({completedUsd:0,unpricedCount:1,unsettledCount:1});
 expect(ledger.retentionStats().active).toBe(0);
});

const priced=(cost:number)=>request(resources({incremental:{currency:"USD",maxInvocationUsd:cost,evidence}}));
it.each([[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]])("preserves exact spend through completion order %j",async(...order)=>{
 let clock=0;
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({maxIncrementalUsd:0.6}),()=>Date.parse(now),limits,()=>clock);
 const ids=ledger.reserve([priced(0.3),priced(0.2),priced(0.1)]);
 for(const i of order){await ledger.begin(ids[i],signal());ledger.finish(ids[i]);clock+=11;ledger.snapshot();}
 expect(ledger.accounting().completedUsd).toBe(0.6);
 expect(()=>ledger.reserve([priced(Number.MIN_VALUE)])).toThrow("SPEND_LIMIT");
 expect(()=>ledger.reserve([priced(0)])).not.toThrow();
});
it("accounts for fractional reports and cancellation without rounding or refunds",async()=>{
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({maxIncrementalUsd:0.6}),()=>Date.parse(now),limits);
 const [released]=ledger.reserve([priced(0.6)]);ledger.release(released);
 const [a,b]=ledger.reserve([priced(0.3),priced(0.3)]);
 await ledger.begin(a,signal());ledger.finish(a,{usd:0.1,quotaUnits:0});
 await ledger.begin(b,signal());ledger.release(b);ledger.finish(b,{usd:0.2,quotaUnits:0});
 expect(ledger.accounting().completedUsd).toBe(0.3);
 expect(()=>ledger.reserve([priced(0.2),priced(0.10000000000000002)])).toThrow("SPEND_LIMIT");
 expect(ledger.retentionStats().active).toBe(0);
 expect(()=>ledger.reserve([priced(0.3)])).not.toThrow();
});
it("does not lose fractional quota reports during compaction",async()=>{
 const ledger=new ResourceAdmission(dispatchPolicySchema.parse({}),()=>Date.parse(now),limits);
 const r=resources({quota:{poolId:"fractional",unit:"requests",remaining:1.3,evidence}});
 for(const units of [0.1,0.2]){const [id]=ledger.reserve([request(r)]);await ledger.begin(id,signal());ledger.finish(id,{usd:0,quotaUnits:units});}
 expect(ledger.accounting().quotaPools[0].units).toBe(0.3);
 expect(()=>ledger.reserve([request(r)])).not.toThrow();
});
