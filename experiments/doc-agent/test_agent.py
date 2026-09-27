import asyncio,hashlib,json,tempfile,unittest
from pathlib import Path
from langchain_core.messages import AIMessage
from agent import run_agent,validate_answer,make_tools
from retrieval import Corpus,Source,Retrieval

TEXT='The queue is in memory.\nRestart loses queued work.\nA proposal is not implemented.\n'
def corpus(): return Corpus([Source('doc','docs/sample.md','Sample','v1',TEXT)])
def call(name,args,cid='c1'): return AIMessage(content='',tool_calls=[{'name':name,'args':args,'id':cid,'type':'tool_call'}])
def answer(**overrides):
    obj={'status':'answered','answer':'Restart loses queued work.','citations':['E1'],'missing_evidence':[]}; obj.update(overrides)
    return AIMessage(content=json.dumps(obj),response_metadata={'done_reason':'stop'},additional_kwargs={'reasoning_content':'DO_NOT_LOG'})
class FakeModel:
    def __init__(self,*responses): self.responses=list(responses); self.requests=[]
    def bind_tools(self,tools): self.tools=tools; return self
    def bind(self,**kwargs): self.final_schema=kwargs.get("format"); return self
    async def ainvoke(self,messages):
        self.requests.append(list(messages))
        return self.responses.pop(0)

