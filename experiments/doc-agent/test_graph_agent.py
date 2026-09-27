"""Run the original agent contracts against the graph, plus trace parity checks."""
import asyncio
import unittest
from unittest.mock import patch
import test_agent as reference_tests
from test_agent import FakeModel, corpus, call, answer
from agent import run_agent
from graph_agent import run_graph_agent
from langchain_core.messages import AIMessage


class GraphContracts(reference_tests.AgentTests):
    def setUp(self):
        self.runner_patch=patch.object(reference_tests,'run_agent',run_graph_agent)
        self.runner_patch.start()
        self.addCleanup(self.runner_patch.stop)


def stable(value):
    if isinstance(value,dict):
        return {k:stable(v) for k,v in value.items() if k not in ('wall_seconds','elapsed_seconds','engine','node_trace')}
    if isinstance(value,list): return [stable(v) for v in value]
    return value


class GraphParity(unittest.IsolatedAsyncioTestCase):
    async def test_loop_graph_same_requests_events_results(self):
        cases=[
            ([call('read_doc',{'source_id':'doc'}),answer()],{}),
            ([call('read_doc',{'source_id':'doc'}),AIMessage(content='bad JSON'),answer()],{}),
            ([answer(),call('read_doc',{'source_id':'doc'}),answer()],{}),
            ([call('read_doc',{'source_id':'doc'}),call('read_doc',{'source_id':'doc'},'c2')],{}),
            ([call('read_doc',{'source_id':'doc','line_count':True}),answer(),answer()],{}),
            ([call('read_doc',{'source_id':'doc'})],{'max_model_calls':1}),
            ([],{'max_input_bytes':1}),
            ([],{'deadline_seconds':0}),
            ([call('read_doc',{'source_id':'doc'}),answer()],{'with_examples':True}),
        ]
        for responses,options in cases:
            with self.subTest(options=options,responses=len(responses)):
                loop=await run_agent(FakeModel(*responses),corpus(),'Question',**options)
                graph=await run_graph_agent(FakeModel(*responses),corpus(),'Question',**options)
                self.assertEqual(stable(loop),stable(graph))
                self.assertEqual(graph['node_trace'][0],'model')
        self.assertEqual((await run_graph_agent(FakeModel(call('read_doc',{'source_id':'doc'}),answer()),corpus(),'Question'))['node_trace'],['model','validate','retrieve','model','validate'])

    async def test_concurrent_runs_do_not_share_evidence(self):
        a,b=await asyncio.gather(
            run_graph_agent(FakeModel(call('read_doc',{'source_id':'doc'}),answer()),corpus(),'A'),
            run_graph_agent(FakeModel(call('search_docs',{'query':'missing'}),answer(),answer()),corpus(),'B'))
        self.assertEqual(a['status'],'completed')
        self.assertEqual(b['status'],'invalid_answer')
        self.assertEqual(b['tool_calls'],1)

    async def test_external_cancellation_propagates(self):
        started=asyncio.Event(); cancelled=asyncio.Event()
        class Waiting(FakeModel):
            async def ainvoke(self,messages):
                started.set()
                try: await asyncio.Event().wait()
                finally: cancelled.set()
        task=asyncio.create_task(run_graph_agent(Waiting(),corpus(),'Question'))
        await asyncio.wait_for(started.wait(),2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(cancelled.is_set())

if __name__=='__main__': unittest.main()
