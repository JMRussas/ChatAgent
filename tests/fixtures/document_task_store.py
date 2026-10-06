"""Builds a document-task store for restart tests, offline, with a scripted fake model.

Usage: python document_task_store.py <root>. Prints the created task ids as JSON.

- "paused": really advanced once by the scripted model, so it has a durable
  checkpoint. Every fake model call is logged to <root>/fixture.calls.
- "running": left running with no live owner, as after a crash, so the sidecar
  reports it uncertain. It has no checkpoint.
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "experiments" / "doc-agent"))
from chat_bridge import ConversationTasks  # noqa: E402
from test_durable import Scripted, fixture_corpus  # noqa: E402

IDENTITY = {"name": "fixture"}


async def main(root):
    bridge = ConversationTasks(root, IDENTITY, fixture_corpus())
    manager = bridge.manager
    calls = str(Path(root) / "fixture.calls")
    ids = {}
    with manager.connect() as c:
        c.execute("INSERT INTO owners VALUES (?,?)", ("conversation-1", "owner-1"))
    for status in ("paused", "running"):
        question = f"A {status} question"
        task = manager.submit(question, fixture_corpus(), IDENTITY)
        if status == "paused":
            result = await manager.advance(task, lambda _: Scripted(calls))
            assert result["status"] == "paused", result["status"]
        else:
            with manager.connect() as c:
                c.execute("UPDATE tasks SET status='running' WHERE id=?", (task,))
        with manager.connect() as c:
            c.execute(
                "INSERT INTO bindings VALUES (?,?,?,?)",
                (f"request-{status}", task, "conversation-1", question),
            )
        ids[status] = task
    await bridge.close()
    print(json.dumps(ids))


asyncio.run(main(sys.argv[1]))
