import { workflowBuilderHtml, workflowBuilderScript } from "./workflowBuilder";

/** Direct controls use the same workflow tools exposed to models through MCP. */
export function workflowPanelHtml(): string {
  return `<details id="workflowPanel" open style="padding:0.85rem 1rem;min-width:0">
    <summary>Plans and work</summary>
    <p>Create and edit a plan, run its saved steps, and review their results.</p>
    <div><button type="button" id="workflowListRefresh">Refresh plans</button>
      <button type="button" id="workflowNew">New plan</button>
      <button type="button" id="workflowNewAgent">New agent task</button></div>
    <p id="workflowNote" role="status" aria-live="polite">Loading plans…</p>
    <p id="workflowProjectScope" hidden></p>
    <ul id="workflowList" aria-label="Saved plans"></ul>
    <details><summary>Available actions</summary><p id="workflowActions"></p></details>
    ${workflowBuilderHtml()}
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
      <fieldset><legend>Tools this agent may use</legend><p>Checked tools are granted when the run starts. During the run the agent can ask you for any other listed tool, and you approve or decline each request.</p><div id="workflowAgentTools"></div></fieldset>
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
      <section id="workflowRespond" hidden>
      <p id="workflowRespondContext"></p>
      <form id="workflowHumanForm" hidden>
        <h3 id="workflowHumanInstructions"></h3>
        <div id="workflowHumanEvidence"></div>
        <fieldset>
          <legend>Answer as</legend>
          <label
            ><input
              type="radio"
              name="workflowHumanFormat"
              id="workflowHumanPlain"
              value="plain"
              checked
            />
            Plain answer</label
          >
          <label
            ><input
              type="radio"
              name="workflowHumanFormat"
              id="workflowHumanApproval"
              value="approval"
            />
            Approval</label
          >
        </fieldset>
        <p id="workflowHumanFormatHelp"></p>
        <div id="workflowHumanPlainFields">
          <label for="workflowHumanText">Your answer</label
          ><textarea id="workflowHumanText" rows="4" maxlength="16000"></textarea>
        </div>
        <div id="workflowHumanApprovalFields" hidden>
          <fieldset>
            <legend>Decision</legend>
            <label
              ><input
                type="radio"
                name="workflowHumanApprovalChoice"
                id="workflowHumanApprove"
                value="true"
              />
              Approve</label
            >
            <label
              ><input
                type="radio"
                name="workflowHumanApprovalChoice"
                id="workflowHumanDoNotApprove"
                value="false"
              />
              Do not approve</label
            >
          </fieldset>
          <label for="workflowHumanNote">Note (optional)</label
          ><textarea id="workflowHumanNote" rows="3" maxlength="16000"></textarea>
        </div>
        <details id="workflowHumanAdvanced">
          <summary>Advanced</summary>
          <label><input type="radio" name="workflowHumanFormat" id="workflowHumanRaw" value="raw" /> Raw JSON</label>
          <div id="workflowHumanRawFields" hidden>
            <label for="workflowHumanOutput">Step result (JSON)</label>
            <textarea id="workflowHumanOutput" rows="4" spellcheck="false">{}</textarea>
          </div>
        </details>
        <p id="workflowHumanRule" hidden></p>
        <p id="workflowHumanScope" hidden>Records your decision for this step. It does not verify the task.</p>
        <button type="submit" id="workflowHumanSubmit">Submit answer</button>
      </form>
      <form id="workflowAgentRequestForm" hidden>
        <h3 id="workflowAgentRequestHeading">The agent asks:</h3>
        <p id="workflowAgentRequestPrompt"></p>
        <p id="workflowAgentToolDescription" hidden></p>
        <div id="workflowAgentContextResponse">
          <label for="workflowAgentResponse">Your answer</label>
          <textarea id="workflowAgentResponse" rows="4" maxlength="16000"></textarea>
          <button type="submit" id="workflowAgentRespond">Send context</button>
        </div>
        <div id="workflowAgentToolResponse" hidden>
          <button type="button" id="workflowAgentAllow">Allow tool</button>
          <button type="button" id="workflowAgentDecline">Decline tool</button>
        </div>
      </form>
      <p id="workflowRespondStatus" role="status" aria-live="polite"></p>
      <details id="workflowRespondEvidence"><summary>Recorded steps and outputs</summary></details>
      <button type="button" id="workflowRespondAdvanced">Open full plan controls</button>
    </section>
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
  var selectedProjectId = null, planProjectId = null, selectedConversationId = null, conversationProjectId = null;
  var pendingWorkspaceOpen = null, projectRefreshPending = false;
  var availableExecutors = [], pendingAgentRequest = null, pendingAgentStep = null;
  var actionDescriptions = new Map();
  var renderedRunId = null,
    expandedDetails = new Set(),
    humanDraftKey = null,
    agentDraftKey = null;
  var humanEvidenceRecord = null;
  ${workflowBuilderScript()}
  var builder = createWorkflowBuilder({
    dirty: function () { dirty = true; controls(); },
    note: note,
    save: function (definition) {
      operation(async function () {
        note('Saving workflow…');
        var created = await tool('create_plan', { definition: definition });
        showPlan(created);
        await listPlans();
        window.dispatchEvent(new CustomEvent('workspace-work-changed', {
          detail: { createdPlanId: created.id, projectId: planProjectId }
        }));
        note('Plan saved. Review it and click Run when ready.');
      });
    },
    advanced: function (definition) {
      builder.hide();
      el('Definition').value = JSON.stringify(definition, null, 2);
      renderDefinition(definition);
      el('DefinitionEditor').open = true;
      el('Editor').hidden = false;
      dirty = true;
      controls();
      note('Advanced JSON draft. Save it before running.');
      window.dispatchEvent(new CustomEvent('workspace-workflow-advanced'));
    }
  });
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
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:none;overflow:auto;max-width:100%';
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
  function renderRecordedEvidence(record, stepId) {
    var root = document.createElement("section");
    root.className = "recorded-review";
    root.setAttribute("aria-label", "Recorded inputs and earlier results");
    var index = record.steps.findIndex(function (step) {
      return step.id === stepId;
    });
    var current = record.steps[index];
    if (!current) return root;
    add(root, "h4", "Recorded information for this step");
    add(root, "p", "Recorded inputs and earlier results, not independent verification.");
    var content = add(root, "div");
    content.className = "recorded-review-values";
    var budget = 12000,
      fields = 0,
      shortened = false;
    function text(parent, tag, value) {
      if (budget <= 0) {
        shortened = true;
        return;
      }
      var shown = value.slice(0, Math.min(3000, budget));
      budget -= shown.length;
      if (shown.length < value.length) shortened = true;
      add(parent, tag, shown);
    }
    function value(parent, data, depth) {
      if (++fields > 60 || budget <= 0) {
        shortened = true;
        return;
      }
      if (typeof data === "string") {
        text(parent, "p", data);
        return;
      }
      if (data === null || typeof data !== "object") {
        text(parent, "p", JSON.stringify(data));
        return;
      }
      if (depth > 3) {
        shortened = true;
        text(parent, "p", "More nested data is recorded in the raw details.");
        return;
      }
      var entries = Object.entries(data);
      if (!entries.length) {
        text(parent, "p", Array.isArray(data) ? "[]" : "{}");
        return;
      }
      if (entries.length > 12) shortened = true;
      entries.slice(0, 12).forEach(function (entry) {
        var block = add(parent, "div");
        text(block, "strong", entry[0]);
        value(block, entry[1], depth + 1);
      });
    }
    var inputValues = new Set();
    if (current.inputs !== undefined) inputValues.add(JSON.stringify(current.inputs));
    if (current.inputs && typeof current.inputs === "object") {
      var entries = Object.entries(current.inputs);
      if (entries.length) {
        var supplied = add(content, "section");
        add(supplied, "strong", "Inputs supplied to this step");
        value(supplied, current.inputs, 0);
        entries.forEach(function (entry) {
          inputValues.add(JSON.stringify(entry[1]));
        });
      } else add(content, "p", "No input values are recorded for this step.");
    } else add(content, "p", "Resolved input is not recorded for this step.");
    var previous = record.steps.slice(0, index).filter(function (step) {
      return step.output !== undefined && !inputValues.has(JSON.stringify(step.output));
    });
    if (previous.length > 5)
      add(
        content,
        "p",
        "Showing the last five earlier results. Full history is in Recorded steps and outputs."
      );
    previous.slice(-5).forEach(function (step) {
      var source = add(content, "section");
      add(
        source,
        "strong",
        "Earlier recorded result: " + step.name + " · " + statusLabel(step.status)
      );
      value(source, step.output, 0);
      if (step.error) text(source, "p", step.error);
    });
    if (shortened) {
      var disclosures = [];
      if (current.inputs !== undefined) disclosures.push("Input details");
      if (previous.length) disclosures.push("Earlier output details");
      add(
        root,
        "p",
        "This preview is shortened. Open " +
          disclosures.join(" or ") +
          " for the full recorded values."
      );
    }
    root.dataset.detailScope = "review:" + current.id;
    if (current.inputs !== undefined) rawDetails(root, "Input details", current.inputs);
    if (previous.length)
      rawDetails(
        root,
        "Earlier output details",
        previous.map(function (step) {
          return { step: step.name, status: step.status, output: step.output, error: step.error };
        })
      );
    return root;
  }
  panel.renderRecordedEvidence = renderRecordedEvidence;
  function note(message, showInResponse) {
    el("Note").textContent = message;
    el("RespondStatus").textContent = showInResponse === false ? "" : message;
    el("BuilderStatus").textContent = message;
  }
  function approvalChoice() {
    return el("HumanForm").querySelector('input[name="workflowHumanApprovalChoice"]:checked');
  }
  function controls() {
    if (builder) builder.setBusy(busy);
    el('Save').disabled = busy || (plan && active());
    el('Run').disabled = busy || !plan || dirty || active();
    el('Stop').disabled = busy || !active();
    el('RunRefresh').disabled = busy || !run;
    el("HumanSubmit").disabled =
      busy || !run || run.status !== "waiting_input" ||
      (el("HumanApproval").checked && !approvalChoice());
    el("HumanForm")
      .querySelectorAll("input, textarea")
      .forEach(function (input) {
        input.disabled = busy;
      });
    el("AgentResponse").disabled = busy || !pendingAgentRequest;
    el("RespondAdvanced").disabled = busy;
    el('ListRefresh').disabled = busy;
    el('New').disabled = busy;
    el('NewAgent').disabled = busy || !availableExecutors.length;
    el('AgentCreate').disabled = busy || !availableExecutors.length;
    el('AgentRespond').disabled = busy || !pendingAgentRequest;
    el('AgentAllow').disabled = busy || !pendingAgentRequest;
    el('AgentDecline').disabled = busy || !pendingAgentRequest;
    el('ProjectScope').hidden = !(plan || dirty) || planProjectId === selectedProjectId;
    el('BuilderScope').hidden = el('ProjectScope').hidden;
    el('BuilderScope').textContent = 'This draft retains its original project while you browse another project. Create a new workflow to use the selected project.';
    el('ProjectScope').textContent = 'This open plan keeps its original project while you browse another project. Create a new plan to use the selected project.';
    el('SavedState').textContent = !plan ? 'Draft — save before running.' :
      dirty ? 'Unsaved changes — save before running.' : 'Saved revision ' + plan.revision + '.';
  }
  async function tool(name, input, projectScope) {
    var scope = projectScope === undefined ? (name === 'list_plans' || name === 'list_actions' ? selectedProjectId : planProjectId) : projectScope;
    var payload = Object.assign({}, input);
    if (scope) payload.projectId = scope;
    var headers = { 'Content-Type': 'application/json' };
    if (
      selectedConversationId &&
      conversationProjectId === scope &&
      ["create_plan", "update_plan", "run_plan", "submit_step_result", "respond_to_task_request"].includes(name)
    ) {
      headers['X-Workspace-Conversation-Id'] = selectedConversationId;
    }
    var controller = new AbortController();
    requests.add(controller);
    var deadline = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch('/workflows/tools/' + name, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: headers,
        body: JSON.stringify(payload), signal: controller.signal
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
  function humanFormat() {
    var selected = el("HumanForm").querySelector('input[name="workflowHumanFormat"]:checked').value;
    el("HumanPlainFields").hidden = selected !== "plain";
    el("HumanApprovalFields").hidden = selected !== "approval";
    el("HumanRawFields").hidden = selected !== "raw";
    if (selected === "raw") el("HumanAdvanced").open = true;
    var definition =
      run &&
      run.definition.steps.find(function (step) {
        return step.id === el("Respond").dataset.stepId;
      });
    el("HumanFormatHelp").textContent =
      selected === "raw"
        ? "Sends the exact JSON value you enter. Use this for a specific result structure."
        : selected === "approval"
          ? "Records an approval decision with an optional note."
          : "Records your written answer as text.";
    if (!definition || !definition.success)
      el("HumanFormatHelp").textContent += " No result rule is declared.";
    else if (
      selected === "plain" &&
      definition.success.path === "approved" &&
      definition.success.equals === true
    )
      el("HumanFormatHelp").textContent +=
        " This step needs an approval decision; a plain answer is not accepted.";
    if (selected === "approval" && !approvalChoice())
      el("HumanFormatHelp").textContent +=
        " Choose Approve or Do not approve to record your decision.";
    el("HumanScope").hidden = selected !== "approval";
    controls();
  }
  el("HumanForm")
    .querySelectorAll('input[name="workflowHumanFormat"], input[name="workflowHumanApprovalChoice"]')
    .forEach(function (input) {
      input.addEventListener("change", humanFormat);
    });
  function placeResponseEvidence(show) {
    var steps = el("Steps"),
      home = el("RunView"),
      sibling = el("Respond");
    if (show) {
      if (steps.parentElement !== el("RespondEvidence")) {
        el("RespondEvidence").open = false;
        el("RespondEvidence").append(steps);
      }
    } else if (steps.parentElement !== home)
      home.insertBefore(steps, sibling.parentElement === home ? sibling : null);
  }
  function responseSaved() {
    if (run.status === "failed" || run.status === "uncertain") {
      el("Respond").hidden = false;
      placeResponseEvidence(true);
      note(
        run.error ||
          "Answer saved, but the execution needs attention. Open full plan controls to inspect its recorded result."
      );
      return;
    }
    note("Answer saved.");
    window.dispatchEvent(
      new CustomEvent("workspace-work-changed", { detail: { responseSaved: true, runId: run.id } })
    );
  }
  function renderRun() {
    el('RunView').hidden = !run;
    el('HumanForm').hidden = true;
    el('AgentRequestForm').hidden = true;
    el("Respond").hidden = true;
    pendingAgentRequest = null; pendingAgentStep = null;
    if (!run) {
      placeResponseEvidence(false);
      stopPolling();
      controls();
      return;
    }
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
        if (run.status === "waiting_input" && request) {
          pendingAgentRequest = request; pendingAgentStep = step.id;
          var requestKey = run.id + ":" + step.id + ":" + request.id;
          if (agentDraftKey !== requestKey) {
            el('AgentResponse').value = '';
            agentDraftKey = requestKey;
          }
          el("AgentRequestHeading").textContent =
            request.kind === "tool" ? "The agent wants to use a tool:" : "The agent asks:";
          el("AgentRequestPrompt").textContent = request.prompt;
          el("AgentToolDescription").hidden = request.kind !== "tool";
          el("AgentToolDescription").textContent = request.tool
            ? request.tool +
              (actionDescriptions.has(request.tool)
                ? " — " + actionDescriptions.get(request.tool)
                : "")
            : "";
          el('AgentContextResponse').hidden = request.kind !== 'context';
          el('AgentToolResponse').hidden = request.kind !== 'tool';
          el('AgentRequestForm').hidden = false;
        }
      }
    });
    var waiting = run.steps.find(function (step) { return step.status === 'waiting_input'; });
    if (run.status === "waiting_input" && waiting && !pendingAgentRequest) {
      var definition = run.definition.steps.find(function (step) { return step.id === waiting.id; });
      if (definition && definition.action.type === "human") {
        var key = run.id + ":" + waiting.id;
        if (humanDraftKey !== key) {
          el("HumanForm").reset();
          el("HumanAdvanced").open = false;
          humanDraftKey = key;
          if (definition.success && definition.success.path === "approved")
            el("HumanApproval").checked = true;
        }
        el("Respond").dataset.stepId = waiting.id;
        var evidenceRecord = JSON.stringify({ run: run.id, step: waiting.id, inputs: waiting.inputs,
          earlier: run.steps.slice(0, run.steps.indexOf(waiting)).map(function (step) {
            return { id: step.id, name: step.name, status: step.status, output: step.output, error: step.error };
          }) });
        if (humanEvidenceRecord !== evidenceRecord) {
          el('HumanEvidence').replaceChildren(renderRecordedEvidence(run, waiting.id));
          humanEvidenceRecord = evidenceRecord;
        }
        humanFormat();
        el('HumanInstructions').textContent = definition.action.instructions;
        el("HumanRule").hidden = !definition.success;
        el("HumanRule").textContent = definition.success
          ? "This step checks: " +
            definition.success.path +
            " equals " +
            JSON.stringify(definition.success.equals) +
            (definition.success.path === "approved" && definition.success.equals === true
              ? ". Do not approve ends this run and records your decision."
              : "")
          : "";
        el('HumanForm').hidden = false;
      }
    }
    var needsResponse = !el("HumanForm").hidden || !el("AgentRequestForm").hidden;
    var isolated = el("Respond").closest("dialog");
    el("Respond").hidden = !needsResponse && !(isolated && isolated.open);
    var waitingIndex = waiting
      ? run.steps.findIndex(function (step) {
          return step.id === waiting.id;
        })
      : -1;
    el("Respond").dataset.planId = run.planId;
    el("Respond").dataset.projectId = planProjectId || "";
    el("Respond").dataset.runId = run.id;
    el("Respond").dataset.stepName = waiting && needsResponse ? waiting.name : "Recorded result";
    el("RespondContext").textContent =
      run.definition.name +
      (needsResponse
        ? " · step " + (waitingIndex + 1) + " of " + run.steps.length + " · waiting for you"
        : " · " + statusLabel(run.status) + " · no pending response");
    placeResponseEvidence(!el("Respond").hidden);
    pollingFailed = false;
    latestRuns.set(run.planId, run.id);
    controls();
    poll();
  }
  function showPlan(next) {
    builder.hide();
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
    var listScope = selectedProjectId;
    var result = await tool('list_plans', {}, listScope);
    if (listScope !== selectedProjectId) { projectRefreshPending = true; return; }
    el('List').replaceChildren();
    if (!result.plans.length) add(el('List'), 'li', 'No saved plans yet.');
    result.plans.forEach(function (entry) {
      var item = add(el('List'), 'li');
      item.dataset.plan = entry.id;
      var button = add(item, 'button', entry.definition.name);
      button.type = 'button';
      var entryProjectId = listScope;
      button.addEventListener('click', function () { openPlan(entry.id, entryProjectId); });
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
    window.dispatchEvent(new CustomEvent('workspace-work-changed'));
  }
  async function operation(action) {
    if (busy || disposed) return;
    busy = true; stopPolling(); controls();
    try { await action(); }
    catch (error) { pollingFailed = true; note(error.message || 'Workflow operation failed.'); stopPolling(); }
    finally {
      busy = false; controls(); poll();
      if (pendingWorkspaceOpen) {
        var requested = pendingWorkspaceOpen; pendingWorkspaceOpen = null;
        setTimeout(function () { window.dispatchEvent(new CustomEvent('workspace-open-plan', { detail: requested })); }, 0);
      } else if (projectRefreshPending) {
        projectRefreshPending = false;
        setTimeout(function () { operation(listPlans); }, 0);
      }
    }
  }
  async function openPlan(id, projectId) {
    if (dirty && !window.confirm("Discard unsaved plan changes?")) {
      note("Unsaved plan changes retained.");
      return false;
    }
    var opened = false;
    await operation(async function () {
      var scope = projectId === undefined ? selectedProjectId : projectId;
      var next = await tool('get_plan', { id: id }, scope);
      planProjectId = scope;
      selection++;
      showPlan(next);
      var runId = next.latestRunId || next.attemptId || latestRuns.get(next.id);
      if (runId) { run = await tool('get_run', { id: runId }); renderRun(); }
      await listPlans();
      note('Opened saved plan.', false);
      opened = true;
    });
    return opened;
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
      note('Execution state refreshed.', false);
    });
  }
  el('ListRefresh').addEventListener('click', function () {
    operation(async function () { await listPlans(); note('Plans refreshed; editor changes are preserved.'); });
  });
  el('New').addEventListener('click', function () {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    selection++;
    plan = null;
    run = null;
    saved = '';
    dirty = true;
    planProjectId = selectedProjectId;
    el('AgentCreateForm').hidden = true;
    el('Editor').hidden = true;
    builder.reset();
    renderRun();
    controls();
    note('Describe the steps, then save the workflow.');
    window.dispatchEvent(new CustomEvent('workspace-new-workflow-form', { detail: { projectId: planProjectId } }));
  });
  el('NewAgent').addEventListener('click', function () {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    builder.hide();
    selection++; plan = null; run = null; saved = ''; dirty = false; planProjectId = selectedProjectId;
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
      await listPlans(); window.dispatchEvent(new CustomEvent('workspace-work-changed')); note('Agent task saved. Review it and click Run when ready.');
    });
  });
  async function respondToAgent(response) {
    await operation(async function () {
      note(typeof response === 'string' ? 'Sending context…' : 'Recording tool permission…');
      run = await tool('respond_to_task_request', { id: run.id, stepId: pendingAgentStep, requestId: pendingAgentRequest.id, response: response });
      el('AgentResponse').value = '';
      renderRun();
      responseSaved();
      await refreshPlanState();
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
      showPlan(next); await listPlans(); window.dispatchEvent(new CustomEvent('workspace-work-changed')); note('Plan saved.');
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
  el("HumanForm").addEventListener("submit", function (event) {
    event.preventDefault();
    operation(async function () {
      note('Saving your answer…');
      var format = el("HumanForm").querySelector('input[name="workflowHumanFormat"]:checked').value,
        output;
      if (format === "plain") {
        var text = el("HumanText").value.trim();
        if (!text) throw new Error("Write your answer first.");
        output = { text: text };
      } else if (format === "approval") {
        var decision = approvalChoice();
        if (!decision) throw new Error("Choose Approve or Do not approve to record your decision.");
        output = { approved: decision.value === "true" };
        var noteText = el("HumanNote").value.trim();
        if (noteText) output.note = noteText;
      } else {
        try {
          output = JSON.parse(el('HumanOutput').value);
        } catch (_) {
          throw new Error('Step result must be valid JSON.');
        }
      }
      var step =
        run &&
        run.status === "waiting_input" &&
        run.steps.find(function (entry) {
          return entry.status === 'waiting_input';
        });
      if (!step)
        throw new Error(
          "This execution is no longer waiting for a response. Refresh its saved state."
        );
      run = await tool('submit_step_result', { id: run.id, stepId: step.id, output: output });
      renderRun();
      responseSaved();
      await refreshPlanState();
    });
  });
  window.addEventListener('workspace-project-selected', function (event) {
    selectedProjectId = event.detail && event.detail.projectId || null;
    if (busy) projectRefreshPending = true;
    else setTimeout(function () { operation(listPlans); }, 0);
  });
  window.addEventListener('workspace-conversation-selected', function (event) {
    selectedConversationId = event.detail && event.detail.conversationId || null;
    conversationProjectId = event.detail && event.detail.projectId || null;
  });
  window.addEventListener("workspace-open-plan", async function (event) {
    if (!event.detail || typeof event.detail.id !== 'string') return;
    if (busy) { pendingWorkspaceOpen = event.detail; return; }
    selectedProjectId = event.detail.projectId || null;
    panel.open = true;
    var opened = await openPlan(event.detail.id, selectedProjectId);
    window.dispatchEvent(
      new CustomEvent("workspace-plan-opened", {
        detail: {
          id: event.detail.id,
          projectId: event.detail.projectId || null,
          opened: !!opened,
          error: el("Note").textContent
        }
      })
    );
    if (event.detail.run && plan && plan.id === event.detail.id && !dirty && !busy && !active()) el('Run').click();
  });
  panel.addEventListener('toggle', poll);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('pagehide', function () {
    disposed = true; stopPolling(); requests.forEach(function (controller) { controller.abort(); });
  });
  controls();
  operation(async function () {
    var result = await tool('list_actions', {});
    availableExecutors = result.executors || [];
    builder.configure(result);
    el('AgentExecutor').replaceChildren();
    availableExecutors.forEach(function (executor) {
      var id = typeof executor === 'string' ? executor : executor.id;
      var option = add(el('AgentExecutor'), 'option', id); option.value = id;
    });
    el('AgentTools').replaceChildren();
    [true, false].forEach(function (readOnly) {
      var group = add(el("AgentTools"), "section");
      add(group, "h4", readOnly ? "Reads only" : "Can create or change plans and workspace");
      var actions = (result.taskTools || result.actions).filter(function (action) {
        return (action.readOnly === true) === readOnly;
      });
      if (!actions.length) add(group, "p", "No tools in this group.");
      actions.forEach(function (action) {
        actionDescriptions.set(action.name, action.description);
        var label = add(group, "label");
        label.style.cssText =
          "display:flex;align-items:center;text-transform:none;letter-spacing:normal";
        var checkbox = add(label, "input");
        checkbox.type = "checkbox";
        checkbox.value = action.name;
        add(label, "span", action.name + " — " + action.description);
      });
    });
    el("Actions").textContent =
      "Direct step actions: " +
      (result.actions
        .map(function (action) {
          return action.name;
        })
        .join(", ") || "none") +
      ". Model execution: " +
      (result.modelAvailable ? "configured" : "not configured") +
      ". Agent steps can be granted " +
      (result.taskTools || result.actions).length +
      " shared tools.";
    await listPlans();
    note('Choose a saved plan or create one.');
  });
})();
</script>`;
}
