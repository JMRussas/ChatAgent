"""Single-task SQLite persistence with exclusive ownership and fail-closed recovery."""
from contextlib import closing
import sys
from pathlib import Path
# Optional local dependencies; ordinary installations use requirements-durable.txt.
local_deps=Path(__file__).with_name('.deps')
if local_deps.exists(): sys.path.insert(0,str(local_deps))
import asyncio, hashlib, json, sqlite3, importlib.metadata, inspect
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from graph_agent import run_graph_agent
from retrieval import Corpus, Source


def versions():
    return {name:importlib.metadata.version(name) for name in ('langgraph','langgraph-checkpoint','langgraph-checkpoint-sqlite','langchain-core','langchain-ollama','ollama','aiosqlite','pydantic')}


def code_identity():
    return {name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ('agent.py','graph_agent.py','retrieval.py','examples.py','durable.py')}


async def run_durable(db, model_factory, *, question=None, corpus=None, identity=None, options=None):
    """Start with question/corpus/identity, or resume the saved task with db only.

    model_factory(saved_identity) must verify and construct the same model setup.
    One task per database; never reset an existing task or replay an uncertain run.
    """
    db=Path(db); db.parent.mkdir(parents=True,exist_ok=True)
    if question is None and not db.exists(): raise ValueError('Task does not exist')
    # SQLite releases this OS-backed lock on process exit, including abrupt death.
    lock=sqlite3.connect(str(db)+'.lock',timeout=0)
    try:
        lock.execute('BEGIN EXCLUSIVE')
        with closing(sqlite3.connect(db)) as conn, conn:
            conn.execute('CREATE TABLE IF NOT EXISTS task (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
            row=conn.execute('SELECT payload FROM task WHERE id=1').fetchone()
            if question is not None:
                if row: raise ValueError('Task already exists; use resume')
                if corpus is None or identity is None: raise ValueError('Start requires corpus and model identity')
                task={'version':1,'question':question,'sources':corpus.snapshot(),'identity':identity,
                      'options':options or {},'versions':versions(),'code':code_identity(),'status':'new'}
            else:
                if row is None: raise ValueError('No saved task')
                task=json.loads(row[0])
                if task.get('version')!=1: raise ValueError('Unsupported task version; migration required')
                if task['versions']!=versions(): raise ValueError('Dependency versions changed; migration required')
                if task['code']!=code_identity(): raise ValueError('Implementation changed; migration required')
                if task['status']=='completed': return task['result']
                if task['status']!='paused': raise ValueError('Uncertain in-flight run; automatic replay refused')
            model=model_factory(task['identity'])
            if inspect.isawaitable(model): model=await model
            corpus=Corpus([Source(**v) for v in task['sources']])
            for source in corpus.sources.values():
                if hashlib.sha256(source.content.encode()).hexdigest()!=source.revision:
                    raise ValueError('Source snapshot hash mismatch')
            resume=task['status']=='paused'
            task['status']='running'
            conn.execute('INSERT OR REPLACE INTO task VALUES (1,?)',(json.dumps(task),))
        # Manifest is committed before execution. Unexpected process death leaves
        # running, which is refused on resume rather than risking model-call replay.
        async with AsyncSqliteSaver.from_conn_string(str(db)) as saver:
            result=await run_graph_agent(model,corpus,task['question'],**task['options'],
                checkpointer=saver,thread_id='task',resume=resume,pause_before_retrieval=True)
        task['status']='paused' if result['status']=='paused' else 'completed'
        task['result']=result
        with closing(sqlite3.connect(db)) as conn, conn:
            conn.execute('UPDATE task SET payload=? WHERE id=1',(json.dumps(task),))
        return result
    finally:
        lock.close()


def local_model(identity):
    from run import api
    from langchain_ollama import ChatOllama
    base='http://127.0.0.1:11434'
    entry=next((m for m in api(base,'/api/tags')['models'] if m['name']==identity['name']),None)
    if entry is None or entry['digest']!=identity['digest']: raise ValueError('Installed model digest changed or missing')
    if api(base,'/api/version')!=identity['ollama_version']: raise ValueError('Ollama version changed')
    return ChatOllama(model=identity['name'],base_url=base,temperature=0,seed=20260926,
        num_ctx=32768,num_predict=1024,reasoning=False,keep_alive='2m',client_kwargs={'timeout':60})


async def main():
    import argparse
    from run import api, ROOT
    p=argparse.ArgumentParser();p.add_argument('action',choices=['start','resume']);p.add_argument('--db',required=True)
    p.add_argument('--question');p.add_argument('--model',default='gemma4:26b')
    args=p.parse_args()
    if args.action=='start':
        if not args.question: p.error('start requires --question')
        base='http://127.0.0.1:11434'
        entry=next((m for m in api(base,'/api/tags')['models'] if m['name']==args.model),None)
        if entry is None: raise ValueError('Model is not installed')
        show=api(base,'/api/show',{'model':args.model})
        capacities=[v for k,v in show.get('model_info',{}).items() if k.endswith('.context_length') and isinstance(v,int)]
        if 'tools' not in show.get('capabilities',[]) or False not in (show.get('thinking') or {}).get('values',[]) or not capacities or min(capacities)<32768:
            raise ValueError('Requires verified tools, thinking=false and 32768 context capacity')
        identity={'name':args.model,'digest':entry['digest'],'ollama_version':api(base,'/api/version')}
        result=await run_durable(args.db,local_model,question=args.question,corpus=Corpus.load(ROOT),identity=identity)
    else:
        if args.question: p.error('resume uses the saved question')
        result=await run_durable(args.db,local_model)
    print(json.dumps(result,ensure_ascii=True))

if __name__=='__main__': asyncio.run(main())
