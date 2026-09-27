"""Explicit LangGraph workflow with optional checkpoint-backed pause/resume."""
import asyncio
import json
import time
from typing import TypedDict
from agent import (AIMessage, HumanMessage, SystemMessage, ToolMessage, Answer,
                   PROMPT_VERSION, EXAMPLES, EXAMPLES_VERSION, make_tools,
                   prompt, serialize, validate_answer, convert_to_openai_tool, invoke_bounded)
from retrieval import Retrieval, Corpus, Source
from langgraph.graph import StateGraph, START, END


class AgentState(TypedDict):
    messages: list
    events: list
    seen: set[str]
    attempts: int
    finalizing: bool
    force_final: bool
    retrieval_reminded: bool
    response: AIMessage | None
    route: str
    result: dict | None
    node_trace: list[str]
    retrieval_state: dict
    source_snapshot: list
    started_at: float
    active_elapsed_seconds: float


def enter(state, node):
    # Default graph reducers replace values. Return new containers instead of
    # mutating the previous node's lists. Nodes execute sequentially in this slice.
    return {**state, 'messages':list(state['messages']), 'events':list(state['events']),
            'seen':set(state['seen']), 'node_trace':[*state['node_trace'], node]}


async def run_graph_agent(model, corpus, question, *, max_model_calls=6,
                          max_tool_calls=8, max_retrieval_bytes=10000,
                          max_input_bytes=28000, deadline_seconds=180,
                          call_timeout=60, with_examples=False, checkpointer=None,
                          thread_id=None, resume=False, pause_before_retrieval=False,
                          deadline_mode="wall"):
    if deadline_mode not in ("wall", "active"): raise ValueError("Unknown deadline mode")
    if not 1<=len(question.strip().encode())<=2000:
        raise ValueError('Question must contain 1..2000 UTF-8 bytes')
    # Rebuild invocation-local tools from checkpointed retrieval state at each node.
    retrieval=Retrieval(corpus,max_tool_calls,max_retrieval_bytes)
    tools=make_tools(retrieval)
    schemas=[convert_to_openai_tool(t) for t in tools]
    bound=model.bind_tools(tools)
    start=time.monotonic()
    config={'recursion_limit':max(4,3*max_model_calls+2)}
    if thread_id: config['configurable']={'thread_id':thread_id}
    saved=None
    if resume:
        checkpoint=await checkpointer.aget_tuple(config)
        if checkpoint is None: raise ValueError('No checkpoint to resume')
        saved=checkpoint.checkpoint['channel_values']
        if saved['source_snapshot'] != corpus.snapshot():
            raise ValueError('Checkpoint source snapshot differs from task manifest')
        retrieval.corpus=Corpus([Source(**v) for v in saved['source_snapshot']])
    started_at=saved['started_at'] if saved else time.time()

    active_before=saved.get("active_elapsed_seconds",0.0) if saved else 0.0

    def elapsed():
        if deadline_mode=="active": return active_before+time.monotonic()-start
        return time.time()-started_at if checkpointer is not None else time.monotonic()-start

    def restore(state,node):
        s=enter(state,node)
        r=s['retrieval_state']
        retrieval.calls=r['calls']; retrieval.bytes=r['bytes']; retrieval.reads=list(r['reads'])
        return s

    def persist_retrieval(s):
        s['retrieval_state']={'calls':retrieval.calls,'bytes':retrieval.bytes,'reads':list(retrieval.reads)}
        return s

    def finish(s,status,answer=None,error=None):
        persist_retrieval(s)
        s['route']='end'
        s['result']={'status':status,'answer':answer,'error':error,
            'prompt_version':PROMPT_VERSION,
            'examples_version':EXAMPLES_VERSION if with_examples else None,
            'events':s['events'],'model_calls':s['attempts'],
            'tool_calls':retrieval.calls,'retrieval_bytes':retrieval.bytes,
            'elapsed_seconds':elapsed(),
            **({'deadline_mode':'active'} if deadline_mode=='active' else {}),
            'limits':{'model_calls':max_model_calls,'tool_calls':max_tool_calls,
                      'retrieval_bytes':max_retrieval_bytes,'input_bytes':max_input_bytes,
                      'deadline_seconds':deadline_seconds},
            'citation_validation':'resolves host-issued IDs to retrieved ranges; does not certify semantic entailment'}
        return s

    async def model_node(state):
        s=restore(state,'model')
        step=s['attempts']
        if step>=max_model_calls: return finish(s,'model_call_limit')
        remaining=deadline_seconds-(elapsed())
        if remaining<=0: return finish(s,'deadline_exceeded')
        s['finalizing']=s['force_final'] or step==max_model_calls-1 or retrieval.calls>=max_tool_calls
        if s['finalizing']:
            s['messages'].append(HumanMessage(content='Retrieval is now closed. Return the requested final JSON using evidence already read. If evidence is insufficient, report insufficient_evidence. Do not request tools.'))
        final_schema=Answer.model_json_schema() if s['finalizing'] else None
        if final_schema is not None:
            ids=[r['evidence_id'] for r in retrieval.reads]
            if ids: final_schema['properties']['citations']['items']={'type':'string','enum':ids}
            else: final_schema['properties']['citations']['maxItems']=0
        active_schemas=[] if s['finalizing'] else schemas
        rendered=[serialize(m) for m in s['messages']]
        size=len(json.dumps({'messages':rendered,'tools':active_schemas,'response_schema':final_schema},ensure_ascii=False).encode())
        if size>max_input_bytes: return finish(s,'context_limit')
        s['attempts']+=1
        t=time.monotonic()
        s['events'].append({'type':'model_request','step':step,'messages':rendered,'tool_schemas':active_schemas,'response_schema':final_schema,'estimated_input_bytes':size})
        try:
            response=await invoke_bounded(model.bind(format=final_schema) if s['finalizing'] else bound,s['messages'],min(call_timeout,remaining))
        except asyncio.TimeoutError: return finish(s,'deadline_exceeded')
        except Exception as exc: return finish(s,'model_error',error=type(exc).__name__)
        metadata={k:v for k,v in response.response_metadata.items() if k in ('model','done','done_reason','total_duration','load_duration','prompt_eval_count','prompt_eval_duration','eval_count','eval_duration')}
        clean=AIMessage(content=response.content,tool_calls=response.tool_calls)
        s['events'].append({'type':'model_response','step':step,'message':serialize(clean),'usage':response.usage_metadata,'metadata':metadata,'wall_seconds':time.monotonic()-t})
        if metadata.get('done_reason')=='length': return finish(s,'incomplete')
        if response.invalid_tool_calls: return finish(s,'invalid_tool_call')
        s['response']=clean
        s['route']='validate'
        return s

    async def validate_node(state):
        s=restore(state,'validate')
        clean=s['response']; step=s['attempts']-1
        if clean.tool_calls:
            if s['finalizing']: return finish(s,'model_call_limit')
            if len(clean.tool_calls)>max_tool_calls-retrieval.calls: return finish(s,'tool_limit')
            s['messages'].append(clean)
            s['route']='retrieve'
            return s
        if retrieval.calls==0:
            if not s['retrieval_reminded'] and not s['finalizing']:
                s['retrieval_reminded']=True
                s['events'].append({'type':'retrieval_required','step':step})
                s['messages'].append(HumanMessage(content='No source has been searched or read yet. Use search_docs or read_doc before making claims about the documents, including claims that evidence is absent.'))
                s['route']='model'
                return s
            return finish(s,'unverified_answer',error='No retrieval attempted')
        answer,error=validate_answer(clean.content,retrieval)
        if not answer and not s['finalizing'] and step<max_model_calls-1:
            s['events'].append({'type':'draft_rejected','step':step,'error':error,'action':'one bounded schema-constrained final synthesis'})
            s['force_final']=True
            s['route']='model'
            return s
        return finish(s,'completed' if answer else 'invalid_answer',answer,error)

    async def retrieve_node(state):
        s=restore(state,'retrieve'); step=s['attempts']-1
        for call in s['response'].tool_calls:
            if elapsed()>=deadline_seconds: return finish(s,'deadline_exceeded')
            name=call['name']; args=call['args']; signature=json.dumps([name,args],sort_keys=True)
            if signature in s['seen']: return finish(s,'repeated_tool_call')
            s['seen'].add(signature)
            if name not in ('search_docs','read_doc'): return finish(s,'invalid_tool_call',error='Unknown tool')
            target=next(t for t in tools if t.name==name); t=time.monotonic(); before=retrieval.calls
            try: result=target.invoke(args)
            except (ValueError,TypeError):
                if retrieval.calls==before: retrieval.calls+=1
                result={'error':'invalid_arguments','constraints':target.args_schema.model_json_schema()}
            s['events'].append({'type':'tool_result','step':step,'tool_call_id':call['id'],'name':name,'arguments':args,'result':result,'wall_seconds':time.monotonic()-t})
            s['messages'].append(ToolMessage(content=json.dumps(result,ensure_ascii=False),tool_call_id=call['id'],name=name))
        s['route']='model'
        return persist_retrieval(s)

    def tracked(node):
        async def execute(state):
            result=await node(state)
            result['active_elapsed_seconds']=active_before+time.monotonic()-start
            return result
        return execute

    graph=StateGraph(AgentState)
    graph.add_node('model',tracked(model_node))
    graph.add_node('validate',tracked(validate_node))
    graph.add_node('retrieve',tracked(retrieve_node))
    graph.add_edge(START,'model')
    graph.add_conditional_edges('model',lambda s:s['route'],{'validate':'validate','end':END})
    graph.add_conditional_edges('validate',lambda s:s['route'],{'model':'model','retrieve':'retrieve','end':END})
    graph.add_conditional_edges('retrieve',lambda s:s['route'],{'model':'model','end':END})
    compiled=graph.compile(checkpointer=checkpointer,interrupt_before=['retrieve'] if pause_before_retrieval else None)
    initial={'messages':[SystemMessage(content=prompt(max_model_calls,max_tool_calls)+(EXAMPLES if with_examples else '')),HumanMessage(content=json.dumps({'question':question,'document_index':corpus.index()}))],
             'events':[],'seen':set(),'attempts':0,'finalizing':False,'force_final':False,
             'retrieval_reminded':False,'response':None,'route':'model','result':None,'node_trace':[],
             'retrieval_state':{'calls':0,'bytes':0,'reads':[]},
             'source_snapshot':corpus.snapshot(),'started_at':started_at,'active_elapsed_seconds':0.0}
    # Graph super-steps are not model calls. The application budget is authoritative.
    final=await compiled.ainvoke(None if resume else initial,config=config,**({'durability':'sync'} if checkpointer is not None else {}))
    if final.get('result') is None:
        snapshot=await compiled.aget_state(config)
        return {'status':'paused','engine':'langgraph','deadline_mode':deadline_mode,
                'elapsed_seconds':elapsed(),'next':list(snapshot.next),
                'model_calls':final['attempts'],'tool_calls':final['retrieval_state']['calls'],
                'retrieval_bytes':final['retrieval_state']['bytes'],'node_trace':final['node_trace']}
    return {**final['result'],'engine':'langgraph','node_trace':final['node_trace']}
