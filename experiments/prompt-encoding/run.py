"""Stdlib-only live Ollama encoding pilot. Never downloads models or changes the server.
Use --windows-host from WSL when Ollama listens only on Windows localhost.
"""
import argparse, collections, datetime, hashlib, json, random, re, statistics, subprocess, tempfile, time
from pathlib import Path
from urllib.request import Request, urlopen
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
VARIANTS = ['prose','concise','json','xml']
SYSTEM = ('Solve the task using only the supplied facts and rules. Return exactly a JSON object '
          'with one key "answer", whose value is an array of matching identifiers. '
          'Use an empty array if none qualify. Do not include explanations.')
DEFAULT_MODELS = ['qwen3:8b','qwen3.5:latest','gemma4:26b','qwen3-coder:latest','qwen2.5-coder:14b']

def render(case, variant):
    fields = {**case['compact'], 'question':case['question']}
    if variant == 'prose': return case['prose']+'\n\n'+case['question']
    if variant == 'concise': return '\n'.join(f'{k}: {v}' for k,v in fields.items())
    if variant == 'json': return json.dumps(fields, separators=(',',':'),ensure_ascii=False)
    if variant == 'xml': return '<task>'+''.join(f'<{k}>{escape(v)}</{k}>' for k,v in fields.items())+'</task>'
    raise ValueError(variant)

def grade(content, expected):
    strict = True
    try: obj = json.loads(content)
    except (ValueError,TypeError):
        strict = False
        match = re.fullmatch(r'\s*```(?:json)?\s*(.*?)\s*```\s*',content,re.S)
        try: obj = json.loads(match[1]) if match else None
        except ValueError: obj = None
    shape = isinstance(obj,dict) and set(obj)=={'answer'} and isinstance(obj['answer'],list) and all(isinstance(x,str) for x in obj['answer'])
    correct = bool(shape and sorted(obj['answer'])==sorted(expected))
    return {'strict_format':bool(strict and shape),'semantic_correct':correct,'pass':bool(strict and correct),'parsed':obj}

