/** The workspace is a directory of saved conversations and work, with explicit actions. */
export function workspacePanelHtml(): string {
  return `<section class="panel" id="workspacePanel" aria-label="Workspace" style="grid-column:1/-1">
  <style>#workspacePanel [hidden] {display:none!important} #workspaceConversations, #workspaceWork {max-height:24rem;overflow:auto;padding-right:.5rem} #workspaceConversations > li, #workspaceWork > li {margin-bottom:.65rem} @media (max-width:760px) {#workspaceConversations, #workspaceWork {max-height:18rem}} #workspacePanel select {font:inherit;padding:.5rem;border:1px solid var(--line);border-radius:10px;max-width:100%}</style>
  <header class="panel-header"><h1>Workspace</h1><p class="sub">Choose a project, continue a conversation, or open its work.</p></header>
  <div style="padding:1rem;display:grid;gap:.8rem">
    <div style="display:flex;gap:.6rem;align-items:end;flex-wrap:wrap">
      <label>Project<select id="workspaceProject" aria-label="Project"><option value="">All projects</option></select></label>
      <label style="display:flex;align-items:center;text-transform:none;letter-spacing:normal"><input id="workspaceArchivedProjects" type="checkbox"> Include archived projects</label>
      <button type="button" id="workspaceNewProject">New project</button>
      <button type="button" id="workspaceEditProject" disabled>Edit project</button>
      <button type="button" id="workspaceRefresh">Refresh workspace</button>
    </div>
    <p id="workspaceNote" role="status"></p><div id="workspaceErrors" role="alert"></div>
    <form id="workspaceProjectForm" hidden style="display:grid;gap:.6rem">
      <h2 id="workspaceProjectFormTitle">New project</h2>
      <label>Project name<input id="workspaceProjectName" required maxlength="200"></label>
      <label>Repository path (optional)<input id="workspaceRepositoryPath" maxlength="2000" placeholder="D:/Git/my-project"></label>
      <details><summary>Project integration</summary>
        <label>Hekate project ID (optional)<input id="workspaceHekateProject" maxlength="100"></label>
        <label>Prepared coding plan roots (one GUID per line)<textarea id="workspacePreparedRoots"></textarea></label>
        <p>Prepared plans use the configured coding host. A repository path alone does not enable execution.</p>
      </details>
      <label style="display:flex;align-items:center;text-transform:none;letter-spacing:normal"><input id="workspaceProjectArchived" type="checkbox"> Archive project</label>
      <div><button type="submit" id="workspaceSaveProject">Save project</button> <button type="button" id="workspaceCancelProject">Cancel</button></div>
    </form>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:1rem;min-width:0">
      <section aria-label="Saved conversations" style="min-width:0">
        <h2>Conversations</h2>
        <label>Search conversations<input id="workspaceSearch" type="search" maxlength="300" placeholder="Title or recent message"></label>
        <label style="display:flex;align-items:center;text-transform:none;letter-spacing:normal"><input id="workspaceArchivedConversations" type="checkbox"> Include archived conversations</label>
        <form id="workspaceConversationForm" style="display:flex;gap:.5rem;align-items:end;flex-wrap:wrap;margin:.6rem 0">
          <label>New conversation title<input id="workspaceConversationTitle" maxlength="200" placeholder="Optional title"></label>
          <button type="submit" id="workspaceNewConversation">New conversation</button>
        </form>
        <div id="workspaceSelectedConversation" hidden style="border:1px solid var(--line);padding:.6rem;border-radius:10px">
          <p id="workspaceSelectedTitle"></p>
          <form id="workspaceConversationEditForm" style="display:grid;gap:.5rem">
            <label>Conversation title<input id="workspaceEditConversationTitle" required maxlength="200"></label>
            <label>Conversation project<select id="workspaceConversationProject" aria-label="Conversation project"></select></label>
            <div><button type="submit">Save conversation</button> <button type="button" id="workspaceArchiveConversation">Archive conversation</button></div>
          </form>
        </div>
        <ul id="workspaceConversations" style="padding-left:1.2rem;overflow-wrap:anywhere"></ul>
      </section>
      <section aria-label="Project work" style="min-width:0">
        <h2>Work</h2><p id="workspaceWorkScope">Saved workflows and coding plans. Execution of coding plans requires preparation on the configured coding host.</p>
        <label style="display:flex;align-items:center;text-transform:none;letter-spacing:normal"><input id="workspaceCompletedWork" type="checkbox"> Include completed work</label>
        <ul id="workspaceWork" style="padding-left:1.2rem;overflow-wrap:anywhere"></ul>
      </section>
    </div>
  </div>
</section>`;
}

