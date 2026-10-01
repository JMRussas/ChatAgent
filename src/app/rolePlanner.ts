import type {GenerationResult} from "../domain/generation";
export type RolePlannerEngine="native"|"langgraph";
export function rolePlannerEngine(value=process.env.ROLE_PLANNER_ENGINE ?? "native"):RolePlannerEngine{
 if(value!=="native" && value!=="langgraph")throw Error("ROLE_PLANNER_ENGINE_INVALID");return value;
}
/** Exactly one model operation and one validation. Tool execution remains application-owned. */
export async function runRolePlanner<T>(engine:RolePlannerEngine,invoke:()=>Promise<GenerationResult>,validate:(result:GenerationResult)=>T,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();
 if(engine === "native"){
  const result=await invoke();signal.throwIfAborted();return validate(result);
 }
 const {Annotation,StateGraph,START,END}=await import("@langchain/langgraph");
 signal.throwIfAborted();
 const state=Annotation.Root({generated:Annotation<GenerationResult>(),plan:Annotation<T>()});
 let modelWork:Promise<GenerationResult>|undefined;
 const graph=new StateGraph(state)
  .addNode("model",async()=>{signal.throwIfAborted();modelWork=invoke();const generated=await modelWork;signal.throwIfAborted();return {generated};})
  .addNode("validate",s=>{signal.throwIfAborted();return {plan:validate(s.generated)};})
  .addEdge(START,"model").addEdge("model","validate").addEdge("validate",END).compile();
 // No checkpointer, retry policy, model integration or extra tools are installed here.
 try{
  const result=await graph.invoke({}, {signal,recursionLimit:4});signal.throwIfAborted();return result.plan;
 }finally{
  // Graph cancellation can reject before a node's provider has settled. Retain
  // service ownership so shutdown/draining and admission do not finish early.
  if(modelWork)await Promise.allSettled([modelWork]);
 }
}
