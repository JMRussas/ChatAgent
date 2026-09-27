"""Frozen fictional demonstrations; never evidence about the actual repository."""
EXAMPLES_VERSION = 'canonical/1'
EXAMPLES = '''

## Canonical examples (fictional demonstrations only)
The following abbreviated exchanges illustrate decisions and response format.
Their source IDs, evidence IDs and facts are fictional, unavailable to tools, and
must never be cited or used as evidence for the actual question. Use only IDs
issued by real read_doc results in the current run.

### Relevant source already identified
Question: According to the indexed Lantern settings document, what is its default theme?
Tool call: read_doc({"source_id":"example-lantern-settings","start_line":1,"line_count":10})
Illustrative result: {"evidence_id":"EXAMPLE_E1","lines":[{"line":3,"text":"The default theme is amber."}]}
Answer: {"status":"answered","answer":"Lantern defaults to the amber theme.","citations":["EXAMPLE_E1"],"missing_evidence":[]}
Stop: the passage resolves the question; no search or additional read is needed.

### Proposal differs from implementation
Question: Does Lantern currently export SVG files?
Tool call: search_docs({"query":"SVG export","limit":2})
Illustrative result: proposal hit at line 4; implementation checkpoint hit at line 8.
Tool call: read_doc({"source_id":"example-export-proposal","start_line":4,"line_count":5})
Illustrative result: {"evidence_id":"EXAMPLE_E1","lines":[{"line":4,"text":"Proposed: SVG export."}]}
Tool call: read_doc({"source_id":"example-export-checkpoint","start_line":8,"line_count":5})
Illustrative result: {"evidence_id":"EXAMPLE_E2","lines":[{"line":8,"text":"Only PNG export is implemented; SVG remains planned."}]}
Answer: {"status":"answered","answer":"SVG export is proposed; the implementation checkpoint supports PNG only.","citations":["EXAMPLE_E1","EXAMPLE_E2"],"missing_evidence":[]}

### Evidence is insufficient
Question: What was Lantern's measured peak GPU temperature during yesterday's run?
Tool call: search_docs({"query":"GPU temperature measured","limit":2})
Illustrative result: a monitoring document hit at line 6.
Tool call: read_doc({"source_id":"example-monitoring","start_line":6,"line_count":5})
Illustrative result: {"evidence_id":"EXAMPLE_E1","lines":[{"line":6,"text":"Monitoring records request latency."}]}
Answer: {"status":"insufficient_evidence","answer":"The retrieved passage describes latency monitoring but does not establish yesterday's peak GPU temperature.","citations":["EXAMPLE_E1"],"missing_evidence":["A temperature measurement tied to yesterday's run."]}
Stop: report the evidence gap without claiming that no temperature record exists anywhere.
'''
