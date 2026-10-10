import { renderToolPayloads } from "./toolPayload";
import { documentTaskScript } from "./documentTaskPanel";
import { planStatusPanelHtml, planStatusScript } from "./planStatusPanel";
import { planRunControlsHtml, planRunControlsScript } from "./planRunControls";
import { attemptProgressHtml, attemptProgressScript } from "./attemptProgress";
import { executiveOverviewHtml, executiveOverviewScript } from "./executiveOverview";
import { workflowPanelHtml, workflowPanelScript } from "./workflowPanel";
import { workspacePanelHtml, workspacePanelScript } from "./workspacePanel";
import { deriveTurns } from "./turnViewModel";
interface RuntimeModeInfo {
  mode: "mock" | "live" | "unknown";
  fastProvider?: string;
  fastModel?: string;
  deepProvider?: string;
  deepModel?: string;
}

export function renderHomePageHtml(
  runtimeMode: RuntimeModeInfo = { mode: "unknown" },
  documentTasks = false,
  planStatus = false,
  planRunControls = false,
  attemptProgress = false,
  executiveOverview = false,
  workflows = false,
  workspace = false
): string {
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
    .activity-spinner { display: inline-block; margin-right: 6px; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: activity-spin 900ms linear infinite; flex-shrink: 0; }
    @keyframes activity-spin { to { transform: rotate(360deg); } }
    .activity-spinner[hidden] { display: none; }
    @media (prefers-reduced-motion: reduce) { .activity-spinner { animation: none; } }
    .status {
      padding: 0.2rem 0.7rem;
      color: var(--muted);
      font-size: 0.82rem;
      border-top: 1px solid var(--line);
      background: #faf8f2;
      min-height: 1.7rem;
    }

    .conversation-notice {
      margin: 0.6rem 1rem 0;
      padding: 0.6rem 0.8rem;
      border: 1px solid rgba(155, 41, 41, 0.4);
      border-radius: 8px;
      background: rgba(155, 41, 41, 0.08);
      color: #6d1f1f;
      font-size: 0.9rem;
    }
    .conversation-notice[hidden] { display: none; }
    .conversation-notice button { margin-left: 0.5rem; }

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

    .tool-payload { overflow: auto; max-height: 32rem; }
    .tool-payload th, .tool-payload td, #directoryPayload th, #directoryPayload td { padding: .4rem .7rem; text-align: left; }
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
    .answer-status { margin-left: 0.6em; font-size: 0.8rem; }
    .phase-outcomes { margin-top: 0.5em; font-size: 0.85rem; }
    .chat-shell > *, .composer > *, .meta-grid > *, .thread, .turn, .bubble, .answer-version, .answer-references { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
    .chat-shell { grid-template-columns: minmax(0, 1fr); }
    .thread, .turn { grid-template-columns: minmax(0, 1fr); }
    .composer select, .composer input { min-width: 0; max-width: 100%; }
    .answer-references { max-height: 32rem; overflow: auto; }
    .answer-content { white-space: pre-wrap; overflow-wrap: anywhere; }
    .answer-version + .answer-version { margin-top: 12px; padding: 10px; border-left: 2px solid var(--accent); }
    details.reply-activity { display: block; font-size: 0.8rem; opacity: 0.85; }
    details.reply-activity summary { cursor: pointer; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <main class="app">${workspace ? workspacePanelHtml() : ""}
    <section class="panel chat-shell" aria-label="chat">${workflows ? `\n      ${workflowPanelHtml()}` : ""}${executiveOverview ? `\n      ${executiveOverviewHtml()}` : ""}
      <header class="panel-header">
        <h1>ChatAgent Fast + Deep Thread</h1>
        <div class="sub">Watch provisional replies upgrade to refined replies as deep processing completes.</div>
      </header>

      <p id="mockNotice" role="status" hidden>Mock preview: replies are simulated. Completion means the simulation finished, not that facts were retrieved or verified.</p>
      <form id="composer" class="composer">
        <fieldset id="runControls" hidden>
          <legend>Manual run controls</legend>
          <label>Role <select id="runRole"><option value="">No role — configured planner</option></select></label>
          <details id="roleDetails" hidden><summary>Role definition and allowed tools</summary>
            <pre id="roleDescription" style="white-space:pre-wrap"></pre>
            <label>Expose selected tools (deselect to narrow) <select id="roleTools" multiple size="5"></select></label>
            <p>Evidence answers, review and revise expose no tools, regardless of this selection.</p>
          </details>
          <label>Model <select id="runModel"><option value="">Configured routing</option></select></label>
          <label>Thinking <select id="runThinking"><option value="configured">Configured</option></select></label>
          <span id="thinkingStatus" role="status"></span>
          <label>Action <select id="runMode"><option value="chat">Chat</option><option value="answer-evidence">Answer from selected evidence</option><option value="review">Review selected answer</option><option value="revise">Revise using my feedback</option></select></label>
          <label>Review scope <select id="reviewScope"><option value="selected-evidence">Selected evidence</option><option value="text-only">Text only (no fact or citation verification)</option></select></label>
          <label>Answer <select id="runTarget"><option value="">Select a completed text answer</option></select></label>
          <p>Answer from selected evidence requires attached rows and an evidence-answer role (or no role). It makes one tool-free call; citation checks do not grade factual correctness. Review is a separate model call using your selected model. It does not rewrite the answer or run tools. Select text-only scope for wording, or selected-evidence scope for attached rows. Evidence revisions generate new validated references. Enter review criteria or revision feedback in the prompt.</p>
        </fieldset>
        <details><summary>Latest admitted model-call budget (estimated)</summary>
          <p id="contextBudgetStatus">No admitted model-call estimate in this conversation.</p>
          <p>Conservative UTF-8 byte estimates, not provider token usage. Editing controls does not recalculate this past call. Oversized requests are rejected before generation.</p>
        </details>
        <fieldset>
          <legend>References for this turn</legend>
          <label>Result <select id="referenceResult"></select></label>
          <label>Rows (up to 20 per result) <select id="referenceRows" multiple size="5"></select></label>
          <button type="button" id="attachRows">Use selected rows</button>
          <button type="button" id="detachRows">Detach selected result</button>
          <button type="button" id="detachTeam">Detach team reference</button>
          <p id="referenceStatus" role="status">No table rows attached.</p>
        </fieldset>
        ${workspace ? '<details id="conversationIdentifiers"><summary>Conversation identifiers</summary>' : ""}
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
        ${workspace ? "</details>" : ""}
        <p id="selectedConversationContext" role="status">Conversation scope: general</p>
        <label>
          Prompt
          <textarea id="prompt" required minlength="1" placeholder="Ask something with external data need to trigger deep path..."></textarea>
        </label>
        <button id="sendButton" type="submit">Send</button>
        ${documentTasks ? '<button id="documentTaskStart" type="button">Ask project docs</button>' : ""}
      </form>

      ${documentTasks ? '<p id="documentTaskStatus" class="status" role="status"></p>' : ""}
      ${planStatus ? planStatusPanelHtml() + (planRunControls ? `\n      ${planRunControlsHtml()}` : "") + (attemptProgress ? `\n      ${attemptProgressHtml()}` : "") : ""}
      <div id="conversationNotice" class="conversation-notice" role="alert" hidden><span id="conversationNoticeText"></span><button type="button" id="newConversation">Start a new conversation</button></div>
      <div id="thread" class="thread" aria-label="Conversation history" aria-live="polite"></div>
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
    <section class="panel" id="gamesPanel" hidden>
      <h2>Games</h2>
      <label>League <select id="gamesLeague"></select></label>
      <label>Team name (optional for date search) <input id="gamesTeam" /></label>
      <label>Search <select id="gamesSelection"><option value="all">Date window</option><option value="latest_completed">Most recent completed found</option></select></label>
      <label>From (ISO timestamp with timezone) <input id="gamesFrom" placeholder="2026-09-01T00:00:00Z" /></label>
      <label>To (exclusive ISO timestamp) <input id="gamesTo" placeholder="2026-09-08T00:00:00Z" /></label>
      <button type="button" id="searchGames">Find games</button>
      <label>Retrieved game <select id="selectedGame"></select></label>
      <button type="button" id="showGameDetails" disabled>Show record details</button>
      <p id="gamesStatus" role="status"></p><div id="gamesPayload" class="tool-payload"></div>
    </section>
    <section class="panel" id="teamDirectoryPanel" hidden>
      <h2>Sports topics</h2>
      <label>Sport <select id="directorySport"></select></label>
      <p>Browse provider data directly. This does not call a model or attach the rows to chat context.</p>
      <label>League <select id="directoryLeague"></select></label>
      <button type="button" id="loadTeams">Show teams</button>
      <p id="directoryStatus" role="status"></p>
      <div id="teamTopicControls" hidden>
        <label>Team <select id="directoryTeam"></select></label>
        <label><input type="checkbox" id="attachTeamReference" /> Use this team's directory record as a model reference</label>
        <button type="button" id="openTeamConversation">Open team conversation</button>
      </div>
      <div id="directoryPayload" style="overflow:auto;max-height:32rem"></div>
    </section>
  </main>

  <script>
    const renderToolPayloads = ${renderToolPayloads.toString()};
    const runtimeInfo = ${runtimeModeJson};

    const state = {
      conversationId: "conv-ui-demo",
      workspaceConversationId: null,
      userId: "user-demo",
      routeDecision: null,
      confidence: null,
      reasons: [],
      events: [],
      previousAssistantStatuses: [],
      pendingUserText: "",
      pendingMessageId: null,
      reconnecting: false,
      expired: false,
      submitting: false,
      pendingUserSentAtMs: 0,
      lastThreadRenderKey: "",
      runtimeInfo
    };

    const $ = (id) => document.getElementById(id);

    const composer = $("composer");
    const conversationIdInput = $("conversationId");
    const userIdInput = $("userId");
    try {
      const saved = JSON.parse(sessionStorage.getItem("chatagent-active-conversation") || "null");
      if (saved && typeof saved.conversationId === "string" && typeof saved.userId === "string") {
        conversationIdInput.value = state.conversationId = saved.conversationId;
        userIdInput.value = state.userId = saved.userId;
        if (${workspace} && saved.workspaceConversationId === saved.conversationId) state.workspaceConversationId = saved.conversationId;
      }
    } catch { /* Storage may be disabled. */ }
    const saveConversation = () => { try { sessionStorage.setItem("chatagent-active-conversation", JSON.stringify({conversationId:conversationIdInput.value.trim(),userId:userIdInput.value.trim(),workspaceConversationId:state.workspaceConversationId})); } catch {} };
    function conversationBase(conversationId = state.conversationId) {
      return (${workspace} && state.workspaceConversationId === conversationId ? "/workspace/conversations/" : "/conversations/") + encodeURIComponent(conversationId);
    }
    const promptInput = $("prompt");
    const sendButton = $("sendButton");
    const thread = $("thread");
    const status = $("status");
    let timelineStream = null;
    let workspaceLastTerminal = null;
    // Unpaired or no longer valid: go to the pairing page and stop everything here.
    let leavingForPairing = false;
    function goPair() {
      if (leavingForPairing) return;
      leavingForPairing = true;
      cancelStreamRetry();
      if (timelineStream) { timelineStream.close(); timelineStream = null; }
      location.replace("/pair");
    }
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (response.status === 401) goPair();
      return response;
    };
    // "invalid" only on an authoritative answer: the server said this browser is not
    // authenticated. Offline, 5xx or a malformed reply prove nothing ("unknown").
    async function sessionState() {
      try {
        const res = await nativeFetch("/auth/session", { cache: "no-store" });
        if (res.status === 401) return "invalid";
        if (!res.ok) return "unknown";
        const body = await res.json();
        return body.authenticated === true ? "valid" : body.authenticated === false ? "invalid" : "unknown";
      } catch { return "unknown"; }
    }
    void sessionState().then((state) => { if (state === "invalid") goPair(); });
    // A closed EventSource never reconnects by itself (for example after 429
    // STREAM_CAPACITY). At most one pending reopen, tied to the stream that closed.
    let streamRetry = null;
    let streamRetryDelayMs = 1000;
    function cancelStreamRetry() {
      if (streamRetry) { clearTimeout(streamRetry); streamRetry = null; }
    }

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

    // Expiry ends this page's conversation; only an operator may retire its identity.
    const conversationNotices = {
      CONVERSATION_EXPIRED: "This conversation expired on the server. Start a new conversation to continue. Anything shown below is only the last copy this page received.",
      CONVERSATION_HISTORY_CAPACITY: "This conversation's history is full, so it cannot accept more messages.",
      CONVERSATION_CAPACITY: "The server cannot start another conversation right now. Existing conversations still work.",
      // Admission refusal: nothing was claimed, so the same message can be sent again.
      TURN_CAPACITY: "The server is already running its maximum number of turns. Wait for one to finish, then send again."
    };
    function showConversationNotice(code) {
      $("conversationNoticeText").textContent = conversationNotices[code];
      $("conversationNotice").hidden = false;
    }
    function clearConversationNotice() {
      state.expired = false;
      $("conversationNotice").hidden = true;
      sendButton.disabled = state.submitting;
    }
    function markConversationExpired(conversationId) {
      if (conversationId !== state.conversationId || state.expired) return;
      state.expired = true;
      state.reconnecting = false;
      state.pendingUserText = "";
      state.pendingUserSentAtMs = 0;
      if (timelineStream) { timelineStream.close(); timelineStream = null; }
      cancelStreamRetry();
      showConversationNotice("CONVERSATION_EXPIRED");
      sendButton.disabled = true;
      setStatus("Conversation expired. Start a new conversation to continue.", true);
      renderThread();
    }
    async function checkConversationExpiry(conversationId) {
      try {
        const res = await fetch(conversationBase(conversationId) + "/events");
        if (res.status === 410) markConversationExpired(conversationId);
      } catch { /* Offline: the reconnecting status already says so. */ }
      return state.expired;
    }
    async function recoverClosedStream(source, conversationId) {
      // An EventSource cannot see its 401; an ended session must not be retried.
      if ((await sessionState()) === "invalid") return goPair();
      if (await checkConversationExpiry(conversationId)) return;
      // A newer stream or conversation supersedes this one; its error must not reopen anything.
      if (source !== timelineStream || conversationId !== state.conversationId || streamRetry) return;
      const delay = streamRetryDelayMs;
      streamRetryDelayMs = Math.min(streamRetryDelayMs * 2, 30000);
      streamRetry = setTimeout(() => {
        streamRetry = null;
        if (source === timelineStream && conversationId === state.conversationId && !state.expired) openTimelineStream();
      }, delay);
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
        const res = await fetch(conversationBase(conversationId) + "/messages/" + encodeURIComponent(messageId) + "/cancel", { method: "POST" });
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
      const budgetEvent=[...state.events].reverse().find(e=>e.contextBudget);
      const b=budgetEvent?.contextBudget;
      const inputCapacity=b ? Math.min(b.availableInputTokens,b.roleInputLimit ?? b.availableInputTokens) : 0;
      const capacityLimit=b && b.roleInputLimit!=null && b.roleInputLimit<b.availableInputTokens ? "role input limit" : "window after reserves";
      $("contextBudgetStatus").textContent=b ? "Message "+budgetEvent.messageId+". Estimated input: "+b.totalInputTokens+" used of "+inputCapacity+" capacity; "+(inputCapacity-b.totalInputTokens)+" remaining. Capacity is limited by the "+capacityLimit+". Full window "+b.windowTokens+". Instructions/framing "+b.instructions+", tool definitions "+b.tools+", selected references/scope "+b.references+", current message "+b.currentMessage+", history "+b.history+", active tasks "+b.activeTasks+", memory "+b.memory+". Output reserve "+b.outputReserve+", safety reserve "+b.safetyReserve+(b.roleInputLimit!=null?"; role input limit "+b.roleInputLimit:"")+". These are estimates, not provider token counts." : "No admitted model-call estimate in this conversation.";
      if (typeof refreshReferenceChoices === "function") refreshReferenceChoices();
      const targets = state.events.filter(e => ["provisional","refined"].includes(e.type) && e.processingStatus === "complete" && e.answerKind !== "acknowledgment");
      const unique = [...new Map(targets.map(e=>[e.messageId,e])).values()];
      const key = unique.map(e=>e.messageId+":"+e.sequence).join(",");
      if ($("runTarget").dataset.key !== key) {
        const previous = $("runTarget").value; $("runTarget").replaceChildren();
        const placeholder = document.createElement("option"); placeholder.value="";placeholder.textContent="Select a completed text answer";$("runTarget").appendChild(placeholder);
        for (const e of unique) {const option=document.createElement("option");option.value=e.messageId;option.textContent=e.text.slice(0,100);$("runTarget").appendChild(option);}
        $("runTarget").value=previous;$("runTarget").dataset.key=key;
      }
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
          const spinner = document.createElement("span"); spinner.className = "activity-spinner"; spinner.setAttribute("aria-hidden", "true"); summary.appendChild(spinner);
          const summaryLabel = document.createElement("span"); summary.appendChild(summaryLabel);
          const history = document.createElement("div"); details.appendChild(history);
          bubble.appendChild(details);
          const outcomes = document.createElement("div"); outcomes.className = "phase-outcomes"; outcomes.setAttribute("role", "status"); bubble.appendChild(outcomes);
          const transport = document.createElement("div"); transport.setAttribute("role", "status"); bubble.appendChild(transport);
          const stop = document.createElement("button"); stop.type = "button"; stop.textContent = "Stop"; stop.onclick = () => stopTurn(turn.messageId); bubble.appendChild(stop);
          node = { row, user, bubble, answers, details, summary, summaryLabel, spinner, history, outcomes, transport, stop, timers: [], answerNodes: new Map(), historyKey: "", wasActive: true };
          turnNodes.set(turn.messageId, node); thread.appendChild(row);
        }
        node.row.dataset.threadTime = state.events.find(e => e.type === "user" && e.messageId === turn.messageId)?.createdAtIso || node.row.dataset.threadTime || new Date().toISOString();
        node.user.textContent = turn.userText;
        node.bubble.setAttribute("aria-busy", String(turn.active));
        node.stop.hidden = !turn.active;
        const outcomes = (turn.phaseOutcomes || []).map(outcome => (outcome.phase === "fast" ? "Fast reply: " : "Deep reply: ") + outcome.state).join(" · ");
        if (node.outcomes.textContent !== outcomes) node.outcomes.textContent = outcomes;
        node.transport.textContent = state.reconnecting && turn.active ? "Live updates reconnecting" : "";
        for (const [id, answer] of node.answerNodes) if (!turn.answers.some(a => a.id === id)) { answer.element.remove(); node.answerNodes.delete(id); }
        for (const [answerIndex, answer] of turn.answers.entries()) {
          let view = node.answerNodes.get(answer.id);
          if (!view) {
            const element = document.createElement("section"); element.className = "answer-version";
            const label = document.createElement("strong"); element.appendChild(label);
            const status = document.createElement("span"); status.className = "answer-status"; element.appendChild(status);
            const content = document.createElement("div"); content.className = "answer-content"; element.appendChild(content);
            const payload = document.createElement("div"); payload.className = "tool-payload"; element.appendChild(payload);
            const references=document.createElement("details");references.className="answer-references";references.hidden=true;element.appendChild(references);
            node.answers.appendChild(element); view = { element, label, status, content, payload, references, referencesKey:"", payloadKey: "" }; node.answerNodes.set(answer.id, view);
          }
          if (node.answers.children[answerIndex] !== view.element) node.answers.insertBefore(view.element, node.answers.children[answerIndex] ?? null);
          view.label.textContent = answer.label + (answer.model ? " · " + (answer.provider ? answer.provider + "/" : "") + answer.model : "");
          view.label.title = (answer.selectionReasons ?? []).join("; ");
          if (view.status.textContent !== answer.state) view.status.textContent = answer.provider === "mock" && answer.state === "Complete" ? "Simulation complete — facts not verified" : answer.state;
          if (view.content.textContent !== answer.text) view.content.textContent = answer.text;
          const referencesKey=JSON.stringify(answer.answerReferences ?? null);
          if(view.referencesKey!==referencesKey){
            view.references.replaceChildren();view.referencesKey=referencesKey;
            const refs=answer.answerReferences;
            view.references.hidden=!refs?.citations?.length;
            if(refs?.citations?.length){
              const summary=document.createElement("summary");summary.textContent="References ("+refs.citations.length+")";view.references.appendChild(summary);
              for(const cite of refs.citations){const item=document.createElement("p");item.textContent="["+cite.id+"] Source "+cite.sourceId+", row "+(cite.row+1)+", "+cite.column+": "+cite.value;view.references.appendChild(item);}
              for(const source of refs.sources){
                const item=document.createElement("p");item.textContent="Source "+source.id+": "+source.title+" · observed "+source.observedAt+" · ";
                let safe=false;try{safe=["https:","http:"].includes(new URL(source.url).protocol);}catch{}
                if(safe){const link=document.createElement("a");link.href=source.url;link.textContent=source.url;link.target="_blank";link.rel="noopener noreferrer";item.appendChild(link);}
                else item.appendChild(document.createTextNode(source.url));
                view.references.appendChild(item);
              }
            }
          }
          const payloadKey = (answer.payloadResults || []).map(r => r.context.resultId).join(",");
          if (view.payloadKey !== payloadKey) { renderToolPayloads(view.payload, answer.payloadResults || []); view.payloadKey = payloadKey; }
        }
        const current = turn.current;
        const working = !turn.active && turn.planAction === "unsupported" ? "Capability unavailable" : !turn.active && turn.planAction === "clarify" ? "Needs clarification" : !turn.active && turn.planAction === "retrieve" && turn.status === "Complete" ? "Retrieval finished — check evidence" : current?.phase === "deep" && turn.status === "Working" ? "Working on a deeper answer" : turn.status;
        const label = (current?.provider === "mock" && working === "Complete" ? "Simulation complete — facts not verified" : working) + (current?.model ? " · " + (current.provider ? current.provider + "/" : "") + current.model : "") + (current?.reasoningEnabled ? " · Reasoning enabled" : "");
        if (node.summaryLabel.textContent !== label) node.summaryLabel.textContent = label;
        node.spinner.hidden = !turn.active;
        if (node.wasActive && !turn.active && turn.status === "Complete") node.details.open = false;
        node.wasActive = turn.active;
        const historyKey = JSON.stringify(turn.attempts.map(a => [a.id, a.steps, a.startedAt, a.endedAt, a.queuedAt, a.model]));
        if (node.historyKey !== historyKey) {
          node.history.replaceChildren(); node.timers = [];
          for (const attempt of turn.attempts) {
            const step = document.createElement("div"); step.textContent = attempt.phase + (attempt.model ? " · " + (attempt.provider ? attempt.provider + "/" : "") + attempt.model : "") + ": " + attempt.steps.join(" → "); node.history.appendChild(step);
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
      window.dispatchEvent(new Event("chatagent-thread-rendered"));
    }

    function renderTelemetry(payload) {
      if (payload && payload.runtimeMode) {
        state.runtimeInfo = payload.runtimeMode;
      }

      const mode = String(state.runtimeInfo?.mode ?? "unknown");
      $("mockNotice").hidden = !(mode === "mock" || state.runtimeInfo?.fastProvider === "mock" || state.runtimeInfo?.deepProvider === "mock");
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
      cancelStreamRetry();
      if (timelineStream) {
        timelineStream.close();
        timelineStream = null;
      }

      if (!state.conversationId || state.expired) return;

      const conversationId = state.conversationId;
      const streamUrl = conversationBase(conversationId) + "/events/stream";
      const source = new EventSource(streamUrl);
      timelineStream = source;

      source.addEventListener("conversation-expired", () => {
        if (source === timelineStream) markConversationExpired(conversationId);
      });

      source.addEventListener("timeline", (event) => {
        if (source !== timelineStream) return;
        try {
          const payload = JSON.parse(event.data);
          state.events = Array.isArray(payload.events) ? payload.events : [];
          if (${workspace} && state.workspaceConversationId === conversationId) {
            const terminal = state.events.findLast((item) => item.type === "terminal");
            const terminalKey = terminal && JSON.stringify(terminal);
            if (terminalKey && terminalKey !== workspaceLastTerminal) {
              workspaceLastTerminal = terminalKey;
              window.dispatchEvent(new CustomEvent("workspace-work-changed"));
            }
          }

          state.reconnecting = false;
          streamRetryDelayMs = 1000;
          if (state.pendingUserText && state.events.some((item) => item.type === "user" && item.messageId === state.pendingMessageId)) {
            state.pendingUserText = "";
            state.pendingUserSentAtMs = 0;
          }

          renderThread();
          if (${workspace} && state.workspaceConversationId === conversationId) window.dispatchEvent(new CustomEvent("workspace-conversation-rendered", { detail: { conversationId } }));
        } catch {
          // Ignore malformed stream events and wait for next update.
        }
      });

      source.onerror = () => {
        if (source !== timelineStream) return;
        state.reconnecting = true; renderThread();
        // A closed source never retries: an expired conversation answers 410, and
        // anything else (such as 429 STREAM_CAPACITY) is reopened with backoff.
        if (source.readyState === 2) void recoverClosedStream(source, conversationId);
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
      if (state.submitting || sendButton.disabled) return;
      const conversationId = String(conversationIdInput.value || "").trim();
      const userId = String(userIdInput.value || "").trim();
      const text = String(promptInput.value || "").trim();

      if (!conversationId || !userId || !text) {
        setStatus("Conversation ID, user ID, and prompt are required.", true);
        return;
      }

      const referenceSelections = [...selectedReferences].map(([resultId,rows])=>({resultId,rows}));
      const runControls = $("runControls").hidden ? undefined : {
        ...($("runRole").value ? {roleId:$("runRole").value,toolIds:[...$("roleTools").selectedOptions].map(o=>o.value)}:{}),
        ...($("runModel").value ? {bindingId:$("runModel").value}:{}),thinking:$("runThinking").value,mode:$("runMode").value,
        ...(["review","revise"].includes($("runMode").value) ? {targetMessageId:$("runTarget").value,reviewScope:$("reviewScope").value}:{})};
      if (runControls && ["review","revise"].includes(runControls.mode) && !runControls.targetMessageId) {setStatus("Select a completed text answer first.",true);return;}
      if(runControls?.mode === "answer-evidence" && !referenceSelections.length){setStatus("Attach evidence rows first.",true);return;}
      state.submitting = true;
      sendButton.disabled = true;
      try {
        await refreshConversationContext();
        if (state.expired) return;
        if (conversationId !== conversationIdInput.value.trim() || userId !== userIdInput.value.trim()) { return; }
        saveConversation();
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

        const res = await fetch(state.workspaceConversationId === conversationId ? conversationBase(conversationId) + "/messages" : "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            messageId,
            userId,
            text, runControls, referenceSelections
          })
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          const reason = payload && payload.error ? String(payload.error) : "HTTP " + res.status;
          throw Object.assign(new Error(reason), { code: payload && payload.code });
        }

        const payload = await res.json();
        if (conversationId !== state.conversationId) return;
        state.routeDecision = payload?.fastResponse?.analysis?.routeDecision ?? null;
        state.confidence = payload?.fastResponse?.analysis?.confidence == null ? null : Number(payload.fastResponse.analysis.confidence);
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
        if (${workspace} && state.workspaceConversationId === conversationId) window.dispatchEvent(new CustomEvent("workspace-work-changed"));
      } catch (error) {
        if (conversationId !== state.conversationId || userId !== userIdInput.value.trim()) return;
        state.pendingUserText = "";
        state.pendingUserSentAtMs = 0;
        await fetchTelemetry().catch(() => undefined);
        renderThread();
        const code = error && error.code;
        if (code === "CONVERSATION_EXPIRED") markConversationExpired(conversationId);
        else if (Object.hasOwn(conversationNotices, code)) {
          if (code === "CONVERSATION_HISTORY_CAPACITY") showConversationNotice(code);
          setStatus("Send failed: " + conversationNotices[code], true);
        } else setStatus("Send failed: " + (error instanceof Error ? error.message : String(error)), true);
      } finally {
        state.submitting = false;
        sendButton.disabled = state.expired;
      }
    });

    $("newConversation").addEventListener("click", () => {
      if (${workspace}) { window.dispatchEvent(new CustomEvent("workspace-new-conversation")); return; }
      conversationIdInput.value = "conv-" + crypto.randomUUID();
      conversationIdInput.dispatchEvent(new Event("change"));
      promptInput.focus();
    });

    conversationIdInput.addEventListener("change", () => {
      state.conversationId = String(conversationIdInput.value || "").trim();
      if (state.workspaceConversationId !== state.conversationId) state.workspaceConversationId = null;
      clearConversationNotice();
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

    window.addEventListener("workspace-conversation-selected", (event) => {
      if (!${workspace} || !event.detail || typeof event.detail.conversationId !== "string") return;
      state.workspaceConversationId = event.detail.conversationId;
      conversationIdInput.value = event.detail.conversationId;
      conversationIdInput.dispatchEvent(new Event("change"));
      saveConversation();
    });

    userIdInput.addEventListener("change", () => {
      state.userId = String(userIdInput.value || "").trim();
    });

    let roleOptions=[],modelOptions=[],thinkingRequest=0;
    const selectedRole=()=>roleOptions.find(r=>r.id===$("runRole").value);
    const refreshThinking=async()=>{
      const role=selectedRole(),version=++thinkingRequest;
      $("runThinking").replaceChildren(new Option(role?"Role default ("+role.thinking+")":"Configured","configured"));
      $("runThinking").disabled=!!role && !role.overrides.thinking;
      if($("runThinking").disabled){$("thinkingStatus").textContent="Thinking is defined by this role.";return;}
      $("thinkingStatus").textContent="Checking supported settings…";
      try{const binding=$("runModel").value || role?.bindingId || "";
        const r=await fetch("/run-controls/thinking?bindingId="+encodeURIComponent(binding));const data=await r.json();if(version!==thinkingRequest)return;
        for(const setting of data.options || [])if(setting!=="configured")$("runThinking").appendChild(new Option(setting,setting));
        $("thinkingStatus").textContent=data.limitation || (data.options.length===1?"Only configured thinking is available for this selection.":"Options verified by the adapter.");
      }catch{if(version===thinkingRequest)$("thinkingStatus").textContent="Could not verify thinking options.";}
    };
    const applyRole=()=>{
      const role=selectedRole();$("roleDetails").hidden=!role;
      $("runModel").replaceChildren(new Option(role?"Role default: "+role.bindingId:"Configured routing",""));
      for(const model of modelOptions)if(!role || model.bindingId===role.bindingId || role.overrides.bindingIds.includes(model.bindingId)){
        $("runModel").appendChild(new Option(model.provider+"/"+model.model,model.bindingId));
      }
      $("roleTools").replaceChildren();
      if(role){$("roleDescription").textContent=role.id+" v"+role.version+"\\nModel: "+role.bindingId+"\\nInput limit: "+role.maxInputTokens+"; tool-call limit: "+role.maxToolCalls+"\\nContext: "+role.contextPolicy+"\\nOutput: "+role.outputContract+"\\n"+role.instructions;
        for(const id of role.toolIds){const o=new Option(id,id);o.selected=true;$("roleTools").appendChild(o);}}
      void refreshThinking();
    };
    $("runRole").onchange=applyRole;$("runModel").onchange=refreshThinking;
    fetch("/run-controls").then(r=>r.json()).then(data=>{
      if(!data.models?.length)return;
      $("runControls").hidden=false;roleOptions=data.roles || [];modelOptions=data.models;
      for(const role of roleOptions)$("runRole").appendChild(new Option(role.id+" v"+role.version,role.id));
      applyRole();
    }).catch(()=>{});
    let contextExpiryTimer, contextRequestVersion = 0;
    const showConversationContext = context => {
      clearTimeout(contextExpiryTimer);
      if (context?.reference && context.referenceStatus === "attached") {
        const remaining = Date.parse(context.reference.expiresAt) - Date.now();
        if (remaining <= 0) context = {...context,reference:null,referenceStatus:"expired"};
        else contextExpiryTimer = setTimeout(() => { void refreshConversationContext(); }, Math.min(remaining + 25, 2147483647));
      }
      $("selectedConversationContext").textContent = context ? "Conversation scope: " + context.path.join(" → ") + ". Reference: " + context.referenceStatus + (context.reference ? " (" + context.reference.sourceUrl + ")" : "") : "Conversation scope: general";
    };
    const refreshConversationContext = async () => {
      const requestVersion = ++contextRequestVersion;
      const conversationId = $("conversationId").value.trim(), userId = $("userId").value.trim();
      showConversationContext(null);
      try {
        const r = await fetch(state.workspaceConversationId === conversationId ? conversationBase(conversationId) + "/context" : "/conversation-context", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({conversationId,userId})});
        const data = await r.json();
        if (requestVersion !== contextRequestVersion || conversationId !== $("conversationId").value.trim() || userId !== $("userId").value.trim()) return;
        if (r.status === 410) { $("selectedConversationContext").textContent = "Conversation expired."; markConversationExpired(conversationId); return; }
        if (!r.ok) { $("selectedConversationContext").textContent = "Conversation context unavailable for this user."; return; }
        showConversationContext(data.context);
      } catch { if (requestVersion === contextRequestVersion) $("selectedConversationContext").textContent = "Conversation context unavailable."; }
    };
    const gameResults = new Map();
    let gameSearchResult, gameRequest;
    const selectedReferences = new Map();
    let availableReferences = new Map();
    const referenceSummary = () => { $("referenceStatus").textContent = selectedReferences.size ? [...selectedReferences].map(([id,rows]) => rows.length + " selected rows from " + (availableReferences.get(id)?.payload?.title || id)).join("; ") : "No table rows attached."; };
    const loadReferenceRows = () => {
      $("referenceRows").replaceChildren();const result=availableReferences.get($("referenceResult").value);
      if(!result?.payload)return;
      result.payload.rows.forEach((row,index)=>{const option=document.createElement("option");option.value=String(index);option.textContent=row.join(" · ").slice(0,160);option.selected=(selectedReferences.get(result.context.resultId)||[]).includes(index);$("referenceRows").appendChild(option);});
    };
    function refreshReferenceChoices() {
      if (typeof directoryResult === "undefined") return;
      const results=[...state.events.flatMap(e=>e.payloadResults || []),...gameResults.values()];
      if(directoryResult)results.push(directoryResult);
      availableReferences=new Map(results.filter(r=>r.payload).map(r=>[r.context.resultId,r]));
      const key=[...availableReferences.keys()].join(",");
      if($("referenceResult").dataset.key===key)return;
      const previous=$("referenceResult").value;$("referenceResult").replaceChildren();
      for(const [id,r] of availableReferences){const option=document.createElement("option");option.value=id;option.textContent=r.payload.title;$("referenceResult").appendChild(option);}
      if(availableReferences.has(previous))$("referenceResult").value=previous;
      $("referenceResult").dataset.key=key;loadReferenceRows();referenceSummary();
    }
    $("referenceResult").onchange=loadReferenceRows;
    $("attachRows").onclick=()=>{
      const id=$("referenceResult").value,rows=[...$("referenceRows").selectedOptions].map(o=>Number(o.value));
      if(!id || !rows.length || rows.length>20 || !selectedReferences.has(id) && selectedReferences.size>=3){$("referenceStatus").textContent="Select 1–20 rows from up to three results.";return;}
      selectedReferences.set(id,rows);referenceSummary();
    };
    $("detachRows").onclick=()=>{selectedReferences.delete($("referenceResult").value);loadReferenceRows();referenceSummary();};
    $("detachTeam").onclick=async()=>{
      const conversationId=conversationIdInput.value.trim(),userId=userIdInput.value.trim();
      const response=await fetch(state.workspaceConversationId === conversationId ? conversationBase(conversationId) + "/context/detach" : "/conversation-context/detach",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({conversationId,userId})}).catch(()=>null);
      if(conversationId!==conversationIdInput.value.trim() || userId!==userIdInput.value.trim())return;
      if(!response?.ok){$("referenceStatus").textContent="Could not detach team reference.";return;}
      await refreshConversationContext();
    };
    let directoryResult, directoryOwner, directoryRequest;
    const clearDirectory = () => { directoryRequest?.abort(); directoryResult = null; $("teamTopicControls").hidden = true; $("directoryPayload").replaceChildren(); $("directoryStatus").textContent = ""; };
    fetch("/sports/team-directories").then(r => r.json()).then(data => {
      if(data.gameLeagues?.length){$("gamesPanel").hidden=false;for(const league of data.gameLeagues){const o=document.createElement("option");o.value=league;o.textContent=league;$("gamesLeague").appendChild(o);}}
      if (!data.leagues?.length) return;
      $("teamDirectoryPanel").hidden = false;
      for (const sport of [...new Set(data.topics.map(t => t.sport))]) { const option = document.createElement("option"); option.value = sport; option.textContent = sport; $("directorySport").appendChild(option); }
      const selectSport = () => {
        clearDirectory(); $("directoryLeague").replaceChildren();
        for (const topic of data.topics.filter(t => t.sport === $("directorySport").value)) { const option = document.createElement("option"); option.value = topic.league; option.textContent = topic.league; $("directoryLeague").appendChild(option); }
      };
      $("directorySport").onchange = selectSport; $("directoryLeague").onchange = clearDirectory; selectSport();
    }).catch(() => {});
    $("loadTeams").onclick = async () => {
      clearDirectory(); const league = $("directoryLeague").value; const controller = new AbortController(); directoryRequest = controller;
      const conversationId = $("conversationId").value.trim(), userId = $("userId").value.trim();
      $("directoryPayload").replaceChildren(); $("directoryStatus").textContent = "Loading directory…";
      try {
        const response = await fetch("/sports/teams", {method:"POST", headers:{"Content-Type":"application/json"}, signal:controller.signal,
          body:JSON.stringify({conversationId,userId,league})});
        const result = await response.json(); if (controller.signal.aborted) return;
        if (league !== $("directoryLeague").value || conversationId !== $("conversationId").value.trim() || userId !== $("userId").value.trim()) { $("directoryStatus").textContent = "Selection changed; load the directory again."; return; }
        if (!response.ok) throw Error(result.error || "Directory unavailable");
        directoryResult = result; directoryOwner = {conversationId,userId};
        $("directoryTeam").replaceChildren();
        result.payload.rows.forEach((row,index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = row[0]; $("directoryTeam").appendChild(option); });
        $("attachTeamReference").checked = false; $("teamTopicControls").hidden = false;
        refreshReferenceChoices();
        renderToolPayloads($("directoryPayload"), [result]); $("directoryStatus").textContent = "Directory displayed. Rows were not sent to a model.";
      } catch (error) { if (!controller.signal.aborted) $("directoryStatus").textContent = error.message; }
    };
    $("gamesSelection").onchange=()=>{const latest=$("gamesSelection").value === "latest_completed";$("gamesFrom").disabled=latest;$("gamesTo").disabled=latest;};
    const runGames=async operation=>{
      if(operation === "details" && (!gameSearchResult || !$("selectedGame").options.length))return;
      gameRequest?.abort();const controller=new AbortController();gameRequest=controller;$("showGameDetails").disabled=true;
      const conversationId=conversationIdInput.value.trim(),userId=userIdInput.value.trim();
      const input=operation === "details" ? {resultId:gameSearchResult.context.resultId,row:Number($("selectedGame").value)} : {
        league:$("gamesLeague").value,selection:$("gamesSelection").value,...($("gamesTeam").value.trim()?{teamQuery:$("gamesTeam").value.trim()}:{}),
        ...($("gamesSelection").value === "all" ? {from:$("gamesFrom").value.trim(),to:$("gamesTo").value.trim()}: {})};
      if(operation === "search"){gameSearchResult=null;$("selectedGame").replaceChildren();}
      $("gamesStatus").textContent="Retrieving game records…";$("gamesPayload").replaceChildren();
      try{
        const r=await fetch("/sports/games",{method:"POST",headers:{"Content-Type":"application/json"},signal:controller.signal,body:JSON.stringify({conversationId,userId,operation,input})});const result=await r.json();
        if(controller.signal.aborted || conversationId!==conversationIdInput.value.trim() || userId!==userIdInput.value.trim())return;
        if(!r.ok)throw Error(result.error || "Game request failed");
        if(!result.context){
          const status=result.resolution?.status || result.status;
          $("gamesStatus").textContent=status === "not_found" ? "No matching team found. Check the team name and league." : status === "ambiguous" || status === "partial" ? "Team lookup did not identify a unique match. Refine the team name and league." : status === "unsupported" ? "Game search or team lookup is not configured for this league." : "Team lookup is unavailable. Try again later.";
          return;
        }
        gameResults.set(result.context.resultId,result);if(gameResults.size>20)gameResults.delete(gameResults.keys().next().value);
        if(operation === "search" && result.payload){gameSearchResult=result;result.payload.rows.forEach((row,index)=>{const o=document.createElement("option");o.value=String(index);o.textContent=row.slice(0,4).join(" · ");$("selectedGame").appendChild(o);});}
        renderToolPayloads($("gamesPayload"),[result]);$("gamesStatus").textContent=result.context.summary+" "+result.context.limitations.join(". ");refreshReferenceChoices();
      }catch(error){if(!controller.signal.aborted)$("gamesStatus").textContent=error.message;}
      finally{if(gameRequest===controller && !controller.signal.aborted)$("showGameDetails").disabled=!gameSearchResult || !$("selectedGame").options.length;}
    };
    $("searchGames").onclick=()=>runGames("search");$("showGameDetails").onclick=()=>runGames("details");
    $("openTeamConversation").onclick = async () => {
      if (!directoryResult) return;
      const selected = directoryResult, owner = directoryOwner;
      $("openTeamConversation").disabled = true;
      try {
        const r = await fetch("/sports/conversations", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...owner,resultId:selected.context.resultId,row:Number($("directoryTeam").value),attachReference:$("attachTeamReference").checked})});
        const data = await r.json();
        if (directoryResult !== selected || owner.userId !== $("userId").value.trim() || owner.conversationId !== $("conversationId").value.trim()) return;
        if (!r.ok) throw Error(data.error || "Cannot open conversation");
        $("conversationId").value = data.conversationId; $("conversationId").dispatchEvent(new Event("change"));
        showConversationContext(data.context); $("prompt").focus();
      } catch (error) { $("directoryStatus").textContent = error.message; }
      finally { $("openTeamConversation").disabled = false; }
    };
    for (const id of ["conversationId", "userId"]) $(id).addEventListener("change", () => { saveConversation(); gameRequest?.abort(); $("showGameDetails").disabled=true; gameResults.clear(); gameSearchResult=null; $("selectedGame").replaceChildren(); $("gamesPayload").replaceChildren(); $("gamesStatus").textContent=""; selectedReferences.clear(); clearDirectory(); refreshReferenceChoices(); referenceSummary(); void refreshConversationContext(); });
    void refreshConversationContext();
    renderDecision();
    renderThread();
    openTimelineStream();
    void fetchTelemetry();
    setInterval(refreshLoop, 1000);
    setInterval(updateActivityTimers, 1000);

    window.addEventListener("beforeunload", () => {
      cancelStreamRetry();
      if (timelineStream) {
        timelineStream.close();
      }
    });
  </script>
${documentTasks ? documentTaskScript() : ""}
${planStatus ? planStatusScript() + (planRunControls ? `\n${planRunControlsScript()}` : "") + (attemptProgress ? `\n${attemptProgressScript()}` : "") : ""}${executiveOverview ? `\n${executiveOverviewScript()}` : ""}${workflows ? `\n${workflowPanelScript()}` : ""}${workspace ? `\n${workspacePanelScript()}` : ""}
</body>
</html>`;
}
