"""Summarize telemetry; no automated factual-quality score."""
import argparse, json, hashlib
from pathlib import Path

def summarize(directory):
    root=Path(directory); meta=json.loads((root/'metadata.json').read_text())
    if not meta['complete']: raise ValueError('Comparison is incomplete')
    assert hashlib.sha256((root/'sources.json').read_bytes()).hexdigest()==meta['source_snapshot_sha256']
    rows=[]; first_schemas=None; systems={}
    for case in meta['cases']:
        r=json.loads((root/(case['id']+'.json')).read_text())
        requests=[e for e in r['events'] if e['type']=='model_request']
        responses=[e for e in r['events'] if e['type']=='model_response']
        results=[e for e in r['events'] if e['type']=='tool_result']
        if first_schemas is None: first_schemas=requests[0]['tool_schemas']
        assert requests[0]['tool_schemas']==first_schemas
        variant='examples' if case['with_examples'] else 'baseline'
        systems.setdefault(variant,requests[0]['messages'][0]['content'])
        assert systems[variant]==requests[0]['messages'][0]['content']
        for metric in ('model_calls','tool_calls','retrieval_bytes'):
            assert r[metric]<=r['limits'][metric]
        assert all(e['estimated_input_bytes']<=r['limits']['input_bytes'] for e in requests)
        issued={e['result']['evidence_id']:e['result'] for e in results if 'evidence_id' in e['result']}
        for citation in (r['answer'] or {}).get('citations',[]):
            assert all(issued[citation['evidence_id']][k]==v for k,v in citation.items())
        structural=r['structural_eval']
        rows.append({'case':case['pair_id'],'variant':variant,'status':r['status'],
            'structural_pass':all(structural[k] for k in ('completed','expected_answer_status','required_source_read_and_cited')),
            'model_calls':r['model_calls'],'tool_calls':r['tool_calls'],
            'input_tokens':sum(e['usage']['input_tokens'] for e in responses),
            'output_tokens':sum(e['usage']['output_tokens'] for e in responses),
            'seconds':round(r['elapsed_seconds'],3),
            'draft_rejections':sum(e['type']=='draft_rejected' for e in r['events']),
            'tool_errors':sum('error' in e['result'] for e in results),
            'first_tool':results[0]['name'] if results else None})
    totals={}
    for variant in ('baseline','examples'):
        selected=[r for r in rows if r['variant']==variant]
        totals[variant]={k:sum(r[k] for r in selected) for k in ('structural_pass','model_calls','tool_calls','input_tokens','output_tokens','seconds','draft_rejections','tool_errors')}
    return {'note':'Structural and resource metrics only; manual review remains separate. One observation per condition per question.', 'totals':totals,'rows':rows}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory');a=p.parse_args()
    result=summarize(a.directory)
    (Path(a.directory)/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
