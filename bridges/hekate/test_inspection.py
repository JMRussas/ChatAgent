"""Usage inspection is opt-in: the undocumented endpoint is read only when enabled."""
import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import claude_bridge as bridge

FLAGS = " ".join(("--tools", "--disallowedTools", "--strict-mcp-config", "--setting-sources",
                  "--settings", "--no-session-persistence", "--disable-slash-commands",
                  "--include-partial-messages"))


def fake_cli(logged_in=True):
    def run(command, **_):
        if command[1:] == ["--version"]:
            return SimpleNamespace(stdout=b"1.0.0", returncode=0)
        if command[1:] == ["auth", "status"]:
            status = {"loggedIn": logged_in, "authMethod": "claude.ai", "apiProvider": "firstParty"}
            return SimpleNamespace(stdout=json.dumps(status).encode(), returncode=0)
        return SimpleNamespace(stdout=FLAGS.encode(), returncode=0)
    return run


class InspectionOptIn(unittest.TestCase):
    def inspect(self, logged_in=True, **kwargs):
        with patch("claude_bridge.subprocess.run", side_effect=fake_cli(logged_in)), \
                patch("claude_bridge.read_usage", return_value={"windows": []}) as read:
            return bridge.inspect("claude", **kwargs), read

    def test_disabled_by_default_and_reported_for_a_subscription(self):
        status, read = self.inspect()
        read.assert_not_called()
        self.assertIsNone(status["usage"])
        self.assertEqual(status["usageErrorCode"], "CLI_USAGE_INSPECTION_DISABLED")

    def test_enabled_reads_usage_once(self):
        status, read = self.inspect(inspect_usage=True)
        read.assert_called_once()
        self.assertEqual(status["usage"], {"windows": []})
        self.assertIsNone(status["usageErrorCode"])

    def test_never_read_without_a_subscription(self):
        for enabled in (False, True):
            status, read = self.inspect(logged_in=False, inspect_usage=enabled)
            read.assert_not_called()
            self.assertIsNone(status["usage"])
            self.assertIsNone(status["usageErrorCode"])

    def test_command_line_flag_reaches_inspect(self):
        for argv, expected in (([], False), (["--inspect-usage"], True)):
            with patch.object(sys, "argv", ["claude_bridge.py", "inspect", "--root", "r", "--executable", "claude", *argv]), \
                    patch("claude_bridge.load_provider"), \
                    patch("claude_bridge.inspect", return_value={}) as inspect, \
                    patch("builtins.print"):
                self.assertEqual(bridge.main(), 0)
            inspect.assert_called_once_with("claude", expected)


if __name__ == "__main__":
    unittest.main()
