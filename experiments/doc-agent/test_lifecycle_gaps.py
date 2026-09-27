"""Fault injection at task lifecycle and persistence boundaries."""
import asyncio
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from task_manager import TaskManager
from test_durable import fixture_corpus
from test_agent import FakeModel,call,answer

class LifecycleGaps(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_budgets_rejected_before_task_is_queued(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td)
            for options in ({'max_model_calls':0},{'max_tool_calls':-1},{'deadline_seconds':float('nan')},
                            {'deadline_seconds':float('inf')},{'call_timeout':True},{'max_input_bytes':0},
                            {'checkpointer':'override'}):
                with self.subTest(options=options):
                    with self.assertRaises(ValueError):m.submit('Question',fixture_corpus(),{},options=options)
            self.assertEqual(m.list(),[])

    async def test_status_rechecks_when_owner_finishes_during_read(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            with m.connect() as c:c.execute("UPDATE tasks SET status='running' WHERE id=?",(i,))
            original=m.owner_available
            def finish_during_probe(task_id):
                with m.connect() as c:c.execute("UPDATE tasks SET status='paused' WHERE id=?",(task_id,))
                return original(task_id)
            with patch.object(m,'owner_available',finish_during_probe):
                self.assertEqual(m.status(i)['status'],'paused')

    async def test_cancel_does_not_modify_unsupported_manifest(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            with m.connect() as c:
                p=json.loads(c.execute('SELECT payload FROM tasks').fetchone()[0]);p['version']=999
                c.execute('UPDATE tasks SET payload=?',(json.dumps(p),))
            with self.assertRaises(ValueError):m.cancel(i)
            with m.connect() as c:self.assertEqual(c.execute('SELECT status FROM tasks').fetchone()[0],'queued')

    async def test_cancel_wins_over_late_success(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{});started=asyncio.Event()
            async def late(*args,**kwargs):
                started.set()
                try:await asyncio.Event().wait()
                except asyncio.CancelledError:return {'status':'completed','answer':'late result'}
            with patch('task_manager.run_durable',late):
                work=asyncio.create_task(m.advance(i))
                await asyncio.wait_for(started.wait(),2);m.cancel(i)
                result=await asyncio.wait_for(work,2)
            self.assertEqual(result['status'],'cancelled');self.assertEqual(result['last_checkpoint'],{})

    async def test_provider_ignoring_timeout_cannot_publish_success(self):
        from agent import run_agent
        from graph_agent import run_graph_agent
        for runner in (run_agent,run_graph_agent):
            class Late(FakeModel):
                async def ainvoke(self,messages):
                    if not any(m.type=='tool' for m in messages):return call('read_doc',{'source_id':'doc'})
                    try:await asyncio.sleep(1)
                    except asyncio.CancelledError:return answer()
            result=await runner(Late(),fixture_corpus(),'Question',call_timeout=.005)
            self.assertEqual(result['status'],'deadline_exceeded')
            self.assertIsNone(result['answer'])

    async def test_stalled_provider_cleanup_does_not_hold_deadline_open(self):
        from agent import run_agent
        from graph_agent import run_graph_agent
        for runner in (run_agent,run_graph_agent):
            release=asyncio.Event();finished=asyncio.Event()
            class Stalled(FakeModel):
                async def ainvoke(self,messages):
                    try:
                        try:await asyncio.Event().wait()
                        except asyncio.CancelledError:await release.wait();return answer()
                    finally:finished.set()
            try:
                result=await asyncio.wait_for(runner(Stalled(),fixture_corpus(),'Question',call_timeout=.01),1)
                self.assertEqual(result['status'],'deadline_exceeded')
                self.assertFalse(finished.is_set())
            finally:
                release.set();await asyncio.wait_for(finished.wait(),1)

    async def test_completed_cancel_is_idempotent_and_factory_failure_is_terminal(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            async def success(*args,**kwargs):return {'status':'completed','answer':'saved'}
            with patch('task_manager.run_durable',success):first=await m.advance(i)
            self.assertEqual(m.cancel(i),first)
            self.assertEqual(await m.advance(i),first)
            j=m.submit('Question',fixture_corpus(),{})
            def broken(_):raise ValueError('model unavailable')
            failure=await m.advance(j,broken)
            self.assertEqual(failure['status'],'failed')
            self.assertIn('model unavailable',failure['error'])
            self.assertEqual(await m.advance(j),failure)

    async def test_owner_cancel_survives_provider_cleanup_exception(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{});started=asyncio.Event()
            async def cleanup_error(*args,**kwargs):
                started.set()
                try:await asyncio.Event().wait()
                except asyncio.CancelledError:raise RuntimeError('cleanup failed')
            with patch('task_manager.run_durable',cleanup_error):
                work=asyncio.create_task(m.advance(i));await asyncio.wait_for(started.wait(),2);work.cancel()
                with self.assertRaises(asyncio.CancelledError):await work
            self.assertEqual(m.status(i)['status'],'cancelled')

    async def test_repeat_detection_and_tool_budget_survive_pause(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{},options={'max_tool_calls':2})
            factory=lambda _:FakeModel(call('read_doc',{'source_id':'doc'}))
            self.assertEqual((await m.advance(i,factory))['status'],'paused')
            second=await m.advance(i,factory)
            self.assertEqual(second['status'],'paused');self.assertEqual(second['last_checkpoint']['tool_calls'],1)
            final=await m.advance(i,factory)
            self.assertEqual(final['status'],'failed')
            self.assertEqual(final['last_checkpoint']['status'],'repeated_tool_call')
            self.assertEqual(final['last_checkpoint']['tool_calls'],1)

    async def test_registry_failure_after_durable_save_refuses_replay(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            real_connect=m.connect
            async def saved(*args,**kwargs):
                # Simulate checkpoint success followed by registry write failure.
                m.connect=lambda: (_ for _ in ()).throw(sqlite3.OperationalError('disk full'))
                return {'status':'paused'}
            with patch('task_manager.run_durable',saved):
                with self.assertRaises(sqlite3.OperationalError):await m.advance(i)
            m.connect=real_connect
            self.assertEqual(m.status(i)['status'],'uncertain')
            with self.assertRaisesRegex(ValueError,'replayed'):await m.advance(i)

class KilledOwner(unittest.TestCase):
    def test_real_process_kill_releases_owner_without_replaying(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);i=m.submit('Question',fixture_corpus(),{})
            process=subprocess.Popen([sys.executable,__file__,'worker',td,i],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                # Worker announces readiness only after ownership and durable running save.
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    ready=pool.submit(process.stdout.readline)
                    try:self.assertEqual(ready.result(timeout=10).strip(),'MODEL_STARTED')
                    except BaseException:process.kill();raise
                with self.assertRaises(sqlite3.OperationalError):asyncio.run(TaskManager(td).advance(i))
                process.kill();process.wait(timeout=10)
                self.assertEqual(TaskManager(td).status(i)['status'],'uncertain')
                with self.assertRaisesRegex(ValueError,'replayed'):asyncio.run(TaskManager(td).advance(i))
            finally:
                if process.poll() is None:process.kill();process.wait(timeout=10)
                process.stdout.close();process.stderr.close()

async def worker(root,task_id):
    class Waiting(FakeModel):
        async def ainvoke(self,messages):
            print('MODEL_STARTED',flush=True);await asyncio.Event().wait()
    await TaskManager(root).advance(task_id,lambda _:Waiting())

if __name__=='__main__':
    if len(sys.argv)==4:asyncio.run(worker(sys.argv[2],sys.argv[3]))
    else:unittest.main()
