/** Frozen panel bounds shared by the markup, the script and the tests. */
export const ATTEMPT_PROGRESS_UI_LIMITS = {
  maxTextChars: 400,
  maxItems: 20,
  maxEvidence: 8,
  maxReasons: 32,
  deadlineMs: 10_000,
  maxResponseBytes: 1024 * 1024,
  maxWatchCycles: 6,
  maxWatchMs: 60_000,
  watchPauseMs: 5_000
} as const;

/**
 * Operator-only, read-only view of one displayed plan task's selected attempt. Nothing is
 * requested at load, on reload or on a scope change; every read is a button click, and the
 * finite watch runs only after an explicit click. Every server field is untrusted and is
 * rendered as text.
 */
export function attemptProgressHtml(): string {
  return `<details id="attemptProgress">
        <summary>Attempt progress (operator, read-only)</summary>
        <p>Reads one task shown in the plan status above, using the attempt the server selects for it. Nothing runs automatically; each read re-reads the recorded trace from its start and is not incremental. Worker statements are unverified claims, separate from verification and from the recorded review decision.</p>
        <label for="progressTask">Task (from the plan status shown above)</label>
        <select id="progressTask"><option value="">Select a task…</option></select>
        <button type="button" id="progressRead">Read attempt progress</button>
        <button type="button" id="progressWatch">Watch briefly</button>
        <button type="button" id="progressStop">Stop watching</button>
        <p id="progressNote" role="status"></p>
        <div id="progressStale" role="alert" hidden style="border:2px solid #b45309;padding:6px;font-weight:bold"></div>
        <div id="progressView"></div>
      </details>`;
}

