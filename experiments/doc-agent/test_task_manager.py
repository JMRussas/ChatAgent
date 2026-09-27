import asyncio
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from task_manager import TaskManager
from test_durable import fixture_corpus,Scripted
from test_agent import FakeModel,call,answer

class ManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_running_tasks_and_cancel_isolation(self):
        with tempfile.TemporaryDirectory() as td:
            manager=TaskManager(td)
            ids=[manager.submit('Question',fixture_corpus(),{}) for _ in range(2)]
            gate=asyncio.Event();both=asyncio.Event();started=[]
            class Waiting(FakeModel):
                async def ainvoke(self,messages):
                    started.append(True)
                    if len(started)==2:both.set()
                    await gate.wait()
                    return call('read_doc',{'source_id':'doc'})
            tasks=[asyncio.create_task(manager.advance(i,lambda _:Waiting())) for i in ids]
            await asyncio.wait_for(both.wait(),3)
            self.assertEqual([manager.status(i)['status'] for i in ids],['running','running'])
            other=TaskManager(td);self.assertEqual(other.cancel(ids[0])['status'],'cancel_requested')
            first=await asyncio.wait_for(tasks[0],3)
            self.assertEqual(first['status'],'cancelled')
            self.assertEqual(manager.status(ids[1])['status'],'running')
            gate.set();second=await tasks[1];self.assertEqual(second['status'],'paused')
            self.assertEqual((await manager.advance(ids[0],lambda _:self.fail('cancelled task invoked')))['status'],'cancelled')
            self.assertEqual(manager.cancel(ids[1])['status'],'cancelled')

    async def test_paused_time_excluded_but_active_budget_expires(self):
        with tempfile.TemporaryDirectory() as td:
            manager=TaskManager(td)
            task=manager.submit('Question',fixture_corpus(),{},options={'deadline_seconds':60})
            factory=lambda _:Scripted(str(Path(td)/'calls'))
            await manager.advance(task,factory)
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
            async def change(active):
                async with AsyncSqliteSaver.from_conn_string(str(manager.path(task))) as saver:
                    row=await saver.aget_tuple({'configurable':{'thread_id':'task'}})
                    checkpoint=dict(row.checkpoint);checkpoint['channel_values']=dict(checkpoint['channel_values'])
                    checkpoint['channel_values']['started_at']=0
                    checkpoint['channel_values']['active_elapsed_seconds']=active
                    await saver.aput(row.config,checkpoint,row.metadata,{})
            await change(0)
            resumed=await manager.advance(task,factory)
            self.assertEqual(resumed['status'],'paused');self.assertEqual(resumed['last_checkpoint']['tool_calls'],1)
            await change(61)
            final=await manager.advance(task,factory)
            self.assertEqual(final['status'],'failed')
            self.assertEqual(final['last_checkpoint']['status'],'deadline_exceeded')
            self.assertEqual(final['last_checkpoint']['tool_calls'],1)

    async def test_queued_cancel_invalid_id_and_uncertain_owner(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            with self.assertRaises(ValueError):m.status('../outside')
            self.assertEqual(m.cancel(i)['status'],'cancelled')
            self.assertEqual((await m.advance(i,lambda _:self.fail('called')))['status'],'cancelled')
            j=m.submit('Question',fixture_corpus(),{})
            with m.connect() as c:c.execute("UPDATE tasks SET status='running' WHERE id=?",(j,))
            self.assertEqual(m.status(j)['status'],'uncertain')
            with self.assertRaisesRegex(ValueError,'replayed'):await m.advance(j)

    async def test_caller_cancellation_is_persisted_and_propagated(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            started=asyncio.Event()
            class Waiting(FakeModel):
                async def ainvoke(self,messages):
                    started.set();await asyncio.Event().wait()
            work=asyncio.create_task(m.advance(i,lambda _:Waiting()))
            await asyncio.wait_for(started.wait(),3);work.cancel()
            with self.assertRaises(asyncio.CancelledError):await work
            self.assertEqual(m.status(i)['status'],'cancelled')

    async def test_same_task_cannot_advance_twice(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            with closing(sqlite3.connect(m.path(i,'owner'))) as owner:
                owner.execute('BEGIN EXCLUSIVE')
                with self.assertRaises(sqlite3.OperationalError):await m.advance(i)
            self.assertEqual(m.status(i)['status'],'queued')

class ProcessTests(unittest.TestCase):
    def test_b_finishes_while_a_paused_then_a_resumes_after_restart(self):
        with tempfile.TemporaryDirectory() as td:
            def run(action):
                r=subprocess.run([sys.executable,__file__,action,td],capture_output=True,text=True,check=True)
                return json.loads(r.stdout)
            first=run('demo-start')
            self.assertEqual(first['a']['status'],'paused')
            self.assertEqual(first['b']['status'],'completed')
            final=run('demo-resume')
            self.assertEqual(final['a']['status'],'completed')
            self.assertEqual(final['b'],first['b'])
            for key in ('a','b'):
                result=final[key]['last_checkpoint']
                self.assertEqual(result['model_calls'],3);self.assertEqual(result['tool_calls'],2)
                self.assertEqual(Path(td,f'{key}.calls').read_text().splitlines(),['0','1','2'])

async def demo(action,root):
    root=Path(root);m=TaskManager(root)
    def factory(key):return lambda _:Scripted(str(root/(key+'.calls')))
    if action=='demo-start':
        ids={key:m.submit('Question',fixture_corpus(),{},options={'max_model_calls':3,'max_tool_calls':2}) for key in ('a','b')}
        (root/'ids.json').write_text(json.dumps(ids))
        await asyncio.gather(*(m.advance(ids[k],factory(k)) for k in ('a','b')))
        while m.status(ids['b'])['status']=='paused':await m.advance(ids['b'],factory('b'))
    else:
        ids=json.loads((root/'ids.json').read_text())
        while m.status(ids['a'])['status']=='paused':await m.advance(ids['a'],factory('a'))
    return {k:m.status(i) for k,i in ids.items()}

if __name__=='__main__':
    if len(sys.argv)==3:print(json.dumps(asyncio.run(demo(*sys.argv[1:]))))
    else:unittest.main()
