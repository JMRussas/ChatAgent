"""Run the frozen contract experiment, reusing the first pilot's API transport only."""
import argparse, dataclasses, datetime, hashlib, importlib.util, json, random, time
from pathlib import Path
from contract import CONTRACT_VERSION, RENDERER_VERSION, SYSTEM, VARIANTS, package, render
from scoring import VERSION as SCORING_VERSION, score
from report import summarize
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('pilot_transport',ROOT/'experiments/prompt-encoding/run.py')
pilot=importlib.util.module_from_spec(spec); spec.loader.exec_module(pilot)

def sha(data): return hashlib.sha256(data).hexdigest()
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def build_messages(case, variant):
    if variant=='legacy': return [{'role':'system','content':pilot.SYSTEM},{'role':'user','content':case['prose']+'\n\n'+case['question']}]
    return [{'role':'system','content':SYSTEM},{'role':'user','content':render(package(case),variant)}]

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--windows-host',action='store_true'); parser.add_argument('--base-url',default='http://localhost:11434'); parser.add_argument('--out',required=True); parser.add_argument('--models',nargs='+',default=pilot.DEFAULT_MODELS)
    args=parser.parse_args(); out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    if any(out.iterdir()): raise SystemExit('Use a new empty output directory')
    source=Path(__file__).parent; cases=json.loads((source/'cases.json').read_text())
    api=pilot.API(args.base_url,args.windows_host); inventory=api.call('/api/tags'); version=api.call('/api/version')
    selected=[]; seen=set()
    for name in args.models:
        item=next((m for m in inventory['models'] if m['name']==name),None)
        if not item or item['digest'] in seen: raise SystemExit('Missing or duplicate model: '+name)
        seen.add(item['digest']); selected.append(item)
    options={'temperature':0,'seed':20260927,'num_ctx':4096,'num_predict':384}
    # Freeze dataset, policy, implementation hashes and exact rendered requests BEFORE inference.
    prereg={'frozen_at':now(),'case_count':len(cases),'expected_records':len(selected)*len(cases)*len(VARIANTS),'primary':'heldout presentation-normalized content correctness; paired TGR versus flat','secondary':'heldout JSON/XML versus flat; exact output compliance; calibration and combined aggregates; tokens and latency','scoring_version':SCORING_VERSION,'contract_version':CONTRACT_VERSION,'renderer_version':RENDERER_VERSION,'options':options,'variants':VARIANTS,'models':selected,'cases':cases,'implementation_sha256':{p.name:sha(p.read_bytes()) for p in sorted(source.iterdir()) if p.suffix in ('.py','.md','.json')}}
    prereg['implementation_sha256']['pilot_transport.py']=sha((ROOT/'experiments/prompt-encoding/run.py').read_bytes())
    (out/'preregistration.json').write_text(json.dumps(prereg,indent=2)+'\n')
    with (out/'rendered-inputs.jsonl').open('w') as f:
        for case in cases:
            for variant in VARIANTS:
                f.write(json.dumps({'case_id':case['id'],'split':case['split'],'variant':variant,'package':dataclasses.asdict(package(case)),'messages':build_messages(case,variant)})+'\n')
    prereg_hash=sha((out/'preregistration.json').read_bytes())
    metadata={'started_at':now(),'ollama_version':version,'inventory':inventory,'transport':'powershell-windows-localhost' if args.windows_host else 'direct','preregistration_sha256':prereg_hash,'models':{},'complete':False}
    save=lambda:(out/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    save(); count=0
    for mi,entry in enumerate(selected):
        name=entry['name']; show=api.call('/api/show',{'model':name}); controls={'think':False} if False in (show.get('thinking') or {}).get('values',[]) else {}
        metadata['models'][name]={'show':show,'thinking_control':controls or 'server-default'}; save()
        print('WARMUP '+name,flush=True)
        warm=api.call('/api/chat',{'model':name,'messages':[{'role':'user','content':'Reply OK.'}],'stream':False,'keep_alive':'2m','options':options,**controls}); warm.get('message',{}).pop('thinking',None)
        metadata['models'][name]['warmup']=warm; save()
        ordered=cases.copy(); random.Random(20260927).shuffle(ordered)
        for ci,case in enumerate(ordered):
            offset=(mi+ci)%len(VARIANTS); variants=VARIANTS[offset:]+VARIANTS[:offset]
            for variant in variants:
                pkg=package(case); request={'model':name,'messages':build_messages(case,variant),'stream':False,'keep_alive':'2m','options':options,**controls}
                rec={'started_at':now(),'model':name,'digest':entry['digest'],'case_id':case['id'],'split':case['split'],'category':case['category'],'variant':variant,'expected':case['expected'],'package_version':CONTRACT_VERSION,'renderer_version':'pilot-v1' if variant=='legacy' else RENDERER_VERSION,'scoring_version':SCORING_VERSION,'preregistration_sha256':prereg_hash,'package_sha256':sha(json.dumps(dataclasses.asdict(pkg),sort_keys=True).encode()),'sources':[{'source_id':s.source_id,'revision':s.revision,'sha256':sha(s.content.encode())} for s in pkg.context],'request':request}
                start=time.monotonic()
                try:
                    response=api.call('/api/chat',request); response.get('message',{}).pop('thinking',None); rec['response']=response; rec['grade']=score(response,case['expected'])
                except Exception as exc:
                    rec['error']=str(exc); rec['grade']=score({},case['expected'])
                rec['wall_seconds']=time.monotonic()-start
                with (out/'records.jsonl').open('a') as f: f.write(json.dumps(rec)+'\n')
                count+=1
                print(f"{count}/{prereg['expected_records']} {name} {case['id']} {variant} {'PASS' if rec['grade']['content_correct'] else 'FAIL'} {rec['wall_seconds']:.2f}s",flush=True)
            summarize(out)
    metadata.update(complete=count==prereg['expected_records'],completed_at=now(),observed_records=count); save(); summarize(out)
    print('DONE '+str(out),flush=True)

if __name__=='__main__': main()
