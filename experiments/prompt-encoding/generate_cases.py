"""Generate a deterministic, synthetic, paired prompt-encoding pilot dataset."""
import json
from pathlib import Path

CASES = [
('retry-partial','negation',
 'A generation may be retried only when its failure is transient and it has emitted no text. Attempt A has a transient failure and zero emitted characters. Attempt B has a transient failure and twelve emitted characters. Attempt C has a permanent failure and zero emitted characters.',
 {'rule':'Retry iff transient failure AND emitted characters = 0','attempts':'A: transient, chars=0; B: transient, chars=12; C: permanent, chars=0'},
 'Which attempts may be retried?', ['A']),
('dependency','relationships',
 'A task may start if it is pending and all its dependencies are complete. Task A is complete and has no dependencies. Task B is pending and depends on A. Task C is pending and depends on B. Task D is pending and has no dependencies. Task E is cancelled and depends on A.',
 {'rule':'Runnable iff pending AND all dependencies complete','tasks':'A: complete, deps=[]; B: pending, deps=[A]; C: pending, deps=[B]; D: pending, deps=[]; E: cancelled, deps=[A]'},
 'Which tasks may start now?', ['B','D']),
('revision','freshness',
 'The current objective revision of task K is 3. A result is acceptable only if it belongs to K, matches its current revision, and passed verification. Result A belongs to K, has revision 2, and passed. Result B belongs to K, has revision 3, and failed. Result C belongs to K, has revision 3, and passed. Result D belongs to L, has revision 3, and passed.',
 {'rule':'Accept iff task=K AND revision=3 AND verification=pass','results':'A: K,2,pass; B: K,3,fail; C: K,3,pass; D: L,3,pass'},
 'Which results are acceptable?', ['C']),
('scope','isolation',
 'For a task in project P, evidence is eligible if it is verified and either belongs to P or is explicitly shared. Document A belongs to P, is verified, and is not shared. Document B belongs to Q, is verified, and is not shared. Document C belongs to Q, is verified, and is shared. Document D belongs to P, is unverified, and is shared.',
 {'rule':'Eligible iff verified AND (project=P OR shared=true)','documents':'A: P,verified,shared=false; B: Q,verified,shared=false; C: Q,verified,shared=true; D: P,unverified,shared=true'},
 'Which documents are eligible?', ['A','C']),
('evidence','relationships',
 'A requirement is satisfied when at least one passing test explicitly covers it. Test A passes and covers R1 and R2. Test B fails and covers R3. Test C passes and covers R2. Test D passes and covers R4.',
 {'rule':'Satisfied iff at least one explicitly covering test passes','tests':'A: pass,covers=[R1,R2]; B: fail,covers=[R3]; C: pass,covers=[R2]; D: pass,covers=[R4]'},
 'Which of R1, R2, R3, and R4 are unsatisfied?', ['R3']),
('schedule','time',
 'The current time is 10:00 UTC. A pending task is eligible to start when its start-not-before time has arrived and it is not blocked. A deadline alone does not permit early starting. Task A is pending, may start at 12:00 UTC, has a 13:00 UTC deadline, and is not blocked. Task B is pending, may start at 09:00 UTC, has a 12:00 UTC deadline, and is blocked. Task C is pending, may start at 10:00 UTC, has an 11:00 UTC deadline, and is not blocked.',
 {'rule':'Eligible iff pending AND start_not_before <= now AND NOT blocked; deadline does not override start_not_before','now':'10:00 UTC','tasks':'A: pending,start=12:00 UTC,deadline=13:00 UTC,blocked=false; B: pending,start=09:00 UTC,deadline=12:00 UTC,blocked=true; C: pending,start=10:00 UTC,deadline=11:00 UTC,blocked=false'},
 'Which tasks may start now?', ['C']),
('exception','exceptions',
 'Production changes require review unless they modify only documentation. Any change affecting authentication requires review even if it modifies only documentation. Change A is a production code change unrelated to authentication. Change B changes only production documentation unrelated to authentication. Change C changes only production authentication documentation. Change D is a non-production code change unrelated to authentication.',
 {'rule':'Review if (production AND NOT docs_only) OR authentication','changes':'A: production=true,docs_only=false,authentication=false; B: production=true,docs_only=true,authentication=false; C: production=true,docs_only=true,authentication=true; D: production=false,docs_only=false,authentication=false'},
 'Which changes require review?', ['A','C']),
('unknown','uncertainty',
 'Select models only when tool support is confirmed and the context capacity is at least 8000 tokens. Unknown capability or capacity does not satisfy a requirement. Model A supports tools and has a capacity of 8192. Model B has unknown tool support and a capacity of 32000. Model C supports tools and has unknown capacity. Model D supports tools and has a capacity of 4096.',
 {'rule':'Eligible iff tools=confirmed AND context>=8000; unknown does not satisfy requirements','models':'A: tools=confirmed,context=8192; B: tools=unknown,context=32000; C: tools=confirmed,context=unknown; D: tools=confirmed,context=4096'},
 'Which models are eligible?', ['A']),
('budget','numeric',
 'Choose exactly one eligible model with the lowest latency. Eligibility requires confirmed tool support and a price no greater than 3 units. Model A has confirmed tool support, costs 2 units, and takes 100 milliseconds. Model B has confirmed tool support, costs 3 units, and takes 60 milliseconds. Model C has confirmed tool support, costs 4 units, and takes 20 milliseconds. Model D does not support tools, costs 1 unit, and takes 10 milliseconds.',
 {'rule':'Choose minimum latency among tools=confirmed AND price<=3','models':'A: tools=confirmed,price=2,latency_ms=100; B: tools=confirmed,price=3,latency_ms=60; C: tools=confirmed,price=4,latency_ms=20; D: tools=no,price=1,latency_ms=10'},
 'Which model should be chosen?', ['B']),
('locks','concurrency',
 'Task A is currently writing file X. A new task conflicts if it reads or writes X; work on another file does not conflict. Task B would read X. Task C would write Y. Task D would write X. Task E would read Z.',
 {'rule':'A holds write lock on X; reads/writes of X conflict; other files do not','candidates':'B: read X; C: write Y; D: write X; E: read Z'},
 'Which candidate tasks can run without conflicting with A?', ['C','E']),
('precedence','instructions',
 'A user revised the task from objective revision 1 to revision 2. The latest revision is authoritative. Revision 1 asked for local or remote models within 5 units. Revision 2 asks for local models only within 3 units. Model A is remote and costs 1 unit. Model B is local and costs 4 units. Model C is local and costs 2 units.',
 {'rule':'Latest objective revision is authoritative','revision_1':'local or remote; price<=5','revision_2':'local only; price<=3','models':'A: remote,price=1; B: local,price=4; C: local,price=2'},
 'Which models meet the current objective?', ['C']),
('no-evidence','uncertainty',
 'A claim is established only by a passing independent check that explicitly covers it. Claim R1 is supported by an implementing agent saying it is correct, but no independent check covers it. Claim R2 has an independent check that explicitly covers it, but that check failed.',
 {'rule':'Established iff explicitly covering independent check passes','claims':'R1: implementer says correct,no independent check; R2: covering independent check failed'},
 'Which claims are established?', []),
]

def generate():
 return [{'id':i,'category':cat,'prose':p,'compact':c,'question':q,'expected':e} for i,cat,p,c,q,e in CASES]

if __name__ == '__main__':
 Path(__file__).with_name('cases.json').write_text(json.dumps(generate(),indent=2)+'\n',encoding='utf-8')