export function workspacePanelScript(): string {
  return `<script>
(function () {
  var panel = document.getElementById('workspacePanel');
  if (!panel) return;
  var snapshot = null, selectedProjectId = null, selectedConversationId = null;
  var editingProject = null, busy = false, disposed = false, requests = new Set();
  var snapshotProjectId = null, refreshPending = false, pendingRevealId = null, revealUntil = 0;
  var el = function (name) { return document.getElementById('workspace' + name); };
  function add(parent, tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node); return node;
  }
  function note(text) { el('Note').textContent = text; }
  function dispatch(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail: detail })); }
  function controls() {
    panel.querySelectorAll('button').forEach(function (button) { button.disabled = busy || button.dataset.unavailable === 'true'; });
    el('EditProject').disabled = busy || !selectedProjectId;
  }
  async function tool(name, input) {
    var controller = new AbortController(); requests.add(controller);
    var deadline = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch('/workspace/tools/' + name, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
      var text = await response.text();
      if (text.length > 1048576) throw new Error('Workspace response is too large.');
      var result;
      try { result = JSON.parse(text); } catch (_) { throw new Error('Workspace returned an invalid response.'); }
      if (!response.ok) throw new Error(result.error || 'Workspace request failed (' + response.status + ').');
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Workspace request timed out or was cancelled. Refresh to check its saved state.');
      throw error;
    } finally { clearTimeout(deadline); requests.delete(controller); }
  }
  async function operation(action) {
    if (busy || disposed) return;
    busy = true; controls();
    try { await action(); } catch (error) { note(error.message || 'Workspace request failed.'); }
    finally {
      busy = false; controls();
      if (refreshPending && !disposed) {
        refreshPending = false; setTimeout(function () { operation(refresh); }, 0);
      }
    }
  }
  function projectsSelect(select, emptyLabel, selected) {
    select.replaceChildren(new Option(emptyLabel, ''));
    snapshot.projects.forEach(function (project) {
      if (!project.archived || el('ArchivedProjects').checked || project.id === selected) {
        select.append(new Option(project.name + (project.archived ? ' (archived)' : ''), project.id));
      }
    });
    select.value = selected || '';
  }
  function selectedSummary() { return snapshot && snapshot.conversations.find(function (entry) { return entry.id === selectedConversationId; }); }
  function renderSelected() {
    var conversation = selectedSummary();
    el('SelectedConversation').hidden = !conversation;
    if (!conversation) return;
    el('SelectedTitle').textContent = 'Selected: ' + conversation.title + ' — ' + conversation.status.replace(/_/g, ' ');
    // Refreshing work does not replace an in-progress title edit.
    if (el('EditConversationTitle').dataset.conversation !== conversation.id) {
      el('EditConversationTitle').value = conversation.title;
      el('EditConversationTitle').dataset.conversation = conversation.id;
      projectsSelect(el('ConversationProject'), 'General conversation', conversation.projectId);
    }
    el('ArchiveConversation').textContent = conversation.archived ? 'Restore conversation' : 'Archive conversation';
  }
  function renderConversations() {
    var search = el('Search').value.trim().toLocaleLowerCase();
    el('Conversations').replaceChildren();
    var conversations = snapshot.conversations.filter(function (entry) {
      return (!selectedProjectId || entry.projectId === selectedProjectId) &&
        (!entry.archived || el('ArchivedConversations').checked) &&
        (!search || (entry.title + ' ' + entry.preview).toLocaleLowerCase().includes(search));
    });
    if (!conversations.length) add(el('Conversations'), 'li', 'No conversations match.');
    conversations.forEach(function (conversation) {
      var row = add(el('Conversations'), 'li'); row.dataset.conversation = conversation.id;
      var open = add(row, 'button', conversation.title); open.type = 'button';
      open.dataset.unavailable = conversation.reopenable ? 'false' : 'true'; open.disabled = !conversation.reopenable;
      open.addEventListener('click', function () { openConversation(conversation); });
      add(row, 'span', ' — ' + conversation.status.replace(/_/g, ' ') + (conversation.archived ? ' (archived)' : ''));
      if (conversation.preview) add(row, 'p', conversation.preview);
      if (!conversation.reopenable) add(row, 'p', 'This saved conversation cannot currently be reopened.');
      var archive = add(row, 'button', conversation.archived ? 'Restore' : 'Archive'); archive.type = 'button';
      archive.setAttribute('aria-label', (conversation.archived ? 'Restore ' : 'Archive ') + conversation.title);
      archive.addEventListener('click', function () { archiveConversation(conversation); });
    }); controls();
  }
  function openConversation(conversation, revealChat) {
    if (!conversation.reopenable) { note('This saved conversation cannot currently be reopened.'); return false; }
    var current = document.getElementById('conversationId').value.trim();
    if (current !== conversation.id && (document.getElementById('prompt').value.trim() || document.getElementById('sendButton').disabled)) {
      note('Send or clear the current message before switching conversations.'); return false;
    }
    selectedConversationId = conversation.id;
    pendingRevealId = revealChat === false ? null : conversation.id; revealUntil = Date.now() + 15000;
    selectedProjectId = conversation.projectId || null;
    el('Project').value = selectedProjectId || '';
    dispatch('workspace-project-selected', { projectId: selectedProjectId });
    dispatch('workspace-conversation-selected', { conversationId: conversation.id, projectId: selectedProjectId });
    renderSelected(); renderConversations(); renderWork();
    note('Opened ' + conversation.title + '.');
    if (snapshotProjectId !== selectedProjectId) requestRefresh();
    if (revealChat !== false) requestAnimationFrame(function () {
      if (disposed || pendingRevealId !== conversation.id) return;
      var chat = document.querySelector('.chat-shell');
      if (chat) chat.scrollIntoView({ block: 'start' });
    });
    return true;
  }
  function openWork(work, run) {
    var conversation = work.conversationId && snapshot.conversations.find(function (entry) { return entry.id === work.conversationId; });
    if (conversation && conversation.reopenable && !document.getElementById('prompt').value.trim() && !document.getElementById('sendButton').disabled) openConversation(conversation, false);
    if (work.kind === 'workflow') {
      if (!document.getElementById('workflowPanel')) { note('Workflow controls are not enabled on this host.'); return; }
      dispatch('workspace-open-plan', { id: work.id, projectId: work.projectId, run: run });
      document.getElementById('workflowPanel').open = true;
      document.getElementById('workflowPanel').scrollIntoView({ block: 'nearest' });
    } else {
      var root = document.getElementById('planRoot'), refresh = document.getElementById('planRefresh');
      if (!root || !refresh) { note('Prepared coding plan controls are not enabled on this host.'); return; }
      root.value = work.id; root.dispatchEvent(new Event('change'));
      document.getElementById('planStatusPanel').open = true; refresh.click();
      if (run) {
        var start = document.getElementById('planHostStart');
        if (!start) { note('The coding host has no execution controls.'); return; }
        document.getElementById('planRunControls').open = true; start.click();
      }
      root.scrollIntoView({ block: 'nearest' });
    }
  }
  function renderWork() {
    el('Work').replaceChildren();
    var work = snapshot.work.filter(function (entry) { return (!selectedProjectId || entry.projectId === selectedProjectId) && (el('CompletedWork').checked || !['done', 'completed', 'complete', 'cancelled'].includes(entry.status)); });
    if (!work.length) add(el('Work'), 'li', 'No saved work in this selection.');
    work.forEach(function (entry) {
      var row = add(el('Work'), 'li'); row.dataset.work = entry.id;
      add(row, 'strong', entry.name + ' — ' + entry.status.replace(/_/g, ' '));
      add(row, 'p', entry.kind === 'coding' ? (entry.prepared ? 'Prepared coding plan' : 'Coding plan') : 'Workflow');
      if (entry.nextStep) add(row, 'p', 'Next: ' + (typeof entry.nextStep === 'string' ? entry.nextStep : entry.nextStep.name + ' — ' + entry.nextStep.status.replace(/_/g, ' ')));
      if (entry.error) add(row, 'p', entry.error);
      var open = add(row, 'button', 'Open'); open.type = 'button'; open.addEventListener('click', function () { openWork(entry, false); });
      var canRun = entry.kind === 'workflow' ? !!document.getElementById('workflowPanel') : entry.prepared === true && !!document.getElementById('planHostStart');
      if (entry.kind === 'coding' && !entry.prepared) add(row, 'p', 'Execution unavailable');
      if (canRun) {
        var run = add(row, 'button', 'Run'); run.type = 'button';
        run.addEventListener('click', function () { openWork(entry, true); });
      }
    }); controls();
  }
  async function refresh() {
    var scope = selectedProjectId;
    var next = await tool('get_workspace', scope ? { projectId: scope } : {});
    if (disposed) return;
    snapshot = next; snapshotProjectId = scope;
    if (selectedProjectId && !snapshot.projects.some(function (entry) { return entry.id === selectedProjectId; })) selectedProjectId = null;
    projectsSelect(el('Project'), 'All projects', selectedProjectId);
    el('Errors').replaceChildren();
    (snapshot.errors || []).forEach(function (error) { add(el('Errors'), 'p', error.message); });
    renderSelected(); renderConversations(); renderWork();
    note((snapshot.persistenceEnabled ? 'Workspace saved on this host.' : 'Workspace storage is temporary on this host.') + (snapshot.truncated ? ' More work exists than this view can show; choose a project to narrow the list.' : ''));
  }
  function projectForm(project) {
    editingProject = project || null;
    el('ProjectForm').reset(); el('ProjectForm').hidden = false;
    el('ProjectFormTitle').textContent = project ? 'Edit project' : 'New project';
    el('ProjectName').value = project ? project.name : '';
    el('RepositoryPath').value = project && project.repositoryPath || '';
    el('HekateProject').value = project && project.hekateProjectId || '';
    el('HekateProject').disabled = !!(project && project.hekateProjectId);
    el('PreparedRoots').value = project ? project.preparedPlanRoots.join('\\n') : '';
    el('ProjectArchived').checked = !!(project && project.archived);
    el('ProjectName').focus();
  }
  el('Project').addEventListener('change', function () {
    selectedProjectId = el('Project').value || null;
    dispatch('workspace-project-selected', { projectId: selectedProjectId });
    renderConversations(); renderWork(); controls(); requestRefresh();
  });
  el('ArchivedProjects').addEventListener('change', function () { projectsSelect(el('Project'), 'All projects', selectedProjectId); });
  el('ArchivedConversations').addEventListener('change', renderConversations);
  el('CompletedWork').addEventListener('change', renderWork);
  el('Search').addEventListener('input', renderConversations);
  function requestRefresh() { if (busy) refreshPending = true; else operation(refresh); }
  el('Refresh').addEventListener('click', requestRefresh);
  el('NewProject').addEventListener('click', function () { projectForm(null); });
  el('EditProject').addEventListener('click', function () { projectForm(snapshot.projects.find(function (entry) { return entry.id === selectedProjectId; })); });
  el('CancelProject').addEventListener('click', function () { el('ProjectForm').hidden = true; });
  el('ProjectForm').addEventListener('submit', function (event) {
    event.preventDefault(); operation(async function () {
      var input = { name: el('ProjectName').value.trim(), repositoryPath: el('RepositoryPath').value.trim() || undefined,
        hekateProjectId: el('HekateProject').value.trim() || undefined,
        preparedPlanRoots: el('PreparedRoots').value.split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean), archived: el('ProjectArchived').checked };
      if (editingProject) { input.id = editingProject.id; input.revision = editingProject.revision; input.archived = el('ProjectArchived').checked; }
      var project = await tool(editingProject ? 'update_project' : 'register_project', input);
      selectedProjectId = project.id; el('ProjectForm').hidden = true;
      await refresh(); dispatch('workspace-project-selected', { projectId: selectedProjectId }); note('Project saved.');
    });
  });
  async function createConversation() {
    var input = { title: el('ConversationTitle').value.trim() || undefined };
    if (selectedProjectId) input.projectId = selectedProjectId;
    var conversation = await tool('create_conversation', input);
    el('ConversationTitle').value = ''; await refresh(); openConversation(conversation);
    document.getElementById('prompt').focus();
  }
  el('ConversationForm').addEventListener('submit', function (event) { event.preventDefault(); operation(createConversation); });
  window.addEventListener('workspace-new-conversation', function () { operation(createConversation); });
  el('ConversationEditForm').addEventListener('submit', function (event) {
    event.preventDefault(); operation(async function () {
      var conversation = await tool('update_conversation', { id: selectedConversationId, title: el('EditConversationTitle').value.trim(), projectId: el('ConversationProject').value || null });
      await refresh(); openConversation(conversation, false); note('Conversation saved.');
    });
  });
  function archiveConversation(conversation) {
    if (!conversation) return;
    operation(async function () {
      await tool('update_conversation', { id: conversation.id, archived: !conversation.archived });
      await refresh(); note(conversation.archived ? 'Conversation restored.' : 'Conversation archived.');
    });
  }
  el('ArchiveConversation').addEventListener('click', function () { archiveConversation(selectedSummary()); });
  window.addEventListener('workspace-conversation-rendered', function (event) {
    if (!event.detail || event.detail.conversationId !== pendingRevealId) return;
    var id = pendingRevealId; pendingRevealId = null;
    if (Date.now() > revealUntil) return;
    requestAnimationFrame(function () {
      if (disposed || selectedConversationId !== id || document.getElementById('conversationId').value.trim() !== id) return;
      var target = document.querySelector('#thread .turn') || document.getElementById('composer');
      if (target) target.scrollIntoView({ block: 'start' });
    });
  });
  window.addEventListener('workspace-work-changed', requestRefresh);
  window.addEventListener('pagehide', function () { disposed = true; requests.forEach(function (request) { request.abort(); }); });
  operation(async function () {
    await refresh();
    try {
      var saved = JSON.parse(sessionStorage.getItem('chatagent-active-conversation') || 'null');
      if (saved && saved.workspaceConversationId === saved.conversationId) {
        var conversation = snapshot.conversations.find(function (entry) { return entry.id === saved.conversationId; });
        if (conversation && conversation.reopenable && !document.getElementById('prompt').value.trim() && !document.getElementById('sendButton').disabled) openConversation(conversation);
      }
    } catch (_) {}
  });
})();
</script>`;
}
