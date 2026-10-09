/** Frozen bounds shared by the markup, the script and the tests. */
export const EXECUTIVE_UI_LIMITS = {
  maxRoots: 8,
  maxTasks: 100,
  maxBlockers: 10,
  maxInvalidCodes: 20,
  maxTextChars: 200,
  maxStatementChars: 400,
  maxEvidence: 8,
  maxStatements: 5,
  maxItems: 50,
  maxConcurrentDrills: 3,
  overviewDeadlineMs: 12_000,
  drillDeadlineMs: 10_000,
  maxResponseBytes: 1024 * 1024
} as const;

/**
 * Operator-only, read-only executive overview. It issues nothing at load or reload: the only
 * requests are the Refresh button's GET of the fixed overview and one GET of the existing
 * progress route when a task is expanded. There is no POST, no polling and no navigation.
 * Every server field is untrusted data, validated against its schema and written with
 * textContent; progress URLs are built only from validated GUIDs taken from the last overview.
 */
export function executiveOverviewHtml(): string {
  return `<details id="executiveOverview" open>
        <summary>Executive overview (operator, read-only)</summary>
        <p>Recorded PlanStore state only. Accepted means accepted in PlanStore; source integration and deployment are not proven by this view. Goals are operator-configured text, not verified results. Budget evidence is not reported unless an operator registered a runner record for the task; such a record is supplied and unauthenticated.</p>
        <button type="button" id="execRefresh">Refresh</button>
        <p id="execNote" role="status">Press Refresh to read the configured plans. Nothing is requested until then.</p>
        <div id="execStale" role="alert" hidden style="border:2px solid #b45309;padding:6px;font-weight:bold"></div>
        <div id="execView"></div>
      </details>`;
}

