/** Creation form emits the same version-one plan accepted by the shared workflow tools. */
export function workflowBuilderHtml(): string {
  return `<form id="workflowBuilder" hidden novalidate>
    <h3>Describe the work</h3>
    <p id="workflowBuilderScope" hidden></p>
    <p id="workflowBuilderStatus" role="status" aria-live="polite"></p>
    <label for="workflowBuilderName">Name</label>
    <input id="workflowBuilderName" maxlength="200" required />
    <label for="workflowBuilderGoal">Goal (optional)</label>
    <textarea id="workflowBuilderGoal" rows="2" maxlength="4000"></textarea>
    <div id="workflowBuilderSteps"></div>
    <button type="button" id="workflowBuilderAdd">Add step</button>
    <details><summary>Plan JSON</summary><pre id="workflowBuilderPreview" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:16rem;overflow:auto"></pre></details>
    <p>Steps run in order. Large inputs or results may exceed execution limits. Tool inputs are checked when each step runs.</p>
    <button type="submit" id="workflowBuilderSave">Save workflow</button>
    <button type="button" id="workflowBuilderAdvanced">Advanced: edit plan JSON</button>
  </form>`;
}

/** This factory is inserted inside the existing controller; callbacks retain its scopes and guards. */
export function workflowBuilderScript(): string {
  return String.raw`
function createWorkflowBuilder(options) {
  var form = document.getElementById("workflowBuilder");
  var list = document.getElementById("workflowBuilderSteps");
  var payload = { actions: [], executors: [], modelAvailable: false },
    serial = 0,
    busy = false;
  function field(row, name) {
    return row.querySelector('[data-field="' + name + '"]');
  }
  function node(parent, tag, text) {
    var element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent.append(element);
    return element;
  }
  function input(parent, row, name, label, tag, max) {
    var elementId = "workflowBuilderStep" + row.dataset.key + "-" + name;
    var labelElement = node(parent, "label", label);
    labelElement.htmlFor = elementId;
    var element = node(parent, tag || "input");
    element.id = elementId;
    element.dataset.field = name;
    if (max) element.maxLength = max;
    if (element.tagName === "TEXTAREA") element.rows = 3;
    return element;
  }
  function checkbox(parent, row, name, label) {
    var labelElement = node(parent, "label");
    var element = node(labelElement, "input");
    element.type = "checkbox";
    element.dataset.field = name;
    element.id = "workflowBuilderStep" + row.dataset.key + "-" + name;
    node(labelElement, "span", label);
    return element;
  }
  function rows() {
    return Array.from(list.children);
  }
  function ids() {
    var used = new Set();
    return rows().map(function (row) {
      var base = field(row, "name")
        .value.trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-");
      if (!/^[a-z]/.test(base)) base = "step-" + base;
      base = base.slice(0, 64);
      var id = base,
        suffix = 1;
      while (used.has(id)) {
        var ending = "-" + ++suffix;
        id = base.slice(0, 64 - ending.length) + ending;
      }
      used.add(id);
      return id;
    });
  }
  function modelPolicy() {
    if (!payload.modelAvailable) return { mode: "unconfigured" };
    var policy = payload.model;
    if (policy && policy.mode === "catalog") return policy;
    if (
      policy &&
      policy.mode === "fixed" &&
      typeof policy.provider === "string" &&
      policy.provider.trim() &&
      typeof policy.model === "string" &&
      policy.model.trim()
    )
      return policy;
    return { mode: "unknown" };
  }
  function modelLabel() {
    var policy = modelPolicy();
    return policy.mode === "fixed"
      ? "Model · " + policy.model + " (" + policy.provider + ")"
      : policy.mode === "catalog"
        ? "Model · chosen per run from catalog"
        : policy.mode === "unknown"
          ? "Model · configured, identity not reported"
          : "Model · No model is configured";
  }
  function modelNote() {
    var mode = modelPolicy().mode;
    return mode === "fixed"
      ? "Runs on the server's configured model. The model selected in chat does not apply."
      : mode === "catalog"
        ? "The server picks an eligible catalog model when the step runs. The chosen model is recorded in the step output."
        : mode === "unknown"
          ? "Identity is not reported before the run; see the step output afterwards."
          : "No model is configured for workflow steps.";
  }
  function actors(row) {
    var select = field(row, "actor"),
      previous = select.value;
    select.replaceChildren();
    function choice(value, label, disabled, parent) {
      var option = node(parent || select, "option", label);
      option.value = value;
      option.disabled = !!disabled;
    }
    choice("human", "You");
    choice("model", modelLabel(), !payload.modelAvailable);
    payload.executors.forEach(function (executor) {
      var id = typeof executor === "string" ? executor : executor.id;
      choice("agent:" + id, "Agent · " + id);
    });
    if (payload.actions.length) {
      var direct = node(select, "optgroup");
      direct.label = "Configured API actions, run directly as a step";
      payload.actions.forEach(function (action) {
        choice("tool:" + action.name, "Tool " + action.name, false, direct);
      });
    }
    select.value = Array.from(select.options).some(function (option) {
      return option.value === previous && !option.disabled;
    })
      ? previous
      : "human";
    var tools = field(row, "tools"),
      checked = new Set(
        Array.from(tools.querySelectorAll("input:checked")).map(function (box) {
          return box.value;
        })
      );
    tools.replaceChildren();
    [true, false].forEach(function (readOnly) {
      var group = node(tools, "section");
      node(group, "h5", readOnly ? "Reads only" : "Can create or change plans and workspace");
      var actions = (payload.taskTools || payload.actions).filter(function (action) {
        return (action.readOnly === true) === readOnly;
      });
      if (!actions.length) node(group, "p", "No tools in this group.");
      actions.forEach(function (action) {
        var label = node(group, "label"),
          box = node(label, "input");
        box.type = "checkbox";
        box.value = action.name;
        box.checked = checked.has(action.name);
        node(label, "span", action.name + " — " + action.description);
      });
    });
  }
  function actorView(row, index) {
    var actor = field(row, "actor").value,
      tool = actor.startsWith("tool:"),
      agent = actor.startsWith("agent:");
    field(row, "whatLabel").textContent = agent
      ? "Objective"
      : actor === "model"
        ? "Prompt"
        : "Instructions";
    field(row, "whatGroup").hidden = tool;
    field(row, "agentDetails").hidden = !agent;
    field(row, "modelNote").hidden = actor !== "model";
    field(row, "modelNote").textContent = modelNote();
    field(row, "toolGroup").hidden = !tool;
    field(row, "previousGroup").hidden = tool || index === 0;
    field(row, "approvalGroup").hidden = actor !== "human";
    field(row, "what").maxLength = actor === "human" ? 4000 : 16000;
    if (tool) {
      var action = payload.actions.find(function (action) {
        return action.name === actor.slice(5);
      });
      field(row, "toolDescription").textContent = action ? action.description : "";
      field(row, "schema").textContent = JSON.stringify(action ? action.inputSchema : {}, null, 2);
    }
  }
  function path(value, label) {
    if (
      value.split(".").some(function (part) {
        return !part || ["__proto__", "prototype", "constructor"].includes(part);
      })
    )
      throw new Error(label + " must use a valid dot path with no empty segments.");
  }
  function bindings(value, earlier, stepId, depth) {
    if (depth > 32) throw new Error("Step " + stepId + " inputs are nested too deeply.");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(function (item) {
        bindings(item, earlier, stepId, depth + 1);
      });
      return;
    }
    if (Object.hasOwn(value, "$step")) {
      if (
        typeof value.$step !== "string" ||
        Object.keys(value).some(function (key) {
          return key !== "$step" && key !== "path";
        }) ||
        (value.path !== undefined && typeof value.path !== "string")
      )
        throw new Error("Step " + stepId + " has a malformed step binding.");
      if (!earlier.has(value.$step))
        throw new Error(
          "Step " + stepId + " references " + value.$step + " which is not an earlier step."
        );
      if (value.path) path(value.path, "Step " + stepId + " binding path");
      return;
    }
    Object.entries(value).forEach(function (entry) {
      if (["__proto__", "prototype", "constructor"].includes(entry[0]))
        throw new Error("Step " + stepId + " inputs contain a forbidden key.");
      bindings(entry[1], earlier, stepId, depth + 1);
    });
  }
  function required(value, label, max, validate) {
    if (validate !== false && (!value.trim() || value.length > max))
      throw new Error(label + " must contain 1–" + max + " characters.");
    return value.trim();
  }
  function definition(validate) {
    var name = required(
      document.getElementById("workflowBuilderName").value,
      "Workflow name",
      200,
      validate
    );
    var goal = document.getElementById("workflowBuilderGoal").value;
    if (goal.length > 4000) throw new Error("Goal must contain at most 4000 characters.");
    var stepIds = ids(),
      earlier = new Set(),
      all = rows();
    if (!all.length || all.length > 50) throw new Error("A workflow needs 1–50 steps.");
    var steps = all.map(function (row, index) {
      var id = stepIds[index],
        actor = field(row, "actor").value;
      var result = {
        id: id,
        name: required(field(row, "name").value, "Step name", 200, validate),
        inputs: {},
        timeoutMs: 120000
      };
      if (actor.startsWith("tool:")) {
        var toolName = actor.slice(5);
        if (
          !payload.actions.some(function (action) {
            return action.name === toolName;
          })
        )
          throw new Error("Step " + id + " requires a registered tool.");
        try {
          result.inputs = JSON.parse(field(row, "inputs").value);
        } catch (_) {
          throw new Error("Step " + id + " inputs must be valid JSON.");
        }
        if (!result.inputs || typeof result.inputs !== "object" || Array.isArray(result.inputs))
          throw new Error("Step " + id + " inputs must be a JSON object.");
        if (validate !== false) bindings(result.inputs, earlier, id, 0);
        result.action = { type: "tool", tool: toolName };
      } else {
        var what = required(
          field(row, "what").value,
          "Step " +
            id +
            " " +
            (actor === "human" ? "instructions" : actor === "model" ? "prompt" : "objective"),
          actor === "human" ? 4000 : 16000,
          validate
        );
        if (actor === "human") result.action = { type: "human", instructions: what };
        else if (actor === "model") {
          if (!payload.modelAvailable) throw new Error("No model is configured.");
          result.action = { type: "model", prompt: what };
        } else if (actor.startsWith("agent:")) {
          var executor = actor.slice(6);
          if (
            !payload.executors.some(function (item) {
              return (typeof item === "string" ? item : item.id) === executor;
            })
          )
            throw new Error("This agent executor is not configured.");
          var criteria = field(row, "criteria")
            .value.split(/\r?\n/)
            .map(function (line) {
              return line.trim();
            })
            .filter(Boolean);
          if (
            validate !== false &&
            (!criteria.length ||
              criteria.length > 10 ||
              criteria.some(function (item) {
                return item.length > 2000;
              }))
          )
            throw new Error(
              "Step " + id + " needs 1–10 completion criteria of at most 2000 characters each."
            );
          var turns = Number(field(row, "turns").value);
          if (!Number.isInteger(turns) || turns < 1 || turns > 30)
            throw new Error("Maximum agent turns must be 1–30.");
          if (field(row, "tools").querySelectorAll("input:checked").length > 30)
            throw new Error("An agent may use at most 30 tools.");
          result.action = {
            type: "agent",
            executor: executor,
            task: {
              objective: what,
              context: "",
              references: [],
              tools: Array.from(field(row, "tools").querySelectorAll("input:checked")).map(
                function (box) {
                  return box.value;
                }
              ),
              completionCriteria: criteria,
              limits: { maxTurns: turns }
            }
          };
          result.timeoutMs = 300000;
        } else throw new Error("Choose who does step " + id + ".");
        if (index && field(row, "previous").checked)
          result.inputs[stepIds[index - 1]] = { $step: stepIds[index - 1] };
      }
      var resultPath = field(row, "path").value.trim(),
        equals = field(row, "equals").value;
      if (resultPath || equals.trim()) {
        if (!resultPath && validate !== false)
          throw new Error(
            "Step " +
              id +
              " needs a result path when Equals is set. Whole-output checks are available in Advanced JSON."
          );
        if (resultPath.length > 200)
          throw new Error("Result path must contain at most 200 characters.");
        if (resultPath) path(resultPath, "Result path");
        var expected;
        try {
          expected = JSON.parse(equals);
        } catch (_) {
          throw new Error("Step " + id + " Equals must be valid JSON.");
        }
        result.success = { path: resultPath, equals: expected };
      }
      earlier.add(id);
      return result;
    });
    return { version: 1, name: name, description: goal, steps: steps };
  }
  function update() {
    var all = rows(),
      stepIds = ids();
    all.forEach(function (row, index) {
      field(row, "heading").textContent = "Step " + (index + 1);
      field(row, "id").textContent = "Saved as " + stepIds[index];
      field(row, "up").disabled = busy || index === 0;
      field(row, "down").disabled = busy || index === all.length - 1;
      field(row, "remove").disabled = busy || all.length === 1;
      field(row, "hint").textContent =
        'To pass an earlier result, set a value to {"$step":"<id>"} or add "path":"a.b" for one field. Earlier step ids: ' +
        (stepIds.slice(0, index).join(", ") || "none") +
        ".";
      actorView(row, index);
    });
    document.getElementById("workflowBuilderAdd").disabled = busy || all.length >= 50;
    try {
      document.getElementById("workflowBuilderPreview").textContent = JSON.stringify(
        definition(),
        null,
        2
      );
    } catch (error) {
      document.getElementById("workflowBuilderPreview").textContent =
        "Finish the form to preview the exact plan. " + error.message;
    }
  }
  function changed() {
    options.dirty();
    update();
  }
  function step() {
    var row = node(list, "section");
    row.className = "workflow-builder-step";
    row.dataset.key = ++serial;
    var heading = node(row, "h4");
    heading.dataset.field = "heading";
    input(row, row, "name", "Step name", "input", 200);
    node(row, "small").dataset.field = "id";
    input(row, row, "actor", "Who does it", "select");
    var whatGroup = node(row, "div");
    whatGroup.dataset.field = "whatGroup";
    var what = input(whatGroup, row, "what", "Instructions", "textarea", 4000);
    what.previousElementSibling.dataset.field = "whatLabel";
    node(row, "p").dataset.field = "modelNote";
    var agent = node(row, "details");
    agent.dataset.field = "agentDetails";
    node(agent, "summary", "Agent details");
    var toolChoices = node(agent, "fieldset");
    node(toolChoices, "legend", "Tools this agent may use");
    node(
      toolChoices,
      "p",
      "Checked tools are granted when the run starts. During the run the agent can ask you for any other listed tool, and you approve or decline each request."
    );
    node(toolChoices, "div").dataset.field = "tools";
    input(agent, row, "criteria", "Completion criteria (one per line)", "textarea");
    var turns = input(agent, row, "turns", "Maximum agent turns");
    turns.type = "number";
    turns.min = 1;
    turns.max = 30;
    turns.value = 12;
    var toolGroup = node(row, "div");
    toolGroup.dataset.field = "toolGroup";
    node(toolGroup, "p").dataset.field = "toolDescription";
    var schema = node(toolGroup, "details");
    node(schema, "summary", "Accepted inputs schema");
    node(schema, "pre").dataset.field = "schema";
    input(toolGroup, row, "inputs", "Inputs (JSON object)", "textarea").value = "{}";
    node(
      toolGroup,
      "p",
      "This step calls the configured API action directly. Inputs are checked when the step runs, not when the plan is saved. Plan and workspace tools are not direct steps. An agent step can use them."
    );
    node(toolGroup, "p").dataset.field = "hint";
    var previous = node(row, "div");
    previous.dataset.field = "previousGroup";
    checkbox(previous, row, "previous", "Use the previous step's result").checked = true;
    var success = node(row, "details");
    node(success, "summary", "Done when (optional)");
    var approval = node(success, "div");
    approval.dataset.field = "approvalGroup";
    checkbox(approval, row, "approval", "Requires approval").addEventListener(
      "change",
      function (event) {
        if (event.target.checked) {
          field(row, "path").value = "approved";
          field(row, "equals").value = "true";
        } else if (field(row, "path").value === "approved" && field(row, "equals").value === "true") {
          field(row, "path").value = "";
          field(row, "equals").value = "";
        }
      }
    );
    input(success, row, "path", "Result path", "input", 200);
    input(success, row, "equals", "Equals (JSON)", "input");
    var ordering = node(row, "div");
    ordering.className = "workflow-builder-order";
    [
      ["up", "Move up"],
      ["down", "Move down"],
      ["remove", "Remove step"]
    ].forEach(function (pair) {
      var button = node(ordering, "button", pair[1]);
      button.type = "button";
      button.dataset.field = pair[0];
      button.addEventListener("click", function () {
        if (pair[0] === "up" && row.previousElementSibling)
          list.insertBefore(row, row.previousElementSibling);
        if (pair[0] === "down" && row.nextElementSibling)
          list.insertBefore(row.nextElementSibling, row);
        if (pair[0] === "remove" && rows().length > 1) row.remove();
        changed();
      });
    });
    actors(row);
    return row;
  }
  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  document.getElementById("workflowBuilderAdd").addEventListener("click", function () {
    if (rows().length < 50) {
      step();
      changed();
    }
  });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (busy) return;
    try {
      options.save(definition());
    } catch (error) {
      options.note(error.message);
    }
  });
  document.getElementById("workflowBuilderAdvanced").addEventListener("click", function () {
    try {
      options.advanced(definition(false));
    } catch (error) {
      options.note(error.message);
    }
  });
  return {
    configure: function (actions) {
      payload = actions;
      rows().forEach(actors);
      update();
    },
    reset: function () {
      form.reset();
      list.replaceChildren();
      step();
      form.hidden = false;
      update();
    },
    setBusy: function (value) {
      busy = value;
      form.querySelectorAll("input, textarea, select, button").forEach(function (element) {
        element.disabled = busy;
      });
      update();
    },
    hide: function () {
      form.hidden = true;
    }
  };
}
`;
}
