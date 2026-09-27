"""Standalone local-only CLI; no dotenv loading, cloud credentials, or app changes."""
import argparse, asyncio, importlib.metadata, json, sys, datetime, hashlib
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request,urlopen
from agent import run_agent, PROMPT_VERSION
from retrieval import Corpus
from langchain_ollama import ChatOllama

ROOT=Path(__file__).resolve().parents[2]
CASES=[
 {'id':'restart','question':'Does restarting ChatRuntime preserve conversation context and queued work in the implemented Iris protocol slice? Distinguish the proposal from the implementation checkpoint.','expected_status':'answered','required_source':'iris-evidence'},
 {'id':'memory','question':'Does the implemented ContextManager wait for a new background summary before answering the current request? What happens to the original transcript?','expected_status':'answered','required_source':'memory-evidence'},
 {'id':'routing','question':'Does the model catalog currently enable automatic model dispatch, or is that still planned?','expected_status':'answered','required_source':'model-catalog'},
 {'id':'unknown','question':'What was the exact measured electricity cost in dollars of this assistant on September 1, 2026? If the documents do not establish it, say what evidence is missing.','expected_status':'insufficient_evidence','required_source':None},
]

def api(base,path,body=None):
    req=Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    with urlopen(req,timeout=10) as r: return json.load(r)

async def main():
    p=argparse.ArgumentParser(); p.add_argument('--model',default='gemma4:26b'); p.add_argument('--base-url',default='http://127.0.0.1:11434'); p.add_argument('--out',required=True); p.add_argument('--engine',choices=['loop','langgraph'],default='loop')
    group=p.add_mutually_exclusive_group(required=True); group.add_argument('--question'); group.add_argument('--eval',action='store_true'); group.add_argument('--compare-examples',action='store_true')
    a=p.parse_args(); u=urlsplit(a.base_url)
    runner=run_agent
    if a.engine=='langgraph':
        from graph_agent import run_graph_agent
        runner=run_graph_agent
    if u.scheme!='http' or u.hostname not in ('localhost','127.0.0.1','::1') or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
        raise SystemExit('This learning slice accepts only local loopback HTTP Ollama endpoints')
    base=a.base_url.rstrip('/'); out=Path(a.out)
    if out.exists() and any(out.iterdir()): raise SystemExit('Use a fresh empty output directory')
    out.mkdir(parents=True,exist_ok=True)
    inventory=api(base,'/api/tags'); entry=next((m for m in inventory['models'] if m['name']==a.model),None)
    if entry is None: raise SystemExit('Requested model is not installed; no automatic download')
    show=api(base,'/api/show',{'model':a.model})
    if 'tools' not in show.get('capabilities',[]): raise SystemExit('Installed metadata does not advertise tools')
    values=(show.get('thinking') or {}).get('values',[])
    if 'thinking' in show.get('capabilities',[]) and False not in values:
        raise SystemExit('This slice requires metadata-confirmed non-thinking mode')
    reasoning=False if False in values else None
    capacities=[v for k,v in show.get('model_info',{}).items() if k.endswith('.context_length') and isinstance(v,int)]
    if not capacities or min(capacities)<32768: raise SystemExit('This slice requires a metadata-confirmed context capacity of at least 32768')
    model=ChatOllama(model=a.model,base_url=base,temperature=0,seed=20260926,num_ctx=32768,num_predict=1024,reasoning=reasoning,keep_alive='2m',client_kwargs={'timeout':60})
    corpus=Corpus.load(ROOT)
    (out/'sources.json').write_text(json.dumps(corpus.snapshot(),indent=2),encoding='utf-8')
    versions={name:importlib.metadata.version(name) for name in ['langchain','langchain-core','langchain-ollama','ollama','pydantic','langgraph']}
    cases=CASES if a.eval else [{'id':'question','question':a.question}]
    if a.compare_examples:
        from comparison_cases import CASES as comparison_cases
        cases=[dict(case, id=case['id']+'-'+variant, pair_id=case['id'], with_examples=variant=='examples') for i,case in enumerate(comparison_cases) for variant in (('baseline','examples') if i%2==0 else ('examples','baseline'))]
    meta={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'python':sys.version,'versions':versions,'ollama_version':api(base,'/api/version'),'model':entry,'model_capabilities':show.get('capabilities'),'thinking_metadata':show.get('thinking'),'options':{'temperature':0,'seed':20260926,'num_ctx':32768,'num_predict':1024,'reasoning':reasoning},'prompt_version':PROMPT_VERSION,'engine':a.engine,'cases':cases,'source_snapshot_sha256':hashlib.sha256((out/'sources.json').read_bytes()).hexdigest(),'implementation_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')},'complete':False}
    (out/'metadata.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
    for case in cases:
        print('RUN '+case['id'],flush=True)
        result=await runner(model,corpus,case['question'],with_examples=case.get('with_examples',False))
        record={'case':case,**result}
        if a.eval or a.compare_examples:
            answer=result.get('answer') or {}; cited={c['source_id'] for c in answer.get('citations',[])}
            record['structural_eval']={'completed':result['status']=='completed','expected_answer_status':answer.get('status')==case['expected_status'],'required_source_read_and_cited':case['required_source'] is None or case['required_source'] in cited,'note':'Structural checks only; factual correctness requires reviewing answer against retrieved sources.'}
        (out/(case['id']+'.json')).write_text(json.dumps(record,indent=2,ensure_ascii=False),encoding='utf-8')
        print(json.dumps({'id':case['id'],'status':result['status'],'model_calls':result['model_calls'],'tool_calls':result['tool_calls'],'answer':result['answer'],'error':result['error']},ensure_ascii=True),flush=True)
    meta.update(complete=True,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat()); (out/'metadata.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
    print('DONE '+str(out),flush=True)

if __name__=='__main__': asyncio.run(main())
