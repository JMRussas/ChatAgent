import { projectTurnEvent } from "../../src/app/protocolV1";
import { it, expect } from "vitest";
import { ToolResultStore } from "../../src/app/toolResult";
it("isolates immutable payload handles by owner, conversation and expiry", () => {
  let now=Date.parse("2026-09-30T00:00:00Z"); const store=new ToolResultStore(()=>now,1);
  const make=()=>store.put("u","c",{version:"tool-result-v1",context:{status:"ready",summary:"Ready",scope:"test",coverage:"complete",limitations:[],expiresAt:new Date(now+1000).toISOString()},payload:{kind:"table",title:"Test",columns:["Name"],rows:[["First"]]},evidence:{sourceUrl:"https://example.invalid",observedAt:new Date(now).toISOString(),revision:"v"}});
  const first=make(); first.payload!.rows[0][0]="changed";
  expect(store.get(first.context.resultId,"u","c").payload!.rows[0][0]).toBe("First");
  expect(()=>store.get(first.context.resultId,"other","c")).toThrow("RESULT_NOT_FOUND");
  expect(()=>store.get(first.context.resultId,"u","other")).toThrow("RESULT_NOT_FOUND");
  const second=make(); expect(()=>store.get(first.context.resultId,"u","c")).toThrow("RESULT_NOT_FOUND");
  now+=1000; expect(()=>store.get(second.context.resultId,"u","c")).toThrow("RESULT_EXPIRED");
  const third=make();store.clear();expect(()=>store.get(third.context.resultId,"u","c")).toThrow("RESULT_NOT_FOUND");
});

it("projects payloads into versioned API answer events", () => {
  const store = new ToolResultStore();
  const result = store.put("u","c",{version:"tool-result-v1",context:{status:"ready",summary:"Ready",scope:"test",coverage:"complete",limitations:[],expiresAt:new Date(Date.now()+60000).toISOString()},payload:{kind:"table",title:"Teams",columns:["Team"],rows:[["Example"]]},evidence:{sourceUrl:"https://example.invalid",observedAt:new Date().toISOString(),revision:"v"}});
  expect(projectTurnEvent("public-conversation",{type:"refined",phase:"deep",messageId:"m",sequence:1,text:"Ready",createdAtIso:new Date().toISOString(),payloadResults:[result]})?.payloadResults).toEqual([result]);
});
