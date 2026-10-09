/** Frozen task bounds shared by the markup, the script and the tests. */
export const PLAN_RUN_LIMITS = {
  deadlineMs: 10000,
  maxResponseBytes: 1024 * 1024,
  maxTextChars: 200
} as const;

/**
 * Operator-only manual controls for the prepared dispatch host of one plan root. Every action
 * is an explicit click; nothing is sent at load, on reload or on a scope change, and nothing
 * is polled or retried. Every server field is untrusted and is rendered as text.
 */
export function planRunControlsHtml(): string {
  return `<details id="planRunControls">
        <summary>Plan run controls (operator)</summary>
        <p>Manual actions for the plan root above. Nothing runs automatically. Closing the page or changing the scope aborts only the browser request; the server may still finish it.</p>
        <button type="button" id="planHostCheck">Check host</button>
        <button type="button" id="planHostStart">Start prepared plan</button>
        <button type="button" id="planHostStop">Request stop</button>
        <p id="planRunNote" role="status"></p>
        <div id="planRunUnknown" role="alert" hidden style="border:2px solid #b45309;padding:6px;font-weight:bold"></div>
        <div id="planRunView"></div>
      </details>`;
}

export function planRunControlsScript(): string {
  return `<script>
(function () {
  var MAX_TEXT = ${PLAN_RUN_LIMITS.maxTextChars};
  var DEADLINE_MS = ${PLAN_RUN_LIMITS.deadlineMs};
  var MAX_BYTES = ${PLAN_RUN_LIMITS.maxResponseBytes};
  var GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var LAUNCH_ID = /^[0-9a-f]{32}$/;
  var WORD = /^[A-Za-z0-9_.:-]{1,80}$/;
  var STAMP = /^[0-9T:.+Z-]{10,40}$/;
  var CODE = /^[A-Z_]{1,40}$/;
  var OUTCOMES = ['launched', 'uncertain', 'failed', 'refused', 'stop_requested', 'unknown', 'unknown-checked'];
  var LIFECYCLES = ['no_host', 'host_mismatch', 'running', 'dispatching', 'stop_requested', 'unverified', 'owner_gone', 'stopped', 'failed', 'exited'];
  var RESULTS = {
    launch: [
      [200, 'LAUNCHED', 'launched'],
      [202, 'UNCONFIRMED', 'uncertain'],
      [502, 'LAUNCH_UNCERTAIN', 'uncertain'],
      [502, 'LAUNCH_FAILED', 'failed'],
      [409, 'LAUNCH_REFUSED', 'refused']
    ],
    stop: [
      [202, 'STOP_REQUESTED', 'stop_requested'],
      [409, 'OWNER_CHANGED', 'refused'],
      [409, 'STOP_ALREADY_REQUESTED', 'refused'],
      [409, 'NO_LIVE_OWNER', 'refused'],
      [502, 'STOP_UNCERTAIN', 'uncertain']
    ]
  };
  var rootInput = document.getElementById('planRoot');
  var userInput = document.getElementById('userId');
  var conversationInput = document.getElementById('conversationId');
  var checkButton = document.getElementById('planHostCheck');
  var startButton = document.getElementById('planHostStart');
  var stopButton = document.getElementById('planHostStop');
  var note = document.getElementById('planRunNote');
  var unknownBox = document.getElementById('planRunUnknown');
  var view = document.getElementById('planRunView');
  var opBox = document.createElement('div');
  var hostBox = document.createElement('div');
  view.replaceChildren(opBox, hostBox);
  var current = null;
  var last = null;
  var memory = {};

  function parts() {
    return [String(userInput.value || '').trim(), String(conversationInput.value || '').trim(), String(rootInput.value || '').trim()];
  }
  function scopeNow() {
    return JSON.stringify(parts());
  }
  var scope = scopeNow();
  var key = null;

  function keyFor(p) {
    return 'chatagent-plan-run:' + encodeURIComponent(p[0]) + ':' + encodeURIComponent(p[1]) + ':' + p[2];
  }
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function clip(value) {
    var s = String(value);
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
  }
  function add(parent, tag, content) {
    var node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    parent.append(node);
    return node;
  }
  function line(parent, label, value) {
    var p = add(parent, 'p');
    if (value === null || value === undefined) {
      add(p, 'span', label + ': none');
      return;
    }
    add(p, 'span', label + ': ');
    add(p, 'code', clip(value));
  }

  function validRecord(raw, root) {
    if (typeof raw !== 'string' || raw.length > 600) return null;
    var r;
    try { r = JSON.parse(raw); } catch (e) { return null; }
    if (!isObject(r)) return null;
    if (Object.keys(r).sort().join(',') !== 'at,code,kind,launchId,operationId,outcome,root,v') return null;
    if (r.v !== 1 || r.root !== root) return null;
    if (r.kind !== 'launch' && r.kind !== 'stop') return null;
    if (typeof r.operationId !== 'string' || !GUID.test(r.operationId)) return null;
    if (r.launchId !== null && !(typeof r.launchId === 'string' && LAUNCH_ID.test(r.launchId))) return null;
    if (OUTCOMES.indexOf(r.outcome) < 0) return null;
    if (typeof r.code !== 'string' || !CODE.test(r.code)) return null;
    if (typeof r.at !== 'string' || !STAMP.test(r.at)) return null;
    return r;
  }
  function loadRecord(k, root) {
    var rec = validRecord(memory[k], root);
    if (rec) return rec;
    try { return validRecord(sessionStorage.getItem(k), root); } catch (e) { return null; }
  }
  function makeRecord(req, outcome, code, launchId) {
    return { v: 1, root: req.root, kind: req.kind, operationId: req.operationId, launchId: launchId, outcome: outcome, code: code, at: new Date().toISOString() };
  }
  function saveRecord(k, rec) {
    var s = JSON.stringify(rec);
    memory[k] = s;
    try { sessionStorage.setItem(k, s); } catch (e) {}
  }
  function blocking(rec) {
    return !!rec && (rec.outcome === 'unknown' || rec.outcome === 'uncertain');
  }

  function headline(rec) {
    switch (rec.outcome) {
      case 'launched': return 'Launched; the host is attached (not worker progress)';
      case 'stop_requested': return 'Stop requested; this is not proof the host stopped';
      case 'uncertain': return 'Outcome uncertain; the host could not confirm it';
      case 'failed': return 'The host reported the operation failed';
      case 'refused': return 'Refused by the server; no success is claimed';
      case 'unknown-checked': return 'Earlier outcome unknown-checked: a later host check found no unresolved journal evidence; success is not claimed';
      default: return 'Outcome unknown';
    }
  }
  function renderOp() {
    opBox.replaceChildren();
    if (!last) return;
    add(opBox, 'strong', headline(last));
    add(opBox, 'p', 'Last operation (browser metadata, not a host read)');
    line(opBox, 'Root', last.root);
    line(opBox, 'Kind', last.kind);
    line(opBox, 'Operation ID', last.operationId);
    line(opBox, 'Launch ID', last.launchId);
    line(opBox, 'Outcome', last.outcome);
    line(opBox, 'Code', last.code);
    line(opBox, 'Recorded at (browser clock)', last.at);
  }
  function render() {
    var blocked = blocking(last);
    renderOp();
    if (blocked) {
      unknownBox.textContent = 'Operation ' + last.operationId + ' (' + last.kind + ') has an unknown outcome. Start and stop stay blocked until Check host reads this root journal with nothing unresolved, uncertain or malformed.';
    } else {
      unknownBox.textContent = '';
    }
    unknownBox.hidden = !blocked;
    checkButton.disabled = !!current;
    startButton.disabled = !!current || blocked;
    stopButton.disabled = !!current || blocked;
  }

  function sync() {
    scope = scopeNow();
    var p = parts();
    if (GUID.test(p[2])) {
      key = keyFor(p);
      last = loadRecord(key, p[2]);
    } else {
      key = null;
      last = null;
    }
    hostBox.replaceChildren();
    render();
    note.textContent = blocking(last) ? 'A stored operation outcome is unknown. Nothing was sent; press Check host.' : '';
  }
  function abortCurrent(why) {
    if (!current) return '';
    var req = current;
    current = null;
    clearTimeout(req.timer);
    req.ctl.abort();
    return req.kind === 'check'
      ? 'Host check abandoned (' + why + ').'
      : 'The browser request was aborted (' + why + '), which does not cancel the server; the ' + req.kind + ' outcome is unknown.';
  }
  function changed() {
    var message = '';
    if (current && scopeNow() !== current.scope) message = abortCurrent('scope changed');
    if (current) return;
    sync();
    if (message) note.textContent = message;
  }
  function stillCurrent(req) {
    if (current !== req) return false;
    if (scopeNow() !== req.scope) {
      changed();
      return false;
    }
    return true;
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
    var decoder = new TextDecoder();
    var out = '';
    var total = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > MAX_BYTES) tooLarge(req);
      out += decoder.decode(step.value, { stream: true });
    }
    return out + decoder.decode();
  }

  function word(value) {
    return typeof value === 'string' && WORD.test(value) ? value : null;
  }
  function stamp(value) {
    return typeof value === 'string' && STAMP.test(value) ? value : null;
  }
  function optional(value, test) {
    return value === undefined || value === null || test(value);
  }
  function parseHost(raw, root) {
    var h;
    try { h = JSON.parse(raw); } catch (e) { return null; }
    if (!isObject(h) || h.rootId !== root) return null;
    if (LIFECYCLES.indexOf(h.lifecycle) < 0) return null;
    var j = h.journal;
    if (j !== null && j !== undefined) {
      if (!isObject(j) || typeof j.unresolvedIntent !== 'boolean' || typeof j.uncertainLaunch !== 'boolean' || typeof j.uncertainStop !== 'boolean') return null;
      if (!Number.isSafeInteger(j.malformedRecords) || j.malformedRecords < 0) return null;
    }
    if (!optional(h.launchId, function (v) { return typeof v === 'string' && LAUNCH_ID.test(v); })) return null;
    if (!optional(h.host, function (v) { return v === 'attached' || v === 'none' || v === 'host_mismatch'; })) return null;
    var words = ['liveness', 'phase', 'state', 'stopReason'];
    for (var w = 0; w < words.length; w++) if (!optional(h[words[w]], word)) return null;
    var stamps = ['startedAt', 'heartbeatAt', 'exitedAt'];
    for (var s = 0; s < stamps.length; s++) if (!optional(h[stamps[s]], stamp)) return null;
    if (h.stopRequested !== undefined && typeof h.stopRequested !== 'boolean') return null;
    var c = h.current;
    if (c !== null && c !== undefined) {
      if (!isObject(c) || !optional(c.node, word)) return null;
      if (!optional(c.nodeId, function (v) { return typeof v === 'string' && GUID.test(v); })) return null;
      if (c.workerLiveness !== undefined && c.workerLiveness !== 'unknown') return null;
    }
    var counters = h.counters;
    if (counters !== null && counters !== undefined) {
      if (!isObject(counters)) return null;
      var names = Object.keys(counters);
      if (names.length > 16) return null;
      for (var n = 0; n < names.length; n++) {
        if (!WORD.test(names[n]) || !Number.isSafeInteger(counters[names[n]])) return null;
      }
    }
    return h;
  }
  function journalClean(h) {
    var j = h.journal;
    return isObject(j) && j.unresolvedIntent === false && j.uncertainLaunch === false && j.uncertainStop === false && j.malformedRecords === 0 && h.lifecycle !== 'host_mismatch';
  }

  function walk(node, out, budget) {
    if (!node || budget.n <= 0) return;
    budget.n--;
    out.push(node);
    var kids = node.children;
    if (!kids) return;
    for (var i = 0; i < kids.length; i++) walk(kids[i], out, budget);
  }
  function panelInfo(root) {
    var panel = document.getElementById('planStatusView');
    if (!panel) return null;
    var stale = document.getElementById('planStatusStale');
    if (stale && stale.hidden === false) return null;
    var full = String(panel.textContent || '');
    if (full.indexOf('Plan root: ' + root) !== 0) return null;
    var stage = null;
    if (full.indexOf('Plan is awaiting review') >= 0) stage = 'awaiting review';
    else if (full.indexOf('Work is allocated') >= 0) stage = 'work allocated (recorded state)';
    else if (full.indexOf('Work is ready to be claimed') >= 0) stage = 'work ready to be claimed';
    else if (full.indexOf('Nothing is ready to be claimed') >= 0) stage = 'nothing ready to be claimed';
    var nodes = [];
    walk(panel, nodes, { n: 3000 });
    var leaves = [];
    for (var i = 0; i < nodes.length && leaves.length < 200; i++) {
      if (String(nodes[i].tagName || '').toLowerCase() !== 'article') continue;
      var leaf = { task: null, attempt: null };
      var kids = nodes[i].children || [];
      for (var k = 0; k < kids.length; k++) {
        var t = String(kids[k].textContent || '');
        if (t.indexOf('Task: ') === 0) leaf.task = clip(t.slice(6));
        else if (t.indexOf('Attempt: ') === 0) leaf.attempt = clip(t.slice(9));
      }
      if (leaf.task !== null) leaves.push(leaf);
    }
    return { stage: stage, leaves: leaves };
  }

  function lifecycleLine(h) {
    switch (h.lifecycle) {
      case 'running': return 'Host running (host-recorded state)';
      case 'dispatching': return 'Host running; a plan node is recorded as current';
      case 'stop_requested': return 'Stop requested; the host is still running and has not stopped';
      case 'stopped': return 'Host exited: stopped';
      case 'failed': return 'Host exited: failed';
      case 'exited': return 'Host exited (neither stopped nor failed is recorded)';
      case 'unverified': return 'Host state is unverified or unavailable; it may still be running';
      case 'owner_gone': return 'Host owner is gone; the recorded launch is no longer verified';
      case 'host_mismatch': return 'Host status does not match this prepared plan; nothing is claimed';
      default: return 'No host is attached';
    }
  }
  function renderHost(h, readAt) {
    hostBox.replaceChildren();
    add(hostBox, 'strong', lifecycleLine(h));
    line(hostBox, 'Root', h.rootId);
    add(hostBox, 'p', 'Host read at ' + readAt + ' (browser clock)');
    line(hostBox, 'Launch ID', h.launchId);
    line(hostBox, 'Host heartbeat (host only, not worker progress)', h.heartbeatAt);
    add(hostBox, 'p', 'Worker liveness: unknown (a host heartbeat is not worker progress)');
    line(hostBox, 'Stop reason', h.stopReason);
    line(hostBox, 'Phase', h.phase);
    line(hostBox, 'State', h.state);
    if (isObject(h.counters)) {
      var names = Object.keys(h.counters);
      var shown = [];
      for (var i = 0; i < names.length; i++) shown.push(names[i] + ' ' + h.counters[names[i]]);
      if (shown.length > 0) add(hostBox, 'p', 'Host counters: ' + shown.join(', '));
    }
    var j = h.journal;
    if (!isObject(j)) {
      add(hostBox, 'p', 'Journal evidence: not reported');
    } else if (journalClean(h)) {
      add(hostBox, 'p', 'Journal: no unresolved, uncertain or malformed records');
    } else {
      add(hostBox, 'p', 'Journal: unresolved ' + j.unresolvedIntent + ', uncertain launch ' + j.uncertainLaunch + ', uncertain stop ' + j.uncertainStop + ', malformed ' + j.malformedRecords);
    }
    var c = h.current;
    var panel = panelInfo(h.rootId);
    if (isObject(c)) {
      line(hostBox, 'Host current plan key (display name only)', c.node === undefined ? null : c.node);
      line(hostBox, 'Host current task ID', c.nodeId === undefined ? null : c.nodeId);
      if (typeof c.nodeId === 'string') {
        if (!panel) {
          add(hostBox, 'p', 'Status panel not loaded for this root; no task correlation (separate observations)');
        } else {
          var match = null;
          for (var m = 0; m < panel.leaves.length && match === null; m++) {
            if (panel.leaves[m].task === c.nodeId) match = panel.leaves[m];
          }
          if (match) {
            add(hostBox, 'p', 'Status panel task ' + match.task + ', attempt ' + (match.attempt === null || match.attempt === 'none' ? 'none' : match.attempt) + ' (matches host current task ID; separate observations)');
          } else if (panel.leaves.length === 0) {
            add(hostBox, 'p', 'Status panel lists no task (separate observations)');
          } else {
            for (var q = 0; q < panel.leaves.length && q < 5; q++) {
              var other = panel.leaves[q];
              add(hostBox, 'p', 'Status panel lists task ' + other.task + ', attempt ' + (other.attempt === null ? 'none' : other.attempt) + ' (does not match host current task ID; separate observations)');
            }
          }
        }
      }
    }
    if (panel && panel.stage) add(hostBox, 'p', 'Plan status panel: ' + panel.stage + ' (separate from host state)');
  }
  function notChecked(message) {
    hostBox.replaceChildren();
    add(hostBox, 'strong', 'Host not checked');
    note.textContent = message;
  }

  function handleCheck(req, status, raw) {
    if (status !== 200) {
      var code = null;
      try {
        var body = JSON.parse(raw);
        if (isObject(body) && typeof body.code === 'string' && CODE.test(body.code)) code = body.code;
      } catch (e) {}
      if (status === 401) notChecked('Pairing is required to check the host.');
      else if (status === 403) notChecked('Operator access required to check the host.');
      else if (status === 404 && code === 'DISPATCH_HOST_DISABLED') notChecked('The dispatch host is not configured.');
      else notChecked('Host check refused or failed (HTTP ' + (status | 0) + (code ? ', ' + code : '') + ').');
      return;
    }
    var h = parseHost(raw, req.root);
    if (h === null) {
      notChecked('The host response is not a supported projection; nothing was inferred from it.');
      return;
    }
    renderHost(h, new Date().toISOString());
    var rec = loadRecord(req.key, req.root);
    if (!blocking(rec)) {
      note.textContent = 'Host checked (read-only).';
      return;
    }
    if (journalClean(h)) {
      var cleared = { v: 1, root: rec.root, kind: rec.kind, operationId: rec.operationId, launchId: rec.launchId, outcome: 'unknown-checked', code: rec.code, at: rec.at };
      saveRecord(req.key, cleared);
      last = cleared;
      note.textContent = 'Host checked. The earlier operation is now labelled unknown-checked: its journal shows nothing unresolved, but success is not claimed.';
    } else {
      note.textContent = 'Host checked, but the earlier operation stays unknown: journal evidence is missing, unresolved, uncertain or malformed.';
    }
  }

  function recognise(req, status, body) {
    if (!isObject(body) || body.operationId !== req.operationId) return null;
    var table = RESULTS[req.kind];
    for (var i = 0; i < table.length; i++) {
      if (table[i][0] !== status || table[i][1] !== body.code || table[i][2] !== body.outcome) continue;
      if (body.launchId !== undefined && body.launchId !== null && !(typeof body.launchId === 'string' && LAUNCH_ID.test(body.launchId))) return null;
      if (body.outcome === 'launched' && !(body.host === 'attached' && typeof body.launchId === 'string')) return null;
      if (body.outcome === 'stop_requested' && !(body.state === 'stop_requested' && body.exited === false)) return null;
      return { outcome: body.outcome, code: body.code, launchId: typeof body.launchId === 'string' ? body.launchId : null };
    }
    return null;
  }
  function finishUnknown(req, code) {
    last = makeRecord(req, 'unknown', code, null);
    saveRecord(req.key, last);
    if (code === 'TIMEOUT') note.textContent = 'The request timed out after ' + DEADLINE_MS / 1000 + ' seconds; the outcome is unknown and is not retried. Press Check host.';
    else if (code === 'TOO_LARGE') note.textContent = 'The response was too large to read; the outcome is unknown and is not retried. Press Check host.';
    else note.textContent = 'The request failed or its response was not recognized; the outcome is unknown and is not retried. Press Check host.';
  }
  function handleMutation(req, status, raw) {
    var body = null;
    try { body = JSON.parse(raw); } catch (e) {}
    var result = recognise(req, status, body);
    if (result === null && (status === 401 || status === 403)) {
      result = { outcome: 'refused', code: status === 401 ? 'PAIRING_REQUIRED' : 'OPERATOR_REQUIRED', launchId: null };
    } else if (result === null && isObject(body) && body.outcome === undefined && typeof body.code === 'string' && CODE.test(body.code) && (status === 400 || status === 404 || status === 409)) {
      result = { outcome: 'refused', code: body.code, launchId: null };
    }
    if (result === null) {
      finishUnknown(req, 'UNRECOGNIZED');
      return;
    }
    last = makeRecord(req, result.outcome, result.code, result.launchId);
    saveRecord(req.key, last);
    var replay = isObject(body) && body.replayed === true ? ' (the host replayed its recorded result)' : '';
    if (result.outcome === 'launched') note.textContent = 'Launched; the host is attached. This is not worker progress.' + replay;
    else if (result.outcome === 'stop_requested') note.textContent = 'Stop requested; this is not proof the host stopped. Press Check host.' + replay;
    else if (result.outcome === 'refused') note.textContent = 'Refused (' + result.code + '). Press Check host to read the recorded state.';
    else if (result.outcome === 'failed') note.textContent = 'The host reported the operation failed; no worker is claimed. Press Check host.';
    else note.textContent = 'The outcome is uncertain; the host could not confirm it. Press Check host before anything else.';
  }

  async function run(req) {
    try {
      var init = {
        method: req.kind === 'check' ? 'GET' : 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: req.ctl.signal
      };
      if (req.kind !== 'check') {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify({ operationId: req.operationId });
      }
      var url = '/development/plans/' + req.root + '/dispatch' + (req.kind === 'launch' ? '/launch' : req.kind === 'stop' ? '/stop' : '');
      var res = await fetch(url, init);
      var raw = await readBounded(res, req);
      if (!stillCurrent(req)) return;
      if (req.kind === 'check') handleCheck(req, res.status, raw);
      else handleMutation(req, res.status, raw);
    } catch (error) {
      if (!stillCurrent(req)) return;
      var code = error && error.tooLarge ? 'TOO_LARGE' : req.timedOut ? 'TIMEOUT' : 'NETWORK';
      if (req.kind !== 'check') finishUnknown(req, code);
      else if (code === 'TIMEOUT') notChecked('The host check timed out.');
      else if (code === 'TOO_LARGE') notChecked('The host response was too large to read.');
      else notChecked('The host check failed.');
    } finally {
      clearTimeout(req.timer);
      if (current === req) {
        current = null;
        render();
      }
    }
  }

  function start(kind) {
    if (scopeNow() !== scope) changed();
    if (current) return;
    var p = parts();
    if (!GUID.test(p[2])) {
      note.textContent = 'Invalid plan root; nothing was sent.';
      return;
    }
    if (kind !== 'check' && blocking(last)) {
      note.textContent = 'Blocked: an earlier operation is unknown. Press Check host first.';
      return;
    }
    var operationId = null;
    if (kind !== 'check') {
      operationId = window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : '';
      if (!GUID.test(operationId)) {
        note.textContent = 'This browser cannot create an operation ID; nothing was sent.';
        return;
      }
    }
    var req = { ctl: new AbortController(), scope: scope, key: key, root: p[2], kind: kind, operationId: operationId, timer: null, timedOut: false };
    if (kind !== 'check') {
      last = makeRecord(req, 'unknown', 'IN_FLIGHT', null);
      saveRecord(key, last);
    }
    current = req;
    render();
    note.textContent = kind === 'check' ? 'Checking host…' : 'Sending ' + kind + ' request…';
    req.timer = setTimeout(function () {
      req.timedOut = true;
      req.ctl.abort();
    }, DEADLINE_MS);
    run(req);
  }

  checkButton.addEventListener('click', function () { start('check'); });
  startButton.addEventListener('click', function () { start('launch'); });
  stopButton.addEventListener('click', function () { start('stop'); });
  var inputs = [rootInput, userInput, conversationInput];
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('input', changed);
    inputs[i].addEventListener('change', changed);
  }
  window.addEventListener('pagehide', function () {
    if (abortCurrent('page hidden')) render();
  });
  sync();
})();
</script>`;
}
