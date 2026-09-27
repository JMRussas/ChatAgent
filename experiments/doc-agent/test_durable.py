from contextlib import closing
import asyncio, hashlib, json, sqlite3, subprocess, sys, tempfile, unittest
from pathlib import Path
from durable import run_durable
from retrieval import Corpus, Source
from test_agent import FakeModel, call, answer


def fixture_corpus():
    text='The queue is in memory.\nRestart loses queued work.\n'
    return Corpus([Source('doc','docs/example.md','Example',hashlib.sha256(text.encode()).hexdigest(),text)])

class Scripted(FakeModel):
    def __init__(self,log): super().__init__(); self.log=log
    async def ainvoke(self,messages):
        n=sum(m.type=='tool' for m in messages)
        with open(self.log,'a') as f: f.write(str(n)+'\n')
        if n<2: return call('read_doc',{'source_id':'doc','start_line':n+1,'line_count':1},f'c{n}')
        return answer(citations=['E1','E2'])

class DurableTests(unittest.TestCase):
    def test_fresh_process_resume_preserves_evidence_and_counts(self):
        with tempfile.TemporaryDirectory() as td:
            db=str(Path(td)/'task.sqlite')
            def run(action):
                r=subprocess.run([sys.executable,__file__,action,db],capture_output=True,text=True,check=True)
                return json.loads(r.stdout)
            first=run('start');self.assertEqual(first['status'],'paused');self.assertEqual(first['tool_calls'],0)
            second=run('resume');self.assertEqual(second['status'],'paused');self.assertEqual(second['tool_calls'],1)
            final=run('resume');self.assertEqual(final['status'],'completed')
            self.assertEqual(final['model_calls'],3);self.assertEqual(final['tool_calls'],2)
            self.assertEqual([c['evidence_id'] for c in final['answer']['citations']],['E1','E2'])
            self.assertEqual(run('resume'),final)
            self.assertEqual(Path(db+'.calls').read_text().splitlines(),['0','1','2'])
            self.assertEqual(final['answer']['citations'][1]['revision'],fixture_corpus().sources['doc'].revision)

    def test_expired_deadline_and_uncertain_run(self):
        with tempfile.TemporaryDirectory() as td:
            db=Path(td)/'task.sqlite'
            factory=lambda _:Scripted(str(db)+'.calls')
            first=asyncio.run(run_durable(db,factory,question='Question',corpus=fixture_corpus(),identity={'fixture':True},options={'deadline_seconds':60}))
            self.assertEqual(first['status'],'paused')
            # Expire persisted deadline without sleeping or resetting any budgets.
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
            async def expire():
                async with AsyncSqliteSaver.from_conn_string(str(db)) as saver:
                    row=await saver.aget_tuple({'configurable':{'thread_id':'task'}})
                    checkpoint=dict(row.checkpoint);checkpoint['channel_values']=dict(checkpoint['channel_values'])
                    checkpoint['channel_values']['started_at']=0
                    await saver.aput(row.config,checkpoint,row.metadata,{})
            asyncio.run(expire())
            result=asyncio.run(run_durable(db,factory))
            self.assertEqual(result['status'],'deadline_exceeded');self.assertEqual(result['tool_calls'],0)
            with closing(sqlite3.connect(db)) as c, c:
                task=json.loads(c.execute('SELECT payload FROM task').fetchone()[0]);task['status']='running'
                c.execute('UPDATE task SET payload=?',(json.dumps(task),))
            with self.assertRaisesRegex(ValueError,'Uncertain'):asyncio.run(run_durable(db,factory))

    def test_changed_code_and_corrupt_source_refused(self):
        with tempfile.TemporaryDirectory() as td:
            db=Path(td)/'task.sqlite'; factory=lambda _:Scripted(str(db)+'.calls')
            asyncio.run(run_durable(db,factory,question='Question',corpus=fixture_corpus(),identity={}))
            with closing(sqlite3.connect(db)) as c, c:
                original=json.loads(c.execute('SELECT payload FROM task').fetchone()[0])
                changed=json.loads(json.dumps(original));changed['code']['agent.py']='changed'
                c.execute('UPDATE task SET payload=?',(json.dumps(changed),))
            with self.assertRaisesRegex(ValueError,'Implementation changed'):asyncio.run(run_durable(db,factory))
            with closing(sqlite3.connect(db)) as c, c:
                original['sources'][0]['content']='corrupt'
                c.execute('UPDATE task SET payload=?',(json.dumps(original),))
            with self.assertRaisesRegex(ValueError,'snapshot hash'):asyncio.run(run_durable(db,factory))

    def test_unknown_manifest_version_and_checkpoint_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as td:
            db=Path(td)/'task.sqlite'; factory=lambda _:Scripted(str(db)+'.calls')
            asyncio.run(run_durable(db,factory,question='Question',corpus=fixture_corpus(),identity={}))
            with closing(sqlite3.connect(db)) as c, c:
                original=json.loads(c.execute('SELECT payload FROM task').fetchone()[0])
                changed={**original,'version':999}
                c.execute('UPDATE task SET payload=?',(json.dumps(changed),))
            with self.assertRaisesRegex(ValueError,'task version'): asyncio.run(run_durable(db,factory))
            # A valid but different manifest snapshot must not silently resume
            # the old checkpoint's corpus, even if both hashes are internally valid.
            original['sources'][0]['content']='Changed corpus'
            original['sources'][0]['revision']=hashlib.sha256(b'Changed corpus').hexdigest()
            with closing(sqlite3.connect(db)) as c, c:
                c.execute('UPDATE task SET payload=?',(json.dumps(original),))
            with self.assertRaisesRegex(ValueError,'differs from task manifest'): asyncio.run(run_durable(db,factory))

    def test_existing_start_and_concurrent_owner_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            db=Path(td)/'task.sqlite'; factory=lambda _:Scripted(str(db)+'.calls')
            args={'question':'Question','corpus':fixture_corpus(),'identity':{}}
            asyncio.run(run_durable(db,factory,**args))
            with self.assertRaisesRegex(ValueError,'already exists'):asyncio.run(run_durable(db,factory,**args))
            with closing(sqlite3.connect(str(db)+'.lock')) as lock, lock:
                lock.execute('BEGIN EXCLUSIVE')
                with self.assertRaises(sqlite3.OperationalError):asyncio.run(run_durable(db,factory))

if __name__=='__main__':
    if len(sys.argv)==3:
        action,db=sys.argv[1:]
        options={'question':'Question','corpus':fixture_corpus(),'identity':{'fixture':True},'options':{'max_model_calls':3,'max_tool_calls':2}} if action=='start' else {}
        print(json.dumps(asyncio.run(run_durable(db,lambda _:Scripted(db+'.calls'),**options))))
    else: unittest.main()
