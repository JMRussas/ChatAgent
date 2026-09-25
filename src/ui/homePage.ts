interface RuntimeModeInfo {
  mode: "mock" | "live" | "unknown";
  fastProvider?: string;
  fastModel?: string;
  deepProvider?: string;
  deepModel?: string;
}

export function renderHomePageHtml(runtimeMode: RuntimeModeInfo = { mode: "unknown" }): string {
  const runtimeModeJson = JSON.stringify(runtimeMode).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChatAgent | Fast + Deep</title>
  <style>
    :root {
      --bg: #f6f4ef;
      --panel: #fffdf7;
      --ink: #12202f;
      --muted: #4b5f6b;
      --line: #d8d3c8;
      --accent: #007a5a;
      --accent-2: #b54708;
      --direct: #0f6f5c;
      --deep: #245aa8;
      --clarify: #8b5e00;
      --provisional: #e6f3ef;
      --refined: #e8eefb;
      --user: #fff2d6;
      --danger: #8f1d2c;
      --glow: rgba(0, 122, 90, 0.15);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--ink);
      font-family: "Avenir Next", "Gill Sans MT", "Trebuchet MS", sans-serif;
      background:
        radial-gradient(circle at 10% 10%, #fff8e6 0 22%, transparent 22%),
        radial-gradient(circle at 88% 84%, #dbe9ff 0 18%, transparent 18%),
        linear-gradient(140deg, #f6f4ef 0%, #edf4f3 44%, #f8efe6 100%);
      min-height: 100vh;
      line-height: 1.4;
    }

    .app {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 1rem;
      max-width: 1200px;
      margin: 1.25rem auto;
      padding: 0 1rem 1rem;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 12px 32px rgba(18, 32, 47, 0.08);
      overflow: hidden;
    }

    .panel-header {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(110deg, #fdf7ea 0%, #f1f8f8 100%);
    }

    .panel-header h1,
    .panel-header h2 {
      margin: 0;
      font-family: "Rockwell", "Georgia", serif;
      letter-spacing: 0.02em;
      font-size: 1.08rem;
    }

    .sub {
      margin-top: 0.2rem;
      color: var(--muted);
      font-size: 0.9rem;
    }

    .chat-shell {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 78vh;
    }

    .composer {
      padding: 0.9rem 1rem;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 0.6rem;
      background: #fffbf2;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.5rem;
    }

    label {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      display: grid;
      gap: 0.25rem;
    }

    input,
    textarea,
    button {
      font: inherit;
      border: 1px solid #c9c5bc;
      border-radius: 10px;
      padding: 0.55rem 0.65rem;
      color: var(--ink);
      background: #fff;
    }

    textarea {
      min-height: 86px;
      resize: vertical;
    }

    button {
      border: 1px solid transparent;
      background: linear-gradient(135deg, #007a5a 0%, #0f6f5c 100%);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      transition: transform 140ms ease, box-shadow 140ms ease;
      box-shadow: 0 8px 18px var(--glow);
    }

    button:hover {
      transform: translateY(-1px);
    }

    button:disabled {
      opacity: 0.65;
      cursor: not-allowed;
      transform: none;
    }

    .thread {
      overflow: auto;
      padding: 1rem;
      display: grid;
      gap: 0.75rem;
      align-content: start;
    }

    .turn {
      display: grid;
      gap: 0.35rem;
    }

    .bubble {
      border: 1px solid #d1cec5;
      border-radius: 14px;
      padding: 0.7rem 0.8rem;
      max-width: 90%;
      animation: rise-in 220ms ease;
    }

    .user {
      background: var(--user);
      justify-self: end;
      border-color: #e6d4a5;
    }

    .assistant {
      background: var(--provisional);
    }

    .assistant.refined {
      background: var(--refined);
      border-color: #c8d7f4;
    }

    .assistant.clarify {
      border-style: dashed;
      border-color: #d0a037;
      background: #fff8de;
    }

    .assistant.direct {
      border-color: #6ab9a9;
    }

    .assistant.deep {
      border-color: #9fb8e8;
    }

    .assistant.just-refined {
      animation: refined-flash 1300ms ease;
    }

    .tag-row {
      display: flex;
      gap: 0.45rem;
      align-items: center;
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.07em;
    }

    .tag {
      border-radius: 999px;
      padding: 0.13rem 0.55rem;
      border: 1px solid;
      font-weight: 700;
    }

    .tag.provisional {
      background: #dff3ee;
      border-color: #9edacb;
      color: #0a6450;
    }

    .tag.refined {
      background: #e0eafc;
      border-color: #a9c1ef;
      color: #2e4f87;
    }

    .tag.route-direct {
      color: var(--direct);
      border-color: rgba(15, 111, 92, 0.4);
      background: rgba(15, 111, 92, 0.08);
    }

    .tag.route-deep {
      color: var(--deep);
      border-color: rgba(36, 90, 168, 0.4);
      background: rgba(36, 90, 168, 0.08);
    }

    .tag.route-clarify {
      color: var(--clarify);
      border-color: rgba(139, 94, 0, 0.4);
      background: rgba(139, 94, 0, 0.1);
    }

    .status {
      padding: 0.2rem 0.7rem;
      color: var(--muted);
      font-size: 0.82rem;
      border-top: 1px solid var(--line);
      background: #faf8f2;
      min-height: 1.7rem;
    }

    .side {
      min-height: 78vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
    }

    .block {
      padding: 0.9rem 1rem;
      border-bottom: 1px solid var(--line);
    }

    .kv {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.4rem 0.8rem;
      font-size: 0.9rem;
    }

    .kv strong {
      font-family: "Rockwell", "Georgia", serif;
      letter-spacing: 0.02em;
    }

    .reasons {
      margin: 0.5rem 0 0;
      padding-left: 1rem;
      color: var(--muted);
      font-size: 0.87rem;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }

    th,
    td {
      border-bottom: 1px solid #e0dcd1;
      text-align: left;
      padding: 0.32rem 0.3rem;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 0.74rem;
    }

    .error {
      color: var(--danger);
      font-weight: 700;
    }

    .hint {
      color: var(--muted);
      font-size: 0.86rem;
    }

    @keyframes rise-in {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes refined-flash {
      0% {
        box-shadow: 0 0 0 0 rgba(36, 90, 168, 0.34);
      }
      100% {
        box-shadow: 0 0 0 16px rgba(36, 90, 168, 0);
      }
    }

    @media (max-width: 980px) {
      .app {
        grid-template-columns: 1fr;
      }

      .chat-shell,
      .side {
        min-height: auto;
      }

      .bubble {
        max-width: 100%;
      }

      .meta-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="panel chat-shell" aria-label="chat">
      <header class="panel-header">
        <h1>ChatAgent Fast + Deep Thread</h1>
        <div class="sub">Watch provisional replies upgrade to refined replies as deep processing completes.</div>
      </header>

      <form id="composer" class="composer">
        <div class="meta-grid">
          <label>
            Conversation ID
            <input id="conversationId" value="conv-ui-demo" required minlength="1" />
          </label>
          <label>
            User ID
            <input id="userId" value="user-demo" required minlength="1" />
          </label>
        </div>
        <label>
          Prompt
          <textarea id="prompt" required minlength="1" placeholder="Ask something with external data need to trigger deep path..."></textarea>
        </label>
        <button id="sendButton" type="submit">Send</button>
      </form>

      <div id="thread" class="thread" aria-live="polite"></div>
      <footer id="status" class="status">Ready.</footer>
    </section>

    <aside class="panel side" aria-label="routing telemetry">
      <header class="panel-header">
        <h2>Routing Readout</h2>
        <div class="sub">Decision trace and rolling latency telemetry for the active conversation.</div>
      </header>

      <section class="block">
        <div class="kv">
          <span>Runtime mode</span><strong id="runtimeMode">-</strong>
          <span>Fast provider/model</span><strong id="fastProvider">-</strong>
          <span>Deep provider/model</span><strong id="deepProvider">-</strong>
          <span>Last route decision</span><strong id="routeDecision">-</strong>
          <span>Last confidence</span><strong id="routeConfidence">-</strong>
          <span>Policy max fast p95</span><strong id="policyP95">-</strong>
          <span>Queue depth</span><strong id="queueDepth">-</strong>
          <span>Direct p95 estimate</span><strong id="directP95">-</strong>
        </div>
        <ul id="routeReasons" class="reasons"></ul>
      </section>

      <section class="block" style="overflow:auto;">
        <div class="hint">Latency buckets (top 8 by p95)</div>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th>Route</th>
              <th>Size</th>
              <th>p95</th>
              <th>N</th>
            </tr>
          </thead>
          <tbody id="latencyRows"></tbody>
        </table>
      </section>
    </aside>
  </main>

  <script>
    const runtimeInfo = ${runtimeModeJson};

    const state = {
      conversationId: "conv-ui-demo",
      userId: "user-demo",
      routeDecision: null,
      confidence: null,
      reasons: [],
      events: [],
      previousAssistantStatuses: [],
      pendingUserText: "",
      pendingUserSentAtMs: 0,
      lastThreadRenderKey: "",
      runtimeInfo
    };

    const $ = (id) => document.getElementById(id);

    const composer = $("composer");
    const conversationIdInput = $("conversationId");
    const userIdInput = $("userId");
    const promptInput = $("prompt");
    const sendButton = $("sendButton");
    const thread = $("thread");
    const status = $("status");

    function escapeHtml(input) {
      return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function setStatus(message, isError = false) {
      status.textContent = message;
      status.className = isError ? "status error" : "status";
    }

    function renderReasons() {
      const list = $("routeReasons");
      list.innerHTML = "";
      for (const reason of state.reasons) {
        const item = document.createElement("li");
        item.textContent = reason;
        list.appendChild(item);
      }
    }

    function deriveTurns(events) {
      const turns = [];

      for (const event of events) {
        if (event.type === "user") {
          turns.push({
            userText: event.text,
            assistantText: "",
            status: null,
            createdAtIso: event.createdAtIso,
            routeDecision: state.routeDecision
          });
          continue;
        }

        if (event.type === "provisional") {
          const target = [...turns].reverse().find((turn) => !turn.assistantText);
          if (target) {
            target.assistantText = event.text;
            target.status = "provisional";
          } else {
            turns.push({
              userText: "",
              assistantText: event.text,
              status: "provisional",
              createdAtIso: event.createdAtIso,
              routeDecision: state.routeDecision
            });
          }
          continue;
        }

        if (event.type === "refined") {
          const target = [...turns].reverse().find((turn) => turn.status === "provisional")
            ?? [...turns].reverse().find((turn) => !!turn.assistantText);

          if (target) {
            target.assistantText = event.text;
            target.status = "refined";
          } else {
            turns.push({
              userText: "",
              assistantText: event.text,
              status: "refined",
              createdAtIso: event.createdAtIso,
              routeDecision: state.routeDecision
            });
          }
        }
      }

      return turns;
    }

    function renderThread() {
      const turns = deriveTurns(state.events);
      const pendingMirroredInEvents = state.pendingUserText
        && state.events.some((event) => {
          if (event.type !== "user") return false;

          const eventCreatedAtMs = Date.parse(event.createdAtIso);
          return event.text === state.pendingUserText && Number.isFinite(eventCreatedAtMs) && eventCreatedAtMs >= state.pendingUserSentAtMs - 2000;
        });

      if (pendingMirroredInEvents) {
        state.pendingUserText = "";
        state.pendingUserSentAtMs = 0;
      }

      if (state.pendingUserText) {
        turns.push({
          userText: state.pendingUserText,
          assistantText: "",
          status: null,
          createdAtIso: new Date().toISOString(),
          routeDecision: state.routeDecision
        });
      }

      const nextStatuses = turns.map((turn) => turn.status ?? "none");
      const renderKey = JSON.stringify({ turns, routeDecision: state.routeDecision });
      if (renderKey === state.lastThreadRenderKey) {
        return;
      }

      thread.innerHTML = "";

      turns.forEach((turn, idx) => {
        const row = document.createElement("section");
        row.className = "turn";

        if (turn.userText) {
          const userBubble = document.createElement("div");
          userBubble.className = "bubble user";
          userBubble.textContent = turn.userText;
          row.appendChild(userBubble);
        }

        if (turn.assistantText) {
          const assistantBubble = document.createElement("div");
          const routeDecision = state.routeDecision ?? "direct";
          const routeClass = routeDecision === "deep" ? "deep" : routeDecision === "clarify" ? "clarify" : "direct";
          const justRefined = state.previousAssistantStatuses[idx] === "provisional" && turn.status === "refined";
          assistantBubble.className = [
            "bubble",
            "assistant",
            routeClass,
            turn.status === "refined" ? "refined" : "",
            justRefined ? "just-refined" : ""
          ].filter(Boolean).join(" ");

          const tags = document.createElement("div");
          tags.className = "tag-row";

          const statusTag = document.createElement("span");
          statusTag.className = "tag " + (turn.status === "refined" ? "refined" : "provisional");
          statusTag.textContent = turn.status === "refined" ? "Refined" : "Provisional";
          tags.appendChild(statusTag);

          const routeTag = document.createElement("span");
          routeTag.className = "tag route-" + routeClass;
          routeTag.textContent = (state.routeDecision ?? "direct").toUpperCase();
          tags.appendChild(routeTag);

          const content = document.createElement("div");
          content.innerHTML = escapeHtml(turn.assistantText).replaceAll("\\n", "<br>");

          assistantBubble.appendChild(tags);
          assistantBubble.appendChild(content);
          row.appendChild(assistantBubble);
        }

        thread.appendChild(row);
      });

      if (thread.lastElementChild) {
        thread.lastElementChild.scrollIntoView({ behavior: "smooth", block: "end" });
      }

      state.previousAssistantStatuses = nextStatuses;
      state.lastThreadRenderKey = renderKey;
    }

    function renderTelemetry(payload) {
      if (payload && payload.runtimeMode) {
        state.runtimeInfo = payload.runtimeMode;
      }

      const mode = String(state.runtimeInfo?.mode ?? "unknown");
      $("runtimeMode").textContent = mode === "live" ? "LIVE" : mode === "mock" ? "MOCK" : "UNKNOWN";

      const fastLabel = state.runtimeInfo?.fastProvider && state.runtimeInfo?.fastModel
        ? state.runtimeInfo.fastProvider + "/" + state.runtimeInfo.fastModel
        : "-";
      const deepLabel = state.runtimeInfo?.deepProvider && state.runtimeInfo?.deepModel
        ? state.runtimeInfo.deepProvider + "/" + state.runtimeInfo.deepModel
        : "-";

      $("fastProvider").textContent = fastLabel;
      $("deepProvider").textContent = deepLabel;

      $("policyP95").textContent = payload.policy?.maxFastP95Ms != null ? String(Math.round(payload.policy.maxFastP95Ms)) + " ms" : "-";
      $("queueDepth").textContent = payload.queueDepth != null ? String(payload.queueDepth) : "-";

      const directEstimate = (payload.estimates || []).find((item) => item.bucket?.route === "direct" && item.bucket?.sizeBand === "medium")
        ?? (payload.estimates || []).find((item) => item.bucket?.route === "direct")
        ?? null;

      $("directP95").textContent = directEstimate ? String(Math.round(directEstimate.p95)) + " ms" : "-";

      const rows = $("latencyRows");
      rows.innerHTML = "";
      const estimates = [...(payload.estimates || [])]
        .sort((a, b) => b.p95 - a.p95)
        .slice(0, 8);

      for (const estimate of estimates) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + escapeHtml(String(estimate.bucket.provider)) + "</td>"
          + "<td>" + escapeHtml(String(estimate.bucket.model)) + "</td>"
          + "<td>" + escapeHtml(String(estimate.bucket.route)) + "</td>"
          + "<td>" + escapeHtml(String(estimate.bucket.sizeBand)) + "</td>"
          + "<td>" + Math.round(estimate.p95) + " ms</td>"
          + "<td>" + estimate.sampleCount + "</td>";
        rows.appendChild(tr);
      }
    }

    function renderDecision() {
      const route = state.routeDecision ?? "-";
      $("routeDecision").textContent = route === "-" ? route : route.toUpperCase();
      $("routeConfidence").textContent = state.confidence == null ? "-" : String(state.confidence.toFixed(2));
      renderReasons();
    }

    async function fetchEvents() {
      if (!state.conversationId) return;
      const res = await fetch("/conversations/" + encodeURIComponent(state.conversationId) + "/events");
      if (!res.ok) return;
      const payload = await res.json();
      state.events = Array.isArray(payload.events) ? payload.events : [];

      if (state.pendingUserText && state.events.some((event) => event.type === "user" && event.text === state.pendingUserText)) {
        state.pendingUserText = "";
        state.pendingUserSentAtMs = 0;
      }

      renderThread();
    }

    async function fetchTelemetry() {
      const res = await fetch("/telemetry/latency");
      if (!res.ok) return;
      const payload = await res.json();
      renderTelemetry(payload);
    }

    async function refreshLoop() {
      try {
        await Promise.all([fetchEvents(), fetchTelemetry()]);
      } catch {
        // Keep polling even when transient errors happen.
      }
    }

    composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      const conversationId = String(conversationIdInput.value || "").trim();
      const userId = String(userIdInput.value || "").trim();
      const text = String(promptInput.value || "").trim();

      if (!conversationId || !userId || !text) {
        setStatus("Conversation ID, user ID, and prompt are required.", true);
        return;
      }

      state.conversationId = conversationId;
      state.userId = userId;
      state.pendingUserText = text;
      state.pendingUserSentAtMs = Date.now();
      renderThread();

      sendButton.disabled = true;
      setStatus("Sending message...");

      try {
        const res = await fetch("/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            userId,
            text
          })
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          const reason = payload && payload.error ? String(payload.error) : "HTTP " + res.status;
          throw new Error(reason);
        }

        const payload = await res.json();
        state.routeDecision = payload?.fastResponse?.analysis?.routeDecision ?? null;
        state.confidence = Number(payload?.fastResponse?.analysis?.confidence ?? NaN);
        state.confidence = Number.isFinite(state.confidence) ? state.confidence : null;
        state.reasons = Array.isArray(payload?.fastResponse?.analysis?.reasons)
          ? payload.fastResponse.analysis.reasons.map((item) => String(item))
          : [];

        promptInput.value = "";
        renderDecision();
        await refreshLoop();
        state.pendingUserText = "";
        state.pendingUserSentAtMs = 0;
        renderThread();
        setStatus("Message accepted. Awaiting refined update if route is deep.");
      } catch (error) {
        state.pendingUserText = "";
        state.pendingUserSentAtMs = 0;
        await refreshLoop();
        renderThread();
        setStatus("Send failed: " + (error instanceof Error ? error.message : String(error)), true);
      } finally {
        sendButton.disabled = false;
      }
    });

    conversationIdInput.addEventListener("change", () => {
      state.conversationId = String(conversationIdInput.value || "").trim();
      state.events = [];
      state.previousAssistantStatuses = [];
      state.pendingUserText = "";
      state.pendingUserSentAtMs = 0;
      state.lastThreadRenderKey = "";
      renderThread();
      void refreshLoop();
    });

    userIdInput.addEventListener("change", () => {
      state.userId = String(userIdInput.value || "").trim();
    });

    renderDecision();
    renderThread();
    void refreshLoop();
    setInterval(refreshLoop, 1000);
  </script>
</body>
</html>`;
}
