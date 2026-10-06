"""Atomic creation of a started task: owner, queued task and binding, all or none."""
import asyncio
from contextlib import closing, contextmanager
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from chat_bridge import ConversationTasks,BridgeError
from task_manager import TaskManager
from test_durable import fixture_corpus
from test_agent import FakeModel

HERE=Path(__file__).resolve().parent
START={'op':'start','conversationId':'c','userId':'u','requestId':'r','question':'Question'}

def rows(root):
    with closing(sqlite3.connect(Path(root)/'tasks.sqlite')) as c:
        return {t:c.execute(f'SELECT * FROM {t}').fetchall() for t in ('owners','tasks','bindings')}

def counts(root):
    return {t:len(r) for t,r in rows(root).items()}

EMPTY={'owners':0,'tasks':0,'bindings':0}
ONE={'owners':1,'tasks':1,'bindings':1}

class Fault(Exception):pass

class CreationTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejected_starts_leave_no_rows(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus(),capacity=0)
            for change,code in (({'requestId':''},'INVALID_REQUEST'),({'question':' '},'INVALID_QUESTION'),
                                ({'userId':''},'INVALID_SCOPE'),({},'CAPACITY_FULL')):
                with self.assertRaisesRegex(BridgeError,code):await b.command({**START,**change})
            await b.close()
            b=ConversationTasks(td,None,fixture_corpus())
            with patch('chat_bridge.identity_for',side_effect=ValueError('Model not installed')):
                with self.assertRaisesRegex(ValueError,'Model not installed'):await b.command(START)
            await b.close()
            self.assertEqual(counts(td),EMPTY)

    async def test_a_fault_at_any_step_before_commit_rolls_back_every_new_row(self):
        def failing(target,name,when):
            original=getattr(target,name)
            def wrapper(*args):
                if when=='before':raise Fault(name)
                original(*args);raise Fault(name)
            return wrapper
        steps=[('bridge','claim'),('manager','insert'),('bridge','bind')]
        for owner,name in steps:
            for when in ('before','after'):
                with self.subTest(step=f'{when} {name}'),tempfile.TemporaryDirectory() as td:
                    b=ConversationTasks(td,{},fixture_corpus())
                    target=b if owner=='bridge' else b.manager
                    with patch.object(b,'schedule') as schedule:
                        with patch.object(target,name,failing(target,name,when)):
                            with self.assertRaises(Fault):await b.command(START)
                        self.assertEqual(counts(td),EMPTY)
                        schedule.assert_not_called()
                        # Nothing is left behind: the same request now creates its task.
                        created=await b.command(START)
                        self.assertEqual(counts(td),ONE)
                        schedule.assert_called_once_with(created['taskId'])
                    await b.close()

    async def test_a_failed_commit_schedules_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus())
            @contextmanager
            def failing_commit():
                # Everything is written, then the commit fails and is rolled back.
                with closing(sqlite3.connect(b.manager.registry,timeout=5,isolation_level=None)) as c:
                    c.execute('BEGIN IMMEDIATE')
                    try:yield c
                    finally:c.execute('ROLLBACK')
                    raise sqlite3.OperationalError('disk I/O error')
            with patch.object(b,'schedule') as schedule:
                with patch.object(b.manager,'transaction',failing_commit):
                    with self.assertRaises(sqlite3.OperationalError):await b.command(START)
                schedule.assert_not_called()
            self.assertEqual(counts(td),EMPTY)
            await b.close()

    def run_dying(self,root,stage):
        # A real process dies abruptly at the given point; nothing is cleaned up.
        script=f'''
import asyncio,os,sys
from chat_bridge import ConversationTasks
from test_durable import fixture_corpus
async def main():
    b=ConversationTasks(sys.argv[1],{{}},fixture_corpus())
    if sys.argv[2]=='inside':
        bind=b.bind
        def die(*args):
            bind(*args);os._exit(3)
        b.bind=die
    else:
        b.schedule=lambda task_id:os._exit(3)
    await b.command({START!r})
asyncio.run(main())
'''
        done=subprocess.run([sys.executable,'-c',script,root,stage],cwd=HERE,capture_output=True,text=True,timeout=60)
        self.assertEqual(done.returncode,3,done.stderr)

    async def test_death_inside_the_transaction_leaves_no_partial_triple(self):
        with tempfile.TemporaryDirectory() as td:
            self.run_dying(td,'inside')
            self.assertEqual(counts(td),EMPTY)

    async def test_death_after_commit_leaves_one_bound_task_that_a_retry_returns_unscheduled(self):
        with tempfile.TemporaryDirectory() as td:
            self.run_dying(td,'after-commit')
            self.assertEqual(counts(td),ONE)
            b=ConversationTasks(td,None,fixture_corpus())
            with patch.object(b,'schedule') as schedule,patch('chat_bridge.identity_for') as identify:
                again=await b.command(START)
                schedule.assert_not_called();identify.assert_not_called()
            self.assertEqual((again['status'],again['scheduled']),('queued',False))
            self.assertEqual(again['taskId'],rows(td)['tasks'][0][0])
            self.assertEqual(counts(td),ONE)
            await b.close()

    async def test_a_retry_after_a_lost_response_does_not_schedule_or_call_the_model_again(self):
        with tempfile.TemporaryDirectory() as td:
            entered=asyncio.Event();calls=[]
            class Waiting(FakeModel):
                async def ainvoke(self,messages):calls.append(True);entered.set();await asyncio.Event().wait()
            b=ConversationTasks(td,{},fixture_corpus(),lambda _:Waiting())
            first=await b.command(START);await asyncio.wait_for(entered.wait(),3)
            with patch.object(b,'schedule',wraps=b.schedule) as schedule:
                again=await b.command(START)
                schedule.assert_not_called()
            self.assertEqual(again['taskId'],first['taskId'])
            await asyncio.sleep(0.05)
            self.assertEqual(len(calls),1)
            self.assertEqual(counts(td),ONE)
            await b.close()

    async def test_concurrent_duplicates_create_one_task(self):
        with tempfile.TemporaryDirectory() as td:
            # Two bridges on one store, both past the first binding check before either
            # writes: the transaction's own check decides.
            bridges=[ConversationTasks(td,None,fixture_corpus()) for _ in range(2)]
            meet=threading.Barrier(2,timeout=5)
            def identity(*_):meet.wait();return {}
            scheduled=[]
            for b in bridges:b.schedule=scheduled.append
            with patch('chat_bridge.identity_for',side_effect=identity):
                results=await asyncio.gather(*(b.command(START) for b in bridges))
            self.assertEqual(results[0]['taskId'],results[1]['taskId'])
            self.assertEqual(scheduled,[results[0]['taskId']])
            self.assertEqual(counts(td),ONE)
            # A concurrent start with other content conflicts and changes nothing.
            # The first round cached the identity; clear it so both bridges again meet
            # at the barrier before either writes.
            meet.reset()
            for b in bridges:b.identity=None
            with patch('chat_bridge.identity_for',side_effect=identity):
                results=await asyncio.gather(*(b.command({**START,'requestId':'r2','question':q}) for b,q in zip(bridges,('One','Two'))),return_exceptions=True)
            self.assertEqual(sum(isinstance(r,BridgeError) and r.code=='REQUEST_CONFLICT' for r in results),1)
            self.assertEqual(counts(td),{'owners':1,'tasks':2,'bindings':2})
            for b in bridges:await b.close()

    async def test_conflicts_and_wrong_owners_change_no_rows(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus())
            with patch.object(b,'schedule'):
                await b.command(START);before=rows(td)
                with self.assertRaisesRegex(BridgeError,'REQUEST_CONFLICT'):await b.command({**START,'question':'Other'})
                with self.assertRaisesRegex(BridgeError,'REQUEST_CONFLICT'):await b.command({**START,'conversationId':'d'})
                with self.assertRaisesRegex(BridgeError,'OWNER_MISMATCH'):await b.command({**START,'userId':'v'})
                with self.assertRaisesRegex(BridgeError,'OWNER_MISMATCH'):await b.command({**START,'userId':'v','requestId':'r2'})
            self.assertEqual(rows(td),before)
            await b.close()

    async def test_an_accepted_request_is_returned_at_full_capacity_without_a_model(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus())
            with patch.object(b,'schedule'):first=await b.command(START)
            await b.close()
            b=ConversationTasks(td,None,fixture_corpus(),capacity=0)
            with patch('chat_bridge.identity_for',side_effect=AssertionError('no lookup')):
                self.assertEqual((await b.command(START))['taskId'],first['taskId'])
                with self.assertRaisesRegex(BridgeError,'CAPACITY_FULL'):await b.command({**START,'requestId':'r2'})
            self.assertEqual(counts(td),ONE)
            await b.close()

    async def test_a_scheduling_failure_after_commit_keeps_the_bound_task(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus())
            with patch.object(b,'schedule',side_effect=BridgeError('CAPACITY_FULL')):
                with self.assertRaisesRegex(BridgeError,'CAPACITY_FULL'):await b.command(START)
            self.assertEqual(counts(td),ONE)
            with patch.object(b,'schedule') as schedule:
                again=await b.command(START);schedule.assert_not_called()
            self.assertEqual((again['status'],again['scheduled']),('queued',False))
            await b.close()

    async def test_a_bound_request_whose_owner_row_is_missing_is_unavailable_to_everyone(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus())
            with patch.object(b,'schedule') as schedule:
                await b.command(START)
                with b.manager.connect() as c:c.execute('DELETE FROM owners')
                before=rows(td)
                # Neither the original user nor any other label reads or reclaims it.
                for user in ('u','v'):
                    with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await b.command({**START,'userId':user})
                self.assertEqual(schedule.call_count,1)
            self.assertEqual(rows(td),before)
            await b.close()

    async def test_a_conversation_with_tasks_but_no_owner_is_unavailable_to_every_operation(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus())
            with patch.object(b,'schedule') as schedule:
                task=(await b.command(START))['taskId']
                with b.manager.connect() as c:c.execute('DELETE FROM owners')
                before=rows(td)
                for user in ('u','v'):
                    for command in ({'op':'list'},{'op':'status','taskId':task},{'op':'resume','taskId':task},
                                    {'op':'cancel','taskId':task},{**START,'requestId':'r2'}):
                        with self.subTest(user=user,op=command['op']):
                            with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):
                                await b.command({'conversationId':'c',**command,'userId':user})
                self.assertEqual(schedule.call_count,1)
            # Nothing was cancelled, claimed, created or repaired.
            self.assertEqual(rows(td),before)
            # A conversation that never had tasks still reads as unclaimed.
            self.assertEqual(await b.command({'op':'list','conversationId':'empty','userId':'v'}),[])
            await b.close()

    async def test_a_binding_without_its_task_or_owner_fails_closed_and_is_not_repaired(self):
        for table in ('tasks','owners'):
            with self.subTest(missing=table),tempfile.TemporaryDirectory() as td:
                b=ConversationTasks(td,{},fixture_corpus())
                with patch.object(b,'schedule') as schedule:
                    await b.command(START)
                    with b.manager.connect() as c:c.execute(f'DELETE FROM {table}')
                    before=rows(td)
                    with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await b.command(START)
                    self.assertEqual(schedule.call_count,1)
                self.assertEqual(rows(td),before)
                await b.close()

    async def test_a_binding_found_inside_the_transaction_is_checked_before_any_owner_write(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,None,fixture_corpus())
            def meanwhile(*_):
                # While the model is looked up, the same request becomes bound to a task
                # whose owner row then vanishes.
                m=TaskManager(td);task=m.submit('Question',fixture_corpus(),{})
                with m.connect() as c:c.execute('INSERT INTO bindings VALUES (?,?,?,?)',('r',task,'c','Question'))
                return {}
            with patch('chat_bridge.identity_for',side_effect=meanwhile),patch.object(b,'schedule') as schedule:
                with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await b.command(START)
                schedule.assert_not_called()
            # The missing owner is not recreated, and no second task is made.
            self.assertEqual(counts(td),{'owners':0,'tasks':1,'bindings':1})
            await b.close()

    def test_submit_still_creates_a_queued_task(self):
        with tempfile.TemporaryDirectory() as td:
            m=TaskManager(td);task=m.submit('Question',fixture_corpus(),{})
            self.assertEqual(m.status(task)['status'],'queued')
            with self.assertRaisesRegex(ValueError,'Invalid question'):m.submit(' ',fixture_corpus(),{})
            with m.connect() as c:self.assertEqual(c.execute('SELECT id,status FROM tasks').fetchall(),[(task,'queued')])

if __name__=='__main__':unittest.main()
