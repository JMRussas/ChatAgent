"""Regenerate descriptive reports from immutable observed records."""
import collections, json, statistics, sys
from pathlib import Path
from contract import VARIANTS

def summarize(out):
    records=[json.loads(x) for x in (out/'records.jsonl').read_text().splitlines()]
    rows=[]; aggregates=[]; pairs=[]
    for split in ('heldout','calibration','all'):
        subset=[r for r in records if split=='all' or r['split']==split]
        for model in dict.fromkeys(r['model'] for r in subset):
            for variant in VARIANTS:
                rs=[r for r in subset if r['model']==model and r['variant']==variant]
                if not rs: continue
                metric=lambda key:[r['response'][key] for r in rs if isinstance(r.get('response',{}).get(key),(int,float))]
                mean=lambda key:statistics.mean(metric(key)) if metric(key) else None
                rows.append(dict(split=split,model=model,variant=variant,n=len(rs),correct=sum(r['grade']['content_correct'] for r in rs),exact=sum(r['grade']['exact_pass'] for r in rs),strict_format=sum(r['grade']['strict_format'] for r in rs),errors=sum('error' in r for r in rs),mean_input_tokens=mean('prompt_eval_count'),mean_output_tokens=mean('eval_count'),median_wall_seconds=statistics.median(r['wall_seconds'] for r in rs)))
            indexed=collections.defaultdict(dict)
            for r in subset:
                if r['model']==model: indexed[r['case_id']][r['variant']]=r
            for variant in ('tgr','json','xml'):
                matched=[(v['flat'],v[variant]) for v in indexed.values() if 'flat' in v and variant in v]
                if matched:
                    wins=sum(not a['grade']['content_correct'] and b['grade']['content_correct'] for a,b in matched)
                    losses=sum(a['grade']['content_correct'] and not b['grade']['content_correct'] for a,b in matched)
                    pairs.append(dict(split=split,model=model,variant=variant,n=len(matched),wins=wins,losses=losses,ties=len(matched)-wins-losses))
        for variant in VARIANTS:
            rs=[r for r in rows if r['split']==split and r['variant']==variant]
            if rs:
                tokens=[r['mean_input_tokens'] for r in rs if r['mean_input_tokens'] is not None]
                aggregates.append(dict(split=split,variant=variant,models=len(rs),n=sum(r['n'] for r in rs),correct=sum(r['correct'] for r in rs),exact=sum(r['exact'] for r in rs),macro_accuracy=statistics.mean(r['correct']/r['n'] for r in rs),mean_input_tokens=statistics.mean(tokens) if tokens else None))
    data={'rows':rows,'aggregate':aggregates,'paired_vs_flat':pairs,'observed_records':len(records)}
    (out/'summary.json').write_text(json.dumps(data,indent=2)+'\n')
    f=lambda x:'n/a' if x is None else f'{x:.1f}'
    lines=['# Task / Guidelines / Response Framework experiment','', 'Held-out content correctness is the primary endpoint. Scoring was frozen before execution. One deterministic pass; differences are descriptive, not statistically established. Flat/TGR/JSON/XML contain identical semantic strings. Legacy differs in instruction wording and placement.','']
    for split in ('heldout','calibration','all'):
        lines += [f'## {split} results','','| Model | Variant | Content correct | Exact pass | Mean input tokens | Median wall s |','|---|---|---:|---:|---:|---:|']
        for r in rows:
            if r['split']==split: lines.append(f"| {r['model']} | {r['variant']} | {r['correct']}/{r['n']} | {r['exact']}/{r['n']} | {f(r['mean_input_tokens'])} | {r['median_wall_seconds']:.2f} |")
        lines+=['','| Variant | Aggregate content | Equal-model accuracy | Exact pass | Mean input tokens |','|---|---:|---:|---:|---:|']
        for r in aggregates:
            if r['split']==split: lines.append(f"| {r['variant']} | {r['correct']}/{r['n']} | {r['macro_accuracy']:.1%} | {r['exact']}/{r['n']} | {f(r['mean_input_tokens'])} |")
    lines+=['','## Paired changes against identical-content flat control','','| Split | Model | Variant | Wins | Losses | Ties |','|---|---|---|---:|---:|---:|']
    for r in pairs: lines.append(f"| {r['split']} | {r['model']} | {r['variant']} | {r['wins']} | {r['losses']} | {r['ties']} |")
    lines+=['','## Content failures','']
    for r in records:
        if not r['grade']['content_correct']: lines.append(f"- {r['split']} / {r['model']} / {r['case_id']} / {r['variant']}: expected `{json.dumps(r['expected'])}`, observed `{json.dumps(r.get('response',{}).get('message',{}).get('content',r.get('error')))}`.")
    (out/'summary.md').write_text('\n'.join(lines)+'\n')
    return data

if __name__=='__main__': summarize(Path(sys.argv[1]))
