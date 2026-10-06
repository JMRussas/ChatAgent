"""Local JSON-lines sidecar: scoped task commands, bounded background admission."""
import asyncio
from contextlib import closing
import json
import sqlite3
import sys
from task_manager import TaskManager, TaskError, UUID, DIGEST
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

    def scope(self,conversation,user):
        if not all(isinstance(s,str) and 0<len(s)<=200 for s in (conversation,user)):raise BridgeError('INVALID_SCOPE')
        with self.manager.connect() as c:self.check_owner(c,conversation,user)

    def check_owner(self,c,conversation,user):
        """True if this user owns the conversation, False if nobody does yet.

        A conversation with bound tasks but no owner row is damaged: it fails closed
        for every operation instead of reading as unclaimed, and is never repaired.
        """
        row=c.execute('SELECT user FROM owners WHERE conversation=?',(conversation,)).fetchone()
        if row is None:
            if c.execute('SELECT 1 FROM bindings WHERE conversation=? LIMIT 1',(conversation,)).fetchone():
                raise BridgeError('TASK_UNAVAILABLE')
            return False
        if row[0]!=user:raise BridgeError('OWNER_MISMATCH')
        return True

    def claim(self,c,conversation,user):
        if not self.check_owner(c,conversation,user):c.execute('INSERT INTO owners VALUES (?,?)',(conversation,user))

    def bind(self,c,request,task_id,conversation,question):
        c.execute('INSERT INTO bindings VALUES (?,?,?,?)',(request,task_id,conversation,question))

    def binding(self,c,request,conversation,question,user):
        """The task bound to this request, if any, for this owner only.

        The same id with other content conflicts. A bound conversation must have an
        owner row, and it must be this user; check_owner fails closed when it is
        missing, rather than letting any label read the task or claim the conversation.
        """
        row=c.execute('SELECT task,conversation,question FROM bindings WHERE request=?',(request,)).fetchone()
        if row is None:return None
        if row[1:]!=(conversation,question):raise BridgeError('REQUEST_CONFLICT')
        self.check_owner(c,conversation,user)
        return row[0]

    def existing(self,task_id):
        # A binding whose task row is missing or unreadable fails closed: no repair,
        # adoption or deletion, and never a second task for the same request.
        try:return self.view(task_id)
        except (ValueError,KeyError,TypeError,IndexError):raise BridgeError('TASK_UNAVAILABLE')

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
                'scheduled':task_id in self.jobs,
                # Abandoned by an operator: what the task did externally is not known.
                **({'externalOutcome':'unknown'} if s['status']=='abandoned' else {})}

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
            op=data.get('op');self.scope(conversation,user)
            if op=='start':
                request=data.get('requestId');question=data.get('question')
                if not isinstance(request,str) or not 1<=len(request)<=100:raise BridgeError('INVALID_REQUEST')
                if not isinstance(question,str) or not 1<=len(question.strip().encode())<=2000:raise BridgeError('INVALID_QUESTION')
                # A request already accepted returns its task, unscheduled, before any
                # capacity or model lookup.
                with self.manager.connect() as c:bound=self.binding(c,request,conversation,question,user)
                if bound:return self.existing(bound)
                if len(self.jobs)>=self.capacity:raise BridgeError('CAPACITY_FULL')
                if self.identity is None:self.identity=await asyncio.to_thread(identity_for,self.model_name,self.base_url)
                task_id,payload=self.manager.prepare(question,self.corpus,self.identity)
                # Owner, queued task and binding commit together or not at all. Nothing
                # awaits inside the transaction, and both checks are repeated in it.
                with self.manager.transaction() as c:
                    # The binding is checked before any write, so a request accepted
                    # meanwhile, or a binding whose owner vanished, is never repaired.
                    bound=self.binding(c,request,conversation,question,user)
                    # A concurrent duplicate makes no write and schedules nothing.
                    if not bound:
                        self.claim(c,conversation,user)
                        self.manager.insert(c,task_id,payload);self.bind(c,request,task_id,conversation,question)
                if bound:return self.existing(bound)
                # Only a task created by this request is scheduled, once, after commit.
                self.schedule(task_id);return self.view(task_id)
            if op=='list':
                with self.manager.connect() as c:ids=[r[0] for r in c.execute('SELECT task FROM bindings WHERE conversation=? ORDER BY rowid',(conversation,))]
                return [self.view(i) for i in ids]
            task_id=data.get('taskId');self.scoped(task_id,conversation)
            # Operator recovery, reached only through the bound conversation and its owner.
            if op in ('inspect_task','abandon_task'):
                try:
                    if op=='inspect_task':return self.manager.inspect(task_id)
                    operation,digest=data.get('operationId'),data.get('expectedDigest')
                    if not isinstance(operation,str) or not UUID.fullmatch(operation):raise BridgeError('INVALID_REQUEST')
                    if not isinstance(digest,str) or not DIGEST.fullmatch(digest):raise BridgeError('INVALID_REQUEST')
                    def guard(c):
                        # Scope rechecked in the abandonment's own transaction.
                        row=c.execute('SELECT conversation FROM bindings WHERE task=?',(task_id,)).fetchone()
                        if row is None or row[0]!=conversation:raise BridgeError('TASK_NOT_FOUND')
                        self.check_owner(c,conversation,user)
                    receipt=self.manager.abandon(task_id,operation,digest,guard)
                    return {'receipt':receipt,'task':self.manager.inspect(task_id)}
                except TaskError as error:raise BridgeError(error.code)
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
