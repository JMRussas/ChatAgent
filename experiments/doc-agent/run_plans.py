"""Paired local-only pilot, counterbalanced condition order, shared six-call budget."""
import argparse,asyncio,datetime,hashlib,importlib.metadata,json
from pathlib import Path
from langchain_ollama import ChatOllama
from retrieval import Corpus
from run import ROOT,api,CASES
from plan_experiment import run_condition,VERSION

async def main():
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=False)
    base='http://127.0.0.1:11434';name='gemma4:26b'
    entry=next(m for m in api(base,'/api/tags')['models'] if m['name']==name)
    show=api(base,'/api/show',{'model':name})
    if 'tools' not in show.get('capabilities',[]) or False not in show.get('thinking',{}).get('values',[]):raise ValueError('Required tools/thinking-off metadata unavailable')
    options=dict(temperature=0,seed=20260928,num_ctx=32768,num_predict=1024,reasoning=False)
    corpus=Corpus.load(ROOT)
    (out/'sources.json').write_text(json.dumps(corpus.snapshot(),indent=2),encoding='utf-8')
    meta={'version':VERSION,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'model':entry,'ollama_version':api(base,'/api/version'),'options':options,'versions':{k:importlib.metadata.version(k) for k in ['langchain-core','langchain-ollama','pydantic']},'cases':CASES,'budget':{'total_model_calls':6,'tool_calls':8,'deadline_seconds':180,'planning_uses_one_call':True},'hashes':{f:hashlib.sha256((Path(__file__).parent/f).read_bytes()).hexdigest() for f in ['agent.py','retrieval.py','plan_experiment.py','run_plans.py']},'complete':False}
    (out/'metadata.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
    model=ChatOllama(model=name,base_url=base,**options,keep_alive='2m',client_kwargs={'timeout':60})
    for i,case in enumerate(CASES):
        for planned in ([False,True] if i%2==0 else [True,False]):
            label=case['id']+('-plan' if planned else '-baseline');print('RUN '+label,flush=True)
            result=await run_condition(model,corpus,case['question'],planned)
            answer=result.get('answer') or {};cited={c['source_id'] for c in answer.get('citations',[])}
            result.update(case=case,condition='plan' if planned else 'baseline',structural_eval={'completed':result['status']=='completed','expected_status':answer.get('status')==case['expected_status'],'required_source':case['required_source'] is None or case['required_source'] in cited})
            (out/(label+'.json')).write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8')
            print(json.dumps({'case':label,'status':result['status'],'calls':result['model_calls'],'answer':result.get('answer')}),flush=True)
    meta['complete']=True;(out/'metadata.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
if __name__=='__main__':asyncio.run(main())
