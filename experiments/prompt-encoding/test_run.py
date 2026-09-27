import json, unittest
from pathlib import Path
from run import grade, render, VARIANTS

class EvaluationTests(unittest.TestCase):
    def test_grader_rejects_duplicates_extras_and_wrong_answers(self):
        for content in ['{"answer":["A","A"]}','{"answer":["B"]}','{"answer":["A"],"extra":1}','{"answer":"A"}','not json']:
            self.assertFalse(grade(content,['A'])['pass'])
    def test_order_is_irrelevant_but_fences_are_format_failure(self):
        self.assertTrue(grade('{"answer":["B","A"]}',['A','B'])['pass'])
        r=grade('```json\n{"answer":["A"]}\n```',['A'])
        self.assertTrue(r['semantic_correct']); self.assertFalse(r['pass'])
    def test_empty_set_is_a_real_answer(self):
        self.assertTrue(grade('{"answer":[]}',[])['pass'])
        self.assertFalse(grade('{"answer":["none"]}',[])['pass'])
    def test_structured_variants_preserve_fields_and_escape(self):
        from xml.etree import ElementTree
        c={'compact':{'rule':'a < b & c > d'},'question':'Which?','prose':'Example'}
        fields={**c['compact'],'question':c['question']}
        self.assertEqual(json.loads(render(c,'json')),fields)
        self.assertEqual({e.tag:e.text for e in ElementTree.fromstring(render(c,'xml'))},fields)
    def test_dataset_has_unique_ids_and_all_variants(self):
        cases=json.loads(Path(__file__).with_name('cases.json').read_text())
        self.assertEqual(len({c['id'] for c in cases}),len(cases))
        for c in cases:
            for variant in VARIANTS: self.assertTrue(render(c,variant))

if __name__=='__main__': unittest.main()
