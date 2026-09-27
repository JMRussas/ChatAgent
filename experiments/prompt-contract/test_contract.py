import dataclasses, json, unittest
from pathlib import Path
from xml.etree import ElementTree as ET
from contract import ContextSource, PromptPackage, package, render
from scoring import score
from run import build_messages

class ContractTests(unittest.TestCase):
    def setUp(self):
        self.p=PromptPackage('Check <A> & B',('Never retry partial output.',),('Return IDs.',),(ContextSource('s1','7','A < B & C > D'),))
    def test_frozen_and_validated(self):
        with self.assertRaises(dataclasses.FrozenInstanceError): self.p.task='other'
        with self.assertRaises(ValueError): ContextSource('','1','text')
        with self.assertRaises(ValueError): PromptPackage('Task',[],('Answer',),self.p.context)
        with self.assertRaises(ValueError): PromptPackage('Task',('Rule',),('Answer',),self.p.context*2)
    def test_json_xml_roundtrip_preserves_every_field(self):
        expected=json.loads(json.dumps(self.p.payload()))
        self.assertEqual(json.loads(render(self.p,'json')),expected)
        root=ET.fromstring(render(self.p,'xml'))
        recovered={'task':root.findtext('task'),'guidelines':[x.text for x in root.find('guidelines')],'response_framework':[x.text for x in root.find('response_framework')],'context':[{e.tag:e.text for e in s} for s in root.find('context')]}
        self.assertEqual(recovered,expected)
    def test_tgr_differs_from_flat_only_in_headings(self):
        text=render(self.p,'tgr')
        for heading in ('Task','Guidelines','Response Framework','Context'):
            text=text.replace(heading+':\n','')
        self.assertEqual(text,render(self.p,'flat'))
    def test_dataset_integrity_and_no_expected_answer_field_leak(self):
        cases=json.loads(Path(__file__).with_name('cases.json').read_text())
        self.assertEqual(len(cases),24); self.assertEqual(len({c['id'] for c in cases}),24)
        for split in ('heldout','calibration'): self.assertEqual(sum(c['split']==split for c in cases),12)
        for c in cases:
            modified={**c,'expected':['THIS_MUST_NOT_REACH_THE_MODEL']}
            for variant in ('legacy','flat','tgr','json','xml'):
                self.assertEqual(build_messages(c,variant),build_messages(modified,variant))
            self.assertEqual(package(c).context[0].content,c['prose'])
    def test_heldout_answer_spot_checks(self):
        cases={c['id']:c for c in json.loads(Path(__file__).with_name('cases.json').read_text())}
        # Independent small oracles for arithmetic and state cases, not model judgments.
        remaining=100-30-20; selected=[]
        for name,size in [('A',35),('B',20),('C',15),('D',5)]:
            if size<=remaining: selected.append(name); remaining-=size
        self.assertEqual(cases['h-mandatory-budget']['expected'],selected)
        ready=[name for name,hour,offset,cancelled in [('A',10,-4,False),('B',17,2,False),('C',13.5,0,True),('D',15,2,False)] if hour-offset<=14 and not cancelled]
        self.assertEqual(cases['h-explicit-offsets']['expected'],ready)

class ScoringTests(unittest.TestCase):
    def res(self,text,**kw): return {'done':True,'done_reason':'stop','message':{'content':text},**kw}
    def test_normalization_and_exact_are_separate(self):
        s=score(self.res('```json\n{"answer":["Job B"]}\n```'),['B'])
        self.assertTrue(s['content_correct']); self.assertFalse(s['exact_pass'])
        self.assertTrue(score(self.res('{"answer":["C","A"]}'),['A','C'])['exact_pass'])
    def test_reject_duplicate_keys_ids_and_wrong_shape(self):
        for text in ['{"answer":["A"],"answer":["B"]}','{"answer":["B","Model B"]}','{"answer":["B"],"extra":1}','{"answer":"B"}','{"answer":["B because yes"]}','{"answer":["b"]}']:
            self.assertFalse(score(self.res(text),['B'])['content_correct'])
    def test_terminal_failure_cannot_pass(self):
        for kw in ({'done':False},{'done_reason':'length'},{'done_reason':'error'}):
            self.assertFalse(score(self.res('{"answer":["B"]}',**kw),['B'])['content_correct'])
        self.assertFalse(score({},[])['content_correct'])
    def test_empty_set_and_wrong_selection(self):
        self.assertTrue(score(self.res('{"answer":[]}'),[])['exact_pass'])
        self.assertFalse(score(self.res('{"answer":["A"]}'),['B'])['content_correct'])

if __name__=='__main__': unittest.main()
