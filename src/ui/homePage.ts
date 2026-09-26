import { deriveTurns } from "./turnViewModel";
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

    .reply-activity { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 0.85rem; }
    .reply-activity.failed { color: #9b2929; }
    .activity-spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: activity-spin 900ms linear infinite; flex-shrink: 0; }
    @keyframes activity-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .activity-spinner { animation: none; } }
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
    .answer-content { white-space: pre-wrap; overflow-wrap: anywhere; }
    .answer-version + .answer-version { margin-top: 12px; padding: 10px; border-left: 2px solid var(--accent); }
    details.reply-activity { display: block; font-size: 0.8rem; opacity: 0.85; }
    details.reply-activity summary { cursor: pointer; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; } }
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
      pendingMessageId: null,
      reconnecting: false,
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
    let timelineStream = null;

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

    const deriveTurns = ${deriveTurns.toString()};
    const turnNodes = new Map();
    const cancelRetries = new Map();

    async function stopTurn(messageId, retry = false) {
      const conversationId = state.conversationId;
      try {
        const res = await fetch("/conversations/" + encodeURIComponent(conversationId) + "/messages/" + encodeURIComponent(messageId) + "/cancel", { method: "POST" });
        if (conversationId !== state.conversationId) return;
        if (res.status === 404 && !retry) {
          if (state.events.some(e => e.type === "user" && e.messageId === messageId)) void stopTurn(messageId, true);
          else cancelRetries.set(messageId, true);
        } else if (!res.ok) setStatus("Could not cancel this turn. Please try again.", true);
      } catch { setStatus("Could not cancel this turn. Please try again.", true); }
    }
    function updateActivityTimers() {
      for (const node of turnNodes.values()) {
        for (const entry of node.timers) {
          const end = entry.end ? Date.parse(entry.end) : Date.now();
          const start = Date.parse(entry.start);
          entry.element.textContent = Number.isFinite(start) && Number.isFinite(end) ? entry.label + Math.max(0, Math.floor((end - start) / 1000)) + "s" : "";
        }
      }
    }
    function renderThread() {
      const turns = deriveTurns(state.events);
      if (state.pendingMessageId && state.events.some(e => e.type === "user" && e.messageId === state.pendingMessageId)) state.pendingUserText = "";
      if (state.pendingUserText) turns.push({ messageId: state.pendingMessageId, userText: state.pendingUserText, answers: [], attempts: [], active: true, status: "Sending", current: null });
      const ids = new Set(turns.map(t => t.messageId));
      for (const [id, node] of turnNodes) if (!ids.has(id)) { node.row.remove(); turnNodes.delete(id); }
      for (const turn of turns) {
        if (cancelRetries.has(turn.messageId) && state.events.some(e => e.type === "user" && e.messageId === turn.messageId)) {
          cancelRetries.delete(turn.messageId); void stopTurn(turn.messageId, true);
        }
        let node = turnNodes.get(turn.messageId);
        if (!node) {
          const row = document.createElement("section"); row.className = "turn";
          const user = document.createElement("div"); user.className = "bubble user"; row.appendChild(user);
          const bubble = document.createElement("div"); bubble.className = "bubble assistant"; row.appendChild(bubble);
          const answers = document.createElement("div"); bubble.appendChild(answers);
          const details = document.createElement("details"); details.className = "reply-activity";
          const summary = document.createElement("summary"); summary.setAttribute("aria-live", "polite"); details.appendChild(summary);
          const history = document.createElement("div"); details.appendChild(history);
          bubble.appendChild(details);
          const transport = document.createElement("div"); transport.setAttribute("role", "status"); bubble.appendChild(transport);
          const stop = document.createElement("button"); stop.type = "button"; stop.textContent = "Stop"; stop.onclick = () => stopTurn(turn.messageId); bubble.appendChild(stop);
          node = { row, user, bubble, answers, details, summary, history, transport, stop, timers: [], answerNodes: new Map(), historyKey: "", wasActive: true };
          turnNodes.set(turn.messageId, node); thread.appendChild(row);
        }
        node.user.textContent = turn.userText;
        node.bubble.setAttribute("aria-busy", String(turn.active));
        node.stop.hidden = !turn.active;
        node.transport.textContent = state.reconnecting && turn.active ? "Live updates reconnecting" : "";
        for (const [id, answer] of node.answerNodes) if (!turn.answers.some(a => a.id === id)) { answer.element.remove(); node.answerNodes.delete(id); }
        for (const [answerIndex, answer] of turn.answers.entries()) {
          let view = node.answerNodes.get(answer.id);
          if (!view) {
            const element = document.createElement("section"); element.className = "answer-version";
            const label = document.createElement("strong"); element.appendChild(label);
            const content = document.createElement("div"); content.className = "answer-content"; element.appendChild(content);
            node.answers.appendChild(element); view = { element, label, content }; node.answerNodes.set(answer.id, view);
          }
          if (node.answers.children[answerIndex] !== view.element) node.answers.insertBefore(view.element, node.answers.children[answerIndex] ?? null);
          view.label.textContent = answer.label;
          if (view.content.textContent !== answer.text) view.content.textContent = answer.text;
        }
        const current = turn.current;
        const working = current?.phase === "deep" && turn.status === "Working" ? "Working on a deeper answer" : turn.status;
        const label = working + (current?.model ? " · " + current.model : "") + (current?.reasoningEnabled ? " · Reasoning enabled" : "");
        if (node.summary.textContent !== label) node.summary.textContent = label;
        if (node.wasActive && !turn.active && turn.status === "Complete") node.details.open = false;
        node.wasActive = turn.active;
        const historyKey = JSON.stringify(turn.attempts.map(a => [a.id, a.steps, a.startedAt, a.endedAt, a.queuedAt, a.model]));
        if (node.historyKey !== historyKey) {
          node.history.replaceChildren(); node.timers = [];
          for (const attempt of turn.attempts) {
            const step = document.createElement("div"); step.textContent = attempt.phase + (attempt.model ? " · " + attempt.model : "") + ": " + attempt.steps.join(" → "); node.history.appendChild(step);
            for (const timing of [
              { start: attempt.queuedAt, end: attempt.startedAt ?? attempt.endedAt, label: "Queued: " },
              { start: attempt.startedAt, end: attempt.endedAt, label: " Active: " }
            ]) if (timing.start) {
              const element = document.createElement("span"); step.appendChild(element); node.timers.push({ ...timing, element });
            }
          }
          node.historyKey = historyKey;
        }
      }
      updateActivityTimers();
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
      return;
    }

    function openTimelineStream() {
      if (timelineStream) {
        timelineStream.close();
        timelineStream = null;
      }

      if (!state.conversationId) return;

      const streamUrl = "/conversations/" + encodeURIComponent(state.conversationId) + "/events/stream";
      const source = new EventSource(streamUrl);
      timelineStream = source;

      source.addEventListener("timeline", (event) => {
        if (source !== timelineStream) return;
        try {
          const payload = JSON.parse(event.data);
          state.events = Array.isArray(payload.events) ? payload.events : [];

          state.reconnecting = false;
          if (state.pendingUserText && state.events.some((item) => item.type === "user" && item.messageId === state.pendingMessageId)) {
            state.pendingUserText = "";
            state.pendingUserSentAtMs = 0;
          }

          renderThread();
        } catch {
          // Ignore malformed stream events and wait for next update.
        }
      });

      source.onerror = () => {
        if (source !== timelineStream) return;
        state.reconnecting = true; renderThread();
      };
    }

    async function fetchTelemetry() {
      const res = await fetch("/telemetry/latency");
      if (!res.ok) return;
      const payload = await res.json();
      renderTelemetry(payload);
    }

    async function refreshLoop() {
      try {
        await fetchTelemetry().catch(() => undefined);
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
      openTimelineStream();
      state.pendingMessageId = crypto.randomUUID();
      const messageId = state.pendingMessageId;
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
            messageId,
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
        if (conversationId !== state.conversationId) return;
        state.routeDecision = payload?.fastResponse?.analysis?.routeDecision ?? null;
        state.confidence = Number(payload?.fastResponse?.analysis?.confidence ?? NaN);
        state.confidence = Number.isFinite(state.confidence) ? state.confidence : null;
        state.reasons = Array.isArray(payload?.fastResponse?.analysis?.reasons)
          ? payload.fastResponse.analysis.reasons.map((item) => String(item))
          : [];

        promptInput.value = "";
        renderDecision();
        await fetchTelemetry().catch(() => undefined);
        state.pendingUserText = "";
        state.pendingUserSentAtMs = 0;
        renderThread();

        setStatus("Message accepted. Progress is shown in its reply bubble.");
      } catch (error) {
        state.pendingUserText = "";
        state.pendingUserSentAtMs = 0;
        await fetchTelemetry().catch(() => undefined);
        renderThread();
        setStatus("Send failed: " + (error instanceof Error ? error.message : String(error)), true);
      } finally {
        sendButton.disabled = false;
      }
    });

    conversationIdInput.addEventListener("change", () => {
      state.conversationId = String(conversationIdInput.value || "").trim();
      cancelRetries.clear();
      state.reconnecting = false;
      state.events = [];
      state.previousAssistantStatuses = [];
      state.pendingUserText = "";
      state.pendingUserSentAtMs = 0;
      state.lastThreadRenderKey = "";
      openTimelineStream();
      renderThread();
      void fetchTelemetry();
    });

    userIdInput.addEventListener("change", () => {
      state.userId = String(userIdInput.value || "").trim();
    });

    renderDecision();
    renderThread();
    openTimelineStream();
    void fetchTelemetry();
    setInterval(refreshLoop, 1000);
    setInterval(updateActivityTimers, 1000);

    window.addEventListener("beforeunload", () => {
      if (timelineStream) {
        timelineStream.close();
      }
    });
  </script>
</body>
</html>`;
}
