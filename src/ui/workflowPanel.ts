/** Direct controls use the same workflow tools exposed to models through MCP. */
export function workflowPanelHtml(): string {
  return `<details id="workflowPanel" open style="padding:0.85rem 1rem;min-width:0">
    <summary>Plans and work</summary>
    <p>Create and edit a plan, run its saved steps, and review their results.</p>
    <div><button type="button" id="workflowListRefresh">Refresh plans</button>
      <button type="button" id="workflowNew">New plan</button>
      <button type="button" id="workflowNewAgent">New agent task</button></div>
    <p id="workflowNote" role="status" aria-live="polite">Loading plans…</p>
    <ul id="workflowList" aria-label="Saved plans"></ul>
    <details><summary>Available actions</summary><p id="workflowActions"></p></details>
    <form id="workflowAgentCreateForm" hidden>
      <h3>New agent task</h3>
      <label for="workflowAgentName">Task name</label><input id="workflowAgentName" maxlength="200" required />
      <label for="workflowAgentObjective">Objective</label><textarea id="workflowAgentObjective" maxlength="16000" required></textarea>
      <label for="workflowAgentExecutor">Executor</label><select id="workflowAgentExecutor"></select>
      <label for="workflowAgentContext">Task context (optional)</label><textarea id="workflowAgentContext" maxlength="16000"></textarea>
      <details><summary>Add a reference</summary>
        <label for="workflowAgentReferenceLabel">Reference label</label><input id="workflowAgentReferenceLabel" maxlength="200" />
        <label for="workflowAgentReferenceContent">Reference content</label><textarea id="workflowAgentReferenceContent" maxlength="16000"></textarea>
      </details>
      <fieldset><legend>Tools this agent may use</legend><div id="workflowAgentTools"></div></fieldset>
      <label for="workflowAgentCriteria">Completion criteria (one per line)</label><textarea id="workflowAgentCriteria" required></textarea>
      <label for="workflowAgentMaxTurns">Maximum agent turns</label><input id="workflowAgentMaxTurns" type="number" min="1" max="30" value="12" required />
      <button type="submit" id="workflowAgentCreate">Create agent task</button>
    </form>
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
      <form id="workflowAgentRequestForm" hidden>
        <h4>Agent needs your input</h4>
        <p id="workflowAgentRequestPrompt"></p>
        <div id="workflowAgentContextResponse">
          <label for="workflowAgentResponse">Additional context</label>
          <textarea id="workflowAgentResponse" maxlength="16000"></textarea>
          <button type="submit" id="workflowAgentRespond">Provide context</button>
        </div>
        <div id="workflowAgentToolResponse" hidden>
          <button type="button" id="workflowAgentAllow">Allow tool</button>
          <button type="button" id="workflowAgentDecline">Decline tool</button>
        </div>
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
  var availableExecutors = [], pendingAgentRequest = null, pendingAgentStep = null;
  var actionDescriptions = new Map();
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
    definition.steps.forEach(function (step) {
      var item = add(el('PlanSteps'), 'li', step.name);
      if (step.action.type === 'agent') {
        var task = step.action.task;
        add(item, 'p', task.objective).style.overflowWrap = 'anywhere';
        add(item, 'p', 'Executor: ' + step.action.executor + '. Allowed tools: ' + (task.tools.join(', ') || 'none') + '.');
        if (task.context) rawDetails(item, 'Task context', task.context);
        task.references.forEach(function (reference) { rawDetails(item, 'Reference: ' + reference.label, reference.content); });
        add(item, 'p', 'Completion criteria:');
        var criteria = add(item, 'ul');
        task.completionCriteria.forEach(function (criterion) { add(criteria, 'li', criterion); });
      }
    });
  }
  function rawDetails(parent, label, value) {
    var details = add(parent, 'details');
    details.dataset.detail = label;
    details.dataset.detailKey = (parent.dataset.detailScope || parent.dataset.step || '') + ':' + label;
    details.open = expandedDetails.has(details.dataset.detailKey);
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
    el('NewAgent').disabled = busy || !availableExecutors.length;
    el('AgentCreate').disabled = busy || !availableExecutors.length;
    el('AgentRespond').disabled = busy || !pendingAgentRequest;
    el('AgentAllow').disabled = busy || !pendingAgentRequest;
    el('AgentDecline').disabled = busy || !pendingAgentRequest;
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
    if (!disposed && !pollingFailed && active() && !document.hidden && panel.open) {
      timer = setTimeout(function () { refreshRun(); }, 2000);
    }
  }
  function renderRun() {
    el('RunView').hidden = !run;
    el('HumanForm').hidden = true;
    el('AgentRequestForm').hidden = true;
    pendingAgentRequest = null; pendingAgentStep = null;
    if (!run) { stopPolling(); controls(); return; }
    el('RunStatus').dataset.status = run.status;
    el('RunStatus').textContent = run.definition.name + ': ' + statusLabel(run.status) +
      (run.error ? ' — ' + run.error : '');
    expandedDetails = new Set();
    if (renderedRunId === run.id) el('Steps').querySelectorAll('details[open]').forEach(function (details) {
      expandedDetails.add(details.dataset.detailKey);
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
      if (step.agent) {
        if (step.status === 'completed') add(item, 'p', 'Executor finished. Review the result against the task’s completion criteria.');
        add(item, 'p', 'Allowed tools: ' + (step.agent.allowedTools.join(', ') || 'none') + '.');
        var activity = add(item, 'ol'); activity.setAttribute('aria-label', 'Agent activity');
        step.agent.events.forEach(function (event, index) {
          var entry = add(activity, 'li', event.message);
          entry.dataset.detailScope = step.id + ':event:' + index;
          entry.style.overflowWrap = 'anywhere';
          if (event.arguments !== undefined) rawDetails(entry, 'Tool arguments', event.arguments);
          if (event.result !== undefined) rawDetails(entry, 'Tool result', event.result);
        });
        var request = step.agent.requests.find(function (entry) { return entry.status === 'pending'; });
        if (run.status === 'waiting_input' && request) {
          pendingAgentRequest = request; pendingAgentStep = step.id;
          el('AgentRequestPrompt').textContent = request.prompt + (request.tool ? ' Tool: ' + request.tool +
            (actionDescriptions.has(request.tool) ? ' — ' + actionDescriptions.get(request.tool) : '') : '');
          el('AgentContextResponse').hidden = request.kind !== 'context';
          el('AgentToolResponse').hidden = request.kind !== 'tool';
          el('AgentRequestForm').hidden = false;
        }
      }
    });
    var waiting = run.steps.find(function (step) { return step.status === 'waiting_input'; });
    if (run.status === 'waiting_input' && waiting && !pendingAgentRequest) {
      var definition = run.definition.steps.find(function (step) { return step.id === waiting.id; });
      if (definition && definition.action.type === 'human') {
        el('HumanInstructions').textContent = definition.action.instructions;
        el('HumanForm').hidden = false;
      }
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
    el('AgentCreateForm').hidden = true;
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
      var previousStatus = run.status;
      run = next; renderRun();
      if (!active() || run.status !== previousStatus) await refreshPlanState();
      note('Execution state refreshed.');
    });
  }
  el('ListRefresh').addEventListener('click', function () {
    operation(async function () { await listPlans(); note('Plans refreshed; editor changes are preserved.'); });
  });
  el('New').addEventListener('click', function () {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    selection++; plan = null; run = null; saved = ''; dirty = true;
    el('AgentCreateForm').hidden = true;
    el('Definition').value = JSON.stringify({ version: 1, name: 'New plan', description: '', steps: [
      { id: 'review', name: 'Review', inputs: {}, action: { type: 'human', instructions: 'Review the work and provide a result.' } }
    ] }, null, 2);
    renderDefinition(JSON.parse(el('Definition').value));
    el('DefinitionEditor').open = true; el('Editor').hidden = false;
    renderRun(); controls(); note('New draft.');
  });
  el('NewAgent').addEventListener('click', function () {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    selection++; plan = null; run = null; saved = ''; dirty = false;
    el('Editor').hidden = true;
    el('AgentCreateForm').reset(); el('AgentCreateForm').hidden = false;
    renderRun(); controls(); note('Describe the task, choose its executor and tools, then save it.');
  });
  el('AgentCreateForm').addEventListener('input', function () { dirty = true; });
  el('AgentCreateForm').addEventListener('submit', function (event) {
    event.preventDefault();
    operation(async function () {
      var objective = el('AgentObjective').value.trim();
      var name = el('AgentName').value.trim();
      var criteria = el('AgentCriteria').value.split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
      if (!criteria.length) throw new Error('Add at least one completion criterion.');
      var label = el('AgentReferenceLabel').value.trim(), content = el('AgentReferenceContent').value;
      var task = { objective: objective, context: el('AgentContext').value,
        references: label || content ? [{ id: 'reference', label: label || 'Reference', content: content }] : [],
        tools: Array.from(el('AgentTools').querySelectorAll('input:checked')).map(function (input) { return input.value; }),
        completionCriteria: criteria, limits: { maxTurns: Number(el('AgentMaxTurns').value) } };
      var definition = { version: 1, name: name, description: objective.slice(0, 4000), steps: [
        { id: 'task', name: name, inputs: {}, action: { type: 'agent', executor: el('AgentExecutor').value, task: task }, timeoutMs: 300000 }
      ] };
      showPlan(await tool('create_plan', { definition: definition }));
      await listPlans(); note('Agent task saved. Review it and click Run when ready.');
    });
  });
  async function respondToAgent(response) {
    await operation(async function () {
      run = await tool('respond_to_task_request', { id: run.id, stepId: pendingAgentStep, requestId: pendingAgentRequest.id, response: response });
      el('AgentResponse').value = '';
      renderRun(); await refreshPlanState(); note('Response saved.');
    });
  }
  el('AgentRequestForm').addEventListener('submit', function (event) {
    event.preventDefault();
    if (!el('AgentResponse').value.trim()) { note('Provide the additional context requested by the agent.'); return; }
    respondToAgent(el('AgentResponse').value);
  });
  el('AgentAllow').addEventListener('click', function () { respondToAgent({ approved: true }); });
  el('AgentDecline').addEventListener('click', function () { respondToAgent({ approved: false }); });
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
    availableExecutors = result.executors || [];
    el('AgentExecutor').replaceChildren();
    availableExecutors.forEach(function (executor) {
      var id = typeof executor === 'string' ? executor : executor.id;
      var option = add(el('AgentExecutor'), 'option', id); option.value = id;
    });
    el('AgentTools').replaceChildren();
    (result.taskTools || result.actions).forEach(function (action) {
      actionDescriptions.set(action.name, action.description);
      var label = add(el('AgentTools'), 'label');
      label.style.cssText = 'display:flex;align-items:center;text-transform:none;letter-spacing:normal';
      var checkbox = add(label, 'input'); checkbox.type = 'checkbox'; checkbox.value = action.name;
      add(label, 'span', action.name + ' — ' + action.description);
    });
    el('Actions').textContent = 'Available tool actions: ' + (result.actions.map(function (action) { return action.name; }).join(', ') || 'none') +
      '. Model execution: ' + (result.modelAvailable ? 'configured.' : 'not configured.');
    note('Choose a saved plan or create one.');
  });
})();
</script>`;
}
