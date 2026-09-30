export const sportsChatScript = String.raw`
    function showSportsQuestion(text, info, conversationId, userId) {
      const card = document.createElement("section"); card.className = "bubble assistant";
      const title = document.createElement("h3"); title.textContent = text; card.appendChild(title);
      const context = document.createElement("p"); context.textContent = "Conversation: " + conversationId; card.appendChild(context);
      const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = info.message; card.appendChild(status);
      $("sportsQuestions").appendChild(card);
      if (!info.capabilities) return;
      const form = document.createElement("form"); form.className = "composer";
      const field = (label, placeholder, required = true) => {
        const wrapper = document.createElement("label"); wrapper.textContent = label;
        const input = document.createElement("input"); input.placeholder = placeholder; input.required = required;
        wrapper.appendChild(input); form.appendChild(wrapper); return input;
      };
      const scope = document.createElement("p"); scope.textContent = "Configured league: " + info.capabilities.league + ". Maximum window: " + info.capabilities.maxWindowHours + " hours. Leave both team fields blank for league-wide evidence."; form.appendChild(scope);
      const kindLabel = document.createElement("label"); kindLabel.textContent = "Evidence type";
      const kind = document.createElement("select");
      for (const value of ["games", "news"]) { const option = document.createElement("option"); option.value = value; option.textContent = value; kind.appendChild(option); }
      kindLabel.appendChild(kind); form.appendChild(kindLabel);
      const teamId = field("Team provider ID (optional)", "Numeric BALLDONTLIE team ID", false);
      const teamName = field("Team name (optional)", "Confirm the team name", false);
      const from = field("From, inclusive (ISO timestamp with timezone)", "2026-09-29T00:00:00-04:00");
      const to = field("To, exclusive (ISO timestamp with timezone)", "2026-09-30T00:00:00-04:00");
      const timezone = field("Timezone", "America/New_York"); timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const start = document.createElement("button"); start.type = "submit"; start.textContent = "Retrieve evidence"; form.appendChild(start);
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel retrieval"; cancel.hidden = true; card.appendChild(cancel);
      const results = document.createElement("div"); card.appendChild(form); card.appendChild(results);
      let runId = null, stopped = false;
      const post = async (path, body) => {
        const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Request failed"); return payload;
      };
      const render = run => {
        results.replaceChildren();
        for (const task of run.tasks) {
          const heading = document.createElement("h4"); heading.textContent = task.planTaskId + ": " + task.status; results.appendChild(heading);
          for (const error of task.errors) { const p = document.createElement("p"); p.textContent = "Retrieval error: " + error.code; results.appendChild(p); }
          for (const result of task.results) {
            const evidence = result.evidence;
            const label = document.createElement("p"); label.textContent = evidence.mode + " evidence · " + evidence.coverage + " coverage · freshness " + evidence.freshness + " · " + evidence.records.length + " records. " + evidence.limitations.join(", "); results.appendChild(label);
            if (!evidence.records.length) { const p = document.createElement("p"); p.textContent = "No matching records returned; this does not prove no game or news occurred."; results.appendChild(p); }
            for (const record of evidence.records) {
              const pre = document.createElement("pre"); pre.style.whiteSpace = "pre-wrap"; pre.textContent = JSON.stringify(record, null, 2); results.appendChild(pre);
              const url = record.provenance?.url;
              if (url && /^https?:\/\//i.test(url)) { const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Open original source"; results.appendChild(link); }
            }
          }
        }
        status.textContent = run.settled ? "Retrieval finished. Review each task's coverage and errors; no model recap was generated." : "Retrieving evidence. You can continue chatting.";
        cancel.hidden = run.settled; return run.settled;
      };
      const poll = async () => {
        if (stopped) return;
        try { const run = await post("/briefings", { op: "status", userId, runId }); if (!render(run)) setTimeout(poll, 1000); }
        catch (error) { status.textContent = "Status unavailable: " + error.message; }
      };
      cancel.onclick = async () => {
        try { const run = await post("/briefings", { op: "cancel", userId, runId }); stopped = true; render(run); }
        catch (error) { status.textContent = "Cancellation failed: " + error.message; }
      };
      form.onsubmit = async event => {
        event.preventDefault(); start.disabled = true;
        try {
          if (Boolean(teamId.value.trim()) !== Boolean(teamName.value.trim())) throw new Error("Provide both team ID and name, or leave both blank.");
          const team = teamId.value.trim() ? { provider: info.capabilities.league === "NFL" ? "balldontlie-nfl" : "balldontlie", id: teamId.value.trim(), name: teamName.value.trim() } : null;
          const run = await post("/sports/chat", { userId, requestId: crypto.randomUUID(), kind: kind.value, league: info.capabilities.league,
            request: { now: to.value.trim(), timezone: timezone.value.trim(), team, lastSuccessful: { league: from.value.trim(), team: from.value.trim() } } });
          runId = run.id; form.hidden = true; if (!render(run)) setTimeout(poll, 1000);
        } catch (error) { status.textContent = "Retrieval not started: " + error.message; start.disabled = false; }
      };
    }
`;
