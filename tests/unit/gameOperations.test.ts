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
