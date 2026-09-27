import unittest
from analyze import normalized_grade
class NormalizationTests(unittest.TestCase):
    def test_narrow_prefix_and_fence_acceptance(self):
        self.assertTrue(normalized_grade('```json\n{"answer":["Model B"]}\n```',['B']))
        self.assertTrue(normalized_grade('{"answer":["Task C","Task E"]}',['C','E']))
    def test_does_not_hide_wrong_answers_or_duplicates(self):
        for s in ['{"answer":["Model A"]}','{"answer":["B","Model B"]}','{"answer":["B because it is cheaper"]}','{"answer":["B"],"explanation":"yes"}']:
            self.assertFalse(normalized_grade(s,['B']))
if __name__=='__main__': unittest.main()
