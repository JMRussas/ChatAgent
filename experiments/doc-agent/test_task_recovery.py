"""Operator inspection and abandonment of orphaned document tasks."""
import asyncio
from contextlib import closing
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from chat_bridge import ConversationTasks,BridgeError
from task_manager import TaskManager,TaskError,row_digest
from test_durable import fixture_corpus,Scripted

HERE=Path(__file__).resolve().parent
SCOPE={'conversationId':'c','userId':'u'}


def seed(root,status):
    """One bound task in the given persisted status, with no live owner."""
    manager=ConversationTasks(root,{'name':'fixture'},fixture_corpus()).manager  # creates the tables
    task=manager.submit('Question',fixture_corpus(),{'name':'fixture'})
    with manager.connect() as c:
        c.execute('INSERT INTO owners VALUES (?,?)',('c','u'))
        c.execute('INSERT INTO bindings VALUES (?,?,?,?)',('r',task,'c','Question'))
        c.execute('UPDATE tasks SET status=? WHERE id=?',(status,task))
    return task


def rows(root):
    with closing(sqlite3.connect(Path(root)/'tasks.sqlite')) as c:
        return {t:c.execute(f'SELECT * FROM {t}').fetchall() for t in ('owners','tasks','bindings')}


class Recovery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir=tempfile.TemporaryDirectory();self.root=self.dir.name

    async def asyncTearDown(self):
        await self.bridge.close() if hasattr(self,'bridge') else None
        self.dir.cleanup()

    def open(self):
        self.bridge=ConversationTasks(self.root,{'name':'fixture'},fixture_corpus())
        return self.bridge

    async def inspect(self,task,**scope):
        return await self.bridge.command({**SCOPE,**scope,'op':'inspect_task','taskId':task})

    async def abandon(self,task,operation,digest,**scope):
        return await self.bridge.command({**SCOPE,**scope,'op':'abandon_task','taskId':task,
                                          'operationId':operation,'expectedDigest':digest})

    async def test_inspection_is_bounded_and_from_one_row(self):
        task=seed(self.root,'running');b=self.open()
        view=await self.inspect(task)
        self.assertEqual(set(view),{'taskId','persistedStatus','effectiveStatus','ownerActive','digest',
                                    'createdAt','updatedAt','modelCalls','toolCalls','abandonment'})
        self.assertEqual((view['persistedStatus'],view['effectiveStatus'],view['ownerActive']),('running','uncertain',False))
        status,text=rows(self.root)['tasks'][0][1:]
        self.assertEqual(view['digest'],row_digest(status,text))
        self.assertNotIn('Question',json.dumps(view))

    async def test_abandons_an_orphan_and_replays_exactly(self):
        for status in ('running','cancel_requested'):
            with self.subTest(status=status):
                self.dir.cleanup();self.dir=tempfile.TemporaryDirectory();self.root=self.dir.name
                task=seed(self.root,status);b=self.open()
                view=await self.inspect(task);op=str(uuid.uuid4())
                done=await self.abandon(task,op,view['digest'])
                self.assertEqual(done['receipt']['previousStatus'],status)
                self.assertEqual(done['receipt']['externalOutcome'],'unknown')
                self.assertEqual(done['task']['persistedStatus'],'abandoned')
                self.assertEqual(await self.abandon(task,op,view['digest']),done)
                with self.assertRaisesRegex(BridgeError,'OPERATION_CONFLICT'):await self.abandon(task,op,'0'*64)
                with self.assertRaisesRegex(BridgeError,'ALREADY_ABANDONED'):await self.abandon(task,str(uuid.uuid4()),view['digest'])
                listed=(await b.command({**SCOPE,'op':'list'}))[0]
                self.assertEqual((listed['status'],listed['answer'],listed['externalOutcome']),('abandoned',None,'unknown'))
                await b.close();del self.bridge

    async def test_refuses_what_is_not_a_confirmed_orphan(self):
        for status in ('queued','paused','completed','cancelled','failed'):
            with self.subTest(status=status):
                self.dir.cleanup();self.dir=tempfile.TemporaryDirectory();self.root=self.dir.name
                task=seed(self.root,status);self.open()
                view=await self.inspect(task)
                with self.assertRaisesRegex(BridgeError,'NOT_ABANDONABLE'):await self.abandon(task,str(uuid.uuid4()),view['digest'])
                await self.bridge.close();del self.bridge

    async def test_a_held_owner_or_checkpoint_lock_blocks_abandonment(self):
        task=seed(self.root,'running');b=self.open()
        view=await self.inspect(task);before=rows(self.root)
        for suffix in ('.owner','.sqlite.lock'):
            with self.subTest(lock=suffix),closing(sqlite3.connect(Path(self.root)/f'{task}{suffix}')) as held:
                held.execute('BEGIN EXCLUSIVE')
                with self.assertRaisesRegex(BridgeError,'TASK_OWNER_ACTIVE'):await self.abandon(task,str(uuid.uuid4()),view['digest'])
        self.assertEqual(rows(self.root),before)

    async def test_a_changed_row_or_scope_refuses_the_action(self):
        task=seed(self.root,'running');b=self.open()
        view=await self.inspect(task)
        with b.manager.connect() as c:c.execute('UPDATE tasks SET status=? WHERE id=?',('cancel_requested',task))
        with self.assertRaisesRegex(BridgeError,'TASK_CHANGED'):await self.abandon(task,str(uuid.uuid4()),view['digest'])
        # The owner changes between inspection and action: refused inside the transaction.
        view=await self.inspect(task)
        guarded=b.manager.abandon
        def change_owner_first(*args):
            with b.manager.connect() as c:c.execute('UPDATE owners SET user=? WHERE conversation=?',('v','c'))
            return guarded(*args)
        with patch.object(b.manager,'abandon',side_effect=change_owner_first):
            with self.assertRaisesRegex(BridgeError,'OWNER_MISMATCH'):await self.abandon(task,str(uuid.uuid4()),view['digest'])
        self.assertEqual(rows(self.root)['tasks'][0][1],'cancel_requested')

    async def test_scope_is_required(self):
        task=seed(self.root,'running');self.open()
        with self.assertRaisesRegex(BridgeError,'OWNER_MISMATCH'):await self.inspect(task,userId='v')
        with self.assertRaisesRegex(BridgeError,'TASK_NOT_FOUND'):await self.inspect(task,conversationId='d')
        with self.assertRaisesRegex(BridgeError,'INVALID_REQUEST'):await self.abandon(task,'not-a-uuid','0'*64)
        with self.assertRaisesRegex(BridgeError,'INVALID_REQUEST'):await self.abandon(task,str(uuid.uuid4()),'XYZ')

    async def test_corrupt_receipts_and_inconsistent_rows_are_unavailable(self):
        task=seed(self.root,'running');b=self.open()
        status,text=rows(self.root)['tasks'][0][1:]
        p=json.loads(text)
        for bad_status,abandonment in (('abandoned',None),('running',{'operationId':'x'}),
                                       ('abandoned',{**dict.fromkeys(('operationId','expectedDigest','previousStatus','abandonedAt','externalOutcome'),'?')})):
            with self.subTest(status=bad_status):
                stored={**p,**({'abandonment':abandonment} if abandonment else {})}
                with b.manager.connect() as c:c.execute('UPDATE tasks SET status=?,payload=? WHERE id=?',(bad_status,json.dumps(stored),task))
                before=rows(self.root)
                with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await self.inspect(task)
                with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await self.abandon(task,str(uuid.uuid4()),'0'*64)
                self.assertEqual(rows(self.root),before)

    async def test_unexpected_stored_values_are_unavailable(self):
        task=seed(self.root,'running');b=self.open()
        status,text=rows(self.root)['tasks'][0][1:]
        p=json.loads(text)
        receipt={'operationId':'a'*36,'expectedDigest':'0'*64,'previousStatus':'running','abandonedAt':1.0,'externalOutcome':'unknown'}
        for bad_status,payload in (('mystery',p),('running',{**p,'version':True}),('running',{**p,'version':1.0}),
                                   ('running',{**p,'result':[]}),('running',{**p,'result':False}),('running',{**p,'result':''}),
                                   ('abandoned',{**p,'abandonment':receipt}),
                                   ('abandoned',{**p,'abandonment':{**receipt,'operationId':str(uuid.uuid4()),'expectedDigest':0}})):
            with self.subTest(status=bad_status,payload=str(payload.get('version'))+str(payload.get('result'))):
                with b.manager.connect() as c:c.execute('UPDATE tasks SET status=?,payload=? WHERE id=?',(bad_status,json.dumps(payload),task))
                with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await self.inspect(task)

    async def test_an_oversized_stored_row_is_unavailable_without_parsing(self):
        task=seed(self.root,'running');self.open()
        with patch('task_manager.MAX_PAYLOAD_BYTES',100),patch('task_manager.json.loads') as loads:
            with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await self.inspect(task)
            loads.assert_not_called()

    async def test_bad_times_or_counts_block_abandonment_without_any_write(self):
        task=seed(self.root,'running');b=self.open()
        status,text=rows(self.root)['tasks'][0][1:]
        p=json.loads(text)
        for name,payload in (('created_at',{**p,'created_at':'yesterday'}),('updated_at',{**p,'updated_at':float('nan')}),
                             ('updated_at',{**p,'updated_at':-1}),('created_at',{**p,'created_at':True}),
                             ('model_calls',{**p,'result':{'model_calls':-1}}),('tool_calls',{**p,'result':{'tool_calls':1.5}}),
                             ('model_calls',{**p,'result':{'model_calls':10**10}})):
            with self.subTest(field=name,value=str(payload.get(name,payload.get('result')))):
                raw=json.dumps(payload)
                with b.manager.connect() as c:c.execute('UPDATE tasks SET status=?,payload=? WHERE id=?',('running',raw,task))
                before=rows(self.root)
                # The exact digest of the raw row, as a caller would have it.
                with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):
                    await self.abandon(task,str(uuid.uuid4()),row_digest('running',raw))
                self.assertEqual(rows(self.root),before)

    async def test_abandoned_never_runs_cancels_or_restarts(self):
        task=seed(self.root,'running');b=self.open()
        view=await self.inspect(task)
        await self.abandon(task,str(uuid.uuid4()),view['digest'])
        before=rows(self.root)
        with patch.object(b,'schedule') as schedule:
            self.assertEqual((await b.command({**SCOPE,'op':'cancel','taskId':task}))['status'],'abandoned')
            with self.assertRaisesRegex(BridgeError,'NOT_RESUMABLE'):await b.command({**SCOPE,'op':'resume','taskId':task})
            again=await b.command({**SCOPE,'op':'start','requestId':'r','question':'Question'})
            schedule.assert_not_called()
        self.assertEqual((again['taskId'],again['status']),(task,'abandoned'))
        self.assertEqual((await b.manager.advance(task,lambda _:self.fail('model called')))['status'],'abandoned')
        self.assertEqual(rows(self.root),before)

    def test_a_crash_before_commit_changes_nothing_and_after_commit_keeps_the_receipt(self):
        for stage in ('before','after'):
            with self.subTest(stage=stage),tempfile.TemporaryDirectory() as root:
                task=seed(root,'running')
                manager=TaskManager(root)
                status,text=rows(root)['tasks'][0][1:]
                script=f'''
import os,sys
from task_manager import TaskManager
m=TaskManager(sys.argv[1]);real=m.transaction
from contextlib import contextmanager
@contextmanager
def dying():
    with real() as c:
        original=c.execute
        class Proxy:
            def execute(self,sql,*a):
                if sql.startswith('UPDATE tasks') and sys.argv[4]=='before':
                    original(sql,*a);os._exit(3)
                return original(sql,*a)
        yield Proxy()
    if sys.argv[4]=='after':os._exit(3)
m.transaction=dying
m.abandon(sys.argv[2],"{uuid.uuid4()}",sys.argv[3])
'''
                done=subprocess.run([sys.executable,'-c',script,root,task,row_digest(status,text),stage],cwd=HERE,capture_output=True,text=True,timeout=60)
                self.assertEqual(done.returncode,3,done.stderr)
                after=rows(root)['tasks'][0][1]
                self.assertEqual(after,'running' if stage=='before' else 'abandoned')
                if stage=='after':self.assertEqual(manager.inspect(task)['abandonment']['previousStatus'],'running')