class API:
    def __init__(self, base, windows): self.base,self.windows=base.rstrip('/'),windows
    def call(self, path, body=None, timeout=180):
        if not self.windows:
            req=Request(self.base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
            with urlopen(req,timeout=timeout) as r: return json.load(r)
        # File transport avoids shell interpolation of prompts and Windows command-size limits.
        with tempfile.TemporaryDirectory(prefix='.ollama-',dir=ROOT/'reports'/'prompt-encoding') as td:
            src,out,script=[Path(td)/n for n in ('request.json','response.json','request.ps1')]
            src.write_text(json.dumps(body),encoding='utf-8')
            win=lambda p: subprocess.check_output(['wslpath','-w',str(p)],text=True).strip()
            url=self.base+path
            if not re.fullmatch(r'https?://[a-zA-Z0-9.:/\-]+',url): raise ValueError('Unsupported endpoint characters')
            operation=f"Invoke-RestMethod -Uri '{url}' -TimeoutSec {timeout}"
            if body is not None: operation+=f" -Method Post -ContentType 'application/json' -Body ([IO.File]::ReadAllText('{win(src)}'))"
            script.write_text("$ErrorActionPreference='Stop'\n$r="+operation+"\n$r | ConvertTo-Json -Depth 60 -Compress | Out-File -Encoding utf8 '"+win(out)+"'\n",encoding='utf-8')
            proc=subprocess.run(['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','-NoProfile','-File',win(script)],capture_output=True,text=True,timeout=timeout+15)
            if proc.returncode: raise RuntimeError(proc.stderr[:1200])
            return json.loads(out.read_text(encoding='utf-8-sig'))

def summarize(records, out):
    groups=collections.defaultdict(list)
    for r in records: groups[(r['model'],r['variant'])].append(r)
    rows=[]
    for (model,variant),rs in groups.items():
        ok=[r for r in rs if 'response' in r]
        avg=lambda key: statistics.mean([r['response'][key] for r in ok if isinstance(r['response'].get(key),(int,float))]) if any(isinstance(r['response'].get(key),(int,float)) for r in ok) else None
        rows.append(dict(model=model,variant=variant,n=len(rs),passed=sum(r.get('grade',{}).get('pass',False) for r in rs),semantic_correct=sum(r.get('grade',{}).get('semantic_correct',False) for r in rs),errors=len(rs)-len(ok),mean_prompt_tokens=avg('prompt_eval_count'),mean_output_tokens=avg('eval_count'),median_wall_seconds=statistics.median(r['wall_seconds'] for r in rs),mean_load_ms=None if avg('load_duration') is None else avg('load_duration')/1e6))
    aggregates=[]
    for variant in VARIANTS:
        subset=[r for r in rows if r['variant']==variant]
        if subset: aggregates.append(dict(variant=variant,models=len(subset),n=sum(r['n'] for r in subset),passed=sum(r['passed'] for r in subset),macro_pass_rate=statistics.mean(r['passed']/r['n'] for r in subset),mean_prompt_tokens=statistics.mean(r['mean_prompt_tokens'] for r in subset if r['mean_prompt_tokens'] is not None)))
    (out/'summary.json').write_text(json.dumps({'rows':rows,'aggregate':aggregates},indent=2)+'\n')
    lines=['# Live prompt-encoding pilot','', 'Descriptive results, not a statistical ranking. See the experiment README for controls and limitations.','', '| Model | Encoding | Exact pass | Semantic pass | Errors | Mean input tokens | Mean output tokens | Median wall s |','|---|---|---:|---:|---:|---:|---:|---:|']
    fmt=lambda x:'n/a' if x is None else f'{x:.1f}'
    for r in rows: lines.append(f"| {r['model']} | {r['variant']} | {r['passed']}/{r['n']} | {r['semantic_correct']}/{r['n']} | {r['errors']} | {fmt(r['mean_prompt_tokens'])} | {fmt(r['mean_output_tokens'])} | {r['median_wall_seconds']:.2f} |")
    lines+=['','## Equal-model aggregate','', '| Encoding | Exact pass | Mean model accuracy | Mean input tokens |','|---|---:|---:|---:|']
    for r in aggregates: lines.append(f"| {r['variant']} | {r['passed']}/{r['n']} | {r['macro_pass_rate']:.1%} | {r['mean_prompt_tokens']:.1f} |")
    lines+=['','## Failures','']
    for r in records:
        if not r.get('grade',{}).get('pass'): lines.append(f"- {r['model']} / {r['case_id']} / {r['variant']}: expected `{json.dumps(r['expected'])}`, observed `{json.dumps(r.get('response',{}).get('message',{}).get('content',r.get('error')))}`; finish={r.get('response',{}).get('done_reason')}")
    (out/'summary.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')

def main():
    p=argparse.ArgumentParser(); p.add_argument('--windows-host',action='store_true'); p.add_argument('--base-url',default='http://localhost:11434'); p.add_argument('--models',nargs='+',default=DEFAULT_MODELS); p.add_argument('--out',required=True); p.add_argument('--case-limit',type=int); p.add_argument('--repeats',type=int,default=1)
    a=p.parse_args(); out=Path(a.out); out.mkdir(parents=True,exist_ok=True)
    if (out/'records.jsonl').exists(): raise SystemExit('Output already contains records; use a fresh directory.')
    api=API(a.base_url,a.windows_host); cases=json.loads(Path(__file__).with_name('cases.json').read_text()); cases=cases[:a.case_limit] if a.case_limit else cases
    tags=api.call('/api/tags'); version=api.call('/api/version'); selected=[]; seen=set()
    for name in a.models:
        entry=next((m for m in tags['models'] if m['name']==name),None)
        if not entry: raise SystemExit(f'Model not installed: {name}')
        if entry['digest'] in seen: raise SystemExit(f'Duplicate model digest: {name}')
        seen.add(entry['digest']); selected.append(entry)
    options={'temperature':0,'seed':20260926,'num_ctx':4096,'num_predict':384}
    metadata={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':version,'inventory':tags,'selected':selected,'options':options,'system':SYSTEM,'repeats':a.repeats,'cases':cases,'transport':'powershell-windows-localhost' if a.windows_host else 'direct','models':{},'references':['https://docs.ollama.com/api/chat','https://docs.ollama.com/api/tags']}
    records=[]
    for mi,entry in enumerate(selected):
        name=entry['name']; show=api.call('/api/show',{'model':name}); thinking=show.get('thinking') or {}; control={'think':False} if False in thinking.get('values',[]) else {}
        metadata['models'][name]={'show':show,'thinking_control':control or 'server-default'}
        (out/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
        print(f'WARMUP {name}',flush=True)
        warm=api.call('/api/chat',{'model':name,'messages':[{'role':'user','content':'Reply OK.'}],'stream':False,'keep_alive':'2m','options':options,**control})
        # Do not retain internal thinking text in telemetry.
        warm.get('message',{}).pop('thinking',None)
        metadata['models'][name]['warmup']=warm
        for repeat in range(a.repeats):
            ordered=cases.copy(); random.Random(20260926+repeat).shuffle(ordered)
            for ci,case in enumerate(ordered):
                shift=(ci+mi+repeat)%len(VARIANTS); variants=VARIANTS[shift:]+VARIANTS[:shift]
                for variant in variants:
                    content=render(case,variant); request={'model':name,'messages':[{'role':'system','content':SYSTEM},{'role':'user','content':content}],'stream':False,'keep_alive':'2m','options':options,**control}
                    rec={'model':name,'digest':entry['digest'],'case_id':case['id'],'category':case['category'],'variant':variant,'repeat':repeat,'expected':case['expected'],'request':request,'prompt_sha256':hashlib.sha256(content.encode()).hexdigest(),'prompt_characters':len(content),'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
                    start=time.monotonic()
                    try:
                        result=api.call('/api/chat',request); result.get('message',{}).pop('thinking',None); rec['response']=result; rec['grade']=grade(result.get('message',{}).get('content',''),case['expected'])
                        if not result.get('done') or result.get('done_reason')=='length': rec['grade']['pass']=False
                    except Exception as exc: rec['error']=str(exc)
                    rec['wall_seconds']=time.monotonic()-start; records.append(rec)
                    with (out/'records.jsonl').open('a',encoding='utf-8') as f: f.write(json.dumps(rec)+'\n')
                    summarize(records,out)
                    print(f"{len(records)} {name} {case['id']} {variant} {'PASS' if rec.get('grade',{}).get('pass') else 'FAIL'} {rec['wall_seconds']:.2f}s",flush=True)
        (out/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(f'DONE {out}',flush=True)

if __name__=='__main__': main()
