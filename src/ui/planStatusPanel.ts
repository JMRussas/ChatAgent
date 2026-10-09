/** Frozen panel bounds shared by the markup, the script and the tests. */
export const PLAN_STATUS_LIMITS = {
  maxLeaves: 200,
  maxTextChars: 200,
  deadlineMs: 10_000,
  maxResponseBytes: 1024 * 1024
} as const;

/**
 * Operator-only, read-only view of the recorded plan state. It never writes, launches or
 * polls; every read is one explicit same-origin GET and every server field is untrusted.
 */
export function planStatusPanelHtml(): string {
  return `<details id="planStatusPanel">
        <summary>Plan status (operator, read-only)</summary>
        <p>Recorded plan state only. It does not show whether any worker is running or making useful progress.</p>
        <label for="planRoot">Plan root (lowercase GUID)</label>
        <input id="planRoot" type="text" autocomplete="off" spellcheck="false" />
        <button type="button" id="planRefresh">Load / refresh</button>
        <p id="planStatusNote" role="status"></p>
        <div id="planStatusStale" role="alert" hidden style="border:2px solid #b45309;padding:6px;font-weight:bold"></div>
        <div id="planStatusView"></div>
      </details>`;
}

export function planStatusScript(): string {
  return `<script>
(function () {
  var MAX_LEAVES = ${PLAN_STATUS_LIMITS.maxLeaves};
  var MAX_TEXT = ${PLAN_STATUS_LIMITS.maxTextChars};
  var DEADLINE_MS = ${PLAN_STATUS_LIMITS.deadlineMs};
  var MAX_BYTES = ${PLAN_STATUS_LIMITS.maxResponseBytes};
  var GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var REASONS = ['INVALID_URL', 'INVALID_ROOT', 'INVALID_RESPONSE', 'INVALID_NUMBER', 'DUPLICATE_KEY', 'UNSAFE_KEY', 'UNSUPPORTED_CONTRACT', 'ROOT_MISMATCH', 'RESPONSE_TOO_LARGE', 'TIMEOUT', 'UNAVAILABLE', 'HTTP_ERROR', 'INVALID_OPTIONS'];
  var HISTORICAL = ' — prior decision from an older attempt (historical)';
  var rootInput = document.getElementById('planRoot');
  var button = document.getElementById('planRefresh');
  var note = document.getElementById('planStatusNote');
  var stale = document.getElementById('planStatusStale');
  var view = document.getElementById('planStatusView');
  var conversationInput = document.getElementById('conversationId');
  var userInput = document.getElementById('userId');
  var current = null;
  var lastGood = null;

  function scopeNow() {
    return JSON.stringify([String(userInput.value || '').trim(), String(conversationInput.value || '').trim()]);
  }
  var scope = scopeNow();

  function storageKey() {
    return 'chatagent-plan-root:' + encodeURIComponent(String(userInput.value || '').trim()) + ':' + encodeURIComponent(String(conversationInput.value || '').trim());
  }
  function readStored() {
    try {
      var saved = sessionStorage.getItem(storageKey());
      return typeof saved === 'string' && GUID.test(saved) ? saved : '';
    } catch (e) {
      return '';
    }
  }
  function writeStored(root) {
    try { sessionStorage.setItem(storageKey(), root); } catch (e) {}
  }

  function clip(value) {
    var s = String(value);
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
  }
  function text(value) {
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return null;
  }
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function add(parent, tag, content) {
    var node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    parent.append(node);
    return node;
  }
  function line(parent, label, value) {
    var p = add(parent, 'p');
    var shown = text(value);
    if (shown === null) {
      add(p, 'span', label + ': none');
      return;
    }
    add(p, 'span', label + ': ');
    add(p, 'code', shown);
  }

  function progressLine(state) {
    switch (state) {
      case 'complete': return 'Plan complete (as recorded by the plan service)';
      case 'inconsistent': return 'Plan state is inconsistent — neither complete nor incomplete is claimed';
      case 'active': return 'Work is allocated (recorded state); whether any worker has begun is unknown';
      case 'awaiting_review': return 'Plan is awaiting review';
      case 'ready': return 'Work is ready to be claimed';
      case 'stuck': return 'Nothing is ready to be claimed';
      default: return 'Plan progress: unrecognized state';
    }
  }
  function pinLabel(pins) {
    switch (pins) {
      case 'current': return 'inputs current';
      case 'stale': return 'inputs changed — stale';
      case 'unknown': return 'inputs unknown (attempt recorded without pins)';
      case 'none': return 'no attempt';
      default: return 'inputs unrecognized';
    }
  }
  function stateLabel(leaf) {
    var historical = leaf.acceptanceHistorical === true;
    var base;
    switch (leaf.state) {
      case 'ready': base = 'Ready'; break;
      case 'blocked': base = 'Blocked'; break;
      case 'in_progress': base = 'Allocated/in progress (recorded state)'; break;
      case 'review_pending': base = 'Awaiting review'; break;
      case 'accepted': return historical ? 'unrecognized state' : 'Accepted';
      case 'rejected': base = 'Rejected'; break;
      case 'stale': base = 'Stale'; break;
      case 'cancelled': base = 'Cancelled'; break;
      default: return 'unrecognized state';
    }
    return historical ? base + HISTORICAL : base;
  }

  function renderBlockers(parent, blockers) {
    if (!Array.isArray(blockers) || blockers.length === 0) return;
    add(parent, 'p', 'Current blockers only (not the full dependency graph):');
    var shown = Math.min(blockers.length, MAX_LEAVES);
    for (var i = 0; i < shown; i++) {
      var b = isObject(blockers[i]) ? blockers[i] : {};
      var who = text(b.predecessorName);
      if (who === null) who = text(b.predecessorId);
      if (who === null) who = 'unknown task';
      var why = text(b.reason);
      if (why === null) why = 'no reason given';
      add(parent, 'p', 'waits on ' + who + ' (' + why + ')');
    }
    if (blockers.length > shown) add(parent, 'p', blockers.length - shown + ' more not shown');
  }

  function renderLeaf(box, leaf) {
    var article = add(box, 'article');
    var title = text(leaf.name);
    if (title === null) title = text(leaf.nodeId);
    add(article, 'strong', title === null ? 'unnamed task' : title);
    add(article, 'span', stateLabel(leaf));
    line(article, 'Task', leaf.nodeId);
    add(article, 'p', 'Input pins: ' + pinLabel(leaf.attemptPins));
    if (leaf.upstreamChanged === true) add(article, 'p', 'Upstream changed since the last attempt');
    line(article, 'Attempt', leaf.attemptId);
    line(article, 'Attempt epoch', leaf.attemptEpoch);
    line(article, 'Executor', leaf.executorRef);
    line(article, 'Artifact', leaf.artifactRef);
    line(article, 'Content revision', leaf.contentRevision);
    line(article, 'State revision', leaf.stateRevision);
    line(article, 'Scope', leaf.scope);
    if (leaf.state === 'in_progress') {
      add(article, 'p', 'Worker start: unknown');
      add(article, 'p', 'Liveness and useful progress: not reported');
    }
    renderBlockers(article, leaf.blockers);
  }

  function render(data, root) {
    var box = document.createElement('div');
    var head = add(box, 'p');
    add(head, 'span', 'Plan root: ');
    add(head, 'code', root);
    if (data.status === 'invalid') {
      add(box, 'p', 'Plan is invalid; readiness errors:');
      var errors = Math.min(data.errors.length, MAX_LEAVES);
      for (var e = 0; e < errors; e++) {
        var item = data.errors[e];
        var code = text(item.code);
        var where = text(item.nodeId);
        add(box, 'p', (code === null ? 'unknown error' : code) + (where === null ? '' : ' (' + where + ')'));
      }
      add(box, 'p', 'No leaf state is shown because the plan projection is invalid.');
      return box;
    }
    add(box, 'strong', progressLine(data.progress.state));
    add(box, 'p', 'Recorded plan state only. Worker liveness and useful progress are not reported.');
    var counts = data.progress.leafCounts;
    if (isObject(counts)) {
      var keys = Object.keys(counts).slice(0, 20);
      var parts = [];
      for (var k = 0; k < keys.length; k++) {
        var n = text(counts[keys[k]]);
        if (n !== null) parts.push(clip(keys[k]) + ' ' + n);
      }
      if (parts.length > 0) add(box, 'p', 'Leaf counts: ' + parts.join(', '));
    }
    var shown = Math.min(data.leaves.length, MAX_LEAVES);
    for (var i = 0; i < shown; i++) renderLeaf(box, data.leaves[i]);
    if (data.leaves.length > shown) {
      add(box, 'p', data.leaves.length - shown + ' more not shown (limit ' + MAX_LEAVES + ' leaves)');
    }
    return box;
  }

  function parseStatus(raw, root) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (!isObject(data) || data.rootId !== root) return null;
    if (data.status === 'invalid') {
      if (!Array.isArray(data.errors)) return null;
      for (var e = 0; e < data.errors.length; e++) if (!isObject(data.errors[e])) return null;
      return data;
    }
    if (data.status !== 'ok' || !isObject(data.progress) || typeof data.progress.state !== 'string') return null;
    if (!Array.isArray(data.leaves)) return null;
    for (var i = 0; i < data.leaves.length; i++) {
      var leaf = data.leaves[i];
      if (!isObject(leaf) || typeof leaf.nodeId !== 'string' || typeof leaf.state !== 'string') return null;
    }
    return data;
  }

  function clearView() {
    lastGood = null;
    view.replaceChildren();
    stale.hidden = true;
    stale.textContent = '';
  }
  function abortCurrent() {
    if (!current) return;
    clearTimeout(current.timer);
    current.ctl.abort();
    current = null;
    button.disabled = false;
  }
  function scopeChanged() {
    var next = scopeNow();
    if (next === scope) return;
    scope = next;
    abortCurrent();
    clearView();
    var saved = readStored();
    rootInput.value = saved;
    note.textContent = saved ? 'Stored plan root restored. Press Load to read it.' : '';
  }
  function stillCurrent(req) {
    if (current !== req) return false;
    if (scopeNow() !== req.scope) {
      scopeChanged();
      return false;
    }
    return true;
  }

  function fail(req, message) {
    note.textContent = message;
    if (lastGood && lastGood.root === req.root) {
      stale.textContent = 'Last successful read at ' + lastGood.at + " (browser clock, not Hekate's) — now unavailable";
      stale.hidden = false;
    } else {
      clearView();
    }
  }

  function tooLarge(req) {
    req.ctl.abort();
    throw { tooLarge: true };
  }
  async function readBounded(res, req) {
    var declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_BYTES) tooLarge(req);
    if (!res.body || typeof res.body.getReader !== 'function') {
      var whole = await res.text();
      if (whole.length > MAX_BYTES || new TextEncoder().encode(whole).length > MAX_BYTES) tooLarge(req);
      return whole;
    }
    var reader = res.body.getReader();
    var chunks = [];
    var total = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > MAX_BYTES) tooLarge(req);
      chunks.push(step.value);
    }
    var decoder = new TextDecoder();
    var out = '';
    for (var i = 0; i < chunks.length; i++) out += decoder.decode(chunks[i], { stream: true });
    return out + decoder.decode();
  }

  function refusal(status) {
    if (status === 401) return 'Pairing is required to view plan status.';
    if (status === 403) return 'Operator access required to view plan status.';
    if (status === 404) return 'Plan status is not configured.';
    if (status === 400) return 'Invalid plan root.';
    return 'Plan status request failed (HTTP ' + (status | 0) + ').';
  }
  function unavailable(raw) {
    var reason = 'unrecognized';
    try {
      var parsed = JSON.parse(raw);
      if (isObject(parsed) && typeof parsed.reason === 'string' && REASONS.indexOf(parsed.reason) >= 0) reason = parsed.reason;
    } catch (e) {}
    return 'Plan status unavailable (reason: ' + reason + ').';
  }

  async function run(req, url) {
    try {
      var res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: req.ctl.signal
      });
      if (res.status === 503) {
        var raw503 = await readBounded(res, req);
        if (stillCurrent(req)) fail(req, unavailable(raw503));
        return;
      }
      if (res.status !== 200) {
        req.ctl.abort();
        if (stillCurrent(req)) fail(req, refusal(res.status));
        return;
      }
      var raw = await readBounded(res, req);
      if (!stillCurrent(req)) return;
      var data = parseStatus(raw, req.root);
      if (data === null) {
        fail(req, 'Plan status response was not recognized.');
        return;
      }
      view.replaceChildren(render(data, req.root));
      lastGood = { root: req.root, at: new Date().toISOString() };
      stale.hidden = true;
      stale.textContent = '';
      note.textContent = 'Plan status loaded (read-only).';
    } catch (error) {
      if (!stillCurrent(req)) return;
      if (error && error.tooLarge) fail(req, 'Plan status response is too large to display.');
      else if (req.timedOut) fail(req, 'Plan status request timed out.');
      else fail(req, 'Plan status request failed.');
    } finally {
      clearTimeout(req.timer);
      if (current === req) {
        current = null;
        button.disabled = false;
      }
    }
  }

  function load() {
    scopeChanged();
    if (current) return;
    var value = String(rootInput.value || '').trim();
    if (!GUID.test(value)) {
      note.textContent = 'Invalid plan root.';
      return;
    }
    writeStored(value);
    if (lastGood && lastGood.root !== value) clearView();
    var req = { ctl: new AbortController(), scope: scopeNow(), root: value, timer: null, timedOut: false };
    var url = '/development/plans/' + value + '/status';
    current = req;
    button.disabled = true;
    note.textContent = 'Loading plan status…';
    req.timer = setTimeout(function () {
      req.timedOut = true;
      req.ctl.abort();
    }, DEADLINE_MS);
    run(req, url);
  }

  button.addEventListener('click', load);
  rootInput.addEventListener('keydown', function (event) {
    if (event && event.key === 'Enter') load();
  });
  conversationInput.addEventListener('change', scopeChanged);
  userInput.addEventListener('change', scopeChanged);
  window.addEventListener('pagehide', abortCurrent);

  var restored = readStored();
  if (restored) {
    rootInput.value = restored;
    note.textContent = 'Stored plan root restored. Press Load to read it.';
  }
})();
</script>`;
}
