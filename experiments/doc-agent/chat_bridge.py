"""Local JSON-lines sidecar: scoped task commands, bounded background admission."""
import asyncio
from contextlib import closing
import json
import sqlite3
import sys
from task_manager import TaskManager
from durable import local_model
from retrieval import Corpus
from run import ROOT,api
from urllib.parse import urlsplit
from functools import partial

def local_endpoint(value):
    u=urlsplit(value)
    if u.scheme!='http' or u.hostname not in ('localhost','127.0.0.1','::1') or u.username or u.password or u.query or u.fragment:
        raise ValueError('Requires a loopback HTTP Ollama endpoint')
    return value.rstrip('/')

HEALTH={'service':'chatagent-document-tasks','protocol':1}

class BridgeError(ValueError):
    def __init__(self,code):self.code=code;super().__init__(code)

class ConversationTasks:
    def __init__(self,root,identity,corpus,model_factory=local_model,capacity=8,model_name="gemma4:26b",base_url='http://127.0.0.1:11434'):
        self.manager=TaskManager(root);self.identity=identity;self.corpus=corpus;self.model_name=model_name
        self.base_url=local_endpoint(base_url)
        self.factory=partial(local_model,base=self.base_url) if model_factory is local_model else model_factory
        self.capacity=capacity
        self.jobs={};self.slot=asyncio.Semaphore(1);self.command_lock=asyncio.Lock()
        with self.manager.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS owners (conversation TEXT PRIMARY KEY, user TEXT NOT NULL)')
            c.execute('CREATE TABLE IF NOT EXISTS bindings (request TEXT PRIMARY KEY, task TEXT UNIQUE NOT NULL, conversation TEXT NOT NULL, question TEXT NOT NULL)')

    def scope(self,conversation,user,claim=False):
        if not all(isinstance(s,str) and 0<len(s)<=200 for s in (conversation,user)):raise BridgeError('INVALID_SCOPE')
        with self.manager.connect() as c:
            row=c.execute('SELECT user FROM owners WHERE conversation=?',(conversation,)).fetchone()
            if row is None:
                if claim:c.execute('INSERT INTO owners VALUES (?,?)',(conversation,user))
            elif row[0]!=user:raise BridgeError('OWNER_MISMATCH')

    def scoped(self,task_id,conversation):
        with self.manager.connect() as c:row=c.execute('SELECT conversation FROM bindings WHERE task=?',(task_id,)).fetchone()
        if row is None or row[0]!=conversation:raise BridgeError('TASK_NOT_FOUND')

    def view(self,task_id):
        s=self.manager.status(task_id);r=s['last_checkpoint'];answer=r.get('answer')
        with self.manager.connect() as c:question=c.execute('SELECT question FROM bindings WHERE task=?',(task_id,)).fetchone()[0]
        return {'taskId':task_id,'question':question,'status':s['status'],
                'modelCalls':r.get('model_calls',0),'toolCalls':r.get('tool_calls',0),
                'answer':answer if s['status']=='completed' else None,
                'error':(r.get('status') or 'execution_failed') if s['status']=='failed' else None,
                'scheduled':task_id in self.jobs}

    async def drive(self,task_id):
        try:
            async with self.slot:
                while self.manager.status(task_id)['status'] in ('queued','paused'):
                    result=await self.manager.advance(task_id,self.factory)
                    if result['status']!='paused':break
        finally:self.jobs.pop(task_id,None)

    def schedule(self,task_id):
        if task_id in self.jobs:return
        if len(self.jobs)>=self.capacity:raise BridgeError('CAPACITY_FULL')
        task=asyncio.create_task(self.drive(task_id));self.jobs[task_id]=task
        # The manager persists normal failures. Unexpected exceptions are consumed;
        # persisted running state remains uncertain, never automatically replayed.
        def done(t):
            if self.jobs.get(task_id) is t:self.jobs.pop(task_id,None)
            if not t.cancelled():t.exception()
        task.add_done_callback(done)

    async def command(self,data):
        async with self.command_lock:
            # Readiness: the owner lock is held and the store is open. No scope, no
            # model and no task state is read or changed.
            if data.get('op')=='health':return HEALTH
            conversation=data.get('conversationId');user=data.get('userId')
            op=data.get('op');self.scope(conversation,user,claim=op=='start')
            if op=='start':
                request=data.get('requestId');question=data.get('question')
                if not isinstance(request,str) or not 1<=len(request)<=100:raise BridgeError('INVALID_REQUEST')
                if not isinstance(question,str) or not 1<=len(question.strip().encode())<=2000:raise BridgeError('INVALID_QUESTION')
                with self.manager.connect() as c:row=c.execute('SELECT task,conversation,question FROM bindings WHERE request=?',(request,)).fetchone()
                if row:
                    if row[1:]!=(conversation,question):raise BridgeError('REQUEST_CONFLICT')
                    return self.view(row[0])
                if len(self.jobs)>=self.capacity:raise BridgeError('CAPACITY_FULL')
                if self.identity is None:self.identity=await asyncio.to_thread(identity_for,self.model_name,self.base_url)
                task_id=self.manager.submit(question,self.corpus,self.identity)
                with self.manager.connect() as c:c.execute('INSERT INTO bindings VALUES (?,?,?,?)',(request,task_id,conversation,question))
                self.schedule(task_id);return self.view(task_id)
            if op=='list':
                with self.manager.connect() as c:ids=[r[0] for r in c.execute('SELECT task FROM bindings WHERE conversation=? ORDER BY rowid',(conversation,))]
                return [self.view(i) for i in ids]
            task_id=data.get('taskId');self.scoped(task_id,conversation)
            if op=='cancel':
                cancelled=self.manager.cancel(task_id)
                job=self.jobs.get(task_id)
                if job:job.cancel()
                if cancelled['status']=='cancelled':self.jobs.pop(task_id,None)
            elif op=='resume':
                if self.manager.status(task_id)['status'] not in ('queued','paused'):raise BridgeError('NOT_RESUMABLE')
                self.schedule(task_id)
            elif op!='status':raise BridgeError('INVALID_OPERATION')
            return self.view(task_id)

    async def close(self):
        jobs=list(self.jobs.values())
        for job in jobs:job.cancel()
        await asyncio.gather(*jobs,return_exceptions=True)


