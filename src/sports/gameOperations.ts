import { candidateSelectionSchema } from "./operationContracts";
import { z } from "zod";
import type { CapabilityTool } from "../app/capabilityChat";
import type { TeamDirectory } from "./teamDirectory";
import type { SportsSource, SportsRecord } from "./sources";
export const gameOperationsOptionsSchema=z.object({
 leagues:z.array(z.enum(["NBA","NFL"])).min(1).max(2).default(["NBA","NFL"]).refine(v=>new Set(v).size===v.length),
 latestWindowDays:z.number().int().min(1).max(31).default(14),
 maxLatestWindows:z.number().int().min(1).max(5).default(3),
 resultTtlMs:z.number().int().min(1000).max(3600000).default(300000),
 maxSnapshots:z.number().int().min(1).max(1000).default(100),
 maxResults:z.number().int().min(1).max(100).default(50)
}).strict();
export const gameSearchSchema=z.object({league:z.enum(["NBA","NFL"]).optional(),teamQuery:z.string().trim().min(1).max(200).optional(),teamSelection:candidateSelectionSchema.optional(),
 selection:z.enum(["all","latest_completed"]).default("all"),from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional(),
 status:z.enum(["any","scheduled","live","final","postponed","cancelled"]).default("any")
}).strict().superRefine((v,c)=>{
 if(v.selection === "all" && (!v.from || !v.to || Date.parse(v.from)>=Date.parse(v.to) || Date.parse(v.to)-Date.parse(v.from)>31*86400000))c.addIssue({code:"custom",message:"Search requires an explicit positive window of at most 31 days"});
 if(v.selection === "latest_completed" && (!(v.teamQuery || v.teamSelection) || v.from || v.to || !["any","final"].includes(v.status)))c.addIssue({code:"custom",message:"Latest completed requires a team name, no date overrides, and final/any status"});
 if(v.teamQuery && v.teamSelection)c.addIssue({code:"custom",message:"Use a name or an issued selection, not both"});
 if(!v.league && !v.teamQuery && !v.teamSelection)c.addIssue({code:"custom",message:"Provide league or team name"});
});
type Game=Extract<SportsRecord,{kind:"games"}>;
const detailSchema=z.object({resultId:z.string().uuid(),row:z.number().int().min(0).max(99)}).strict();
/** Bounded searches over existing shared sources; details refer to issued evidence snapshots. */
export class GameOperations {
 private closed=false;
 private shutdown=new AbortController();
 private games=new Map<string,{records:Game[];expires:number}>();
 private config:z.infer<typeof gameOperationsOptionsSchema>;
 constructor(private directory:TeamDirectory,private sources:ReadonlyMap<string,SportsSource>,options:unknown,private revision:string,private clock=Date.now){this.config=gameOperationsOptionsSchema.parse(options);}
 leagues(){return [...this.config.leagues];}
 close(){this.closed=true;this.shutdown.abort();this.games.clear();}
 async search(input:unknown,userId:string,conversationId:string,signal:AbortSignal){
  const args=gameSearchSchema.parse(input);if(this.closed)throw Error("CAPABILITIES_CHANGED");
  const combined=AbortSignal.any([signal,this.shutdown.signal]);combined.throwIfAborted();
  let league=args.league,team=null;
  if(league && !this.config.leagues.includes(league))return {status:"unsupported",missingCapability:`${league} game search`};
  if(args.teamSelection){
   const candidate=this.directory.select(args.teamSelection,userId,conversationId);
   if(league && candidate.scope.league!==league)throw Error("TEAM_SCOPE_MISMATCH");
   league=z.enum(["NBA","NFL"]).parse(candidate.scope.league);team=candidate.team;
  }
  if(args.teamQuery){
   const resolution=await this.directory.lookup({query:args.teamQuery,...(league?{league}:{})},userId,conversationId,combined);
   if(resolution.status!=="matched")return {status:"needs_resolution",resolution};
   const candidate=resolution.snapshot.candidates[0];league=z.enum(["NBA","NFL"]).parse(candidate.scope.league);team=candidate.team;
  }
  if(!league || !this.config.leagues.includes(league))return {status:"unsupported",missingCapability:"game search for resolved league"};
  const source=this.sources.get(league.toLowerCase()+"-games");if(!source)throw Error("GAME_SOURCE_UNAVAILABLE");
  const now=this.clock(),end=args.to ? Date.parse(args.to):now;
  const windows=args.selection === "latest_completed" ? this.config.maxLatestWindows:1;
  const records:Game[]=[],limitations=new Set<string>(["Provider data freshness is unknown","Details reflect retrieved records; no play-by-play or recap"]);
  let reads=0,successfulReads=0,observedAt=new Date(now).toISOString(),sourceUrl="https://api.balldontlie.io/",lower=end,stopReason="window_limit";
  for(let i=0;i<windows;i++){
   combined.throwIfAborted();
   const to=end-i*this.config.latestWindowDays*86400000;
   const from=args.from ? Date.parse(args.from):to-this.config.latestWindowDays*86400000;lower=from;
   try{
    reads++;
    const result=await source.read({league,kind:"games",team,window:{fromInclusive:new Date(from).toISOString(),toExclusive:new Date(to).toISOString()},now:new Date(now).toISOString(),limit:100,maxAgeMs:60000},combined);
    observedAt=result.source.retrievedAt;sourceUrl=result.source.url;
    for(const limitation of result.limitations)limitations.add(limitation);
    if(result.errorCode || result.coverage === "unavailable"){limitations.add(result.errorCode ?? "SOURCE_UNAVAILABLE");stopReason="source_unavailable";break;}
    successfulReads++;
    for(const record of result.records)if(record.kind === "games" && (args.selection === "latest_completed" ? record.status === "final" && record.score !== null : args.status === "any" || record.status === args.status))records.push(record);
    if(args.selection === "latest_completed" && records.length){stopReason="candidate_found";break;}
   }catch{combined.throwIfAborted();limitations.add("Source read or shared admission unavailable");stopReason="source_unavailable";break;}
  }
  combined.throwIfAborted();if(this.closed)throw Error("CAPABILITIES_CHANGED");
  const sorted=[...new Map(records.map(r=>[r.id,r])).values()].sort((a,b)=>b.startsAt.localeCompare(a.startsAt)||a.id.localeCompare(b.id));
  const selected=sorted.slice(0,args.selection === "latest_completed" ? 1:this.config.maxResults);
  if(sorted.length>selected.length && args.selection === "all")limitations.add("RESULT_LIMIT");
  limitations.add("Search coverage is partial; empty results do not establish absence");
  if(args.selection === "latest_completed")limitations.add("Most recent final found by start time; latest completion is not confirmed");
  const expires=this.clock()+this.config.resultTtlMs;
  const result=this.directory.results.put(userId,conversationId,{version:"tool-result-v1",context:{status:successfulReads?"ready":"unavailable",summary:`${selected.length} ${league} game records prepared. ${reads} bounded source reads; stop: ${stopReason}.`,scope:`${league} games starting ${new Date(lower).toISOString()} to ${new Date(end).toISOString()}${team?"; "+team.name:""}`,coverage:successfulReads?"partial":"unavailable",limitations:[...limitations].slice(0,20),expiresAt:new Date(expires).toISOString()},
   payload:successfulReads?{kind:"table",title:`${league} games${args.selection === "latest_completed"?" — most recent completed found":""}`,columns:["Start (UTC)","Away","Home","Status","Away score","Home score"],rows:selected.map(r=>[r.startsAt,r.away.name,r.home.name,r.status,r.score?String(r.score.away):"Unknown",r.score?String(r.score.home):"Unknown"])}:null,
   evidence:{sourceUrl,observedAt,revision:this.revision}});
  for(const [id,r] of this.games)if(r.expires<=this.clock())this.games.delete(id);
  if(this.games.size>=this.config.maxSnapshots)this.games.delete(this.games.keys().next().value!);
  this.games.set(result.context.resultId,{records:structuredClone(selected),expires});return result;
 }
 details(input:unknown,userId:string,conversationId:string){
  if(this.closed)throw Error("CAPABILITIES_CHANGED");const {resultId,row}=detailSchema.parse(input);
  const parent=this.directory.results.get(resultId,userId,conversationId),record=this.games.get(resultId)?.records[row];
  if(!record)throw Error("GAME_REFERENCE_UNAVAILABLE");
  return this.directory.results.put(userId,conversationId,{version:"tool-result-v1",context:{...parent.context,summary:"Selected game record prepared from the retrieved snapshot. No fresh lookup was performed."},payload:{kind:"table",title:`${record.away.name} at ${record.home.name}`,columns:["Field","Value"],rows:[["Start (UTC)",record.startsAt],["Status",record.status],["Away",record.away.name],["Home",record.home.name],["Away score",record.score?String(record.score.away):"Unknown"],["Home score",record.score?String(record.score.home):"Unknown"]]},evidence:{...parent.evidence,sourceUrl:record.provenance.url}});
 }
 tools():CapabilityTool[]{return [
  {id:"sports:find-games",description:`Search games for ${this.config.leagues.join(", ")}. Accepts team names, not provider IDs. For a specific matchup/date use explicit ISO from/to (maximum 31 days); status optionally filters. latest_completed resolves a team and searches up to ${this.config.maxLatestWindows} windows of ${this.config.latestWindowDays} days backwards from now. Coverage is partial; latest is not guaranteed. Returns a user table; rows are outside model context.`,inputSchema:{type:"object",additionalProperties:false,properties:{league:{type:"string",enum:this.config.leagues},teamQuery:{type:"string"},teamSelection:{type:"object",additionalProperties:false,required:["snapshotId","candidateId"],properties:{snapshotId:{type:"string"},candidateId:{type:"string"}}},selection:{enum:["all","latest_completed"]},from:{type:"string"},to:{type:"string"},status:{enum:["any","scheduled","live","final","postponed","cancelled"]}}},validate:v=>gameSearchSchema.parse(v),execute:async(v,u,_r,s,c)=>{if(!c)throw Error("CONVERSATION_REQUIRED");return this.search(v,u,c,s);}},
  {id:"sports:game-details",description:"Display a specific game's basic record from an issued game-search result. Supply its resultId and zero-based row. Snapshot only; no fresh lookup, statistics or play-by-play. Never guess row identity: use an explicitly user-selected row.",inputSchema:{type:"object",additionalProperties:false,required:["resultId","row"],properties:{resultId:{type:"string"},row:{type:"integer",minimum:0,maximum:99}}},validate:v=>detailSchema.parse(v),execute:async(v,u,_r,s,c)=>{s.throwIfAborted();if(!c)throw Error("CONVERSATION_REQUIRED");return this.details(v,u,c);}}
 ];}
}