class RetrievalTests(unittest.TestCase):
    def test_search_then_read_pins_revision_and_lines(self):
        r=Retrieval(corpus()); s=r.execute('search_docs',{'query':'restart'})
        self.assertEqual(s['matches'][0]['hits'][0]['line'],2)
        d=r.execute('read_doc',{'source_id':'doc','start_line':2,'line_count':1})
        self.assertEqual(d['revision'],'v1'); self.assertEqual(d['lines'][0]['text'],'Restart loses queued work.')
    def test_paths_and_arbitrary_files_are_unavailable(self):
        r=Retrieval(corpus())
        for value in ('../.env','D:/secrets.txt','.env','docs/sample.md'):
            self.assertEqual(r.execute('read_doc',{'source_id':value})['error'],'unknown_source_id')
    def test_allowlist_resolve_rejects_escape(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)/'repo'; root.mkdir(); (Path(td)/'outside.md').write_text('secret')
            with self.assertRaises(ValueError): Corpus.load(root,[('x','../outside.md','x')])
    def test_invalid_limits_and_budget_do_not_add_evidence(self):
        r=Retrieval(corpus(),max_calls=3,max_bytes=1)
        self.assertEqual(r.execute('read_doc',{'source_id':'doc','line_count':41})['error'],'invalid_arguments')
        self.assertEqual(r.execute('read_doc',{'source_id':'doc'})['error'],'retrieval_byte_limit')
        self.assertEqual(r.reads,[])
        r.execute('search_docs',{'query':'restart'})
        self.assertEqual(r.execute('search_docs',{'query':'restart'})['error'],'tool_call_limit')
    def test_snapshot_survives_source_file_change(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'a.md'; p.write_text(TEXT)
            c=Corpus.load(td,[('doc','a.md','Sample')]); p.write_text('changed')
            r=Retrieval(c); result=r.execute('read_doc',{'source_id':'doc'})
            self.assertEqual(result['revision'],hashlib.sha256(TEXT.encode()).hexdigest())
            self.assertEqual(result['lines'][1]['text'],'Restart loses queued work.')
    def test_evidence_ids_only_issued_for_accepted_reads(self):
        r=Retrieval(corpus()); r.execute('search_docs',{'query':'restart'})
        self.assertEqual(r.reads,[])
        result=r.execute('read_doc',{'source_id':'doc','start_line':2,'line_count':1})
        self.assertEqual(result['evidence_id'],'E1')
        r.max_bytes=r.bytes
        denied=r.execute('read_doc',{'source_id':'doc','start_line':3,'line_count':1})
        self.assertEqual(denied['error'],'retrieval_byte_limit')
        self.assertEqual([s['evidence_id'] for s in r.reads],['E1'])

class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_tools_evidence_and_local_telemetry(self):
        m=FakeModel(call('search_docs',{'query':'restart'}),call('read_doc',{'source_id':'doc','start_line':2,'line_count':1},'c2'),answer())
        result=await run_agent(m,corpus(),'What happens on restart?')
        self.assertEqual(result['status'],'completed'); self.assertEqual(result['tool_calls'],2)
        self.assertEqual(result['answer']['citations'][0]['revision'],'v1')
        self.assertNotIn('DO_NOT_LOG',json.dumps(result))
        self.assertEqual(m.requests[-1][-1].type,'tool')
    async def test_unretrieved_or_fabricated_citation_rejected(self):
        r=await run_agent(FakeModel(answer(),answer()),corpus(),'Question')
        self.assertEqual(r['status'],'unverified_answer')
        m=FakeModel(call('read_doc',{'source_id':'doc','start_line':1,'line_count':1}),answer(citations=['E99']),answer(citations=['E99']))
        self.assertEqual((await run_agent(m,corpus(),'Question'))['status'],'invalid_answer')
    async def test_bounded_final_schema_corrects_format_without_new_retrieval(self):
        fenced=AIMessage(content='```json\n'+answer().content+'\n```')
        m=FakeModel(call('read_doc',{'source_id':'doc'}),fenced,answer())
        result=await run_agent(m,corpus(),'Question')
        self.assertEqual(result['status'],'completed'); self.assertEqual(result['model_calls'],3)
        self.assertEqual(m.final_schema['properties']['citations']['items']['enum'],['E1'])
        self.assertEqual(sum(e['type']=='draft_rejected' for e in result['events']),1)
    async def test_missing_evidence_after_empty_search(self):
        final=answer(status='insufficient_evidence',answer='The available docs do not establish the price.',citations=[],missing_evidence=['A measured cost record'])
        m=FakeModel(call('search_docs',{'query':'electricity'}),final)
        result=await run_agent(m,corpus(),'Cost?')
        self.assertEqual(result['status'],'completed'); self.assertEqual(result['answer']['status'],'insufficient_evidence')
    async def test_tool_calls_capped_even_in_single_batch(self):
        response=AIMessage(content='',tool_calls=[{'name':'read_doc','args':{'source_id':'doc'},'id':f'c{i}','type':'tool_call'} for i in range(3)])
        r=await run_agent(FakeModel(response),corpus(),'Question',max_tool_calls=2)
        self.assertEqual(r['status'],'tool_limit'); self.assertEqual(r['tool_calls'],0)
    async def test_repeated_request_and_unknown_tool_stopped(self):
        m=FakeModel(call('read_doc',{'source_id':'doc'}),call('read_doc',{'source_id':'doc'},'c2'))
        self.assertEqual((await run_agent(m,corpus(),'Question'))['status'],'repeated_tool_call')
        self.assertEqual((await run_agent(FakeModel(call('write_file',{'path':'.env'})),corpus(),'Question'))['status'],'invalid_tool_call')
    async def test_context_and_model_call_limits(self):
        m=FakeModel(); r=await run_agent(m,corpus(),'Question',max_input_bytes=1)
        self.assertEqual(r['status'],'context_limit'); self.assertEqual(r['model_calls'],0)
        m=FakeModel(call('read_doc',{'source_id':'doc'}))
        self.assertEqual((await run_agent(m,corpus(),'Question',max_model_calls=1))['status'],'model_call_limit')
    async def test_timeout_and_truncation_have_no_accepted_answer(self):
        class Slow(FakeModel):
            async def ainvoke(self,messages): await asyncio.sleep(1)
        self.assertEqual((await run_agent(Slow(),corpus(),'Question',call_timeout=.001))['status'],'deadline_exceeded')
        truncated=answer(); truncated.response_metadata={'done_reason':'length'}
        r=await run_agent(FakeModel(truncated),corpus(),'Question')
        self.assertEqual(r['status'],'incomplete'); self.assertIsNone(r['answer'])
    async def test_invalid_schema_consumes_budget(self):
        m=FakeModel(call('read_doc',{'source_id':'doc','line_count':True}),answer(),answer())
        result=await run_agent(m,corpus(),'Question')
        self.assertEqual(result['tool_calls'],1)
        self.assertEqual([e for e in result['events'] if e['type']=='tool_result'][0]['result']['error'],'invalid_arguments')


class ExampleIsolationTests(unittest.TestCase):
    def test_examples_do_not_grant_evidence(self):
        r=Retrieval(corpus())
        r.execute('read_doc',{'source_id':'doc'})
        value,error=validate_answer(answer(citations=['EXAMPLE_E1']).content,r)
        self.assertIsNone(value)
        self.assertIn('not retrieved',error)

    def test_variants_keep_tools_and_limits_identical(self):
        from examples import EXAMPLES
        runs=[]
        for enabled in (False,True):
            model=FakeModel(call('read_doc',{'source_id':'doc'}),answer())
            runs.append(asyncio.run(run_agent(model,corpus(),'What happens on restart?',with_examples=enabled)))
        baseline,examples=runs
        self.assertEqual(baseline['status'],'completed')
        self.assertEqual(examples['status'],'completed')
        self.assertEqual(baseline['limits'],examples['limits'])
        first=baseline['events'][0]; second=examples['events'][0]
        self.assertEqual(first['tool_schemas'],second['tool_schemas'])
        self.assertEqual(first['messages'][1:],second['messages'][1:])
        self.assertEqual(second['messages'][0]['content'],first['messages'][0]['content']+EXAMPLES)

if __name__=='__main__': unittest.main()