OWNER='o1:'+'P'*43+':'+'K'*43
OTHER='o1:'+'Q'*43+':'+'K'*43


class RecoveryThroughStoredOwner(unittest.IsolatedAsyncioTestCase):
    """recover_inspect and recover_abandon: the owner comes from the store, never the caller."""
    async def asyncSetUp(self):
        self.dir=tempfile.TemporaryDirectory();self.root=self.dir.name
        self.task=seed(self.root,'running')
        self.set_owner(OWNER)
        self.bridge=ConversationTasks(self.root,{'name':'fixture'},fixture_corpus())

    async def asyncTearDown(self):
        await self.bridge.close();self.dir.cleanup()

    def set_owner(self,owner):
        with closing(sqlite3.connect(Path(self.root)/'tasks.sqlite')) as c,c:
            c.execute('UPDATE owners SET user=? WHERE conversation=?',(owner,'c'))

    async def inspect(self,**fields):
        return await self.bridge.command({'op':'recover_inspect','conversationId':'c','taskId':self.task,**fields})

    async def abandon(self,digest,operation=None,**fields):
        return await self.bridge.command({'op':'recover_abandon','conversationId':'c','taskId':self.task,
                                          'operationId':operation or str(uuid.uuid4()),'expectedDigest':digest,**fields})

    async def test_inspects_through_the_stored_owner_without_writing(self):
        before=rows(self.root)
        for fields in ({},{'expectedOwner':OWNER}):
            with self.subTest(fields=fields):
                view=await self.inspect(**fields)
                self.assertEqual((view['taskId'],view['effectiveStatus']),(self.task,'uncertain'))
                self.assertNotIn(OWNER,json.dumps(view))
        self.assertEqual(rows(self.root),before)

    async def test_abandons_and_replays_through_either_path(self):
        view=await self.inspect();op=str(uuid.uuid4())
        done=await self.abandon(view['digest'],op)
        self.assertEqual(done['task']['persistedStatus'],'abandoned')
        self.assertEqual(await self.abandon(view['digest'],op,expectedOwner=OWNER),done)
        # The receipt is the same one the owner-scoped operation replays.
        replayed=await self.bridge.command({'op':'abandon_task','conversationId':'c','userId':OWNER,'taskId':self.task,
                                            'operationId':op,'expectedDigest':view['digest']})
        self.assertEqual(replayed,done)
        data=rows(self.root)
        self.assertEqual((data['owners'],len(data['bindings'])),([('c',OWNER)],1))

    async def test_refuses_an_unbound_task_or_another_conversation(self):
        with self.assertRaisesRegex(BridgeError,'TASK_NOT_FOUND'):await self.inspect(conversationId='d')
        with self.assertRaisesRegex(BridgeError,'TASK_NOT_FOUND'):await self.inspect(taskId='0'*32)
        with self.assertRaisesRegex(BridgeError,'TASK_NOT_FOUND'):await self.abandon('0'*64,conversationId='d')

    async def test_a_binding_without_an_owner_is_unavailable(self):
        with closing(sqlite3.connect(Path(self.root)/'tasks.sqlite')) as c,c:c.execute('DELETE FROM owners')
        before=rows(self.root)
        with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await self.inspect()
        with self.assertRaisesRegex(BridgeError,'TASK_UNAVAILABLE'):await self.abandon('0'*64)
        self.assertEqual(rows(self.root),before)

    async def test_legacy_or_unscoped_owners_are_refused_not_adopted(self):
        for owner in ('u','o1:short:x',OWNER+'x',OWNER+'\n','o1:'+'P'*43+':'+'K'*42+'=',OWNER.upper()):
            with self.subTest(owner=owner):
                self.set_owner(owner);before=rows(self.root)
                with self.assertRaisesRegex(BridgeError,'OWNER_UNSCOPED'):await self.inspect()
                with self.assertRaisesRegex(BridgeError,'OWNER_UNSCOPED'):await self.inspect(expectedOwner=owner)
                with self.assertRaisesRegex(BridgeError,'OWNER_UNSCOPED'):await self.abandon('0'*64)
                self.assertEqual(rows(self.root),before)

    async def test_a_different_expected_owner_is_refused(self):
        view=await self.inspect()
        with self.assertRaisesRegex(BridgeError,'OWNER_MISMATCH'):await self.inspect(expectedOwner=OTHER)
        with self.assertRaisesRegex(BridgeError,'OWNER_MISMATCH'):await self.abandon(view['digest'],expectedOwner=OTHER)
        self.assertEqual(rows(self.root)['tasks'][0][1],'running')

    async def test_requests_are_validated_and_never_carry_a_user(self):
        cases=[{'userId':OWNER},{'userId':None},{'conversationId':''},{'conversationId':'c'*201},{'conversationId':7},
               {'taskId':'A'*32},{'taskId':'0'*31},{'taskId':None},{'expectedOwner':''},{'expectedOwner':'o'*201},
               {'expectedOwner':1},{'expectedOwner':None},{'expectedOwner':False},{'expectedOwner':True},
               {'expectedOwner':[OWNER]},{'expectedOwner':{'owner':OWNER}}]
        for fields in cases:
            with self.subTest(fields=fields):
                with self.assertRaisesRegex(BridgeError,'INVALID_'):await self.inspect(**fields)
        for operation,digest in (('not-a-uuid','0'*64),('ABCDEF01-2345-4678-9ABC-DEF012345678','0'*64),(None,'0'*64),(str(uuid.uuid4()),'XYZ'),(str(uuid.uuid4()),None)):
            with self.subTest(operation=operation,digest=digest):
                with self.assertRaisesRegex(BridgeError,'INVALID_REQUEST'):
                    await self.bridge.command({'op':'recover_abandon','conversationId':'c','taskId':self.task,
                                               'operationId':operation,'expectedDigest':digest})
        self.assertEqual(rows(self.root)['tasks'][0][1],'running')

    async def test_owner_drift_inside_the_transaction_refuses(self):
        # The lookup sees OWNER; the abandonment's own transaction then sees another row.
        for drifted,code in ((OTHER,'OWNER_MISMATCH'),('u','OWNER_UNSCOPED'),(None,'TASK_UNAVAILABLE')):
            with self.subTest(drifted=drifted):
                self.set_owner(OWNER);view=await self.inspect()
                guarded=self.bridge.manager.abandon
                def drift_first(*args):
                    with closing(sqlite3.connect(Path(self.root)/'tasks.sqlite')) as c,c:
                        if drifted is None:c.execute('DELETE FROM owners')
                        else:c.execute('UPDATE owners SET user=? WHERE conversation=?',(drifted,'c'))
                    return guarded(*args)
                with patch.object(self.bridge.manager,'abandon',side_effect=drift_first):
                    with self.assertRaisesRegex(BridgeError,code):await self.abandon(view['digest'])
                self.assertEqual(rows(self.root)['tasks'][0][1],'running')
                with closing(sqlite3.connect(Path(self.root)/'tasks.sqlite')) as c,c:
                    c.execute('INSERT OR REPLACE INTO owners VALUES (?,?)',('c',OWNER))

    async def test_a_moved_binding_inside_the_transaction_refuses(self):
        view=await self.inspect();guarded=self.bridge.manager.abandon
        def move_first(*args):
            with closing(sqlite3.connect(Path(self.root)/'tasks.sqlite')) as c,c:
                c.execute('UPDATE bindings SET conversation=? WHERE task=?',('d',self.task))
            return guarded(*args)
        with patch.object(self.bridge.manager,'abandon',side_effect=move_first):
            with self.assertRaisesRegex(BridgeError,'TASK_NOT_FOUND'):await self.abandon(view['digest'])
        self.assertEqual(rows(self.root)['tasks'][0][1],'running')

    async def test_replay_rechecks_the_owner_first(self):
        view=await self.inspect();op=str(uuid.uuid4())
        await self.abandon(view['digest'],op)
        self.set_owner(OTHER)
        # The lookup itself now resolves OTHER; an expected owner exposes the drift.
        with self.assertRaisesRegex(BridgeError,'OWNER_MISMATCH'):await self.abandon(view['digest'],op,expectedOwner=OWNER)
        guarded=self.bridge.manager.abandon
        def drift_first(*args):
            self.set_owner('u');return guarded(*args)
        self.set_owner(OWNER)
        with patch.object(self.bridge.manager,'abandon',side_effect=drift_first):
            with self.assertRaisesRegex(BridgeError,'OWNER_UNSCOPED'):await self.abandon(view['digest'],op)

    async def test_recovery_never_claims_an_owner(self):
        with closing(sqlite3.connect(Path(self.root)/'tasks.sqlite')) as c,c:
            c.execute('DELETE FROM bindings');c.execute('DELETE FROM owners')
        with self.assertRaisesRegex(BridgeError,'TASK_NOT_FOUND'):await self.inspect()
        self.assertEqual(rows(self.root)['owners'],[])


