"""Contract tests against the actual shared provider; no model calls."""
import json
import io
import os
import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
import claude_bridge as bridge
from usage import normalize_usage


class SharedProviderContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = os.environ.get("HEKATE_TEST_ROOT", str(Path(__file__).resolve().parents[3] / "Hekate"))
        cls.shared = bridge.load_provider(root)

    def test_command_disables_tools_settings_sessions_and_fallback(self):
        cmd = bridge.build_command(self.shared, "claude", "sonnet")
        def value(flag):
            return cmd[cmd.index(flag) + 1]
        self.assertEqual(value("--tools"), "")
        self.assertEqual(value("--setting-sources"), "")
        self.assertEqual(value("--permission-mode"), "dontAsk")
        self.assertEqual(value("--max-turns"), "1")
        self.assertEqual(json.loads(value("--mcp-config")), {"mcpServers": {}})
        self.assertTrue(json.loads(value("--settings"))["disableAllHooks"])
        for flag in ("--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"):
            self.assertIn(flag, cmd)
        for flag in ("--fallback-model", "--dangerously-skip-permissions", "--continue", "--resume", "--allowedTools"):
            self.assertNotIn(flag, cmd)

    def test_normalization_returns_exactly_one_final_not_duplicate_assistant(self):
        messages = [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "héllo"}]}},
            {"type": "result", "subtype": "success", "result": "héllo", "is_error": False}]
        frames = [bridge.normalize(self.shared, raw) for raw in messages]
        self.assertEqual(frames, [None, {"type": "complete", "text": "héllo", "finishReason": "stop"}])

    def test_reasoning_and_diagnostics_are_not_answers(self):
        for raw in [{"type": "system", "subtype": "init", "tools": [], "session_id": "private"},
                    {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "private"}]}},
                    {"type": "stream_event", "event": {"private": "data"}}]:
            self.assertIsNone(bridge.normalize(self.shared, raw))

    def test_tools_fail_closed(self):
        for raw in [{"type": "system", "subtype": "init", "tools": ["Bash"]},
                    {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
                    {"type": "tool_use", "name": "Bash"}]:
            with self.assertRaisesRegex(bridge.BridgeError, "CLI_AUTOMATION_UNSUPPORTED"):
                bridge.normalize(self.shared, raw)

    def test_error_results_never_become_answers(self):
        for text, code in [("rate_limit_error secret", "QUOTA_EXHAUSTED"), ("not logged in secret", "AUTH_REQUIRED"), ("private session", "CLI_PROVIDER_ERROR")]:
            with self.assertRaisesRegex(bridge.BridgeError, "^" + code + "$"):
                bridge.normalize(self.shared, {"type": "result", "is_error": True, "result": text})

    def test_empty_success_and_malformed_payload_fail(self):
        with self.assertRaisesRegex(bridge.BridgeError, "CLI_EMPTY_OUTPUT"):
            bridge.normalize(self.shared, {"type": "result", "subtype": "success", "result": ""})
        with self.assertRaisesRegex(bridge.BridgeError, "CLI_MALFORMED_OUTPUT"):
            bridge.normalize(self.shared, [])

    def test_environment_excludes_api_and_session_overrides(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "secret", "ANTHROPIC_BASE_URL": "bad", "CLAUDE_CODE_OAUTH_TOKEN": "secret", "CLAUDECODE": "1"}):
            env = bridge.environment()
        self.assertNotIn("ANTHROPIC_API_KEY", env)
        self.assertNotIn("ANTHROPIC_BASE_URL", env)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", env)
        self.assertNotIn("CLAUDECODE", env)
        self.assertEqual(env["ENABLE_CLAUDEAI_MCP_SERVERS"], "false")

    def test_real_subprocess_preserves_stdin_and_drops_stderr(self):
        original = subprocess.Popen
        fixture = "import sys,json; r=json.load(sys.stdin); sys.stderr.write('private diagnostic'); print(json.dumps({'type':'result','subtype':'success','result':r['context']['systemInstruction']}))"
        prompt = 'héllo "quotes" $HOME $(touch unwanted)'
        stdin = io.StringIO(json.dumps({"context": {"systemInstruction": prompt}, "outputBudget": 32}))
        stdout = io.StringIO()
        with patch.object(bridge.subprocess, "Popen", side_effect=lambda _cmd, **kw: original([sys.executable, "-c", fixture], **kw)), patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            bridge.generate(self.shared, "claude", "sonnet", 4096)
        self.assertEqual(json.loads(stdout.getvalue())["text"], prompt)
        self.assertNotIn("diagnostic", stdout.getvalue())

    def test_real_subprocess_stderr_counts_toward_output_limit(self):
        original = subprocess.Popen
        fixture = "import sys; sys.stdin.read(); sys.stderr.write('private' * 10000)"
        stdin = io.StringIO(json.dumps({"context": {}, "outputBudget": 32}))
        with patch.object(bridge.subprocess, "Popen", side_effect=lambda _cmd, **kw: original([sys.executable, "-c", fixture], **kw)), patch.object(sys, "stdin", stdin):
            with self.assertRaisesRegex(bridge.BridgeError, "OUTPUT_TOO_LARGE"):
                bridge.generate(self.shared, "claude", "sonnet", 4096)

    def test_usage_preserves_scoped_windows_and_ignores_breakdown(self):
        snapshot = normalize_usage({"five_hour": {"utilization": 10, "resets_at": "2026-10-01T00:00:00Z"},
            "seven_day_opus": {"utilization": 100, "resets_at": "2026-10-02T00:00:00Z"},
            "seven_day_sonnet": None, "seven_day_breakdown": {"percent": 95},
            "extra_usage": {"is_enabled": True, "private": "secret"}})
        self.assertEqual([w["scope"] for w in snapshot["windows"]], ["five_hour", "seven_day_opus"])
        self.assertTrue(snapshot["extraUsageEnabled"])
        self.assertNotIn("secret", json.dumps(snapshot))

    def test_invalid_usage_never_becomes_zero(self):
        for value in (None, "0", -1, float("nan"), True):
            with self.assertRaises(ValueError):
                normalize_usage({"five_hour": {"utilization": value, "resets_at": "2026-10-01T00:00:00Z"}})
        self.assertEqual(normalize_usage({})["windows"], [])


if __name__ == "__main__":
    unittest.main()
