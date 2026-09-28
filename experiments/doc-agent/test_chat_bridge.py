import asyncio
import tempfile
import unittest
from chat_bridge import ConversationTasks,BridgeError,local_endpoint
from unittest.mock import patch
from test_durable import fixture_corpus
from test_agent import FakeModel,call,answer

class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_endpoint_used_for_identity_and_model_without_changing_identity(self):
        with tempfile.TemporaryDirectory() as td:
            endpoint='http://127.0.0.1:54321/background/worker'
            with patch('chat_bridge.identity_for',return_value={'name':'test'}) as identify, patch('chat_bridge.local_model') as model:
                # Explicit injected factory and default endpoint lookup use the same URL.
                b=ConversationTasks(td,None,fixture_corpus(),model_factory=model,base_url=endpoint)
                with patch.object(b,'schedule'):
                    await b.command({'op':'start','conversationId':'c','userId':'u','requestId':'r','question':'Question'})
                identify.assert_called_once_with('gemma4:26b',endpoint)
                await b.close()
            b=ConversationTasks(td,{},fixture_corpus(),base_url=endpoint)
            self.assertEqual(b.factory.keywords,{'base':endpoint})
            await b.close()
        for invalid in ('https://127.0.0.1:11434','http://example.com','http://user:secret@localhost','http://localhost?token=x'):
            with self.assertRaises(ValueError):local_endpoint(invalid)

    async def test_immediate_ack_scoping_idempotency_capacity_and_cancel(self):
        with tempfile.TemporaryDirectory() as td:
            entered=asyncio.Event();model_entries=[]
            class Slow(FakeModel):
                async def ainvoke(self,messages):model_entries.append(True);entered.set();await asyncio.Event().wait()
            b=ConversationTasks(td,{},fixture_corpus(),lambda _:Slow(),capacity=2)
            base={'conversationId':'c','userId':'u'}
            command={**base,'op':'start','requestId':'one','question':'Question'}
            try:
                first=await b.command(command);await asyncio.wait_for(entered.wait(),2)
                self.assertEqual((await b.command(command))['taskId'],first['taskId'])
                second=await b.command({**command,'requestId':'two'})
                self.assertEqual(second['status'],'queued')
                self.assertEqual(len(model_entries),1)
                with self.assertRaisesRegex(BridgeError,'CAPACITY'):await b.command({**command,'requestId':'three'})
                with self.assertRaisesRegex(BridgeError,'OWNER'):await b.command({**base,'userId':'other','op':'list'})
                with self.assertRaisesRegex(BridgeError,'TASK_NOT_FOUND'):await b.command({'conversationId':'other','userId':'u','op':'cancel','taskId':first['taskId']})
                with self.assertRaisesRegex(BridgeError,'REQUEST_CONFLICT'):await b.command({**command,'question':'Changed'})
                self.assertEqual(len(await b.command({**base,'op':'list'})),2)
                await b.command({**base,'op':'cancel','taskId':second['taskId']})
                await asyncio.sleep(0)
                self.assertNotIn(second['taskId'],b.jobs)
            finally:await b.close()

    async def test_completion_is_projected_and_scope_survives_restart_without_model(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,{},fixture_corpus(),lambda _:FakeModel(call('read_doc',{'source_id':'doc'}),answer()))
            # Each advance creates a new model; choose response based on messages.
            class Smart(FakeModel):
                async def ainvoke(self,messages):
                    return answer() if any(m.type=='tool' for m in messages) else call('read_doc',{'source_id':'doc'})
            b.factory=lambda _:Smart()
            base={'conversationId':'c','userId':'u'}
            t=await b.command({**base,'op':'start','requestId':'id','question':'Question'})
            await asyncio.wait_for(asyncio.gather(*list(b.jobs.values())),3)
            result=(await b.command({**base,'op':'list'}))[0]
            self.assertEqual(result['status'],'completed');self.assertIsNotNone(result['answer'])
            self.assertNotIn('events',result)
            await b.close()
            restarted=ConversationTasks(td,None,fixture_corpus())
            self.assertEqual((await restarted.command({**base,'op':'list'}))[0],result)
            with self.assertRaisesRegex(BridgeError,'OWNER'):await restarted.command({**base,'userId':'other','op':'list'})
            await restarted.close()

    async def test_listing_does_not_claim_empty_conversation(self):
        with tempfile.TemporaryDirectory() as td:
            b=ConversationTasks(td,None,fixture_corpus())
            self.assertEqual(await b.command({'op':'list','conversationId':'new','userId':'a'}),[])
            self.assertEqual(await b.command({'op':'list','conversationId':'new','userId':'b'}),[])
            await b.close()
