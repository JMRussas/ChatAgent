"""Local multi-task lifecycle around the durable documentation agent.

No scheduler daemon: advance() runs one task to its next pause or terminal result.
Separate processes may advance different tasks; cancellation is persisted and polled.
"""
import asyncio
from contextlib import closing, contextmanager
import json
import math
from pathlib import Path
import re
import sqlite3
import time
import uuid
from durable import run_durable, local_model
from retrieval import Corpus, Source

TERMINAL={'completed','failed','cancelled'}

class TaskManager:
    def __init__(self,root):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.registry=self.root/'tasks.sqlite'
        with self.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL)')

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.registry,timeout=5)) as c, c: yield c

    def path(self,task_id,suffix='sqlite'):
        if not re.fullmatch(r'[0-9a-f]{32}',task_id):raise ValueError('Invalid task ID')
        return self.root/(task_id+'.'+suffix)

    def submit(self,question,corpus,identity,*,options=None):
        if not isinstance(question,str) or not 1<=len(question.strip().encode())<=2000:raise ValueError('Invalid question')
        options=dict(options or {})
        if options.get('deadline_mode','active')!='active':raise ValueError('Managed tasks use active execution time')
        integer_limits={'max_model_calls','max_tool_calls','max_retrieval_bytes','max_input_bytes'}
        durations={'deadline_seconds','call_timeout'}
        allowed=integer_limits|durations|{'deadline_mode','with_examples'}
        if set(options)-allowed:raise ValueError('Unknown task options')
        for key,value in options.items():
            if key in integer_limits and (type(value) is not int or value<=0):
                raise ValueError('Task limits require positive integers')
            if key in durations and (type(value) not in (int,float) or not math.isfinite(value) or value<=0):
                raise ValueError('Task durations require positive finite numbers')
            if key=='with_examples' and type(value) is not bool:raise ValueError('with_examples must be boolean')
        options['deadline_mode']='active'
        task_id=uuid.uuid4().hex
        payload={'version':1,'question':question,'sources':corpus.snapshot(),'identity':identity,
                 'options':options,'created_at':time.time(),'updated_at':time.time(),'result':None,'error':None}
        with self.connect() as c:c.execute('INSERT INTO tasks VALUES (?,?,?)',(task_id,'queued',json.dumps(payload)))
        return task_id

    def load(self,task_id):
        self.path(task_id)
        with self.connect() as c:row=c.execute('SELECT status,payload FROM tasks WHERE id=?',(task_id,)).fetchone()
        if row is None:raise ValueError('Task not found')
        task=json.loads(row[1])
        if task.get('version')!=1:raise ValueError('Unsupported task version')
        return row[0],task

    def owner_available(self,task_id):
        with closing(sqlite3.connect(self.path(task_id,'owner'),timeout=0)) as c:
            try:c.execute('BEGIN EXCLUSIVE');return True
            except sqlite3.OperationalError:return False

    def status(self,task_id):
        status,p=self.load(task_id)
        if status in ('running','cancel_requested') and self.owner_available(task_id):
            # A vanished owner does not establish what happened to an in-flight call.
            # Re-read while holding the owner lock: the owner may have saved a
            # pause/completion between our first registry read and lock probe.
            with closing(sqlite3.connect(self.path(task_id,'owner'),timeout=0)) as owner:
                try:owner.execute('BEGIN EXCLUSIVE')
                except sqlite3.OperationalError:status,p=self.load(task_id)
                else:
                    status,p=self.load(task_id)
                    if status in ('running','cancel_requested'):status='uncertain'
        r=p.get('result') or {}
        return {'task_id':task_id,'status':status,'last_checkpoint':r,
                'error':p.get('error'),'created_at':p['created_at'],'updated_at':p['updated_at']}

    def list(self):
        with self.connect() as c:ids=[r[0] for r in c.execute('SELECT id FROM tasks ORDER BY rowid')]
        return [self.status(i) for i in ids]

    def cancel(self,task_id):
        self.path(task_id)
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            row=c.execute('SELECT status,payload FROM tasks WHERE id=?',(task_id,)).fetchone()
            if row is None:raise ValueError('Task not found')
            status,p=row[0],json.loads(row[1])
            if p.get('version')!=1:raise ValueError('Unsupported task version')
            if status not in TERMINAL:
                status='cancel_requested' if status in ('running','cancel_requested') else 'cancelled'
                p['updated_at']=time.time()
                c.execute('UPDATE tasks SET status=?,payload=? WHERE id=?',(status,json.dumps(p),task_id))
        return self.status(task_id)

    async def advance(self,task_id,model_factory=local_model):
        owner=sqlite3.connect(self.path(task_id,'owner'),timeout=0)
        try:
            owner.execute('BEGIN EXCLUSIVE')
            with self.connect() as c:
                c.execute('BEGIN IMMEDIATE')
                row=c.execute('SELECT status,payload FROM tasks WHERE id=?',(task_id,)).fetchone()
                if row is None:raise ValueError('Task not found')
                status,p=row[0],json.loads(row[1])
                if status in TERMINAL:return self.status(task_id)
                if status not in ('queued','paused'):raise ValueError('Uncertain or running task cannot be replayed')
                if p.get('version')!=1:raise ValueError('Unsupported task version')
                starting=status=='queued'
                p['updated_at']=time.time()
                c.execute('UPDATE tasks SET status=?,payload=? WHERE id=?',('running',json.dumps(p),task_id))
            args={'question':p['question'],'corpus':Corpus([Source(**s) for s in p['sources']]),
                  'identity':p['identity'],'options':p['options']} if starting else {}
            # Metadata HTTP checks in local_model are synchronous; keep them off
            # the event loop so other tasks and status/cancel calls stay responsive.
            async def factory(identity):
                if asyncio.iscoroutinefunction(model_factory):return await model_factory(identity)
                return await asyncio.to_thread(model_factory,identity)
            caller_cancelled=False
            work=asyncio.create_task(run_durable(self.path(task_id),factory,**args))
            try:
                while not work.done():
                    await asyncio.wait({work},timeout=.05)
                    if self.load(task_id)[0]=='cancel_requested':
                        work.cancel()
                        try:await work
                        except asyncio.CancelledError:pass
                        break
                result=None if work.cancelled() else work.result()
                error=None
            except asyncio.CancelledError:
                caller_cancelled=True
                work.cancel()
                cleanup_error=None
                try:await work
                except asyncio.CancelledError:pass
                except Exception as exc:cleanup_error=type(exc).__name__+': '+str(exc)
                self.cancel(task_id)
                result=None;error='Owner coroutine cancelled'
                if cleanup_error:error+='; cleanup: '+cleanup_error
            except Exception as exc:
                result=None;error=type(exc).__name__+': '+str(exc)
            with self.connect() as c:
                c.execute('BEGIN IMMEDIATE')
                current=c.execute('SELECT status FROM tasks WHERE id=?',(task_id,)).fetchone()[0]
                if current=='cancel_requested':status='cancelled'
                elif error:status='failed'
                elif result['status']=='paused':status='paused'
                elif result['status']=='completed':status='completed'
                else:status='failed'
                # A cancelled task never publishes a racing successful answer.
                p.update(updated_at=time.time(),error=error)
                if status!='cancelled':p['result']=result
                c.execute('UPDATE tasks SET status=?,payload=? WHERE id=?',(status,json.dumps(p),task_id))
        finally:owner.close()
        if caller_cancelled: raise asyncio.CancelledError
        return self.status(task_id)


