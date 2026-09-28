"""Summarize every measured condition; keep failures and missing timings explicit."""
import json
from pathlib import Path
from statistics import median
import sys


def distribution(values):
    return {'count':len(values),'median':median(values) if values else None,
            'max':max(values) if values else None}


def summarize(report):
    result={'outcome':report['outcome'],'policies':{}}
    for policy in dict.fromkeys(report['order']):
        blocks=[b for b in report['blocks'] if b['policy']==policy]
        out={'conditions':{}}
        for phase in ('baseline','overlap'):
            rows=[r for b in blocks for r in b['timings'] if r['lane']=='foreground' and r['phase']==phase]
            out['conditions'][phase]={
                'requests':len(rows),
                'outcomes':{v:sum(r.get('outcome')==v for r in rows) for v in {r.get('outcome') for r in rows}},
                **{key:distribution([r[key] for r in rows if key in r]) for key in ('firstAnswerLatencyMs','admissionWaitMs','elapsedMs')},
                'missingFirstAnswer':sum('firstAnswerLatencyMs' not in r for r in rows),
            }
        tasks=[t for b in blocks for t in b.get('background',[]) if t['status']!='cancelled']
        out['background']={
            'tasks':len(tasks),'completed':sum(t['status']=='completed' for t in tasks),
            'waveCompletionObservedMs':[max((t['observedTerminalMs'] for t in b.get('background',[]) if t['status']!='cancelled'),default=None) for b in blocks],
            'note':'Observed terminal upper bounds from batch submission; includes Python queue time. Not individual execution durations.',
        }
        out['queuedCancellationChecks']=sum(b.get('queuedCancellation',{}).get('after',{}).get('status')=='cancelled' for b in blocks)
        out['activeCancellationChecks']=sum(f['outcome']=='CANCELLED' for b in blocks for f in b['foreground'] if f['label']=='active-cancel')
        out['recoveryChecks']=sum(f['outcome']=='completed' for b in blocks for f in b['foreground'] if f['label']=='after-cancel')
        out['foregroundOvertakesWaitingBackground']=sum(
            1 for b in blocks for f in b['timings'] for bg in b['timings']
            if f['lane']=='foreground' and bg['lane']=='background'
            and 'admittedMs' in f and 'admittedMs' in bg
            and bg.get('readyMs',float('inf')) < f.get('readyMs',0)
            and f['admittedMs'] < bg['admittedMs'])
        result['policies'][policy]=out
    return result


if __name__=='__main__':
    folder=Path(sys.argv[1])
    (folder/'summary.json').write_text(json.dumps(summarize(json.loads((folder/'results.json').read_text())),indent=2)+'\n')