def identity_for(name,base='http://127.0.0.1:11434'):
    entry=next((m for m in api(base,'/api/tags')['models'] if m['name']==name),None)
    if entry is None:raise ValueError('Model not installed')
    show=api(base,'/api/show',{'model':name})
    capacities=[v for k,v in show.get('model_info',{}).items() if k.endswith('.context_length') and isinstance(v,int)]
    if 'tools' not in show.get('capabilities',[]) or False not in (show.get('thinking') or {}).get('values',[]) or not capacities or min(capacities)<32768:
        raise ValueError('Model metadata does not support this configuration')
    return {'name':name,'digest':entry['digest'],'ollama_version':api(base,'/api/version')}

async def main():
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--model',default='gemma4:26b')
    p.add_argument('--base-url',default='http://127.0.0.1:11434',type=local_endpoint);a=p.parse_args()
    manager=TaskManager(a.root)
    with closing(sqlite3.connect(manager.root/'bridge.owner',timeout=0)) as owner:
        owner.execute('BEGIN EXCLUSIVE')
        bridge=None
        try:
            while line:=await asyncio.to_thread(sys.stdin.readline):
                request={}
                try:
                    if len(line)>16000:raise BridgeError('REQUEST_TOO_LARGE')
                    request=json.loads(line)
                    if bridge is None:
                        bridge=ConversationTasks(a.root,None,Corpus.load(ROOT),model_name=a.model,base_url=a.base_url)
                    result=await bridge.command(request)
                    response={'id':request.get('id'),'result':result}
                except Exception as exc:
                    response={'id':request.get('id'),'error':exc.code if isinstance(exc,BridgeError) else 'BRIDGE_ERROR'}
                print(json.dumps(response),flush=True)
        finally:
            if bridge:await bridge.close()

if __name__=='__main__':asyncio.run(main())
