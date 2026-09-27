"""Exploratory post-run rescore; preserves original exact grades and responses.
Normalization rule added after observing pilot responses: accept a single entity
noun prefix and JSON fences. No arbitrary prose extraction or LLM grading.
"""
import collections, json, re, statistics, sys
from pathlib import Path
from run import grade, VARIANTS

def normalized_grade(content, expected):
    obj=grade(content,expected)['parsed']
    if not isinstance(obj,dict) or set(obj)!={'answer'} or not isinstance(obj['answer'],list): return False
    answers=[]
    for value in obj['answer']:
        if not isinstance(value,str): return False
        answers.append(re.sub(r'^(?:Model|Task|Document|Result|Attempt|Change|Claim) ([A-Z][0-9]*)$',r'\1',value))
    return sorted(answers)==sorted(expected)

def analyze(out):
    records=[json.loads(s) for s in (out/'records.jsonl').read_text().splitlines()]
    rows=[]; pairs=[]
    for model in dict.fromkeys(r['model'] for r in records):
        by_case=collections.defaultdict(dict)
        for r in records:
            if r['model']!=model: continue
            res=r.get('response',{}); content=res.get('message',{}).get('content','')
            r['normalized_correct']=bool(res.get('done') and res.get('done_reason')!='length' and normalized_grade(content,r['expected']))
            by_case[(r['case_id'],r['repeat'])][r['variant']]=r
        for variant in VARIANTS:
            rs=[r for r in records if r['model']==model and r['variant']==variant]
            if not rs: continue
            nums=lambda key:[r['response'][key] for r in rs if isinstance(r.get('response',{}).get(key),(int,float))]
            row={'model':model,'variant':variant,'n':len(rs),'normalized_correct':sum(r['normalized_correct'] for r in rs),'exact_pass':sum(r.get('grade',{}).get('pass',False) for r in rs),'strict_format':sum(r.get('grade',{}).get('strict_format',False) for r in rs),'mean_input_tokens':statistics.mean(nums('prompt_eval_count')) if nums('prompt_eval_count') else None}
            rows.append(row)
            if variant!='prose':
                ps=[(case['prose'],case[variant]) for case in by_case.values() if 'prose' in case and variant in case]
                pairs.append({'model':model,'variant':variant,'pairs':len(ps),'wins':sum(not a['normalized_correct'] and b['normalized_correct'] for a,b in ps),'losses':sum(a['normalized_correct'] and not b['normalized_correct'] for a,b in ps),'ties':sum(a['normalized_correct']==b['normalized_correct'] for a,b in ps)})
    aggregate=[]
    for v in VARIANTS:
        rs=[r for r in rows if r['variant']==v]
        if rs: aggregate.append({'variant':v,'n':sum(r['n'] for r in rs),'normalized_correct':sum(r['normalized_correct'] for r in rs),'exact_pass':sum(r['exact_pass'] for r in rs),'macro_normalized_accuracy':statistics.mean(r['normalized_correct']/r['n'] for r in rs),'mean_input_tokens':statistics.mean(r['mean_input_tokens'] for r in rs if r['mean_input_tokens'] is not None)})
    result={'grading_version':'exploratory-prefix-and-fence-v1','post_hoc':True,'rows':rows,'aggregate':aggregate,'paired_against_prose':pairs}
    (out/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
    lines=['# Exploratory content scoring','', 'Added after observing pilot output; raw exact grades remain unchanged. Accept JSON fences and a single entity prefix (e.g. "Model B" → "B"). No extra identifiers, duplicates, invalid JSON or arbitrary explanatory prose are accepted. This is a post-hoc descriptive analysis, not a preregistered metric.','', '| Model | Encoding | Content correct | Exact pass | Strict JSON shape | Mean input tokens |','|---|---|---:|---:|---:|---:|']
    for r in rows: lines.append(f"| {r['model']} | {r['variant']} | {r['normalized_correct']}/{r['n']} | {r['exact_pass']}/{r['n']} | {r['strict_format']}/{r['n']} | {r['mean_input_tokens']:.1f} |")
    lines+=['','## Paired content changes versus prose','','| Model | Encoding | Wins | Losses | Ties |','|---|---|---:|---:|---:|']
    for r in pairs: lines.append(f"| {r['model']} | {r['variant']} | {r['wins']} | {r['losses']} | {r['ties']} |")
    (out/'analysis.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(result['aggregate'],indent=2))
if __name__=='__main__': analyze(Path(sys.argv[1]))
