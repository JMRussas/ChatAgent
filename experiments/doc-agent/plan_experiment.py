"""Optional explicit-plan comparison. Runtime traces, not private reasoning, are evidence."""
import asyncio,json,time
from pydantic import BaseModel,ConfigDict,Field
from langchain_core.messages import SystemMessage,HumanMessage
from agent import run_agent,invoke_bounded,serialize

VERSION='observable-plan/1'
class Step(BaseModel):
    model_config=ConfigDict(extra='forbid')
    action:str=Field(min_length=1,max_length=120)
    expected_evidence:str=Field(min_length=1,max_length=120)
class Plan(BaseModel):
    model_config=ConfigDict(extra='forbid')
    steps:list[Step]=Field(min_length=1,max_length=4)

PLAN_PROMPT='''Produce a brief proposed work plan, not an answer or a reasoning transcript.
List only observable actions and the evidence each would obtain. Use 1 to 4 steps,
only as many as needed. Available tools are search_docs (bounded keyword search)
and read_doc (up to 40 lines from an indexed source). You have not read any sources.
Do not claim actions are completed or invent findings. Include a check for missing
or conflicting evidence where relevant. Return ONLY JSON matching the schema.'''

def parse_plan(text):
    def unique(pairs):
        d={}
        for k,v in pairs:
            if k in d:raise ValueError('duplicate key')
            d[k]=v
        return d
    return Plan.model_validate(json.loads(text,object_pairs_hook=unique)).model_dump()

def actual_actions(result):
    return [{k:e[k] for k in ('step','tool_call_id','name','arguments','result')} for e in result.get('events',[]) if e['type']=='tool_result']

async def run_condition(model,corpus,question,planned,*,total_calls=6,deadline=180,call_timeout=60):
    if total_calls<2 or deadline<=0:raise ValueError('Invalid experiment budget')
    start=time.monotonic();planning=[];plan=None
    if planned:
        messages=[SystemMessage(content=PLAN_PROMPT),HumanMessage(content=json.dumps({'question':question,'document_index':corpus.index()}))]
        schema=Plan.model_json_schema()
        planning.append({'type':'plan_request','messages':[serialize(m) for m in messages],'response_schema':schema})
        try:
            response=await invoke_bounded(model.bind(format=schema),messages,min(call_timeout,deadline))
            planning.append({'type':'plan_response','content':response.content,'usage':response.usage_metadata,'done_reason':response.response_metadata.get('done_reason'),'elapsed_seconds':time.monotonic()-start})
            if response.tool_calls or response.invalid_tool_calls or response.response_metadata.get('done_reason')=='length':raise ValueError('Invalid or truncated plan')
            plan=parse_plan(response.content)
        except asyncio.TimeoutError:
            return {'status':'plan_timeout','answer':None,'model_calls':1,'tool_calls':0,'planning_events':planning,'plan':None,'actual_actions':[],'elapsed_seconds':time.monotonic()-start}
        except (ValueError,TypeError) as e:
            return {'status':'invalid_plan','answer':None,'model_calls':1,'tool_calls':0,'planning_events':planning,'plan':None,'actual_actions':[],'error':str(e)[:300],'elapsed_seconds':time.monotonic()-start}
        except Exception as e:
            return {'status':'plan_model_error','answer':None,'model_calls':1,'tool_calls':0,'planning_events':planning,'plan':None,'actual_actions':[],'error':type(e).__name__,'elapsed_seconds':time.monotonic()-start}
    remaining=deadline-(time.monotonic()-start)
    if remaining<=0:return {'status':'deadline_exceeded','answer':None,'model_calls':int(planned),'tool_calls':0,'plan':plan,'planning_events':planning,'actual_actions':[],'elapsed_seconds':time.monotonic()-start}
    execution_question=question
    if plan:
        execution_question+='\nProposed work plan (not evidence; adapt if retrieved evidence requires it): '+json.dumps(plan,ensure_ascii=False)
    result=await run_agent(model,corpus,execution_question,max_model_calls=total_calls-int(planned),deadline_seconds=remaining,call_timeout=call_timeout)
    result.update(execution_model_calls=result['model_calls'],model_calls=result['model_calls']+int(planned),planning_events=planning,plan=plan,actual_actions=actual_actions(result),elapsed_seconds=time.monotonic()-start,total_model_call_budget=total_calls,total_deadline_seconds=deadline)
    return result
