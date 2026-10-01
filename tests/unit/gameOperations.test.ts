import {it,expect,vi} from "vitest";
import {GameOperations} from "../../src/sports/gameOperations";
import {TeamDirectory} from "../../src/sports/teamDirectory";
import {SportsRequestBudget} from "../../src/sports/sharedSources";
import type {SportsSource,SourceQuery,SourceResult} from "../../src/sports/sources";
const now=Date.parse("2026-09-30T00:00:00Z"),signal=()=>new AbortController().signal;
const team={provider:"balldontlie-nfl",id:"1",name:"Harbor Comets"};
const game={kind:"games" as const,id:"42",startsAt:"2026-09-28T00:00:00Z",status:"final" as const,home:team,away:{...team,id:"2",name:"Other"},score:{home:21,away:14},provenance:{sourceId:"games",url:"https://example.invalid/games/42",updatedAt:null}};
function setup(responses:Partial<SourceResult>[]=[{records:[game]}],options={}){
 let time=now;
 const directory=new TeamDirectory("key",new SportsRequestBudget(),{leagues:["NFL"]},"rev",(async()=>Response.json({data:[{id:1,full_name:team.name,name:"Comets",abbreviation:"HC"}]})) as typeof fetch,()=>time);
 let calls=0;const read=vi.fn(async(query:SourceQuery):Promise<SourceResult>=>({schemaVersion:"chatagent-sports-source-result-v1",mode:"live",query,source:{id:"games",url:"https://example.invalid/games",retrievedAt:new Date(time).toISOString(),dataAsOf:null},coverage:"partial",freshness:"unknown",limitations:[],errorCode:null,records:[],canAdvanceCheckpoint:false,...responses[Math.min(calls++,responses.length-1)]}));
 const ops=new GameOperations(directory,new Map<string,SportsSource>([["nfl-games",{read}]]),{leagues:["NFL"],...options},"rev",()=>time);
 return {ops,directory,read,advance:()=>{time+=400000;}};
}
it("resolves names and returns partial latest-found evidence without inserting rows in context",async()=>{
 const s=setup();const result=await s.ops.search({teamQuery:"Comets",selection:"latest_completed"},"u","c",signal());
 expect(result).toMatchObject({context:{status:"ready",coverage:"partial"},payload:{rows:[[game.startsAt,"Other",team.name,"final","14","21"]]}});
 expect(s.read.mock.calls[0][0].team).toEqual(team);
 expect(JSON.stringify('context' in result?result.context:{})).not.toContain('"21"');
 if(!('context' in result))throw Error();
 const details=s.ops.details({resultId:result.context.resultId,row:0},"u","c");
 expect(details.evidence.sourceUrl).toBe(game.provenance.url);expect(details.payload?.rows).toContainEqual(["Home score","21"]);
 expect(()=>s.ops.details({resultId:result.context.resultId,row:0},"u","foreign")).toThrow();
 s.advance();expect(()=>s.ops.details({resultId:result.context.resultId,row:0},"u","c")).toThrow("RESULT_EXPIRED");
});
it("bounds offseason search and never treats partial empty evidence as absence",async()=>{
 const s=setup([{records:[]}],{maxLatestWindows:2});
 const result=await s.ops.search({league:"NFL",teamQuery:"Comets",selection:"latest_completed"},"u","c",signal());
 expect(s.read).toHaveBeenCalledTimes(2);expect(result).toMatchObject({context:{coverage:"partial"},payload:{rows:[]}});
 expect(s.read.mock.calls[1][0].window.toExclusive).toBe(s.read.mock.calls[0][0].window.fromInclusive);
});
it("preserves unavailable status and stops further reads on source failure",async()=>{
 const s=setup([{coverage:"unavailable",errorCode:"RATE_LIMITED"}]);
 expect(await s.ops.search({league:"NFL",teamQuery:"Comets",selection:"latest_completed"},"u","c",signal())).toMatchObject({context:{status:"unavailable",coverage:"unavailable"},payload:null});
 expect(s.read).toHaveBeenCalledTimes(1);
});
it("supports date-window status filters and rejects invalid windows before I/O",async()=>{
 const s=setup([{records:[game,{...game,id:"43",status:"scheduled",score:null}]}]);
 const result=await s.ops.search({league:"NFL",from:"2026-09-27T00:00:00Z",to:"2026-09-30T00:00:00Z",status:"scheduled"},"u","c",signal());
 expect(result).toMatchObject({payload:{rows:[[game.startsAt,"Other",team.name,"scheduled","Unknown","Unknown"]]}});
 await expect(s.ops.search({league:"NFL",from:"2020-01-01T00:00:00Z",to:"2026-09-30T00:00:00Z"},"u","c",signal())).rejects.toThrow();expect(s.read).toHaveBeenCalledTimes(1);
 s.ops.close();await expect(s.ops.search({teamQuery:"Comets",selection:"latest_completed"},"u","c",signal())).rejects.toThrow("CAPABILITIES_CHANGED");
});

it("does not publish when closed while a source ignores cancellation",async()=>{
 const s=setup();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const response=s.read.getMockImplementation()!;
 s.read.mockImplementation(async query=>{await gate;return response(query);});
 const pending=s.ops.search({league:"NFL",from:"2026-09-27T00:00:00Z",to:"2026-09-30T00:00:00Z"},"u","c",signal());
 const rejected=expect(pending).rejects.toThrow();s.ops.close();release();await rejected;
});

it.each(["cancel", "close"])("rejects %s during team resolution before returning any result",async action=>{
 const s=setup(),controller=new AbortController();
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 vi.spyOn(s.directory,"lookup").mockImplementation(async()=>{await gate;return {status:"unavailable",requested:{query:"Comets"},reason:"cancelled"};});
 const pending=s.ops.search({teamQuery:"Comets",selection:"latest_completed"},"u","c",controller.signal);
 const rejected=expect(pending).rejects.toThrow();
 if(action === "cancel")controller.abort();else s.ops.close();
 release();await rejected;expect(s.read).not.toHaveBeenCalled();
});
it("limits unscoped team resolution to the sole configured game league",async()=>{
 const s=setup(),lookup=vi.spyOn(s.directory,"lookup");
 await s.ops.search({teamQuery:"Comets",selection:"latest_completed"},"u","c",signal());
 expect(lookup.mock.calls[0][0]).toEqual({query:"Comets",league:"NFL"});
});
it("preserves directory unavailability rather than asking for resolution",async()=>{
 const s=setup();vi.spyOn(s.directory,"lookup").mockResolvedValue({status:"unavailable",requested:{query:"Comets"},reason:"admission"});
 expect(await s.ops.search({teamQuery:"Comets",selection:"latest_completed"},"u","c",signal())).toMatchObject({status:"unavailable",resolution:{reason:"admission"}});
 expect(s.read).not.toHaveBeenCalled();
});
it("accepts maximum-length team names in snapshot details without losing names",async()=>{
 const home="H".repeat(200),away="A".repeat(200);
 const s=setup([{records:[{...game,home:{...team,name:home},away:{...game.away,name:away}}]}]);
 const result=await s.ops.search({league:"NFL",from:"2026-09-27T00:00:00Z",to:"2026-09-30T00:00:00Z"},"u","c",signal());
 if(!("context" in result))throw Error("Missing search result");
 const details=s.ops.details({resultId:result.context.resultId,row:0},"u","c");
 expect(details.payload?.rows).toContainEqual(["Home",home]);expect(details.payload?.rows).toContainEqual(["Away",away]);
});
