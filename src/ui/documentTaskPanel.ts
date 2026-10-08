/** Task turns share the visible history; execution and model context remain independent. */
export function documentTaskScript(): string {
  return `<script>
  (() => {
    const button = document.getElementById('documentTaskStart');
    const panel = document.getElementById('thread');
    const note = document.getElementById('documentTaskStatus');
    const rows = new Map();
    const clear = () => { for (const row of rows.values()) row.remove(); rows.clear(); };
    const order = () => {
      const sorted = [...panel.children].sort((a,b) => (a.dataset.threadTime || '').localeCompare(b.dataset.threadTime || ''));
      sorted.forEach((row,index) => { if (panel.children[index] !== row) panel.insertBefore(row,panel.children[index] || null); });
    };
    window.addEventListener('chatagent-thread-rendered', order);
    let busy = false, fingerprint = '', scopeKey = '';
    const scope = () => ({conversationId: document.getElementById('conversationId').value.trim(), userId: document.getElementById('userId').value.trim()});
    async function command(body, owner) {
      const res = await fetch('/document-tasks', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...owner,...body})});
      const data = await res.json();
      if (!res.ok) throw new Error(data.code || data.error || 'Task request failed');
      return data;
    }
    async function refresh() {
      const owner = scope(), key = JSON.stringify(owner);
      if (key !== scopeKey) { clear(); fingerprint=''; scopeKey=key; note.textContent=''; }
      if (busy || !owner.conversationId || !owner.userId) return;
      busy=true;
      try {
        const tasks = await command({op:'list'},owner);
        if (JSON.stringify(scope()) !== key) return;
        const next = JSON.stringify(tasks);
        if (next === fingerprint) return;
        fingerprint=next;
        const ids = new Set(tasks.map(task => task.taskId));
        for (const [id,row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
        for (const task of tasks) {
          let row=rows.get(task.taskId);
          if (!row) { row=document.createElement('article'); row.className='turn document-task'; row.dataset.taskId=task.taskId; rows.set(task.taskId,row); panel.append(row); }
          row.dataset.threadTime = Number.isFinite(task.createdAt) ? new Date(task.createdAt * 1000).toISOString() : row.dataset.threadTime || new Date().toISOString();
          row.replaceChildren();
          const question=document.createElement('div');question.className='bubble user';question.textContent=task.question;row.append(question);
          const reply=document.createElement('div');reply.className='bubble assistant';reply.setAttribute('aria-busy',String(['queued','running','cancel_requested'].includes(task.status)));row.append(reply);
          const title=document.createElement('strong');title.textContent='Documentation task — '+task.status;reply.append(title);
          if (task.answer) {
            const answer=document.createElement('p');answer.textContent=task.answer.answer;reply.append(answer);
            for (const cite of task.answer.citations || []) {const source=document.createElement('p');source.textContent=cite.path+':'+cite.start_line+'–'+cite.end_line;reply.append(source);}
          }
          if (task.error) {const error=document.createElement('p');error.textContent='Task failed: '+task.error;reply.append(error);}
          if (task.status==='abandoned' && task.externalOutcome==='unknown') {const unknown=document.createElement('p');unknown.textContent='Abandoned by an operator after its worker stopped. Whether it completed any work elsewhere is unknown, and no answer will be shown.';reply.append(unknown);}
          const actions=[];
          if (['queued','paused'].includes(task.status) && !task.scheduled) actions.push('resume');
          if (['queued','paused','running'].includes(task.status)) actions.push('cancel');
          for (const op of actions) {
            const action=document.createElement('button');action.type='button';action.textContent=op==='resume'?'Resume':'Cancel';
            action.onclick=async () => {action.disabled=true;try {await command({op,taskId:task.taskId},owner);fingerprint='';} catch(e) {note.textContent=e.message;} finally {action.disabled=false;void refresh();}};
            reply.append(action);
          }
        }
        order();
      } catch(e) {if (JSON.stringify(scope())===key) note.textContent=e.message;}
      finally {busy=false;}
    }
    button.onclick=async () => {
      const owner=scope(),question=document.getElementById('prompt').value.trim();
      if (!owner.conversationId || !owner.userId || !question) {note.textContent='Enter a conversation, user, and documentation question.';return;}
      button.disabled=true;
      try {await command({op:'start',requestId:crypto.randomUUID(),question},owner);if (JSON.stringify(scope())===JSON.stringify(owner)) {note.textContent='Task submitted. You can keep chatting.';const prompt=document.getElementById('prompt');if (prompt.value.trim()===question) prompt.value='';}}
      catch(e) {note.textContent=e.message;}
      finally {button.disabled=false;void refresh();}
    };
    document.getElementById('conversationId').addEventListener('change',refresh);
    document.getElementById('userId').addEventListener('change',refresh);
    const timer=setInterval(refresh,1000);window.addEventListener('pagehide',()=>clearInterval(timer));void refresh();
  })();
  </script>`;
}
