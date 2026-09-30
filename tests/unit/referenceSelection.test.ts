import {it,expect} from "vitest";
import {ToolResultStore} from "../../src/app/toolResult";
import {selectReferences} from "../../src/app/referenceSelection";
it("selects only bounded owned rows and rejects expired, foreign and invalid selections",()=>{
 let now=Date.now();const store=new ToolResultStore(()=>now);
 const result=store.put("u","c",{version:"tool-result-v1",context:{status:"ready",summary:"ready",scope:"test",coverage:"complete",limitations:[],expiresAt:new Date(now+1000).toISOString()},payload:{kind:"table",title:"Test",columns:["Team"],rows:[["SELECTED"],["NOT_SELECTED"]]},evidence:{sourceUrl:"https://example.invalid",observedAt:new Date(now).toISOString(),revision:"v"}});
 const selection=[{resultId:result.context.resultId,rows:[0]}];
 expect(JSON.stringify(selectReferences(store,selection,"u","c"))).not.toContain("NOT_SELECTED");
 expect(()=>selectReferences(store,selection,"u","other")).toThrow();
 expect(()=>selectReferences(store,[{...selection[0],rows:[4]}],"u","c")).toThrow();
 expect(()=>selectReferences(store,[{...selection[0],rows:[0,0]}],"u","c")).toThrow();
 now+=1000;expect(()=>selectReferences(store,selection,"u","c")).toThrow("RESULT_EXPIRED");
});
