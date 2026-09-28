import asyncio,json,unittest
from langchain_core.messages import AIMessage
from plan_experiment import run_condition,parse_plan
from test_agent import FakeModel,corpus,call,answer

PLAN={'steps':[{'action':'Read the restart passage','expected_evidence':'Whether queued work persists'}]}
class PlanTests(unittest.IsolatedAsyncioTestCase):
    async def test_plan_costs_one_call_and_execution_is_host_recorded(self):
        model=FakeModel(AIMessage(content=json.dumps(PLAN),additional_kwargs={'reasoning_content':'PRIVATE'}),call('read_doc',{'source_id':'doc'}),answer())
        r=await run_condition(model,corpus(),'Does work persist?',True,total_calls=3)
        self.assertEqual(r['status'],'completed');self.assertEqual(r['model_calls'],3)
        self.assertEqual(r['execution_model_calls'],2);self.assertEqual(len(r['actual_actions']),1)
        self.assertEqual(r['actual_actions'][0]['result']['evidence_id'],'E1')
        self.assertNotIn('PRIVATE',json.dumps(r));self.assertEqual(r['plan'],PLAN)
    async def test_baseline_has_no_plan_call(self):
        r=await run_condition(FakeModel(call('read_doc',{'source_id':'doc'}),answer()),corpus(),'Question',False,total_calls=2)
        self.assertEqual(r['model_calls'],2);self.assertIsNone(r['plan']);self.assertEqual(r['planning_events'],[])
    async def test_invalid_plan_does_not_execute_or_retry(self):
        for content in ['not json',json.dumps({'steps':[]}),'{"steps":[],"steps":[]}']:
            m=FakeModel(AIMessage(content=content),answer());r=await run_condition(m,corpus(),'Question',True)
            self.assertEqual(r['status'],'invalid_plan');self.assertEqual(len(m.requests),1);self.assertEqual(r['actual_actions'],[])
    async def test_truncated_plan_fails_even_when_json_valid(self):
        r=await run_condition(FakeModel(AIMessage(content=json.dumps(PLAN),response_metadata={'done_reason':'length'})),corpus(),'Question',True)
        self.assertEqual(r['status'],'invalid_plan')
    async def test_planner_timeout_and_cancellation(self):
        class Slow(FakeModel):
            async def ainvoke(self,messages):await asyncio.sleep(5)
        r=await run_condition(Slow(),corpus(),'Question',True,call_timeout=.01)
        self.assertEqual(r['status'],'plan_timeout');self.assertEqual(r['model_calls'],1)
        task=asyncio.create_task(run_condition(Slow(),corpus(),'Question',True));await asyncio.sleep(.01);task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
    def test_unknown_fields_and_excess_steps_rejected(self):
        for plan in [dict(PLAN,reasoning='extra'),{'steps':PLAN['steps']*5}]:
            with self.assertRaises(ValueError):parse_plan(json.dumps(plan))
