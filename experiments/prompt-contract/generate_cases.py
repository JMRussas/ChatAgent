"""Twelve previously tested calibration cases plus twelve new held-out cases.
Held-out means unobserved model outcomes at design freeze, not an independent benchmark.
"""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]

def heldout():
    cases=[]
    def add(i,category,prose,question,expected):
        cases.append(dict(id=i,category=category,prose=prose,question=question,expected=expected,split='heldout'))
    add('h-revision-scope','freshness',
        'The objective is task K in project P at revision 4. Accept a result only if its task, project and revision match, its check passed, and it is not retracted. Result A is K/P/4, passed, retracted. Result B is K/Q/4, passed, not retracted. Result C is K/P/3, passed, not retracted. Result D is K/P/4, passed, not retracted. Result E is L/P/4, passed, not retracted. Result F is K/P/4, failed, not retracted.',
        'Which results are acceptable?', ['D'])
    add('h-joint-dependency','dependencies',
        'Runnable tasks must be pending, unblocked, and have every dependency complete. A is complete with no dependencies. B is failed with no dependencies. C is pending, unblocked, and depends on A and B. D is pending, unblocked, and depends only on A. E is pending, blocked, and depends only on A. F is pending, unblocked, and has no dependencies. G is cancelled, unblocked, and has no dependencies.',
        'Which tasks can start now?', ['D','F'])
    add('h-explicit-offsets','time',
        'It is 14:00 UTC. A job is ready only if its start-not-before time has arrived and it is not cancelled. Job A starts at 10:00 UTC-04:00 and is not cancelled. Job B starts at 17:00 UTC+02:00 and is not cancelled. Job C starts at 13:30 UTC and is cancelled. Job D starts at 15:00 UTC+02:00 and is not cancelled. Interpret offsets numerically; all timestamps refer to the same date.',
        'Which jobs are ready?', ['A','D'])
    add('h-mandatory-budget','context-budget',
        'Input capacity is 100 tokens. Mandatory instructions use 30 and the response reserve uses 20, leaving a maximum of 50 for evidence. Process optional sources in priority order A, B, C, D; include a source if it fits the remaining evidence allowance, otherwise skip it and continue. Sources are indivisible. A uses 35 tokens, B uses 20, C uses 15, and D uses 5.',
        'Which sources are included?', ['A','C'])
    add('h-two-witnesses','evidence',
        'A claim is established only if it has passing checks from at least two distinct independent reviewers. Multiple checks by one reviewer count once. R1 has passing independent checks from U and U. R2 has passing independent checks from U and V. R3 has a passing independent check from U and a failed independent check from V. R4 has passing checks from U and V, but neither reviewer is independent.',
        'Which claims are established?', ['R2'])
    add('h-disclosure-exception','exceptions',
        'A document can be shared if it is public or has explicit owner approval, unless it contains credentials. Credentials always prohibit sharing, even with approval. A is public, lacks approval, and has no credentials. B is private, has approval, and has no credentials. C is public, has approval, and contains credentials. D is private, lacks approval, and has no credentials. E is private, has approval, and contains credentials.',
        'Which documents may be shared?', ['A','B'])
    add('h-multiple-locks','concurrency',
        'A worker holds a read lock on X and a write lock on Y. Another read of X is compatible; a write of X conflicts. Any read or write of Y conflicts. Access to Z does not conflict. Candidate A reads X and writes Z. Candidate B writes X. Candidate C reads Y. Candidate D reads X and reads Z. Candidate E writes Z and reads Y.',
        'Which candidates can run without any conflict?', ['A','D'])
    add('h-task-local-revision','instructions',
        'Task K revision 1 allows local or remote models at price at most 5. Task K revision 2 allows local models only at price at most 3. Task L revision 9 allows remote models only at price at most 1. Only revisions of the requested task apply; its highest revision wins. Model A is remote at price 1. Model B is local at price 3. Model C is local at price 4. Model D is local at price 2.',
        'Which models are eligible for task K?', ['B','D'])
    add('h-unknown-all','uncertainty',
        'Eligibility requires confirmed tool support, confirmed local execution, and at least 8192 context tokens. Unknown facts do not satisfy a requirement. A has tools, unknown execution locality, and 32000 tokens. B has unknown tools, local execution, and 32000 tokens. C has tools, local execution, and 8191 tokens. D has tools, remote execution, and 32000 tokens.',
        'Which models are eligible?', [])
    add('h-select-lexicographic','selection',
        'Eligible models must be local and cost at most 3. Choose exactly one by lowest latency, then lowest price, then alphabetically smallest identifier. A is local, price 3, latency 40. B is local, price 2, latency 40. C is local, price 2, latency 40. D is remote, price 1, latency 10. E is local, price 4, latency 5.',
        'Which model is selected?', ['B'])
    add('h-retry-bounds','negation',
        'Retry an attempt only if its error is transient, no answer text has been emitted, it is not cancelled, and fewer than two retries have already occurred. A: transient, zero characters, not cancelled, two retries. B: transient, zero characters, not cancelled, one retry. C: transient, one character, not cancelled, zero retries. D: transient, zero characters, cancelled, zero retries. E: permanent, zero characters, not cancelled, zero retries.',
        'Which attempts may be retried?', ['B'])
    add('h-source-authority','provenance',
        'Only the current acceptance specification defines required tests. That specification requires T1 and T3. A historical specification required T1, T2 and T4. The implementer says every test passed, but the actual current check records say T1 passed, T2 failed, T3 failed and T4 passed. Determine unsatisfied requirements from the current specification and actual check records.',
        'Which currently required tests remain unsatisfied?', ['T3'])
    return cases

if __name__=='__main__':
    original=json.loads((ROOT/'experiments/prompt-encoding/cases.json').read_text())
    calibration=[{k:c[k] for k in ('id','category','prose','question','expected')}|{'split':'calibration'} for c in original]
    Path(__file__).with_name('cases.json').write_text(json.dumps(calibration+heldout(),indent=2)+'\n')