class RecoveryCandidates(unittest.IsolatedAsyncioTestCase):
    """recover_list: bound, unfinished tasks for operators; read-only and bounded."""
    async def asyncSetUp(self):
        self.dir=tempfile.TemporaryDirectory();self.root=self.dir.name
        self.bridge=ConversationTasks(self.root,{'name':'fixture'},fixture_corpus())
        self.manager=self.bridge.manager

    async def asyncTearDown(self):
        await self.bridge.close();self.dir.cleanup()

    def add(self,status,conversation='c',owner=OWNER,bound=True):
        task=self.manager.submit('Question',fixture_corpus(),{'name':'fixture'})
        with self.manager.connect() as c:
            if owner is not None:c.execute('INSERT OR IGNORE INTO owners VALUES (?,?)',(conversation,owner))
            if bound:c.execute('INSERT INTO bindings VALUES (?,?,?,?)',(f'r-{task}',task,conversation,'Question'))
            c.execute('UPDATE tasks SET status=? WHERE id=?',(status,task))
        return task

    async def page(self,**fields):
        return await self.bridge.command({'op':'recover_list','limit':100,**fields})

    async def test_lists_bound_unfinished_tasks_only_and_writes_nothing(self):
        listed=sorted([self.add('running'),self.add('cancel_requested')])
        for status in ('queued','paused','completed','failed','cancelled'):self.add(status)
        self.add('running',bound=False)
        before=rows(self.root);files=sorted(p.name for p in Path(self.root).iterdir())
        page=await self.page()
        self.assertEqual([t['taskId'] for t in page['tasks']],listed)
        # Not even an owner lock file is created by the advisory probe.
        self.assertEqual(sorted(p.name for p in Path(self.root).iterdir()),files)
        self.assertIsNone(page['nextAfter'])
        for item in page['tasks']:
            self.assertEqual((item['conversationId'],item['ownerScope'],item['effectiveStatus'],item['ownerActive']),
                             ('c','scoped','uncertain',False))
        self.assertNotIn(OWNER,json.dumps(page))
        self.assertNotIn('Question',json.dumps(page))
        self.assertEqual(rows(self.root),before)

    async def test_reports_owner_scope_without_the_key(self):
        scoped=self.add('running','a',OWNER);legacy=self.add('running','b','u');missing=self.add('running','d',None)
        scopes={t['taskId']:t['ownerScope'] for t in (await self.page())['tasks']}
        self.assertEqual(scopes,{scoped:'scoped',legacy:'unscoped',missing:'missing'})

    async def test_an_active_owner_is_listed_as_advisory_running(self):
        task=self.add('running')
        with closing(sqlite3.connect(Path(self.root)/f'{task}.owner')) as held:
            held.execute('BEGIN EXCLUSIVE')
            item=(await self.page())['tasks'][0]
        self.assertEqual((item['ownerActive'],item['effectiveStatus']),(True,'running'))

    async def test_an_owner_file_that_cannot_be_opened_counts_as_held(self):
        task=self.add('running')
        (Path(self.root)/f'{task}.owner').mkdir()
        item=(await self.page())['tasks'][0]
        self.assertEqual((item['ownerActive'],item['effectiveStatus']),(True,'running'))

    def test_the_owner_probe_works_from_a_relative_root(self):
        import os
        cwd=os.getcwd();os.chdir(self.root)
        try:
            manager=TaskManager('relative-root')
            task='a'*32;path=Path('relative-root')/f'{task}.owner'
            self.assertTrue(manager.owner_available(task))          # missing: free, not created
            self.assertFalse(path.exists())
            with closing(sqlite3.connect(path)) as held:
                held.execute('BEGIN EXCLUSIVE')
                self.assertFalse(manager.owner_available(task))     # held
            self.assertTrue(manager.owner_available(task))          # released
        finally:os.chdir(cwd)

    async def test_pages_are_stable_and_exhaustive(self):
        tasks=sorted(self.add('running') for _ in range(5))
        seen,after=[],None
        for _ in range(4):
            page=await self.page(limit=2,**({'afterTaskId':after} if after else {}))
            seen+= [t['taskId'] for t in page['tasks']]
            after=page['nextAfter']
            if after is None:break
        self.assertEqual(seen,tasks)
        self.assertEqual((await self.page(limit=5))['nextAfter'],None)
        self.assertEqual((await self.page(limit=4))['nextAfter'],tasks[3])

    async def test_a_corrupt_or_oversized_row_is_unavailable_without_hiding_others(self):
        good=self.add('running');bad=self.add('running')
        with self.manager.connect() as c:c.execute('UPDATE tasks SET payload=? WHERE id=?',('not json',bad))
        items={t['taskId']:t for t in (await self.page())['tasks']}
        self.assertEqual(items[bad],{'taskId':bad,'conversationId':'c','unavailable':True})
        self.assertEqual(items[good]['effectiveStatus'],'uncertain')
        # Over the per-row limit: unavailable, and never handed to the parser.
        with patch('task_manager.MAX_PAYLOAD_BYTES',5),patch('task_manager._stored',side_effect=AssertionError('read')):
            items=(await self.page())['tasks']
        self.assertTrue(all(t['unavailable'] for t in items))

    async def test_corrupt_rows_still_spend_the_page_budget(self):
        # Rows that are read and then refused as corrupt count against the budget,
        # so many corrupt rows cannot each use the per-row allowance.
        tasks=sorted(self.add('running') for _ in range(3))
        with self.manager.connect() as c:
            for t in tasks:c.execute('UPDATE tasks SET payload=? WHERE id=?',('x'*1000,t))
        with patch('chat_bridge.LIST_PAYLOAD_BUDGET',1500):
            page=await self.page()
        self.assertEqual(page['tasks'],[{'taskId':tasks[0],'conversationId':'c','unavailable':True}])
        self.assertEqual(page['nextAfter'],tasks[0])

    async def test_stored_strings_are_bounded_before_they_are_read(self):
        long_owner=self.add('running','a','x'*300)
        long_binding=self.add('running','c'*300)
        items={t['taskId']:t for t in (await self.page())['tasks']}
        self.assertEqual(items[long_owner]['ownerScope'],'unscoped')
        self.assertEqual(items[long_binding],{'taskId':long_binding,'conversationId':None,'unavailable':True})

    async def test_a_row_growing_after_enumeration_cannot_exceed_the_budget(self):
        tasks=sorted(self.add('running') for _ in range(3))
        with self.manager.connect() as c:
            sizes=dict(c.execute('SELECT id,length(CAST(payload AS BLOB)) FROM tasks').fetchall())
        real=self.manager.inspect_within;parsed=[]
        def grow_second(task_id,max_bytes):
            if task_id==tasks[1]:
                with self.manager.connect() as c:
                    c.execute("UPDATE tasks SET payload=json_set(payload,'$.padding',?) WHERE id=?",('x'*5000,task_id))
            return real(task_id,max_bytes)
        import task_manager
        stored=task_manager._stored
        def record(status,text):
            parsed.append(len(text.encode()));return stored(status,text)
        with patch('chat_bridge.LIST_PAYLOAD_BUDGET',sizes[tasks[0]]+sizes[tasks[1]]),                patch.object(self.manager,'inspect_within',side_effect=grow_second),patch('task_manager._stored',side_effect=record):
            page=await self.page()
        # The grown row no longer fits what is left: the page stops before reading it.
        self.assertEqual([t['taskId'] for t in page['tasks']],tasks[:1])
        self.assertEqual(page['nextAfter'],tasks[0])
        self.assertLessEqual(sum(parsed),sizes[tasks[0]]+sizes[tasks[1]])
        # The next page starts with it, read whole as that page's first row.
        nxt=await self.page(afterTaskId=page['nextAfter'])
        self.assertEqual(nxt['tasks'][0]['taskId'],tasks[1])

    async def test_payload_reads_are_bounded_per_page(self):
        tasks=sorted(self.add('running') for _ in range(3))
        with self.manager.connect() as c:
            sizes=dict(c.execute('SELECT id,length(CAST(payload AS BLOB)) FROM tasks').fetchall())
        with patch('chat_bridge.LIST_PAYLOAD_BUDGET',sizes[tasks[0]]+sizes[tasks[1]]):
            page=await self.page()
        self.assertEqual([t['taskId'] for t in page['tasks']],tasks[:2])
        self.assertEqual(page['nextAfter'],tasks[1])
        with patch('chat_bridge.LIST_PAYLOAD_BUDGET',1):
            page=await self.page()
        self.assertEqual(len(page['tasks']),1)   # at least one row per page

    async def test_requests_are_validated_and_never_carry_a_scope(self):
        before=rows(self.root)
        for fields in ({'limit':0},{'limit':101},{'limit':'5'},{'limit':True},{'limit':None},{'limit':1.0},
                       {'afterTaskId':'A'*32},{'afterTaskId':'0'*31},{'afterTaskId':None},
                       {'userId':OWNER},{'conversationId':'c'}):
            with self.subTest(fields=fields):
                with self.assertRaisesRegex(BridgeError,'INVALID_REQUEST'):
                    await self.bridge.command({'op':'recover_list','limit':10,**fields})
        with self.assertRaisesRegex(BridgeError,'INVALID_REQUEST'):
            await self.bridge.command({'op':'recover_list'})
        self.assertEqual(rows(self.root),before)


