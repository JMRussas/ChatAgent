"""Read-only, best-effort Claude account usage. This endpoint is undocumented.

Credentials remain in memory and are sent only to the fixed Anthropic origin.
Never forward redirects, persist raw responses, or infer absent scopes as zero.
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path
import urllib.request
import urllib.error


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def normalize_usage(data):
    if not isinstance(data, dict):
        raise ValueError("INVALID_USAGE")
    windows = []
    for name in ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps", "seven_day_cowork"):
        value = data.get(name)
        if value is None:
            continue
        if not isinstance(value, dict):
            raise ValueError("INVALID_USAGE")
        used, reset = value.get("utilization"), value.get("resets_at")
        if type(used) not in (int, float) or not math.isfinite(used) or used < 0 or not isinstance(reset, str):
            raise ValueError("INVALID_USAGE")
        parsed = datetime.fromisoformat(reset.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("INVALID_USAGE")
        windows.append({"scope": name, "usedPercentage": used, "resetsAt": parsed.isoformat()})
    extra = data.get("extra_usage")
    enabled = extra.get("is_enabled") if isinstance(extra, dict) else None
    return {"source": "anthropic-oauth-usage-undocumented", "observedAt": datetime.now(timezone.utc).isoformat(),
            "windows": windows, "extraUsageEnabled": enabled if type(enabled) is bool else None}


def read_usage(on_error=lambda code: None):
    try:
        credentials = json.loads((Path.home() / ".claude" / ".credentials.json").read_text(encoding="utf-8"))
        token = credentials.get("claudeAiOauth", {}).get("accessToken")
        if not isinstance(token, str) or not token:
            return None
        request = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
            "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "Accept": "application/json"})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
            payload = response.read(65537)
        if len(payload) > 65536:
            return None
        return normalize_usage(json.loads(payload))
    except urllib.error.HTTPError as error:
        on_error("CLI_USAGE_RATE_LIMITED" if error.code == 429 else "CLI_USAGE_HTTP_ERROR")
        return None
    except Exception:
        on_error("CLI_USAGE_UNAVAILABLE")
        # Includes denied/expired auth, throttling, malformed responses and network
        # failures. No automatic retries and no exception payloads in diagnostics.
        return None
