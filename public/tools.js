/* CRM tools UI: tasks, deals pipeline, reports, email templates, CSV export.
   Loaded before app.js; uses its helpers ($, api, esc, fmt, toast, clients, settings, modal functions) at call time. */

const money = v => (settings.currency || '') + Number(v || 0).toLocaleString('en-IN');
const dayOf = d => (d && d.length === 10 ? d + 'T00:00' : d);
const fmtDay = d => d ? new Date(dayOf(d)).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const clientName = id => (clients.find(c => c.id === id) || {}).name || '';
const clientOptions = sel => `<option value="">- none -</option>` + clients.slice().sort((a, b) => a.name.localeCompare(b.name))
  .map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}${c.company ? ' (' + esc(c.company) + ')' : ''}</option>`).join('');
const exportBtn = what => `<a class="btn" href="/api/export/${what}.csv" download>Export ${what} (CSV)</a>`;
const barRow = (label, val, max, text) => `<div class="bar"><label>${label}</label><div class="track"><div class="fill" style="width:${max ? val / max * 100 : 0}%"></div></div><b style="width:auto;min-width:28px">${text ?? val}</b></div>`;
const pct = x => Math.round((x || 0) * 100) + '%';

// ======================= TASKS =======================
const PRIORITY = { high: 'High', normal: 'Normal', low: 'Low' };
let taskFilter = 'open';

async function renderTasks() {
  const all = await api('/tasks');
  const q = $('#search').value.toLowerCase();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const flt = {
    open: t => !t.done, today: t => !t.done && t.dueAt && new Date(dayOf(t.dueAt)) <= endToday,
    overdue: t => !t.done && t.dueAt && new Date(dayOf(t.dueAt)) < new Date(), done: t => t.done, all: () => true
  };
  let rows = all.filter(flt[taskFilter] || flt.open);
  if (q) rows = rows.filter(t => (t.title + ' ' + clientName(t.clientId)).toLowerCase().includes(q));
  const rank = { high: 0, normal: 1, low: 2 };
  rows.sort((a, b) => taskFilter === 'done' ? (b.doneAt || '').localeCompare(a.doneAt || '') : (a.dueAt || '9').localeCompare(b.dueAt || '9') || rank[a.priority] - rank[b.priority]);
  const n = k => all.filter(flt[k]).length;
  $('#view').innerHTML = `<div class="toolbar">
    <select onchange="taskFilter=this.value;renderTasks()">${[['open', 'Open'], ['today', 'Due today / overdue'], ['overdue', 'Overdue'], ['done', 'Done'], ['all', 'All']]
      .map(([k, l]) => `<option value="${k}" ${taskFilter === k ? 'selected' : ''}>${l} (${n(k)})</option>`).join('')}</select>
    <button class="btn primary" onclick="openTask()">+ Add task</button>${exportBtn('tasks')}
  </div>
  <div class="table-wrap"><table><thead><tr><th style="width:36px"></th><th>Task</th><th>Client</th><th>Due</th><th>Priority</th><th></th></tr></thead><tbody>
  ${rows.map(t => `<tr class="${t.done ? 'done-row' : ''}">
    <td><input type="checkbox" style="width:auto" ${t.done ? 'checked' : ''} onchange="toggleTask('${t.id}',this.checked)"></td>
    <td><b>${esc(t.title)}</b>${t.notes ? `<br><small style="color:var(--muted)">${esc(t.notes).slice(0, 100)}</small>` : ''}</td>
    <td>${t.clientId && clientName(t.clientId) ? `<a href="javascript:openClient('${t.clientId}')">${esc(clientName(t.clientId))}</a>` : '-'}</td>
    <td class="${!t.done && t.dueAt && new Date(dayOf(t.dueAt)) < new Date() ? 'late' : ''}">${t.dueAt ? (t.dueAt.length === 10 ? fmtDay(t.dueAt) : fmt(t.dueAt)) : '-'}</td>
    <td><span class="badge p-${t.priority}">${PRIORITY[t.priority]}</span></td>
    <td><button class="btn small" onclick="openTask('${t.id}')">Edit</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No tasks here.</td></tr>'}
  </tbody></table></div>`;
}

async function toggleTask(id, done) {
  await api('/tasks/' + id, 'PUT', { done });
  if (page === 'tasks') renderTasks();
  renderNav();
}

async function openTask(id, clientId) {
  const t = id ? (await api('/tasks')).find(x => x.id === id) : { priority: 'normal', clientId: clientId || '' };
  if (!t) return toast('Task not found');
  $('#modalBox').innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
    <h2 style="margin:0">${id ? 'Edit task' : 'New task'}</h2>
    <button class="btn small" onclick="closeModal()" title="Close" style="border:0;background:transparent;font-size:22px;cursor:pointer;color:var(--muted);padding:0 6px;line-height:1">&times;</button>
  </div>
  <div class="form">
    <div class="full"><label>Task *</label><input id="t_title" value="${esc(t.title)}" placeholder="e.g. Send quotation to Amit"></div>
    <div><label>Client</label><select id="t_client">${clientOptions(t.clientId)}</select></div>
    <div><label>Priority</label><select id="t_prio">${Object.keys(PRIORITY).map(k => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${PRIORITY[k]}</option>`).join('')}</select></div>
    <div class="full"><label>Due</label><input type="datetime-local" id="t_due" value="${toLocalInput(t.dueAt)}"></div>
    <div class="full"><label>Notes</label><textarea id="t_notes" style="min-height:70px">${esc(t.notes)}</textarea></div>
  </div>
  <div class="actions">${id ? `<button class="btn danger" onclick="delTask('${id}')">Delete</button>` : ''}
    <button class="btn" onclick="closeModal()">Close</button><button class="btn primary" onclick="saveTask('${id || ''}')">Save</button></div>`;
  $('#modal').classList.remove('hidden');
}
async function saveTask(id) {
  const body = {
    title: $('#t_title').value.trim(), clientId: $('#t_client').value, priority: $('#t_prio').value, notes: $('#t_notes').value,
    dueAt: $('#t_due').value ? new Date($('#t_due').value).toISOString() : ''
  };
  if (!body.title) return toast('Task title is required');
  const r = await api(id ? '/tasks/' + id : '/tasks', id ? 'PUT' : 'POST', body);
  if (r.error) return toast(r.error);
  closeModal(); toast('Task saved'); render();
}
async function delTask(id) {
  if (!confirm('Delete this task?')) return;
  await api('/tasks/' + id, 'DELETE'); closeModal(); render();
}

// ======================= DEALS =======================
const DEAL_STAGES = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
const dealOverdue = d => !['won', 'lost'].includes(d.stage) && d.expectedClose && new Date(d.expectedClose.length === 10 ? d.expectedClose + 'T23:59:59' : d.expectedClose) < new Date();

async function renderDeals() {
  const all = await api('/deals');
  const q = $('#search').value.toLowerCase();
  const deals = q ? all.filter(d => (d.title + ' ' + clientName(d.clientId)).toLowerCase().includes(q)) : all;
  const open = all.filter(d => !['won', 'lost'].includes(d.stage));
  $('#view').innerHTML = `<div class="toolbar">
    <button class="btn primary" onclick="openDeal()">+ New deal</button>${exportBtn('deals')}
    <span style="color:var(--muted)">${open.length} open deal(s) worth <b>${money(open.reduce((n, d) => n + d.value, 0))}</b> &middot; drag cards between columns to move them</span></div>
  <div class="board">${Object.keys(DEAL_STAGES).map(s => {
    const ds = deals.filter(d => d.stage === s).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return `<div class="col col-${s}" ondragover="event.preventDefault();this.classList.add('over')" ondragleave="this.classList.remove('over')" ondrop="dropDeal(event,'${s}')">
      <h4>${DEAL_STAGES[s]} <span>${ds.length} &middot; ${money(ds.reduce((n, d) => n + d.value, 0))}</span></h4>
      ${ds.map(d => `<div class="deal" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','${d.id}')" onclick="openDeal('${d.id}')">
        <b>${esc(d.title)}</b><div>${money(d.value)}</div>
        <small>${esc(clientName(d.clientId) || 'No client')}</small>
        ${d.expectedClose ? `<small class="${dealOverdue(d) ? 'late' : ''}">Close: ${fmtDay(d.expectedClose)}</small>` : ''}
      </div>`).join('') || '<div class="empty">-</div>'}</div>`;
  }).join('')}</div>`;
}
async function dropDeal(e, stage) {
  e.preventDefault(); e.currentTarget.classList.remove('over');
  const id = e.dataTransfer.getData('text/plain'); if (!id) return;
  const r = await api('/deals/' + id, 'PUT', { stage });
  if (r.error) return toast(r.error);
  renderDeals();
}

async function openDeal(id, clientId) {
  const d = id ? (await api('/deals')).find(x => x.id === id) : { stage: 'lead', clientId: clientId || '', value: '' };
  if (!d) return toast('Deal not found');
  $('#modalBox').innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
    <h2 style="margin:0">${id ? 'Edit deal' : 'New deal'}</h2>
    <button class="btn small" onclick="closeModal()" title="Close" style="border:0;background:transparent;font-size:22px;cursor:pointer;color:var(--muted);padding:0 6px;line-height:1">&times;</button>
  </div>
  <div class="form">
    <div class="full"><label>Deal title *</label><input id="d_title" value="${esc(d.title)}" placeholder="e.g. Website redesign - ABC Traders"></div>
    <div><label>Client</label><select id="d_client">${clientOptions(d.clientId)}</select></div>
    <div><label>Value (${esc(settings.currency || '')})</label><input id="d_value" type="number" min="0" step="any" value="${esc(d.value)}"></div>
    <div><label>Stage</label><select id="d_stage">${Object.keys(DEAL_STAGES).map(k => `<option value="${k}" ${d.stage === k ? 'selected' : ''}>${DEAL_STAGES[k]}</option>`).join('')}</select></div>
    <div><label>Expected close date</label><input id="d_close" type="date" value="${esc((d.expectedClose || '').slice(0, 10))}"></div>
    <div class="full"><label>Reason lost (only used when stage is Lost)</label><input id="d_lost" value="${esc(d.lostReason)}"></div>
    <div class="full"><label>Notes</label><textarea id="d_notes" style="min-height:70px">${esc(d.notes)}</textarea></div>
  </div>
  <div class="actions">${id ? `<button class="btn danger" onclick="delDeal('${id}')">Delete</button>` : ''}
    <button class="btn" onclick="closeModal()">Close</button><button class="btn primary" onclick="saveDeal('${id || ''}')">Save</button></div>`;
  $('#modal').classList.remove('hidden');
}
async function saveDeal(id) {
  const body = {
    title: $('#d_title').value.trim(), clientId: $('#d_client').value, value: $('#d_value').value || 0, stage: $('#d_stage').value,
    expectedClose: $('#d_close').value, lostReason: $('#d_lost').value, notes: $('#d_notes').value
  };
  if (!body.title) return toast('Deal title is required');
  const r = await api(id ? '/deals/' + id : '/deals', id ? 'PUT' : 'POST', body);
  if (r.error) return toast(r.error);
  closeModal(); toast('Deal saved'); render();
}
async function delDeal(id) {
  if (!confirm('Delete this deal?')) return;
  await api('/deals/' + id, 'DELETE'); closeModal(); render();
}

// Tasks + deals for one client, shown inside the client modal
async function clientExtras(id) {
  const [tasks, deals] = await Promise.all([api('/tasks'), api('/deals')]);
  const ts = tasks.filter(t => t.clientId === id && !t.done), ds = deals.filter(d => d.clientId === id);
  return `<div class="timeline"><b>Tasks</b> <button class="btn small" onclick="openTask('', '${id}')">+ Task</button>
    ${ts.map(t => `<div><a href="javascript:openTask('${t.id}')">${esc(t.title)}</a> <small>${t.dueAt ? 'due ' + (t.dueAt.length === 10 ? fmtDay(t.dueAt) : fmt(t.dueAt)) : ''}</small></div>`).join('') || '<div class="empty">No open tasks.</div>'}
    <div style="margin-top:12px"><b>Deals</b> <button class="btn small" onclick="openDeal('', '${id}')">+ Deal</button></div>
    ${ds.map(d => `<div><a href="javascript:openDeal('${d.id}')">${esc(d.title)}</a> <small>${money(d.value)} &middot; ${DEAL_STAGES[d.stage]}</small></div>`).join('') || '<div class="empty">No deals.</div>'}</div>`;
}

// ======================= REPORTS =======================
let reportDays = 30;
async function renderReports() {
  const r = await api('/reports?days=' + reportDays);
  const c = r.clients, d = r.deals, a = r.activity;
  const stageMax = Math.max(1, ...Object.values(c.stages)), callMax = Math.max(1, ...Object.values(c.calls));
  const dealMax = Math.max(1, ...d.stages.map(s => s.value)), monthMax = Math.max(1, ...d.months.map(m => m.value));
  $('#view').innerHTML = `<div class="toolbar">
    <select onchange="reportDays=this.value;renderReports()">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']].map(([v, l]) => `<option value="${v}" ${+reportDays === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${exportBtn('clients')}${exportBtn('deals')}${exportBtn('tasks')}${exportBtn('activities')}
  </div>
  <div class="grid stats">
    <div class="stat"><b>${c.created}</b><span>New clients (period)</span></div>
    <div class="stat blue"><b>${pct(c.responseRate)}</b><span>Response rate (replied or onboarded / contacted)</span></div>
    <div class="stat green"><b>${pct(c.conversionRate)}</b><span>Onboarded / all clients</span></div>
    <div class="stat amber"><b>${money(d.openValue)}</b><span>Open pipeline (${d.openCount} deals)</span></div>
    <div class="stat"><b>${money(d.weightedForecast)}</b><span>Weighted forecast</span></div>
    <div class="stat green"><b>${money(d.wonValue)}</b><span>Won in period (${d.wonCount})</span></div>
    <div class="stat"><b>${pct(d.winRate)}</b><span>Win rate (${d.wonCount} won / ${d.lostCount} lost)</span></div>
    <div class="stat red"><b>${r.tasks.overdue}</b><span>Overdue tasks (${r.tasks.open} open)</span></div>
  </div>
  <div class="grid cols">
    <div class="panel"><h3>Client funnel (now)</h3>${Object.keys(STAGES).map(k => barRow(STAGES[k].split(' ')[0] === 'Said' ? 'Said No' : STAGES[k].split(' ')[0], c.stages[k], stageMax)).join('')}
      <div class="empty">In this period: ${c.onboardedInRange} onboarded, ${c.rejectedInRange} said no (from logged stage changes).</div></div>
    <div class="panel"><h3>Calling outcomes (now)</h3>${Object.keys(CALLS).map(k => barRow(CALLS[k], c.calls[k], callMax)).join('')}</div>
    <div class="panel"><h3>Team activity (period)</h3>
      ${[['call', 'Call updates'], ['reply', 'Client replies'], ['mail', 'Emails sent'], ['note', 'Notes'], ['stage', 'Stage changes'], ['task', 'Task events'], ['deal', 'Deal events']].map(([k, l]) => barRow(l, a[k], Math.max(1, ...Object.values(a)))).join('')}</div>
    <div class="panel"><h3>Deals by stage (value)</h3>${d.stages.map(s => barRow(DEAL_STAGES[s.stage], s.value, dealMax, `${money(s.value)} <small style="color:var(--muted)">(${s.count})</small>`)).join('')}
      ${d.overdueOpen ? `<div class="empty late">${d.overdueOpen} open deal(s) are past their expected close date.</div>` : ''}</div>
    <div class="panel green"><h3>Won revenue, last 6 months</h3>${d.months.map(m => barRow(m.month, m.value, monthMax, `${money(m.value)} <small style="color:var(--muted)">(${m.won})</small>`)).join('')}
      <div class="empty">Average won deal in period: ${money(d.avgWon)}</div></div>
    <div class="panel"><h3>Lead sources</h3>
      ${c.sources.length ? `<table style="font-size:13px"><thead><tr><th>Source</th><th>Clients</th><th>Onboarded</th></tr></thead><tbody>${c.sources.map(s => `<tr><td>${esc(s.source)}</td><td>${s.clients}</td><td>${s.onboarded}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No data.</div>'}</div>
  </div>
  <p class="empty" style="margin-top:14px">Weighted forecast uses: Lead 10%, Qualified 25%, Proposal 50%, Negotiation 75% (edit <code>DEAL_WEIGHT</code> in lib/tools.js).</p>`;
}

// ======================= EMAIL TEMPLATES =======================
let tplSel = '';
async function renderTemplates() {
  const list = await api('/templates');
  const t = list.find(x => x.id === tplSel) || null;
  $('#view').innerHTML = `<div class="grid cols">
    <div class="panel"><h3>Your templates <button class="btn small primary" onclick="tplSel='';renderTemplates()">+ New</button></h3>
      ${list.map(x => `<div class="item ${x.id === tplSel ? 'sel' : ''}" onclick="tplSel='${x.id}';renderTemplates()"><b>${esc(x.name)}</b><small>${esc(x.subject)}</small></div>`).join('') || '<div class="empty">No templates yet. Create one, or save a campaign as a template from the Mass Mailing page.</div>'}</div>
    <div class="panel"><h3>${t ? 'Edit template' : 'New template'}</h3>
      <label>Name</label><input id="tp_name" value="${esc(t?.name)}" placeholder="e.g. First introduction">
      <label style="margin-top:8px;display:block">Subject</label><input id="tp_sub" value="${esc(t?.subject)}">
      <label style="margin-top:8px;display:block">Message (use {{name}}, {{company}})</label><textarea id="tp_body" style="min-height:200px">${esc(t?.body)}</textarea>
      ${aiWriterBox('tp_sub', 'tp_body')}
      <div class="actions">${t ? `<button class="btn danger" onclick="delTemplate('${t.id}')">Delete</button>` : ''}<button class="btn primary" onclick="saveTemplate('${t?.id || ''}')">Save template</button></div></div>
  </div>`;
}
async function saveTemplate(id) {
  const body = { name: $('#tp_name').value.trim(), subject: $('#tp_sub').value, body: $('#tp_body').value };
  if (!body.name) return toast('Give the template a name');
  const r = await api(id ? '/templates/' + id : '/templates', id ? 'PUT' : 'POST', body);
  if (r.error) return toast(r.error);
  tplSel = r.id; toast('Template saved'); renderTemplates();
}
async function delTemplate(id) {
  if (!confirm('Delete this template?')) return;
  await api('/templates/' + id, 'DELETE'); tplSel = ''; renderTemplates();
}
// Fill {{name}} / {{company}} for one client (the server does the same for mass mail)
const fillTpl = (t, c) => String(t || '').replace(/{{\s*(name|company|email|phone)\s*}}/gi, (_, k) => c[k.toLowerCase()] || '');