class CheckpointPreserved(unittest.IsolatedAsyncioTestCase):
    async def test_a_real_paused_checkpoint_and_rows_survive_abandonment(self):
        with tempfile.TemporaryDirectory() as root:
            b=ConversationTasks(root,{'name':'fixture'},fixture_corpus(),lambda _:Scripted(str(Path(root)/'calls')))
            with patch.object(b,'schedule'):
                task=(await b.command({**SCOPE,'op':'start','requestId':'r','question':'Question'}))['taskId']
            result=await b.manager.advance(task,lambda _:Scripted(str(Path(root)/'calls')))
            self.assertEqual(result['status'],'paused')
            with b.manager.connect() as c:c.execute("UPDATE tasks SET status='running' WHERE id=?",(task,))
            checkpoint=Path(root)/f'{task}.sqlite'
            digest=hashlib.sha256(checkpoint.read_bytes()).hexdigest()
            view=await b.command({**SCOPE,'op':'inspect_task','taskId':task})
            self.assertEqual(view['modelCalls'],1)
            await b.command({**SCOPE,'op':'abandon_task','taskId':task,'operationId':str(uuid.uuid4()),'expectedDigest':view['digest']})
            self.assertEqual(hashlib.sha256(checkpoint.read_bytes()).hexdigest(),digest)
            data=rows(root)
            self.assertEqual((len(data['owners']),len(data['bindings'])),(1,1))
            await b.close()


if __name__=='__main__':unittest.main()