async def main():
    import argparse
    from run import api,ROOT
    p=argparse.ArgumentParser();p.add_argument('--root',required=True)
    sub=p.add_subparsers(dest='action',required=True)
    start=sub.add_parser('start');start.add_argument('--question',required=True);start.add_argument('--model',default='gemma4:26b')
    for name in ('status','resume','cancel'):sub.add_parser(name).add_argument('task_id')
    sub.add_parser('list')
    a=p.parse_args();manager=TaskManager(a.root)
    if a.action=='start':
        base='http://127.0.0.1:11434';entry=next((m for m in api(base,'/api/tags')['models'] if m['name']==a.model),None)
        if entry is None:raise ValueError('Model not installed')
        show=api(base,'/api/show',{'model':a.model})
        capacities=[v for k,v in show.get('model_info',{}).items() if k.endswith('.context_length') and isinstance(v,int)]
        if 'tools' not in show.get('capabilities',[]) or False not in (show.get('thinking') or {}).get('values',[]) or not capacities or min(capacities)<32768:
            raise ValueError('Requires verified tools, thinking=false and 32768 context capacity')
        identity={'name':a.model,'digest':entry['digest'],'ollama_version':api(base,'/api/version')}
        task_id=manager.submit(a.question,Corpus.load(ROOT),identity)
        result=await manager.advance(task_id)
    elif a.action=='resume':result=await manager.advance(a.task_id)
    elif a.action=='status':result=manager.status(a.task_id)
    elif a.action=='cancel':result=manager.cancel(a.task_id)
    else:result=manager.list()
    print(json.dumps(result,ensure_ascii=True))

if __name__=='__main__':asyncio.run(main())
