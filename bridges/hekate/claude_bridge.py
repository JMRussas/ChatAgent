"""Local protocol adapter to Hekate's shared CLI provider. Never copies its registry.

Operator-owned argv supplies the Hekate checkout and native Claude executable.
Conversation data arrives exclusively through stdin. stdout is a private protocol.
"""
import argparse
import dataclasses
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from usage import read_usage


class BridgeError(Exception):
    pass


def load_provider(root):
    location = Path(root).resolve() / "orchestration"
    if not (location / "backend/services/cli_provider.py").is_file():
        raise BridgeError("HEKATE_PROVIDER_UNAVAILABLE")
    sys.path.insert(0, str(location))
    return importlib.import_module("backend.services.cli_provider")


def build_command(shared, executable, model):
    config = dataclasses.replace(shared.get_provider_config("claude_code"),
        binary=executable, allowed_tools="", permission_mode="dontAsk", default_flags=[])
    # Shared builder owns flag mapping; bridge fixes chat policy and disables fallbacks.
    return shared.CommandBuilder(config).build(shared.ExecutionMode.SINGLE_SHOT,
        model=model, tools="", allowed_tools="", disallowed_tools="mcp__*",
        permission_mode="dontAsk", output_format=shared.OutputFormat.STREAM_JSON,
        verbose=True, no_session_persistence=True, disable_slash_commands=True,
        strict_mcp_config=True, mcp_config=['{"mcpServers":{}}'],
        settings='{"disableAllHooks":true}',
        # Existing builder omits empty setting_sources, so use its explicit extension.
        extra_flags=["--setting-sources", "", "--max-turns", "1", "--no-chrome"],
        system_prompt="Answer the conversation supplied as JSON on stdin. Follow its systemInstruction and the selected role instruction. Use only supplied context; do not claim to execute tools.")


def environment():
    # Keep the existing OS login profile. Exclude alternative billed transports,
    # injected tokens, nested sessions, debug/log settings and model overrides.
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith(("ANTHROPIC_", "CLAUDE_", "CLAUDECODE"))}
    env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"
    env["DISABLE_AUTOUPDATER"] = "1"
    return env


def inspect(executable):
    env = environment()
    version = subprocess.run([executable, "--version"], capture_output=True, timeout=10, env=env, check=True).stdout.decode().strip()
    result = subprocess.run([executable, "auth", "status"], capture_output=True, timeout=10, env=env)
    status = json.loads(result.stdout)
    help_text = subprocess.run([executable, "--help"], capture_output=True, timeout=10, env=env, check=True).stdout.decode()
    supported = all(flag in help_text for flag in ("--tools", "--disallowedTools", "--strict-mcp-config", "--setting-sources", "--settings", "--no-session-persistence", "--disable-slash-commands"))
    subscription = status.get("loggedIn") is True and status.get("authMethod") == "claude.ai" and status.get("apiProvider") == "firstParty"
    # Utilization is a fresh observation, not a token/call allowance or billing grant.
    return {"version": version, "authenticated": "yes" if subscription else "no",
            "authentication": "subscription-login" if subscription else "unknown",
            "quota": "unknown", "automation": "supported" if supported else "unsupported",
            "usage": read_usage() if subscription else None}


def normalize(shared, raw):
    if not isinstance(raw, dict):
        raise BridgeError("CLI_MALFORMED_OUTPUT")
    event = shared._normalize_claude_event(raw)
    if raw.get("type") == "system" and raw.get("subtype") == "init":
        if raw.get("tools") or raw.get("mcp_servers"):
            raise BridgeError("CLI_AUTOMATION_UNSUPPORTED")
    if raw.get("type") == "assistant":
        if any(b.get("type") == "tool_use" for b in raw.get("message", {}).get("content", [])):
            raise BridgeError("CLI_AUTOMATION_UNSUPPORTED")
    if event.type in (shared.StreamEventType.TOOL_USE, shared.StreamEventType.TOOL_RESULT):
        raise BridgeError("CLI_AUTOMATION_UNSUPPORTED")
    if event.type == shared.StreamEventType.ERROR or raw.get("is_error"):
        # Only expose stable codes, never raw session/error payloads.
        message = json.dumps(raw).lower()
        code = "QUOTA_EXHAUSTED" if any(x in message for x in ("rate_limit", "rate limit", "usage limit")) else "AUTH_REQUIRED" if any(x in message for x in ("authentication", "not logged in", "login required")) else "CLI_PROVIDER_ERROR"
        raise BridgeError(code)
    if event.type == shared.StreamEventType.RESULT:
        if raw.get("subtype") != "success" or not event.content.strip():
            raise BridgeError("CLI_EMPTY_OUTPUT")
        return {"type": "complete", "text": event.content, "finishReason": "stop"}
    # Assistant messages duplicate the final result; reasoning and diagnostics
    # never become answer text. This bridge intentionally supports final-only output.
    return None


def generate(shared, executable, model, max_bytes):
    request = json.load(sys.stdin)
    budget = request.get("outputBudget")
    if type(budget) is not int or not 1 <= budget <= 64000:
        raise BridgeError("CLI_INVALID_REQUEST")
    env = environment()
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(budget)
    command = build_command(shared, executable, model)
    # Outer CliRunner owns timeout and termination of this process and descendants.
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, env=env, shell=False)
    errors, frames = [], []
    size = 0
    lock = threading.Lock()

    def read(pipe, stdout=False):
        nonlocal size
        pending = b""
        try:
            while chunk := pipe.read1(4096):
                with lock:
                    size += len(chunk)
                    if size > max_bytes:
                        raise BridgeError("OUTPUT_TOO_LARGE")
                if stdout:
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        if line.strip():
                            frame = normalize(shared, json.loads(line))
                            if frame:
                                frames.append(frame)
            if stdout and pending.strip():
                frame = normalize(shared, json.loads(pending))
                if frame:
                    frames.append(frame)
        except BridgeError as error:
            errors.append(str(error))
            child.kill()
        except Exception:
            errors.append("CLI_MALFORMED_OUTPUT")
            child.kill()

    threads = [threading.Thread(target=read, args=(child.stdout, True)), threading.Thread(target=read, args=(child.stderr,))]
    for thread in threads:
        thread.start()
    try:
        child.stdin.write(json.dumps(request).encode("utf-8"))
        child.stdin.close()
    except BrokenPipeError:
        pass
    code = child.wait()
    for thread in threads:
        thread.join()
    child.stdout.close()
    child.stderr.close()
    if not child.stdin.closed:
        try:
            child.stdin.close()
        except BrokenPipeError:
            pass
    if errors:
        raise BridgeError(errors[0])
    if code:
        raise BridgeError("CLI_NONZERO_EXIT")
    if len(frames) != 1:
        raise BridgeError("CLI_EMPTY_OUTPUT" if not frames else "CLI_MALFORMED_OUTPUT")
    print(json.dumps(frames[0]), flush=True)


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["inspect", "generate", "contract"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--executable", required=True)
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--max-bytes", type=int, default=1048576)
    args = parser.parse_args()
    try:
        shared = load_provider(args.root)
        if args.mode == "contract":
            print(json.dumps(build_command(shared, args.executable, args.model)))
        elif args.mode == "inspect":
            print(json.dumps(inspect(args.executable)))
        else:
            generate(shared, args.executable, args.model, args.max_bytes)
    except Exception as error:
        code = str(error) if isinstance(error, BridgeError) else "HEKATE_BRIDGE_FAILED"
        print(json.dumps({"type": "error", "code": code}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
