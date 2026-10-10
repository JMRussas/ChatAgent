/** Direct controls use the same workflow tools exposed to models through MCP. */
export function workflowPanelHtml(): string {
  return `<details id="workflowPanel" open style="padding:0.85rem 1rem;min-width:0">
    <summary>Plans and work</summary>
    <p>Create and edit a plan, run its saved steps, and review their results.</p>
    <div><button type="button" id="workflowListRefresh">Refresh plans</button>
      <button type="button" id="workflowNew">New plan</button></div>
    <p id="workflowNote" role="status" aria-live="polite">Loading plans…</p>
    <ul id="workflowList" aria-label="Saved plans"></ul>
    <details><summary>Available actions</summary><p id="workflowActions"></p></details>
    <section id="workflowEditor" hidden>
      <h3 id="workflowTitle">New plan</h3>
      <p id="workflowDescription"></p>
      <ol id="workflowPlanSteps" aria-label="Plan steps"></ol>
      <p id="workflowSavedState"></p>
      <details id="workflowDefinitionEditor"><summary>Edit plan definition</summary>
      <label for="workflowDefinition">Plan definition (JSON)</label>
      <textarea id="workflowDefinition" rows="14" spellcheck="false" style="width:100%;font-family:monospace"></textarea>
      <button type="button" id="workflowSave">Save plan</button>
      </details>
      <button type="button" id="workflowRun">Run saved plan</button>
    </section>
    <section id="workflowRunView" hidden>
      <h3>Execution</h3>
      <p id="workflowRunStatus" role="status"></p>
      <div><button type="button" id="workflowRunRefresh">Refresh execution</button>
        <button type="button" id="workflowStop">Stop execution</button></div>
      <ol id="workflowSteps"></ol>
      <form id="workflowHumanForm" hidden>
        <p id="workflowHumanInstructions"></p>
        <label for="workflowHumanOutput">Step result (JSON)</label>
        <textarea id="workflowHumanOutput" rows="4" spellcheck="false">{}</textarea>
        <button type="submit" id="workflowHumanSubmit">Submit result</button>
      </form>
    </section>
  </details>`;
}