export function attemptProgressScript(): string {
  return `<script>
(function () {
  var MAX_TEXT = ${ATTEMPT_PROGRESS_UI_LIMITS.maxTextChars};
  var MAX_ITEMS = ${ATTEMPT_PROGRESS_UI_LIMITS.maxItems};
  var MAX_EVIDENCE = ${ATTEMPT_PROGRESS_UI_LIMITS.maxEvidence};
  var MAX_REASONS = ${ATTEMPT_PROGRESS_UI_LIMITS.maxReasons};
  var DEADLINE_MS = ${ATTEMPT_PROGRESS_UI_LIMITS.deadlineMs};
  var MAX_BYTES = ${ATTEMPT_PROGRESS_UI_LIMITS.maxResponseBytes};
  var MAX_CYCLES = ${ATTEMPT_PROGRESS_UI_LIMITS.maxWatchCycles};
  var MAX_WATCH_MS = ${ATTEMPT_PROGRESS_UI_LIMITS.maxWatchMs};
  var PAUSE_MS = ${ATTEMPT_PROGRESS_UI_LIMITS.watchPauseMs};
  var GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var REASONS = ['INVALID_URL', 'INVALID_ROOT', 'INVALID_NODE', 'INVALID_RESPONSE', 'INVALID_NUMBER', 'DUPLICATE_KEY', 'UNSAFE_KEY', 'UNSUPPORTED_CONTRACT', 'ROOT_MISMATCH', 'RESPONSE_TOO_LARGE', 'TIMEOUT', 'UNAVAILABLE', 'HTTP_ERROR', 'INVALID_OPTIONS', 'BUSY', 'INVALID_ATTEMPT', 'IDENTITY_MISMATCH', 'CURSOR_STALLED', 'INVALID_SEQUENCE', 'PAGE_LIMIT', 'INVALID_OBSERVATION', 'TOO_LARGE'];
  var rootInput = document.getElementById('planRoot');
  var userInput = document.getElementById('userId');
  var conversationInput = document.getElementById('conversationId');
  var select = document.getElementById('progressTask');
  var readButton = document.getElementById('progressRead');
  var watchButton = document.getElementById('progressWatch');
  var stopButton = document.getElementById('progressStop');
  var note = document.getElementById('progressNote');
  var staleBox = document.getElementById('progressStale');
  var view = document.getElementById('progressView');
  var current = null;
  var watch = null;
  var last = null;
  var optionKey = '';
  var pinned = null;

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function clip(value, max) {
    var s = String(value);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  function text(value) {
    if (typeof value === 'string') return clip(value, MAX_TEXT);
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return null;
  }
  function add(parent, tag, content) {
    var node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    parent.append(node);
    return node;
  }
  function line(parent, label, value) {
    var p = add(parent, 'p');
    var shown = typeof value === 'boolean' ? String(value) : text(value);
    if (shown === null) {
      add(p, 'span', label + ': none');
      return;
    }
    add(p, 'span', label + ': ');
    add(p, 'code', shown);
  }
  function scopeNow() {
    return JSON.stringify([String(userInput.value || '').trim(), String(conversationInput.value || '').trim(), String(rootInput.value || '').trim(), String(select.value || '')]);
  }

  // The plan status panel is the only source of task identities: its rendered articles.
  function displayed() {
    var panel = document.getElementById('planStatusView');
    var stale = document.getElementById('planStatusStale');
    if (!panel || (stale && stale.hidden === false)) return null;
    var root = String(rootInput.value || '').trim();
    if (!GUID.test(root) || String(panel.textContent || '').indexOf('Plan root: ' + root) !== 0) return null;
    var articles = panel.querySelectorAll('article');
    var tasks = [];
    for (var i = 0; i < articles.length && tasks.length < 200; i++) {
      var id = null;
      var title = null;
      var attempt = '';
      var epoch = '';
      var kids = articles[i].children;
      for (var k = 0; k < kids.length && k < 64; k++) {
        var t = String(kids[k].textContent || '');
        if (t.indexOf('Task: ') === 0) id = t.slice(6).trim();
        else if (t.indexOf('Attempt epoch: ') === 0) epoch = clip(t.slice(15).trim(), 40);
        else if (t.indexOf('Attempt: ') === 0) attempt = clip(t.slice(9).trim(), 200);
        else if (title === null && String(kids[k].tagName).toLowerCase() === 'strong') title = clip(t, 80);
      }
      if (id !== null && GUID.test(id)) tasks.push({ id: id, title: title, bind: attempt + '#' + epoch });
    }
    return { root: root, tasks: tasks };
  }
  // The displayed attempt and epoch of one task, or null when it is not shown.
  function bindingFor(shown, node) {
    if (!shown) return null;
    for (var i = 0; i < shown.tasks.length; i++) {
      if (shown.tasks[i].id === node) return shown.root + '|' + node + '|' + shown.tasks[i].bind;
    }
    return null;
  }
  function pinSelection() {
    pinned = bindingFor(displayed(), String(select.value || ''));
  }

  function clearView() {
    last = null;
    view.replaceChildren();
    staleBox.hidden = true;
    staleBox.textContent = '';
    view.removeAttribute('data-stale');
  }
  function setButtons() {
    readButton.disabled = current !== null || watch !== null;
    watchButton.disabled = current !== null || watch !== null;
    stopButton.disabled = watch === null;
  }
  function abortCurrent() {
    if (!current) return;
    clearTimeout(current.timer);
    current.ctl.abort();
    current = null;
  }
  function stopWatch(message) {
    if (watch) {
      clearTimeout(watch.timer);
      clearTimeout(watch.hard);
      watch = null;
    }
    if (message) note.textContent = message;
    setButtons();
  }
  // Scope, selection or status changes drop everything that belongs to the old selection.
  function invalidate(message) {
    stopWatch(null);
    abortCurrent();
    clearView();
    note.textContent = message || '';
    setButtons();
  }

  function syncTasks() {
    var shown = displayed();
    var tasks = shown ? shown.tasks : [];
    var key = (shown ? shown.root : '') + '|' + tasks.map(function (t) { return t.id + '@' + t.bind; }).join(',');
    var selected = String(select.value || '');
    if (key !== optionKey) {
      optionKey = key;
      select.replaceChildren();
      add(select, 'option', 'Select a task…').value = '';
      for (var i = 0; i < tasks.length; i++) {
        var option = add(select, 'option', tasks[i].id + (tasks[i].title ? ' — ' + tasks[i].title : ''));
        option.value = tasks[i].id;
      }
      var kept = tasks.some(function (t) { return t.id === selected; });
      select.value = kept ? selected : '';
      if (selected && !kept) invalidate('The selected task is no longer shown in the plan status; selection cleared.');
    }
    return shown;
  }

  function stampNow() {
    return new Date().toISOString();
  }
  function fail(req, message) {
    note.textContent = message;
    if (last && last.root === req.root && last.node === req.node) {
      staleBox.textContent = 'Last successful read at ' + last.at + ' (browser clock); observation time ' + last.observedAt + '. The refresh failed, so the view below is historical, not current state.';
      staleBox.hidden = false;
      view.setAttribute('data-stale', 'true');
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
    if (status === 401) return 'Pairing is required to read attempt progress.';
    if (status === 403) return 'Operator access required to read attempt progress.';
    if (status === 404) return 'Attempt progress is not available (not configured, or the task was not found).';
    if (status === 400) return 'Invalid plan root or task.';
    return 'Attempt progress request failed (HTTP ' + (status | 0) + ').';
  }
  function unavailable(raw) {
    var reason = 'unrecognized';
    try {
      var parsed = JSON.parse(raw);
      if (isObject(parsed) && typeof parsed.reason === 'string' && REASONS.indexOf(parsed.reason) >= 0) reason = parsed.reason;
    } catch (e) {}
    return 'Attempt progress unavailable (reason: ' + reason + '). Nothing was restarted.';
  }

  function parseProgress(raw, req) {
    var d;
    try { d = JSON.parse(raw); } catch (e) { return null; }
    if (!isObject(d) || d.schema !== 'attempt-progress/v1') return null;
    if (d.rootId !== req.root || d.nodeId !== req.node) return null;
    if (!isObject(d.task) || typeof d.observedAt !== 'string') return null;
    if (['current', 'stale', 'partial'].indexOf(d.consistency) < 0) return null;
    if (!isObject(d.assessment)) return null;
    if (d.selectedAttempt !== null && !isObject(d.selectedAttempt)) return null;
    if (d.trace !== null && !isObject(d.trace)) return null;
    if (d.activity !== null && !(isObject(d.activity) && Array.isArray(d.activity.items))) return null;
    if (!isObject(d.acceptance) || !Array.isArray(d.evidence) || !Array.isArray(d.reasons)) return null;
    return d;
  }

  function refLine(parent, label, ref) {
    if (!isObject(ref) || ref.state === 'none') return line(parent, label, null);
    if (ref.state === 'shown') return line(parent, label, ref.ref);
    add(parent, 'p', label + ': present but withheld (not a plain reference)');
  }
  function itemKey(item) {
    return String(item.traceSeq) + ':' + String(item.index);
  }

  function render(d, previousKeys) {
    var box = document.createElement('div');
    var task = d.task;
    var sel = d.selectedAttempt;
    add(box, 'strong', 'Observed at ' + (text(d.observedAt) || 'unknown') + ' (ChatAgent server clock)');
    line(box, 'Snapshot consistency', d.consistency);
    if (d.consistency !== 'current') add(box, 'p', 'This snapshot is ' + d.consistency + ': fields may have changed between its reads.');
    var reasons = d.reasons.slice(0, MAX_REASONS).map(text).filter(function (r) { return r !== null; });
    if (reasons.length > 0) line(box, 'Reasons', reasons.join(', '));

    add(box, 'h4', 'Task (recorded plan state)');
    line(box, 'Plan root', d.rootId);
    line(box, 'Project', d.projectId);
    line(box, 'Task', d.nodeId);
    line(box, 'Work state', task.work);
    line(box, 'State revision', task.stateRevision);
    line(box, 'Content revision', task.contentRevision);
    line(box, 'Recorded acceptance', task.effectiveAcceptance);
    line(box, 'Task attempt', task.attemptId);
    line(box, 'Task attempt epoch', task.attemptEpoch);

    add(box, 'h4', 'Selected attempt');
    if (!sel) {
      add(box, 'p', 'No attempt is recorded for this task, so there is no trace to read.');
    } else {
      add(box, 'p', sel.scope === 'current' ? 'This is the task\\'s current attempt.' : 'Historical attempt: the task has no current attempt; this is the latest recorded one.');
      line(box, 'Attempt', sel.attemptId);
      line(box, 'Attempt epoch', sel.attemptEpoch);
      line(box, 'Attempt content revision', sel.attemptContentRevision);
      line(box, 'Content pins', sel.contentPins);
      if (sel.sourceEventSeq !== null) line(box, 'Named by event', sel.sourceEventSeq);
    }

    add(box, 'h4', 'Trace (observed activity only)');
    var tr = d.trace;
    if (!tr) {
      add(box, 'p', 'No trace was read.');
    } else {
      line(box, 'Trace status', tr.status);
      line(box, 'Trace integrity (as reported by the plan API)', tr.integrity);
      line(box, 'Claim linkage (cross-source correlation, not authentication)', tr.claimLinkage);
      line(box, 'Records read', tr.recordCount);
      line(box, 'First record', tr.firstSeq);
      line(box, 'Last record', tr.lastSeq);
      line(box, 'Pages', tr.pages);
      line(box, 'Capped', tr.capped);
      line(box, 'Truncated', tr.truncated);
      line(box, 'Stable metadata', tr.metadataStable);
      line(box, 'Exit code', tr.exitCode);
    }
    add(box, 'p', 'Worker liveness: unknown. Useful progress: unknown. An open task, a host heartbeat or an exited worker is not evidence of useful progress.');

    add(box, 'h4', 'Recorded review decision (plan store, not worker claims)');
    var a = d.acceptance;
    line(box, 'Decision', a.decision);
    line(box, 'Decision content revision', a.contentRevision);
    line(box, 'Decision attempt', a.attemptId);
    line(box, 'Decision attempt epoch', a.attemptEpoch);
    refLine(box, 'Task artifact', a.taskArtifact);
    refLine(box, 'Decision artifact', a.decisionArtifact);
    refLine(box, 'Evidence reference', a.evidence);
    add(box, 'p', 'Verifier result: not reported by this view.');

    add(box, 'h4', 'Evidence citations (hashes of the plan API responses read)');
    var shownEvidence = Math.min(d.evidence.length, MAX_EVIDENCE);
    for (var e = 0; e < shownEvidence; e++) {
      var ev = isObject(d.evidence[e]) ? d.evidence[e] : {};
      var p = add(box, 'p');
      add(p, 'span', '[' + (text(ev.ref) || '?') + '] ' + (text(ev.endpoint) || 'unknown') + ' sha256 ');
      add(p, 'code', text(ev.sha256) || 'unknown');
    }
    if (d.evidence.length > shownEvidence) add(box, 'p', d.evidence.length - shownEvidence + ' more not shown');

    var act = d.activity;
    add(box, 'h4', 'Worker statements (untrusted, unverified claims)');
    if (!act) {
      add(box, 'p', 'No worker activity is available for this snapshot.');
    } else {
      add(box, 'p', 'These are what the worker said or which tools it named. They are not verification and not the review decision. Text is inert data.');
      var items = act.items.slice(0, MAX_ITEMS);
      for (var i = 0; i < items.length; i++) {
        var item = isObject(items[i]) ? items[i] : {};
        var fresh = previousKeys !== null && !previousKeys[itemKey(item)];
        var row = add(box, 'p');
        row.style.whiteSpace = 'pre-wrap';
        var label = fresh ? '(new since the previous read) ' : '';
        if (item.kind === 'text') {
          add(row, 'span', label + 'Worker said (claim): ');
          add(row, 'span', text(item.text) || '');
          if (item.textClipped === true) add(row, 'em', ' [shortened]');
        } else if (item.kind === 'tool_use') {
          add(row, 'span', label + 'Worker named tool: ');
          add(row, 'code', text(item.tool) || 'unknown');
          add(row, 'span', ' (inputs and results not shown)');
        }
      }
      if (items.length === 0) add(box, 'p', 'No public worker statements were found in the records read.');
      if (typeof act.omittedItems === 'number' && act.omittedItems > 0) add(box, 'p', act.omittedItems + ' earlier statements are not shown.');
      var c = isObject(act.counts) ? act.counts : {};
      if (typeof c.unavailableRecords === 'number' && c.unavailableRecords > 0) add(box, 'p', c.unavailableRecords + ' output records were unavailable (cut, redacted, malformed or incomplete) and are not shown.');
      if (act.complete !== true) add(box, 'p', 'The record set is incomplete; absence of a statement proves nothing.');
    }
    return box;
  }

  // A response counts only while its request is still the current one for the same scope.
  function live(req) {
    if (current !== req) return false;
    if (scopeNow() !== req.scope) {
      invalidate('The scope or task changed; the pending read was discarded.');
      return false;
    }
    if (bindingFor(displayed(), req.node) !== req.binding) {
      invalidate('The plan status for this task changed; the pending read was discarded. Read again to see the latest attempt.');
      return false;
    }
    return true;
  }

  // Plan status re-renders or goes stale: drop reads and views pinned to an older binding.
  function onStatusChange() {
    var shown = syncTasks();
    if (pinned === null) return;
    var node = String(select.value || '');
    if (!GUID.test(node) || bindingFor(shown, node) !== pinned) {
      pinned = null;
      invalidate('The plan status for the selected task changed; the earlier read was discarded. Select and read again.');
    }
  }

  async function run(req) {
    var url = '/development/plans/' + req.root + '/nodes/' + req.node + '/progress';
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
        if (!live(req)) return 'orphan';
        fail(req, unavailable(raw503));
        return 'fail';
      }
      if (res.status !== 200) {
        req.ctl.abort();
        if (!live(req)) return 'orphan';
        fail(req, refusal(res.status));
        return 'fail';
      }
      var raw = await readBounded(res, req);
      if (!live(req)) return 'orphan';
      var d = parseProgress(raw, req);
      if (d === null) {
        fail(req, 'Attempt progress response was not recognized.');
        return 'fail';
      }
      var previous = null;
      if (last && last.root === req.root && last.node === req.node && last.attempt === (d.selectedAttempt ? d.selectedAttempt.attemptId + '#' + d.selectedAttempt.attemptEpoch : '')) previous = last.keys;
      var keys = {};
      if (d.activity) {
        var items = d.activity.items.slice(0, MAX_ITEMS);
        for (var i = 0; i < items.length; i++) if (isObject(items[i])) keys[itemKey(items[i])] = true;
      }
      view.replaceChildren(render(d, previous));
      last = { root: req.root, node: req.node, at: stampNow(), observedAt: text(d.observedAt) || 'unknown', keys: keys, attempt: d.selectedAttempt ? d.selectedAttempt.attemptId + '#' + d.selectedAttempt.attemptEpoch : '' };
      staleBox.hidden = true;
      staleBox.textContent = '';
      view.removeAttribute('data-stale');
      note.textContent = 'Attempt progress read (read-only).';
      return 'ok';
    } catch (error) {
      if (!live(req)) return 'orphan';
      if (error && error.tooLarge) fail(req, 'Attempt progress response is too large to display.');
      else if (req.timedOut) fail(req, 'Attempt progress request timed out.');
      else fail(req, 'Attempt progress request failed.');
      return 'fail';
    } finally {
      clearTimeout(req.timer);
    }
  }

  // Starts at most one request. Returns false (with a note) when nothing was started.
  function readOnce(done) {
    if (current) return false;
    var shown = syncTasks();
    if (!shown) {
      invalidate('Load the plan status for this root first; no task is displayed.');
      return false;
    }
    var node = String(select.value || '');
    if (!GUID.test(node)) {
      note.textContent = 'Select a task shown in the plan status.';
      return false;
    }
    var binding = bindingFor(shown, node);
    if (binding === null) {
      note.textContent = 'Select a task shown in the plan status.';
      return false;
    }
    pinned = binding;
    var req = { ctl: new AbortController(), scope: scopeNow(), root: shown.root, node: node, binding: binding, timer: null, timedOut: false };
    current = req;
    setButtons();
    note.textContent = 'Reading attempt progress…';
    req.timer = setTimeout(function () {
      req.timedOut = true;
      req.ctl.abort();
    }, DEADLINE_MS);
    run(req).then(function (outcome) {
      if (outcome === 'orphan' || current !== req) return;
      current = null;
      setButtons();
      if (done) done(outcome === 'ok');
    });
    return true;
  }

  function cycle() {
    var w = watch;
    if (!w) return;
    w.cycles++;
    var started = readOnce(function (ok) {
      if (watch !== w) return;
      if (!ok) return stopWatch(note.textContent + ' Watching stopped; nothing is retried.');
      if (w.cycles >= MAX_CYCLES) return stopWatch('Watching finished after ' + MAX_CYCLES + ' reads.');
      if (Date.now() - w.startedAt + PAUSE_MS >= MAX_WATCH_MS) return stopWatch('Watching finished after the 60 second limit.');
      w.timer = setTimeout(cycle, PAUSE_MS);
    });
    if (!started) stopWatch(null);
  }
  function startWatch() {
    if (current || watch) return;
    var w = { cycles: 0, startedAt: Date.now(), timer: null, hard: null };
    watch = w;
    setButtons();
    w.hard = setTimeout(function () {
      if (watch !== w) return;
      abortCurrent();
      stopWatch('Watching finished after the 60 second limit.');
    }, MAX_WATCH_MS);
    cycle();
  }

  readButton.addEventListener('click', function () { readOnce(null); });
  watchButton.addEventListener('click', startWatch);
  stopButton.addEventListener('click', function () {
    abortCurrent();
    stopWatch('Watching stopped.');
  });
  select.addEventListener('focus', syncTasks);
  select.addEventListener('mousedown', syncTasks);
  select.addEventListener('change', function () { invalidate(''); pinSelection(); });
  rootInput.addEventListener('input', function () { invalidate(''); syncTasks(); });
  rootInput.addEventListener('change', function () { invalidate(''); syncTasks(); });
  userInput.addEventListener('input', function () { invalidate(''); });
  userInput.addEventListener('change', function () { invalidate(''); });
  conversationInput.addEventListener('input', function () { invalidate(''); });
  conversationInput.addEventListener('change', function () { invalidate(''); });
  var observed = [document.getElementById('planStatusView'), document.getElementById('planStatusStale')];
  if (typeof MutationObserver === 'function') {
    var observer = new MutationObserver(onStatusChange);
    for (var o = 0; o < observed.length; o++) {
      if (observed[o]) observer.observe(observed[o], { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    }
  }
  window.addEventListener('pagehide', function () {
    abortCurrent();
    stopWatch(null);
  });
  setButtons();
})();
</script>`;
}
