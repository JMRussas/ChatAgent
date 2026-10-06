"""Seeds one conversation owner in a document-task store, offline.

Usage: python document_task_owner.py <root> <json>, where <json> is
{"conversationId": ..., "userId": ...}. The JSON may escape non-ASCII, so the
labels reach Python exactly whatever the command-line encoding.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "experiments" / "doc-agent"))
from chat_bridge import ConversationTasks  # noqa: E402
from test_durable import fixture_corpus  # noqa: E402

root, labels = sys.argv[1], json.loads(sys.argv[2])
bridge = ConversationTasks(root, {"name": "fixture"}, fixture_corpus())
with bridge.manager.connect() as c:
    c.execute("INSERT INTO owners VALUES (?,?)", (labels["conversationId"], labels["userId"]))