export function workflowPanelScript(): string {
  return `<script>
(function () {
  var panel = document.getElementById('workflowPanel');
  if (!panel) return;
  function el(id) { return document.getElementById('workflow' + id); }
  var plan = null, run = null, saved = '', dirty = false, busy = false;
  var timer = null, requests = new Set(), disposed = false, selection = 0, pollingFailed = false;
  var latestRuns = new Map();
  var renderedRunId = null, expandedDetails = new Set();
  function add(parent, tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  function active() { return run && (run.status === 'running' || run.status === 'waiting_input'); }
  function statusLabel(status) {
    return { running: 'In progress', waiting_input: 'Needs your input', completed: 'Completed',
      failed: 'Failed', stopped: 'Stopped', uncertain: 'Outcome uncertain', pending: 'Not started',
      todo: 'Ready', in_progress: 'In progress', done: 'Completed', cancelled: 'Cancelled' }[status] || status;
  }
  function renderDefinition(definition) {
    el('Title').textContent = definition.name;
    el('Description').textContent = definition.description || '';
    el('PlanSteps').replaceChildren();
    definition.steps.forEach(function (step) { add(el('PlanSteps'), 'li', step.name); });
  }
  function rawDetails(parent, label, value) {
    var details = add(parent, 'details');
    details.dataset.detail = label;
    details.open = expandedDetails.has(parent.dataset.step + ':' + label);
    add(details, 'summary', label);
    var pre = add(details, 'pre', JSON.stringify(value, null, 2));
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:16rem;overflow:auto;max-width:100%';
  }
  function readableOutput(parent, output) {
    var text = typeof output === 'string' ? output : output && typeof output.text === 'string' ? output.text : null;
    if (text !== null) {
      var paragraph = add(parent, 'p', text);
      paragraph.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
    } else if (output && typeof output.approved === 'boolean') {
      add(parent, 'p', output.approved ? 'Approved' : 'Not approved');
      if (typeof output.note === 'string') add(parent, 'p', output.note).style.overflowWrap = 'anywhere';
    } else add(parent, 'p', 'Result saved.');
    rawDetails(parent, 'Output details', output);
  }
  function note(message) { el('Note').textContent = message; }
  function controls() {
    el('Save').disabled = busy || (plan && active());
    el('Run').disabled = busy || !plan || dirty || active();
    el('Stop').disabled = busy || !active();
    el('RunRefresh').disabled = busy || !run;
    el('HumanSubmit').disabled = busy || !run || run.status !== 'waiting_input';
    el('ListRefresh').disabled = busy;
    el('New').disabled = busy;
    el('SavedState').textContent = !plan ? 'Draft — save before running.' :
      dirty ? 'Unsaved changes — save before running.' : 'Saved revision ' + plan.revision + '.';
  }
  async function tool(name, input) {
    var controller = new AbortController();
    requests.add(controller);
    var deadline = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch('/workflows/tools/' + name, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: controller.signal
      });
      var text = await response.text();
      if (text.length > 1048576) throw new Error('Workflow response is too large.');
      var result;
      try { result = JSON.parse(text); } catch (_) { throw new Error('Workflow service returned an invalid response.'); }
      if (!response.ok) {
        var detail = result && (result.message || (typeof result.error === 'string' ? result.error : result.error && result.error.message));
        throw new Error(typeof detail === 'string' ? detail : 'Workflow request failed (' + response.status + ').');
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Workflow request timed out or was cancelled. Refresh to check its saved state.');
      throw error;
    } finally { clearTimeout(deadline); requests.delete(controller); }
  }
  function stopPolling() { clearTimeout(timer); timer = null; }
  function poll() {
    stopPolling();
    if (!disposed && !pollingFailed && run && run.status === 'running' && !document.hidden && panel.open) {
      timer = setTimeout(function () { refreshRun(); }, 2000);
    }
  }
  function renderRun() {
    el('RunView').hidden = !run;
    el('HumanForm').hidden = true;
    if (!run) { stopPolling(); controls(); return; }
    el('RunStatus').dataset.status = run.status;
    el('RunStatus').textContent = run.definition.name + ': ' + statusLabel(run.status) +
      (run.error ? ' — ' + run.error : '');
    expandedDetails = new Set();
    if (renderedRunId === run.id) el('Steps').querySelectorAll('details[open]').forEach(function (details) {
      expandedDetails.add(details.parentElement.dataset.step + ':' + details.dataset.detail);
    });
    renderedRunId = run.id;
    el('Steps').replaceChildren();
    run.steps.forEach(function (step) {
      var item = add(el('Steps'), 'li');
      item.dataset.step = step.id;
      add(item, 'strong', step.name + ': ' + statusLabel(step.status));
      if (step.inputs !== undefined) rawDetails(item, 'Inputs', step.inputs);
      if (step.output !== undefined) readableOutput(item, step.output);
      if (step.error) add(item, 'p', step.error);
    });
    var waiting = run.steps.find(function (step) { return step.status === 'waiting_input'; });
    if (run.status === 'waiting_input' && waiting) {
      var definition = run.definition.steps.find(function (step) { return step.id === waiting.id; });
      el('HumanInstructions').textContent = definition && definition.action.type === 'human' ?
        definition.action.instructions : 'Provide the requested step result.';
      el('HumanForm').hidden = false;
    }
    pollingFailed = false;
    latestRuns.set(run.planId, run.id);
    controls(); poll();
  }
  function showPlan(next) {
    plan = next; run = null; dirty = false;
    saved = JSON.stringify(next.definition, null, 2);
    el('Definition').value = saved;
    renderDefinition(next.definition);
    el('DefinitionEditor').open = false;
    el('Editor').hidden = false;
    renderRun(); controls();
  }
  async function listPlans() {
    var result = await tool('list_plans', {});
    el('List').replaceChildren();
    if (!result.plans.length) add(el('List'), 'li', 'No saved plans yet.');
    result.plans.forEach(function (entry) {
      var item = add(el('List'), 'li');
      item.dataset.plan = entry.id;
      var button = add(item, 'button', entry.definition.name);
      button.type = 'button';
      button.addEventListener('click', function () { openPlan(entry.id); });
      add(item, 'span', ' — ' + statusLabel(entry.work));
    });
  }
  async function refreshPlanState() {
    if (!plan || !run || run.planId !== plan.id) return;
    var next = await tool('get_plan', { id: plan.id });
    // Refresh execution metadata without replacing the draft or its revision fence.
    plan.work = next.work; plan.stateRevision = next.stateRevision;
    plan.attemptId = next.attemptId; plan.attemptEpoch = next.attemptEpoch;
    plan.latestRunId = next.latestRunId;
    await listPlans();
  }
  async function operation(action) {
    if (busy || disposed) return;
    busy = true; stopPolling(); controls();
    try { await action(); }
    catch (error) { pollingFailed = true; note(error.message || 'Workflow operation failed.'); stopPolling(); }
    finally { busy = false; controls(); poll(); }
  }
  async function openPlan(id) {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    await operation(async function () {
      var next = await tool('get_plan', { id: id });
      selection++;
      showPlan(next);
      var runId = next.latestRunId || next.attemptId || latestRuns.get(next.id);
      if (runId) { run = await tool('get_run', { id: runId }); renderRun(); }
      note('Opened saved plan.');
    });
  }
  async function refreshRun() {
    if (!run || busy || disposed) return;
    var id = run.id, version = selection;
    await operation(async function () {
      var next = await tool('get_run', { id: id });
      if (version !== selection || !run || run.id !== id) return;
      run = next; renderRun();
      if (run.status !== 'running') await refreshPlanState();
      note('Execution state refreshed.');
    });
  }
  el('ListRefresh').addEventListener('click', function () {
    operation(async function () { await listPlans(); note('Plans refreshed; editor changes are preserved.'); });
  });
  el('New').addEventListener('click', function () {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    selection++; plan = null; run = null; saved = ''; dirty = true;
    el('Definition').value = JSON.stringify({ version: 1, name: 'New plan', description: '', steps: [
      { id: 'review', name: 'Review', inputs: {}, action: { type: 'human', instructions: 'Review the work and provide a result.' } }
    ] }, null, 2);
    renderDefinition(JSON.parse(el('Definition').value));
    el('DefinitionEditor').open = true; el('Editor').hidden = false;
    renderRun(); controls(); note('New draft.');
  });
  el('Definition').addEventListener('input', function () { dirty = el('Definition').value !== saved; controls(); });
  el('Save').addEventListener('click', function () {
    operation(async function () {
      var definition;
      try { definition = JSON.parse(el('Definition').value); }
      catch (_) { throw new Error('Plan definition must be valid JSON.'); }
      var next = await tool(plan ? 'update_plan' : 'create_plan', plan ?
        { id: plan.id, revision: plan.revision, definition: definition } : { definition: definition });
      showPlan(next); await listPlans(); note('Plan saved.');
    });
  });
  el('Run').addEventListener('click', function () {
    operation(async function () {
      run = await tool('run_plan', { id: plan.id, revision: plan.revision });
      renderRun(); await refreshPlanState(); note('Execution started.');
    });
  });
  el('RunRefresh').addEventListener('click', refreshRun);
  el('Stop').addEventListener('click', function () {
    operation(async function () { run = await tool('stop_run', { id: run.id }); renderRun(); await refreshPlanState(); note('Stop requested; inspect the recorded execution state.'); });
  });
  el('HumanForm').addEventListener('submit', function (event) {
    event.preventDefault();
    operation(async function () {
      var output;
      try { output = JSON.parse(el('HumanOutput').value); }
      catch (_) { throw new Error('Step result must be valid JSON.'); }
      var step = run.steps.find(function (entry) { return entry.status === 'waiting_input'; });
      run = await tool('submit_step_result', { id: run.id, stepId: step.id, output: output });
      renderRun(); await refreshPlanState(); note('Step result saved.');
    });
  });
  panel.addEventListener('toggle', poll);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('pagehide', function () {
    disposed = true; stopPolling(); requests.forEach(function (controller) { controller.abort(); });
  });
  controls();
  operation(async function () {
    await listPlans();
    var result = await tool('list_actions', {});
    el('Actions').textContent = 'Available tool actions: ' + (result.actions.map(function (action) { return action.name; }).join(', ') || 'none') +
      '. Model execution: ' + (result.modelAvailable ? 'configured.' : 'not configured.');
    note('Choose a saved plan or create one.');
  });
})();
</script>`;
}