export function executiveOverviewScript(): string {
  const L = EXECUTIVE_UI_LIMITS;
  return `<script>
(function () {
  var MAX_ROOTS = ${L.maxRoots};
  var MAX_TASKS = ${L.maxTasks};
  var MAX_BLOCKERS = ${L.maxBlockers};
  var MAX_CODES = ${L.maxInvalidCodes};
  var MAX_TEXT = ${L.maxTextChars};
  var MAX_STATEMENT = ${L.maxStatementChars};
  var MAX_EVIDENCE = ${L.maxEvidence};
  var MAX_STATEMENTS = ${L.maxStatements};
  var MAX_ITEMS = ${L.maxItems};
  var MAX_DRILLS = ${L.maxConcurrentDrills};
  var OVERVIEW_DEADLINE_MS = ${L.overviewDeadlineMs};
  var DRILL_DEADLINE_MS = ${L.drillDeadlineMs};
  var MAX_BYTES = ${L.maxResponseBytes};
  var GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var SHA = /^[0-9a-f]{64}$/;
  var DIGEST_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|git:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
  var ENDPOINT = /^[/]api[/]plan-contract[/]v1[/][A-Za-z0-9/_%.?=-]{1,400}$/;
  var REASON = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  var UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');
  var ERROR_CODES = ['INVALID_URL', 'INVALID_ROOT', 'INVALID_RESPONSE', 'INVALID_NUMBER', 'DUPLICATE_KEY', 'UNSAFE_KEY', 'UNSUPPORTED_CONTRACT', 'ROOT_MISMATCH', 'RESPONSE_TOO_LARGE', 'TIMEOUT', 'UNAVAILABLE', 'HTTP_ERROR', 'INVALID_OPTIONS'];
  var STATES = ['ready', 'blocked', 'in_progress', 'review_pending', 'accepted', 'rejected', 'stale', 'cancelled'];
  var PLAN_STATES = ['complete', 'inconsistent', 'active', 'awaiting_review', 'ready', 'stuck'];
  var PRODS = ['review_needed', 'decide_rework', 'refresh_inputs', 'resolve_dependency', 'claim_available', 'confirm_worker_liveness', 'investigate_plan_state'];
  var PIN_VALUES = ['current', 'stale', 'unknown', 'none'];
  var GATES = ['accepted', 'rejected', 'awaiting_review', 'not_verified'];
  var WORK = ['todo', 'in_progress', 'done', 'cancelled'];
  var EFFECTIVE = ['none', 'accepted', 'rejected', 'stale'];
  var CONSISTENCY = ['current', 'stale', 'partial'];
  var TRACE_STATUS = ['running', 'exited', 'unfinished', 'not_captured'];
  var INTEGRITY = ['verified', 'unverified', 'none'];
  var TOKEN = /^[!-~]{1,200}$/;
  var GIT_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  var STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/;
  var SIGNAL = /^SIG[A-Z0-9]{1,12}$/;
  var BUDGET_EVIDENCE = ['not_reported', 'reported', 'unavailable'];
  var BUDGET_REASONS = ['missing', 'unreadable', 'too_large', 'invalid', 'unsupported_schema', 'stale_identity', 'timeout'];
  var STOP_CODES = {
    none: ['none'],
    refused: ['profile_unsupported', 'pin_mismatch', 'worktree_invalid', 'authority_mismatch', 'authority_unavailable', 'claim_already_owned'],
    tripwire: ['hard_units', 'hard_wall', 'hard_output', 'counter_uncertain', 'authority_changed'],
    cancelled: ['cancelled'],
    exited: ['exited'],
    failed: ['exited_nonzero', 'spawn_failed', 'cleanup_failed', 'record_write_failed']
  };
  var GATE_OUTCOMES = ['checks_passed', 'source_failed', 'partial', 'verifier_unavailable'];
  var CHECK_RESULTS = ['pass', 'fail', 'unavailable'];
  var allowBudget = false;
  var STATE_LABELS = {
    review_pending: 'Awaiting review',
    rejected: 'Rejected (rework decision needed)',
    stale: 'Stale inputs',
    blocked: 'Blocked by dependency',
    ready: 'Ready to claim; execution preparation unverified',
    in_progress: 'In progress; worker liveness unknown',
    accepted: 'Accepted in PlanStore; source integration not proven',
    cancelled: 'Cancelled'
  };
  var PROD_LABELS = {
    review_needed: 'review needed',
    decide_rework: 'rework decision needed',
    refresh_inputs: 'inputs stale; refresh needed',
    resolve_dependency: 'blocked by dependency',
    claim_available: 'ready to claim; execution preparation unverified',
    confirm_worker_liveness: 'worker liveness unknown; confirm',
    investigate_plan_state: 'plan state needs investigation',
    none: 'no action indicated'
  };
  var userInput = document.getElementById('userId');
  var conversationInput = document.getElementById('conversationId');
  var button = document.getElementById('execRefresh');
  var note = document.getElementById('execNote');
  var staleBox = document.getElementById('execStale');
  var view = document.getElementById('execView');
  var current = null;
  var last = null;
  var drills = {};
  var openRoots = {};

  function scopeNow() {
    return JSON.stringify([String(userInput.value || '').trim(), String(conversationInput.value || '').trim()]);
  }
  var scope = scopeNow();

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 9007199254740991; }
  function isStr(v, max) { return typeof v === 'string' && v.length <= max; }
  function isNullStr(v, max) { return v === null || isStr(v, max); }
  function oneOf(v, list) { return typeof v === 'string' && list.indexOf(v) >= 0; }
  function clip(value, max) {
    var s = String(value).replace(UNSAFE, ' ');
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  function text(value) { return clip(value, MAX_TEXT); }
  function add(parent, tag, content) {
    var node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    parent.append(node);
    return node;
  }
  function line(parent, label, value) {
    var p = add(parent, 'p');
    if (value === null || value === undefined) { p.textContent = label + ': none'; return p; }
    add(p, 'span', label + ': ');
    add(p, 'code', typeof value === 'string' ? text(value) : String(value));
    return p;
  }
  function refText(value) {
    if (value === null) return 'none';
    return DIGEST_REF.test(value) ? value : 'present but withheld (not a plain digest reference)';
  }

  // ----- overview schema -----
  function validBlocker(b) {
    return isObject(b) && isStr(b.id, 200) && isNullStr(b.name, 400) && isStr(b.gate, 40) && isStr(b.reason, 400);
  }
  function validAcceptance(a) {
    return a === null || (isObject(a) && oneOf(a.decision, ['accepted', 'rejected']) && isInt(a.contentRevision) && isNullStr(a.artifactRef, 400) && isNullStr(a.attemptId, 400) && isInt(a.attemptEpoch) && isStr(a.decidedBy, 400) && isNullStr(a.evidenceRef, 400));
  }
  function keysAre(o, list) {
    var keys = Object.keys(o);
    return keys.length === list.length && list.every(function (k) { return keys.indexOf(k) >= 0; });
  }
  function validFence(f) {
    return GUID.test(f.rootId) && GUID.test(f.nodeId) && typeof f.attemptId === 'string' && TOKEN.test(f.attemptId) && isInt(f.attemptEpoch) && isInt(f.contentRevision);
  }
  function validRecord(r) {
    if (!isObject(r) || !keysAre(r, ['schema', 'runId', 'identity', 'baseRef', 'profile', 'state', 'unit', 'expected', 'hard', 'consumed', 'expectedExceeded', 'providerReported', 'cost', 'stop', 'exit', 'rootPid', 'startedAt', 'updatedAt', 'endedAt', 'writer', 'recordTrust', 'writerLiveness', 'artifactRef'])) return false;
    var i = r.identity, e = r.expected, h = r.hard, c = r.consumed, p = r.providerReported, s = r.stop;
    if (r.schema !== 'checkpoint-budget/v1' || !GUID.test(r.runId) || !GIT_REF.test(r.baseRef) || !oneOf(r.profile, ['readonly_smoke', 'coding']) || !oneOf(r.state, ['running', 'ended']) || r.unit !== 'assistant_message_ids_distinct/v1') return false;
    if (!isObject(i) || !keysAre(i, ['rootId', 'nodeId', 'attemptId', 'attemptEpoch', 'contentRevision', 'observedStateRevision', 'executorRef']) || !validFence(i) || !isInt(i.observedStateRevision) || typeof i.executorRef !== 'string' || !TOKEN.test(i.executorRef)) return false;
    if (!isObject(e) || !keysAre(e, ['units', 'basis']) || !isInt(e.units) || e.basis !== 'provisional_heuristic') return false;
    if (!isObject(h) || !keysAre(h, ['units', 'wallMs', 'outputBytes']) || !isInt(h.units) || !isInt(h.wallMs) || !isInt(h.outputBytes)) return false;
    if (!isObject(c) || !keysAre(c, ['units', 'wallMs', 'outputBytes', 'counterState']) || !isInt(c.units) || !isInt(c.wallMs) || !isInt(c.outputBytes) || !oneOf(c.counterState, ['exact_observed', 'lower_bound'])) return false;
    if (typeof r.expectedExceeded !== 'boolean') return false;
    if (!isObject(p) || !keysAre(p, ['numTurns', 'costUsd', 'status']) || !(p.numTurns === null || isInt(p.numTurns)) || !(p.costUsd === null || (typeof p.costUsd === 'number' && isFinite(p.costUsd) && p.costUsd >= 0)) || p.status !== 'unverified') return false;
    if (!isObject(r.cost) || !keysAre(r.cost, ['enforcement']) || !oneOf(r.cost.enforcement, ['none', 'provider_cap_configured_unverified'])) return false;
    if (!isObject(s) || !keysAre(s, ['kind', 'code']) || !STOP_CODES.hasOwnProperty(s.kind) || !oneOf(s.code, STOP_CODES[s.kind])) return false;
    if (!(r.exit === null || (isObject(r.exit) && keysAre(r.exit, ['code', 'signal']) && (r.exit.code === null || (typeof r.exit.code === 'number' && Math.floor(r.exit.code) === r.exit.code)) && (r.exit.signal === null || (typeof r.exit.signal === 'string' && SIGNAL.test(r.exit.signal)))))) return false;
    if (!(r.rootPid === null || isInt(r.rootPid))) return false;
    if (typeof r.startedAt !== 'string' || !STAMP.test(r.startedAt) || typeof r.updatedAt !== 'string' || !STAMP.test(r.updatedAt) || !(r.endedAt === null || (typeof r.endedAt === 'string' && STAMP.test(r.endedAt)))) return false;
    if (r.writer !== 'runner_record' || r.recordTrust !== 'supplied_not_authenticated' || r.writerLiveness !== 'unknown' || !(r.artifactRef === null || (typeof r.artifactRef === 'string' && GIT_REF.test(r.artifactRef)))) return false;
    return (r.state === 'running') === (s.kind === 'none') && (r.state === 'running') === (r.endedAt === null);
  }
  function validGate(g) {
    if (!isObject(g) || !keysAre(g, ['schema', 'runId', 'identity', 'sourceRef', 'suppliedBy', 'recordedAt', 'evidenceRefs', 'checks', 'failureAttribution', 'outcome'])) return false;
    if (g.schema !== 'checkpoint-gate/v1' || !GUID.test(g.runId) || !isObject(g.identity) || !keysAre(g.identity, ['rootId', 'nodeId', 'attemptId', 'attemptEpoch', 'contentRevision']) || !validFence(g.identity)) return false;
    if (typeof g.sourceRef !== 'string' || !GIT_REF.test(g.sourceRef) || g.suppliedBy !== 'lead' || typeof g.recordedAt !== 'string' || !STAMP.test(g.recordedAt) || !oneOf(g.outcome, GATE_OUTCOMES)) return false;
    if (!Array.isArray(g.evidenceRefs) || g.evidenceRefs.length > 8 || !g.evidenceRefs.every(function (x) { return isStr(x, 128); })) return false;
    if (!oneOf(g.failureAttribution, ['source', 'unattributed']) || !Array.isArray(g.checks) || g.checks.length > 16 || !g.checks.every(function (x) { return isObject(x) && keysAre(x, ['name', 'result']) && isStr(x.name, 64) && oneOf(x.result, CHECK_RESULTS); })) return false;
    var inferred = 'partial';
    if (g.checks.length === 0 || g.checks.every(function (x) { return x.result === 'unavailable'; })) inferred = 'verifier_unavailable';
    else if (g.checks.every(function (x) { return x.result === 'pass'; })) inferred = 'checks_passed';
    else if (g.failureAttribution === 'source' && g.checks.some(function (x) { return x.result === 'fail'; }) && g.checks.every(function (x) { return x.result !== 'unavailable'; })) inferred = 'source_failed';
    return g.outcome === inferred && (inferred !== 'source_failed' || g.evidenceRefs.length > 0);
  }
  function validGateView(v) {
    if (!isObject(v)) return false;
    if (v.state === 'unavailable') return keysAre(v, ['state', 'reason']) && oneOf(v.reason, BUDGET_REASONS);
    return (v.state === 'current' || v.state === 'history') && keysAre(v, ['state', 'gate']) && validGate(v.gate);
  }
  function validBudget(b) {
    if (!isObject(b)) return false;
    if (b.state === 'unavailable') return keysAre(b, ['state', 'reason']) && oneOf(b.reason, BUDGET_REASONS);
    return b.state === 'reported' && keysAre(b, ['state', 'record', 'gate', 'overdueUnreported']) && typeof b.overdueUnreported === 'boolean' && validRecord(b.record) && validGateView(b.gate);
  }
  function validBudgetFields(t) {
    if (!allowBudget) return t.budgetEvidence === 'not_reported' && t.checkpointBudget === undefined;
    if (!oneOf(t.budgetEvidence, BUDGET_EVIDENCE)) return false;
    if (t.budgetEvidence === 'not_reported') return t.checkpointBudget === undefined;
    return validBudget(t.checkpointBudget) && (t.budgetEvidence === 'reported') === (t.checkpointBudget.state === 'reported');
  }
  function validTask(t) {
    return isObject(t) && GUID.test(t.nodeId) && isNullStr(t.name, 400) && oneOf(t.state, STATES) && t.executionAcknowledged === 'unknown' && typeof t.gatesHold === 'boolean' && typeof t.upstreamChanged === 'boolean' && oneOf(t.attemptPins, PIN_VALUES) && isNullStr(t.scope, 400) && isInt(t.contentRevision) && isInt(t.stateRevision) && isNullStr(t.attemptId, 400) && isInt(t.attemptEpoch) && isNullStr(t.executorRef, 400) && isNullStr(t.artifactRef, 400) && validAcceptance(t.acceptance) && (t.acceptanceHistorical === undefined || t.acceptanceHistorical === true) && Array.isArray(t.blockers) && t.blockers.length <= MAX_BLOCKERS && t.blockers.every(validBlocker) && isInt(t.blockersOmitted) && (t.prod === 'none' || oneOf(t.prod, PRODS)) && oneOf(t.checkpointGate, GATES) && validBudgetFields(t);
  }
  function validRoot(r) {
    if (!isObject(r) || !GUID.test(r.rootId) || !isStr(r.label, 400) || !isNullStr(r.goal, 800) || !isStr(r.observedAt, 64) || !oneOf(r.status, ['ok', 'invalid', 'unavailable'])) return false;
    if (!(r.reason === null || oneOf(r.reason, ERROR_CODES))) return false;
    if (!Array.isArray(r.invalidCodes) || r.invalidCodes.length > MAX_CODES || !r.invalidCodes.every(function (c) { return isObject(c) && isStr(c.code, 400) && (c.nodeId === null || GUID.test(c.nodeId)); })) return false;
    if (!(r.planState === null || oneOf(r.planState, PLAN_STATES))) return false;
    if (!(r.acceptedCounts === null || (isObject(r.acceptedCounts) && isInt(r.acceptedCounts.accepted) && isInt(r.acceptedCounts.total)))) return false;
    if (!isObject(r.counts) || !Object.keys(r.counts).every(function (k) { return STATES.indexOf(k) >= 0 && isInt(r.counts[k]); })) return false;
    if (!Array.isArray(r.prods) || r.prods.length > 8 || !r.prods.every(function (p) { return isObject(p) && oneOf(p.kind, PRODS) && isInt(p.count); })) return false;
    if (!Array.isArray(r.tasks) || r.tasks.length > MAX_TASKS || !r.tasks.every(validTask) || !isInt(r.tasksOmitted)) return false;
    if (r.status === 'ok' && (r.planState === null || r.acceptedCounts === null)) return false;
    if (r.status === 'unavailable' && r.reason === null) return false;
    return true;
  }
  function parseOverview(raw) {
    var d;
    try { d = JSON.parse(raw); } catch (e) { return null; }
    if (!isObject(d) || (d.schema !== 'executive-overview/v1' && d.schema !== 'executive-overview/v2') || d.atomic !== false || !isStr(d.generatedAt, 64)) return null;
    allowBudget = d.schema === 'executive-overview/v2';
    if (!Array.isArray(d.roots) || d.roots.length > MAX_ROOTS || !d.roots.every(validRoot)) return null;
    var seen = {};
    for (var i = 0; i < d.roots.length; i++) {
      if (seen[d.roots[i].rootId]) return null;
      seen[d.roots[i].rootId] = true;
      var nodes = {};
      for (var k = 0; k < d.roots[i].tasks.length; k++) {
        if (nodes[d.roots[i].tasks[k].nodeId]) return null;
        nodes[d.roots[i].tasks[k].nodeId] = true;
      }
    }
    return d;
  }

  // ----- bounded reads -----
  function tooLarge(ctl) { ctl.abort(); throw { tooLarge: true }; }
  async function readBounded(res, ctl) {
    var declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_BYTES) tooLarge(ctl);
    if (!res.body || typeof res.body.getReader !== 'function') {
      var whole = await res.text();
      if (new TextEncoder().encode(whole).length > MAX_BYTES) tooLarge(ctl);
      return whole;
    }
    var reader = res.body.getReader();
    var chunks = [];
    var total = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > MAX_BYTES) tooLarge(ctl);
      chunks.push(step.value);
    }
    var decoder = new TextDecoder();
    var out = '';
    for (var i = 0; i < chunks.length; i++) out += decoder.decode(chunks[i], { stream: true });
    return out + decoder.decode();
  }
  function refusal(status) {
    if (status === 401) return 'Pairing is required to read the overview.';
    if (status === 403) return 'Operator access required to read the overview.';
    if (status === 404) return 'The executive overview is not configured.';
    return 'The overview request failed (HTTP ' + (status | 0) + ').';
  }

  // ----- drill-down (existing progress route) -----
  function bindingOf(rootId, t) {
    return [rootId, t.nodeId, t.attemptId === null ? '' : t.attemptId, t.attemptEpoch, t.contentRevision, t.stateRevision].join('|');
  }
  function knownPair(rootId, nodeId) {
    if (!last || !GUID.test(rootId) || !GUID.test(nodeId)) return null;
    for (var i = 0; i < last.overview.roots.length; i++) {
      var r = last.overview.roots[i];
      if (r.rootId !== rootId) continue;
      for (var k = 0; k < r.tasks.length; k++) if (r.tasks[k].nodeId === nodeId) return r.tasks[k];
    }
    return null;
  }
  function validRef(r) {
    return isObject(r) && (r.state === 'none' || r.state === 'withheld' || (r.state === 'shown' && typeof r.ref === 'string' && DIGEST_REF.test(r.ref)));
  }
  // Returns a normalized subset of validated fields, or null when the schema is not met.
  function parseProgress(raw, rootId, task) {
    var d;
    try { d = JSON.parse(raw); } catch (e) { return null; }
    if (!isObject(d) || d.schema !== 'attempt-progress/v1' || d.rootId !== rootId || d.nodeId !== task.nodeId) return null;
    if (!isStr(d.observedAt, 64) || !oneOf(d.consistency, CONSISTENCY) || !Array.isArray(d.reasons) || d.reasons.length > 32) return null;
    var t = d.task;
    if (!isObject(t) || !oneOf(t.work, WORK) || !isInt(t.stateRevision) || !isInt(t.contentRevision) || !isNullStr(t.attemptId, 200) || !isInt(t.attemptEpoch) || !oneOf(t.effectiveAcceptance, EFFECTIVE)) return null;
    var sel = d.selectedAttempt;
    if (sel !== null && !(isObject(sel) && isStr(sel.attemptId, 200) && isInt(sel.attemptEpoch) && oneOf(sel.scope, ['current', 'historical']) && oneOf(sel.contentPins, ['current', 'stale', 'unknown']))) return null;
    if (sel !== null && sel.scope === 'current' && (sel.attemptId !== t.attemptId || sel.attemptEpoch !== t.attemptEpoch)) return null;
    if (sel !== null && sel.scope === 'historical' && t.attemptId !== null) return null;
    var tr = d.trace;
    if (tr !== null && !(isObject(tr) && oneOf(tr.status, TRACE_STATUS) && oneOf(tr.integrity, INTEGRITY) && isInt(tr.recordCount))) return null;
    var a = d.acceptance;
    if (!isObject(a) || a.source !== 'plan_store_recorded_decision' || !(a.contentRevision === null || isInt(a.contentRevision)) || !(a.attemptEpoch === null || isInt(a.attemptEpoch)) || !isNullStr(a.attemptId, 200) || !(a.decision === null || oneOf(a.decision, ['accepted', 'rejected'])) || !validRef(a.taskArtifact) || !validRef(a.decisionArtifact) || !validRef(a.evidence)) return null;
    if (!Array.isArray(d.evidence) || d.evidence.length > 1000) return null;
    var evidence = [];
    for (var i = 0; i < d.evidence.length && i < MAX_EVIDENCE; i++) {
      var e = d.evidence[i];
      if (!isObject(e) || !isInt(e.ref) || typeof e.endpoint !== 'string' || !(e.endpoint === 'withheld' || ENDPOINT.test(e.endpoint)) || typeof e.sha256 !== 'string' || !SHA.test(e.sha256)) return null;
      evidence.push({ ref: e.ref, endpoint: e.endpoint, sha256: e.sha256 });
    }
    if (!isObject(d.assessment) || d.assessment.workerLiveness !== 'unknown') return null;
    var statements = [];
    var tools = 0;
    if (d.activity !== null) {
      if (!isObject(d.activity) || !Array.isArray(d.activity.items) || d.activity.items.length > MAX_ITEMS) return null;
      for (var k = 0; k < d.activity.items.length; k++) {
        var it = d.activity.items[k];
        if (!isObject(it)) return null;
        if (it.kind === 'text' && typeof it.text === 'string' && it.text.length <= 4000) statements.push(it.text);
        else if (it.kind === 'tool_use' && typeof it.tool === 'string' && it.tool.length <= 64) tools++;
        else return null;
      }
    }
    // The fence: the read must describe the exact task and attempt the overview showed.
    var fenced = t.stateRevision === task.stateRevision && t.contentRevision === task.contentRevision && t.attemptEpoch === task.attemptEpoch && t.attemptId === task.attemptId;
    var artifactsMatch = (a.taskArtifact.state === 'none' && a.decisionArtifact.state === 'none') || (a.taskArtifact.state === 'shown' && a.decisionArtifact.state === 'shown' && a.taskArtifact.ref === a.decisionArtifact.ref);
    var decisionLinkage = a.decision === null ? 'none' : (sel !== null && sel.scope === 'current' && t.work === 'done' && t.effectiveAcceptance === a.decision && a.attemptId === t.attemptId && a.attemptEpoch === t.attemptEpoch && a.contentRevision === t.contentRevision && artifactsMatch ? 'current' : 'historical_or_unmatched');
    var reasons = d.reasons.filter(function (r) { return typeof r === 'string' && REASON.test(r); });
    return { fenced: fenced, observedAt: d.observedAt, consistency: d.consistency, reasons: reasons, task: t, selected: sel, trace: tr, acceptance: a, decisionLinkage: decisionLinkage, evidence: evidence, evidenceTotal: d.evidence.length, statements: statements.slice(-MAX_STATEMENTS), statementTotal: statements.length, tools: tools };
  }
  function renderEvidence(box, p) {
    box.replaceChildren();
    add(box, 'strong', 'Evidence read at ' + clip(p.observedAt, 64) + ' (server clock)');
    line(box, 'Snapshot consistency', p.consistency);
    if (p.reasons.length > 0) line(box, 'Reasons', p.reasons.slice(0, 8).join(', '));
    line(box, 'Recorded work state', p.task.work);
    line(box, 'Recorded acceptance', p.task.effectiveAcceptance);
    line(box, 'Task attempt', p.task.attemptId);
    line(box, 'Task attempt epoch', p.task.attemptEpoch);
    if (!p.selected) {
      add(box, 'p', p.task.attemptId === null ? 'No attempt is recorded for this task.' : 'Selected attempt evidence is unavailable; the recorded task claim remains shown.');
    } else {
      add(box, 'p', p.selected.scope === 'current' ? 'Selected attempt is the current attempt.' : 'Selected attempt is historical: the task has no current attempt.');
      line(box, 'Selected attempt', p.selected.attemptId);
      line(box, 'Selected attempt epoch', p.selected.attemptEpoch);
      line(box, 'Content pins', p.selected.contentPins);
    }
    if (!p.trace) {
      add(box, 'p', 'No worker trace recorded for this task (liveness unknown).');
    } else {
      line(box, 'Trace status', p.trace.status);
      line(box, 'Trace integrity (as reported by the plan API)', p.trace.integrity);
      line(box, 'Trace records read', p.trace.recordCount);
    }
    add(box, 'p', 'Worker liveness: unknown. Useful progress: unknown. An open task or a host heartbeat is not evidence of useful progress.');
    var a = p.acceptance;
    line(box, 'Recorded decision (PlanStore)', a.decision);
    line(box, 'Decision linkage', p.decisionLinkage);
    line(box, 'Decision attempt', a.attemptId);
    line(box, 'Decision attempt epoch', a.attemptEpoch);
    line(box, 'Decision content revision', a.contentRevision);
    add(box, 'p', 'Task artifact: ' + (a.taskArtifact.state === 'shown' ? a.taskArtifact.ref : a.taskArtifact.state === 'none' ? 'none' : 'present but withheld'));
    add(box, 'p', 'Decision artifact: ' + (a.decisionArtifact.state === 'shown' ? a.decisionArtifact.ref : a.decisionArtifact.state === 'none' ? 'none' : 'present but withheld'));
    add(box, 'p', 'Decision evidence: ' + (a.evidence.state === 'shown' ? a.evidence.ref : a.evidence.state === 'none' ? 'none' : 'present but withheld'));
    add(box, 'p', 'Evidence citations (hashes of plan API responses read): ' + p.evidence.length + (p.evidenceTotal > p.evidence.length ? ' of ' + p.evidenceTotal : ''));
    for (var i = 0; i < p.evidence.length; i++) {
      var para = add(box, 'p');
      add(para, 'span', '[' + p.evidence[i].ref + '] ' + p.evidence[i].endpoint + ' sha256 ');
      add(para, 'code', p.evidence[i].sha256);
    }
    add(box, 'p', 'Worker statements (unverified claims, not verification or the review decision): ' + p.statementTotal + ' found, ' + p.tools + ' tool names not shown.');
    for (var s = 0; s < p.statements.length; s++) {
      var row = add(box, 'p', 'Worker said (claim): ' + clip(p.statements[s], MAX_STATEMENT));
      row.style.whiteSpace = 'pre-wrap';
    }
  }
  function drillCount() {
    var n = 0;
    for (var key in drills) if (drills[key].status === 'loading') n++;
    return n;
  }
  function stopDrill(key) {
    var d = drills[key];
    if (!d) return;
    if (d.ctl) d.ctl.abort();
    clearTimeout(d.timer);
    delete drills[key];
  }
  function drillMessage(d, message) {
    d.status = 'message';
    d.box.replaceChildren();
    add(d.box, 'p', message);
  }
  async function runDrill(key, d) {
    var url = '/development/plans/' + d.rootId + '/nodes/' + d.nodeId + '/progress';
    function live() { return drills[key] === d && scope === scopeNow(); }
    try {
      var res = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: d.ctl.signal });
      if (res.status !== 200) {
        d.ctl.abort();
        if (live()) drillMessage(d, 'Evidence unavailable (HTTP ' + (res.status | 0) + '). Collapse and expand again to retry.');
        return;
      }
      var raw = await readBounded(res, d.ctl);
      if (!live()) return;
      var p = parseProgress(raw, d.rootId, d.task);
      if (p === null) { drillMessage(d, 'Evidence unavailable: the progress response was not recognized. Collapse and expand again to retry.'); return; }
      if (!p.fenced) { drillMessage(d, 'Evidence changed: the task no longer matches the overview. Refresh, then re-expand.'); return; }
      d.status = 'ok';
      renderEvidence(d.box, p);
    } catch (error) {
      if (!live()) return;
      if (error && error.tooLarge) drillMessage(d, 'Evidence unavailable: the response is too large to display. Collapse and expand again to retry.');
      else if (d.timedOut) drillMessage(d, 'Evidence unavailable: the request timed out. Collapse and expand again to retry.');
      else drillMessage(d, 'Evidence unavailable: the request failed. Collapse and expand again to retry.');
    } finally {
      clearTimeout(d.timer);
    }
  }
  function expand(details, box, rootId, task) {
    var key = rootId + '|' + task.nodeId;
    var task0 = knownPair(rootId, task.nodeId);
    if (task0 === null) { box.replaceChildren(); add(box, 'p', 'This task is not in the last overview.'); return; }
    stopDrill(key);
    var d = { rootId: rootId, nodeId: task.nodeId, task: task0, binding: bindingOf(rootId, task0), box: box, status: 'loading', ctl: new AbortController(), timer: null, timedOut: false };
    box.replaceChildren();
    if (drillCount() >= MAX_DRILLS) {
      drills[key] = d;
      drillMessage(d, 'Too many evidence reads are in flight (maximum ' + MAX_DRILLS + '). Wait, then collapse and expand again.');
      return;
    }
    drills[key] = d;
    add(box, 'p', 'Reading evidence…');
    d.timer = setTimeout(function () { d.timedOut = true; d.ctl.abort(); }, DRILL_DEADLINE_MS);
    void runDrill(key, d);
  }

  // ----- rendering -----
  function summaryOf(task) {
    var name = task.name === null ? '(unnamed task)' : text(task.name);
    return (STATE_LABELS[task.state] || task.state) + ' — ' + name;
  }
  function decisionText(task) {
    var a = task.acceptance;
    if (a === null) return 'Recorded decision: none';
    var who = ' by ' + text(a.decidedBy) + ' (attempt ' + (a.attemptId === null ? 'none' : text(a.attemptId)) + ', epoch ' + a.attemptEpoch + ', content revision ' + a.contentRevision + ')';
    if (task.acceptanceHistorical === true) return 'Historical decision from an older attempt, not this attempt\\'s outcome: ' + a.decision + who;
    if (task.state === 'accepted' || task.state === 'rejected') return 'Current decision: ' + a.decision + who;
    return 'Recorded decision, not current for this task state: ' + a.decision + who;
  }
  function renderBudget(body, task) {
    var b = task.checkpointBudget;
    if (b === undefined) return;
    var box = add(body, 'div');
    box.setAttribute('data-budget', b.state);
    if (b.state === 'unavailable') {
      add(box, 'p', 'Checkpoint budget record unavailable (reason: ' + b.reason + ').' + (b.reason === 'stale_identity' ? ' The record belongs to another attempt or content revision; its numbers are not shown.' : ''));
      return;
    }
    var r = b.record;
    add(box, 'p', 'Checkpoint budget record (supplied runner record, not authenticated; owner liveness unknown):');
    line(box, 'Run', r.runId);
    line(box, 'Unit', 'distinct assistant message IDs seen (' + r.unit + ')');
    line(box, 'Expected (provisional heuristic, not an SLO)', r.expected.units);
    line(box, 'Hard limits', r.hard.units + ' units, ' + r.hard.wallMs + ' ms, ' + r.hard.outputBytes + ' output bytes');
    line(box, 'Consumed at last write (' + (r.consumed.counterState === 'lower_bound' ? 'lower bound' : 'observed') + ')', r.consumed.units + ' units, ' + r.consumed.wallMs + ' ms, ' + r.consumed.outputBytes + ' output bytes');
    if (r.expectedExceeded) add(box, 'p', 'Expected units reached.');
    add(box, 'p', r.state === 'running' ? 'Run state: running as last recorded at ' + r.updatedAt + '; owner liveness unknown.' : 'Run state: ended at ' + r.endedAt + '.');
    if (b.overdueUnreported) add(box, 'p', 'Overdue: no end was recorded past the hard wall limit plus grace (overdue_unreported).');
    line(box, 'Stop', r.stop.kind + ' / ' + r.stop.code);
    if (r.stop.code === 'cleanup_failed') add(box, 'p', 'Cleanup was not confirmed; clean stop is not asserted. Root PID ' + (r.rootPid === null ? 'unknown' : r.rootPid) + ' is a recorded descriptor, not authority to stop or restart anything.');
    if (r.exit !== null) line(box, 'Worker exit (not the stop cause)', (r.exit.code === null ? 'no code' : r.exit.code) + (r.exit.signal === null ? '' : ' ' + r.exit.signal));
    line(box, 'Provider reported (unverified)', 'num_turns ' + (r.providerReported.numTurns === null ? 'none' : r.providerReported.numTurns) + ', cost USD ' + (r.providerReported.costUsd === null ? 'none' : r.providerReported.costUsd));
    line(box, 'Cost enforcement', r.cost.enforcement);
    var g = b.gate;
    if (g.state === 'unavailable') {
      add(box, 'p', 'Gate evidence unavailable (reason: ' + g.reason + '). Supplied by the lead when present, not verified by ChatAgent.');
      return;
    }
    add(box, 'p', 'Gate evidence (' + (g.state === 'current' ? 'current' : 'history, not for the current artifact') + '; supplied by the lead, not verified by ChatAgent): ' + g.gate.outcome);
    line(box, 'Gate source', g.gate.sourceRef);
    line(box, 'Failure attribution (lead supplied)', g.gate.failureAttribution);
    for (var k = 0; k < g.gate.checks.length; k++) add(box, 'p', 'Check ' + text(g.gate.checks[k].name) + ': ' + g.gate.checks[k].result);
  }
  function renderTask(parent, rootId, task) {
    var key = rootId + '|' + task.nodeId;
    var details = add(parent, 'details');
    details.setAttribute('data-task', task.nodeId);
    details.setAttribute('data-state', task.state);
    var summary = add(details, 'summary', summaryOf(task));
    if (task.prod !== 'none') add(summary, 'em', ' — attention: ' + PROD_LABELS[task.prod]);
    var body = add(details, 'div');
    line(body, 'Task', task.nodeId);
    line(body, 'Content revision', task.contentRevision);
    line(body, 'State revision', task.stateRevision);
    line(body, 'Scope', task.scope);
    line(body, 'Attempt', task.attemptId);
    line(body, 'Attempt epoch', task.attemptEpoch);
    line(body, 'Executor', task.executorRef);
    line(body, 'Input pins', task.attemptPins);
    line(body, 'Gates hold', task.gatesHold);
    line(body, 'Upstream changed', task.upstreamChanged);
    add(body, 'p', 'Worker started: unknown. Liveness: unknown.');
    add(body, 'p', decisionText(task));
    add(body, 'p', 'Task artifact: ' + refText(task.artifactRef));
    add(body, 'p', 'Checkpoint gate (current state): ' + task.checkpointGate);
    add(body, 'p', 'Budget evidence: ' + task.budgetEvidence);
    renderBudget(body, task);
    if (task.blockers.length > 0) {
      add(body, 'p', 'Blocked by:');
      var list = add(body, 'ul');
      for (var b = 0; b < task.blockers.length; b++) add(list, 'li', (task.blockers[b].name === null ? task.blockers[b].id : text(task.blockers[b].name)) + ' (' + text(task.blockers[b].gate) + '): ' + text(task.blockers[b].reason));
      if (task.blockersOmitted > 0) add(body, 'p', task.blockersOmitted + ' more blockers not shown.');
    }
    var box = add(body, 'div');
    box.setAttribute('data-evidence', '');
    var kept = drills[key];
    if (kept) {
      if (kept.binding === bindingOf(rootId, task)) {
        // Unchanged binding: the evidence (or its pending read) still describes this exact
        // attempt and these revisions.
        kept.box = box;
        kept.task = task;
        box.replaceChildren.apply(box, kept.nodes || []);
        details.open = true;
      } else {
        stopDrill(key);
        drills[key] = { rootId: rootId, nodeId: task.nodeId, task: task, binding: bindingOf(rootId, task), box: box, status: 'message', ctl: null, timer: null };
        add(box, 'p', 'Evidence unavailable: the task changed since it was expanded. Collapse and expand again to re-read.');
        details.open = true;
      }
    }
    summary.addEventListener('click', function () {
      // The click runs before the toggle, so details.open is the state being left.
      if (details.open) { stopDrill(key); box.replaceChildren(); }
      else expand(details, box, rootId, task);
    });
    return details;
  }
  function renderRoot(parent, root) {
    var details = add(parent, 'details');
    details.setAttribute('data-root', root.rootId);
    details.setAttribute('data-status', root.status);
    if (openRoots[root.rootId]) details.open = true;
    var summary = add(details, 'summary');
    add(summary, 'strong', text(root.label));
    var bits = [];
    if (root.status === 'ok') {
      bits.push('plan ' + root.planState.replace(/_/g, ' '));
      bits.push(root.acceptedCounts.accepted + ' of ' + root.acceptedCounts.total + ' tasks accepted in PlanStore');
    } else if (root.status === 'invalid') {
      bits.push('plan invalid; cannot be evaluated');
    } else {
      bits.push('unavailable (' + root.reason + ')');
    }
    add(summary, 'span', ' — ' + bits.join('; '));
    if (root.prods.length > 0) {
      add(summary, 'em', ' — attention: ' + root.prods.map(function (p) { return p.count + ' ' + PROD_LABELS[p.kind]; }).join('; '));
    }
    summary.addEventListener('click', function () { openRoots[root.rootId] = !details.open; });
    var body = add(details, 'div');
    line(body, 'Plan root', root.rootId);
    line(body, 'Goal (configured, not verified)', root.goal);
    add(body, 'p', 'Read finished at ' + clip(root.observedAt, 64) + ' (server clock)');
    if (root.status === 'unavailable') add(body, 'p', 'This plan could not be read (reason: ' + root.reason + '). Other plans are unaffected.');
    if (root.status === 'invalid') {
      add(body, 'p', 'The plan reports readiness errors, so no task state is inferred.');
      for (var c = 0; c < root.invalidCodes.length; c++) add(body, 'p', 'Readiness error: ' + text(root.invalidCodes[c].code) + (root.invalidCodes[c].nodeId ? ' (' + root.invalidCodes[c].nodeId + ')' : ''));
    }
    if (root.status === 'ok') {
      var counts = Object.keys(root.counts).map(function (k) { return root.counts[k] + ' ' + k.replace(/_/g, ' '); });
      add(body, 'p', 'Counts: ' + (counts.length ? counts.join(', ') : 'no tasks'));
      for (var t = 0; t < root.tasks.length; t++) renderTask(body, root.rootId, root.tasks[t]);
      if (root.tasksOmitted > 0) add(body, 'p', 'Omitted ' + root.tasksOmitted + ' lower-priority tasks to stay within the size bound.');
    }
    return details;
  }
  function render(overview) {
    // Evidence nodes survive a re-render only when the task binding is unchanged.
    for (var key in drills) if (drills[key].box) drills[key].nodes = Array.prototype.slice.call(drills[key].box.childNodes || []);
    var box = document.createElement('div');
    add(box, 'p', 'Generated ' + clip(overview.generatedAt, 64) + ' (ChatAgent server clock). Roots are read independently; their times are not one snapshot.');
    var alive = {};
    for (var i = 0; i < overview.roots.length; i++) {
      renderRoot(box, overview.roots[i]);
      for (var k = 0; k < overview.roots[i].tasks.length; k++) alive[overview.roots[i].rootId + '|' + overview.roots[i].tasks[k].nodeId] = true;
    }
    view.replaceChildren(box);
    for (var gone in drills) if (!alive[gone]) stopDrill(gone);
  }

  // ----- refresh -----
  function setButton() { button.disabled = current !== null; }
  function clearAll(message) {
    if (current) { clearTimeout(current.timer); current.ctl.abort(); current = null; }
    for (var key in drills) stopDrill(key);
    last = null;
    openRoots = {};
    view.replaceChildren();
    staleBox.hidden = true;
    staleBox.textContent = '';
    view.removeAttribute('data-stale');
    note.textContent = message || '';
    setButton();
  }
  function failed(message) {
    note.textContent = message;
    if (last) {
      staleBox.textContent = 'Refresh failed; showing data last read at ' + last.at + ' (browser clock) / ' + last.overview.generatedAt + ' (server clock). ' + message;
      staleBox.hidden = false;
      view.setAttribute('data-stale', 'true');
    }
  }
  async function refresh() {
    if (current) return;
    var req = { ctl: new AbortController(), scope: scopeNow(), timer: null, timedOut: false };
    current = req;
    setButton();
    note.textContent = 'Reading the configured plans…';
    req.timer = setTimeout(function () { req.timedOut = true; req.ctl.abort(); }, OVERVIEW_DEADLINE_MS);
    function live() { return current === req && req.scope === scopeNow(); }
    try {
      var res = await fetch('/development/executive/overview', { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: req.ctl.signal });
      if (res.status !== 200) {
        req.ctl.abort();
        if (live()) failed(refusal(res.status));
        return;
      }
      var raw = await readBounded(res, req.ctl);
      if (!live()) return;
      var overview = parseOverview(raw);
      if (overview === null) { failed('The overview response was not recognized.'); return; }
      last = { overview: overview, at: new Date().toISOString(), scope: req.scope };
      render(overview);
      staleBox.hidden = true;
      staleBox.textContent = '';
      view.removeAttribute('data-stale');
      note.textContent = 'Overview read (read-only).';
    } catch (error) {
      if (!live()) return;
      if (error && error.tooLarge) failed('The overview response is too large to display.');
      else if (req.timedOut) failed('The overview request timed out.');
      else failed('The overview request failed.');
    } finally {
      clearTimeout(req.timer);
      if (current === req) { current = null; setButton(); }
    }
  }

  function scopeChanged() {
    var next = scopeNow();
    if (next === scope) return;
    scope = next;
    clearAll('The user or conversation changed; press Refresh to read again.');
  }
  button.addEventListener('click', function () { void refresh(); });
  userInput.addEventListener('input', scopeChanged);
  userInput.addEventListener('change', scopeChanged);
  conversationInput.addEventListener('input', scopeChanged);
  conversationInput.addEventListener('change', scopeChanged);
  window.addEventListener('pagehide', function () {
    if (current) current.ctl.abort();
    for (var key in drills) if (drills[key].ctl) drills[key].ctl.abort();
  });
  setButton();
})();
</script>`;
}
