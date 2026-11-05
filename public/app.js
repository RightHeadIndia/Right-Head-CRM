/* Company CRM front-end (vanilla JS, no build step) */
const $ = s => document.querySelector(s);
const api = async (url, method = 'GET', body) => {
  const r = await fetch('/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Please sign in again.'); }
  let data;
  try { data = await r.json(); } catch (_) { data = { error: 'The server returned an unreadable response.' }; }
  if (!r.ok) {
    const error = new Error(data.error || 'The request could not be completed.');
    error.name = 'ApiError'; error.status = r.status;
    throw error;
  }
  return data;
};
async function logout() { await api('/auth/logout', 'POST', {}); location.replace('/login.html'); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const STAGES = { new: 'New', contacted: 'Contacted', replied: 'Replied (Blue)', onboarded: 'Onboarded (Green)', rejected: 'Said No (Red)' };
const CALLS = { not_called: 'Not called', connected: 'Connected', no_answer: 'No answer', busy: 'Busy', callback: 'Call back' };
const COMMUNICATION = { not_contacted: 'Not contacted', contacted: 'Contacted', replied: 'Replied', opted_out: 'Opted out' };
const badge = s => { const stage = Object.hasOwn(STAGES, s) ? s : 'new'; return `<span class="badge b-${stage}">${STAGES[stage].split(' ')[0] === 'Said' ? 'Said No' : STAGES[stage].split(' ')[0]}</span>`; };
const CLIENT_ACTION_ICONS = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.72"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.72-1.72"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20l1.2-4.4A8.4 8.4 0 1 1 20 11.5Z"/><path d="M8 8.5c.6 3.2 2.4 5 5.6 5.6l1-1.3 2 .8c-.2 1.4-1.2 2.2-2.6 2.1-3.7-.4-7.2-3.9-7.6-7.6-.1-1.4.7-2.4 2.1-2.6l.8 2L8 8.5Z"/></svg>',
  linkedin: '<span class="action-brand-icon" aria-hidden="true">in</span>',
  call: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h4l2 5-2.5 1.5a15 15 0 0 0 6 6L16 13l5 2v4c0 1.1-.9 2-2 2C10 21 3 14 3 5c0-1.1.9-2 2-2Z"/></svg>',
  email: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>'
};
const fmt = d => d ? new Date(d).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
const isLate = d => d && new Date(d) < new Date();
const toLocalInput = d => { if (!d) return ''; const t = new Date(d); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 16); };

let clients = [];
let page = location.hash.slice(1) || 'dashboard';
let settings = {};
let openTaskCount;
function applyTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  try { localStorage.setItem('crm-theme', selected); } catch (_) {}
  const button = $('#themeToggle');
  if (button) button.textContent = selected === 'dark' ? 'Light mode' : 'Dark mode';
}
async function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { await api('/settings', 'PUT', { theme }); settings.theme = theme; }
  catch (e) { toast('Theme saved on this device; account preference could not be saved.'); }
}

const PAGES = {
  dashboard: { title: 'Dashboard', icon: '&#9638;' },
  clients: { title: 'All Clients', icon: '&#9776;', filter: () => true },
  calls: { title: 'Calling Status', icon: '&#9742;', filter: c => c.stage === 'new' || c.stage === 'contacted' || c.callStatus !== 'not_called' },
  followups: { title: 'Follow-up Reminders', icon: '&#9200;', filter: c => c.followUp && c.stage !== 'onboarded' && c.stage !== 'rejected', sort: (a, b) => a.followUp.localeCompare(b.followUp) },
  replied: { title: 'Replies (Blue Zone)', icon: '&#9993;', dot: '#2563eb', filter: c => c.stage === 'replied' },
  onboarded: { title: 'Onboarded Clients', icon: '&#10003;', dot: '#16a34a', filter: c => c.stage === 'onboarded' },
  redzone: { title: 'Red Zone (Said No)', icon: '&#10005;', dot: '#dc2626', filter: c => c.stage === 'rejected' },
  tasks: { title: 'Tasks', icon: '&#9745;' },
  deals: { title: 'Deals Pipeline', icon: '&#36;' },
  reports: { title: 'Reports', icon: '&#9636;' },
  history: { title: 'History', icon: '&#8635;' },
  mail: { title: 'Mass Mailing', icon: '&#9993;' },
  templates: { title: 'Email Templates', icon: '&#9998;' },
  assistant: { title: 'AI Assistant', icon: '&#10024;' },
  settings: { title: 'Settings & Import', icon: '&#9881;' }
};

async function refresh() {
  clients = await api('/clients');
  try { openTaskCount = (await api('/tasks')).filter(t => !t.done).length; } catch (_) { /* nav badge only */ }
}

function renderNav() {
  const cnt = {
    replied: clients.filter(PAGES.replied.filter).length, onboarded: clients.filter(PAGES.onboarded.filter).length,
    redzone: clients.filter(PAGES.redzone.filter).length, followups: clients.filter(PAGES.followups.filter).length,
    clients: clients.length, tasks: openTaskCount
  };
  const item = k => `<a data-p="${k}" class="${page === k ? 'active' : ''}" onclick="go('${k}')">
    ${PAGES[k].dot ? `<span class="dot" style="background:${PAGES[k].dot}"></span>` : `<span>${PAGES[k].icon}</span>`}
    ${PAGES[k].title}${cnt[k] !== undefined ? `<span class="count">${cnt[k]}</span>` : ''}</a>`;
  $('#nav').innerHTML = `<div class="sep">Overview</div>${item('dashboard')}
    <div class="sep">Pipeline</div>${item('clients')}${item('calls')}${item('followups')}
    <div class="sep">Zones</div>${item('replied')}${item('onboarded')}${item('redzone')}
    <div class="sep">Sales tools</div>${item('tasks')}${item('deals')}${item('reports')}${item('history')}
    <div class="sep">Outreach</div>${item('mail')}${item('templates')}
    <div class="sep">AI</div>${item('assistant')}
    <div class="sep">System</div>${item('settings')}`;
}

let listLimit = 200; // rows drawn at once; "Show more" adds 200 (keeps big lists fast)
const selectedClientIds = new Set();
let renderedClientIds = [];
function go(p) {
  if (page !== p) selectedClientIds.clear();
  page = p; listLimit = 200; location.hash = p; render();
}
window.addEventListener('hashchange', () => {
  const nextPage = location.hash.slice(1) || 'dashboard';
  if (page !== nextPage) selectedClientIds.clear();
  page = nextPage; listLimit = 200; render();
});

async function render() {
  $('#pageTitle').textContent = PAGES[page]?.title || 'Dashboard';
  renderNav();
  if (page === 'dashboard') return renderDashboard();
  if (page === 'mail') return renderMail();
  if (page === 'tasks') return renderTasks();
  if (page === 'deals') return renderDeals();
  if (page === 'reports') return renderReports();
  if (page === 'history') return renderHistory();
  if (page === 'templates') return renderTemplates();
  if (page === 'assistant') return renderAssistant();
  if (page === 'settings') return renderSettings();
  renderList();
}

// ---------- dashboard ----------
const listItems = (arr, extra) => arr.length ? arr.map(c => `<div class="item" onclick="openClient('${c.id}')"><b>${esc(c.name)}</b> ${esc(c.company ? '· ' + c.company : '')}
  <small>${extra(c)}</small></div>`).join('') : '<div class="empty">Nothing here yet.</div>';

async function renderDashboard() {
  const d = await api('/dashboard');
  const maxCall = Math.max(1, ...Object.values(d.calls));
  const maxCommunication = Math.max(1, ...Object.values(d.communication || {}));
  $('#view').innerHTML = `
  <div class="grid stats">
    <div class="stat" onclick="go('clients')"><b>${d.total}</b><span>Total clients</span></div>
    <div class="stat amber" onclick="go('followups')"><b>${d.overdue + d.dueToday}</b><span>Follow-ups due (${d.overdue} overdue)</span></div>
    <div class="stat blue" onclick="go('replied')"><b>${d.stages.replied}</b><span>Replies / revert back</span></div>
    <div class="stat green" onclick="go('onboarded')"><b>${d.stages.onboarded}</b><span>Onboarded</span></div>
    <div class="stat red" onclick="go('redzone')"><b>${d.stages.rejected}</b><span>Red zone (said no)</span></div>
  </div>
  <div class="grid cols">
    <div class="panel"><h3>Calling Status <a onclick="go('calls')">view all</a></h3>
      ${Object.keys(CALLS).map(k => `<div class="bar"><label>${CALLS[k]}</label><div class="track"><div class="fill" style="width:${d.calls[k] / maxCall * 100}%"></div></div><b>${d.calls[k]}</b></div>`).join('')}
    </div>
    <div class="panel"><h3>Communication Status</h3>
      ${Object.keys(COMMUNICATION).map(k => `<div class="bar"><label>${COMMUNICATION[k]}</label><div class="track"><div class="fill" style="width:${(d.communication?.[k] || 0) / maxCommunication * 100}%"></div></div><b>${d.communication?.[k] || 0}</b></div>`).join('')}
    </div>
    <div class="panel amber"><h3>Follow-up Reminders <a onclick="go('followups')">view all</a></h3>
      ${listItems(d.reminders, c => `<span class="${isLate(c.followUp) ? 'late' : ''}">${isLate(c.followUp) ? 'Overdue: ' : 'Today: '}${fmt(c.followUp)}</span> · ${esc(c.phone)}`)}
      ${d.upcoming?.length ? `<div style="margin-top:12px"><b style="font-size:12px">Upcoming</b>${listItems(d.upcoming, c => `${fmt(c.followUp)} · ${esc(c.phone)}`)}</div>` : ''}
    </div>
    <div class="panel blue"><h3>Client Replies (Blue) <a onclick="go('replied')">view all</a></h3>
      ${listItems(d.replied, c => esc(c.lastReply || 'Client replied').slice(0, 90))}
    </div>
    <div class="panel green"><h3>Onboarded Clients <a onclick="go('onboarded')">view all</a></h3>
      ${listItems(d.onboarded, c => `Onboarded ${fmt(c.updatedAt)}`)}
    </div>
    <div class="panel red"><h3>Red Zone - Said No <a onclick="go('redzone')">view all</a></h3>
      ${listItems(d.rejected, c => esc(c.notes || 'Not interested').slice(0, 90))}
    </div>
    <div class="panel"><h3>Mass Mailing <a onclick="go('mail')">open</a></h3>
      ${d.campaigns.length ? d.campaigns.map(m => `<div class="item"><b>${esc(m.subject)}</b><small>${fmt(m.at)} · ${m.sent}/${m.total} sent${m.simulated ? ' (simulated)' : ''}${m.failed ? ' · ' + m.failed + ' failed' : ''}${m.skipped ? ' · ' + m.skipped + ' skipped' : ''}${m.status === 'sending' ? ' · sending' : m.status === 'interrupted' ? ' · interrupted' : ''}</small></div>`).join('') : '<div class="empty">No campaigns sent yet.</div>'}
      <div class="actions"><button class="btn primary small" onclick="go('mail')">New campaign</button></div>
    </div>
  </div>`;
}

// ---------- list pages ----------
function renderList() {
  const cfg = PAGES[page] || PAGES.clients;
  const q = $('#search').value.toLowerCase();
  let rows = clients.filter(cfg.filter);
  if (q) rows = rows.filter(c => [c.name, c.company, c.phone, c.email, c.location, c.source, c.notes].join(' ').toLowerCase().includes(q));
  rows.sort(cfg.sort || ((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  const stageFilter = page === 'clients' || page === 'calls'
    ? `<select id="stageF" onchange="renderList()"><option value="">All stages</option>${Object.keys(STAGES).map(k => `<option value="${k}" ${$('#stageF')?.value === k ? 'selected' : ''}>${STAGES[k]}</option>`).join('')}</select>` : '';
  if ($('#stageF') && $('#stageF').value) rows = rows.filter(c => (Object.hasOwn(STAGES, c.stage) ? c.stage : 'new') === $('#stageF').value);
  const total = rows.length;
  rows = rows.slice(0, listLimit);
  renderedClientIds = rows.map(client => client.id);
  $('#view').innerHTML = `<div class="toolbar">${stageFilter}<span style="color:var(--muted)">${total} record(s)</span>${page === 'clients' ? `<button class="btn" onclick="go('settings')">&#128229; Import clients</button>` + exportBtn('clients') : ''}</div>
  <div class="bulk-status-toolbar" id="bulkStatusToolbar" hidden>
    <span class="bulk-selected-count" id="bulkSelectedCount"></span>
    <span class="bulk-note">Same values apply to every selected record. Blank fields stay unchanged.</span>
    <label class="bulk-field">Stage<select id="bulkStage"><option value="">Keep current</option>${Object.entries(STAGES).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
    <label class="bulk-field">Communication<select id="bulkCommunication"><option value="">Keep current</option>${Object.entries(COMMUNICATION).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
    <label class="bulk-field">Call status<select id="bulkCall"><option value="">Keep current</option>${Object.entries(CALLS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
    <label class="bulk-field">Follow-up<input id="bulkFollowUp" type="datetime-local"></label>
    <label class="bulk-clear"><input id="bulkClearFollowUp" type="checkbox"> Clear follow-up</label>
    <label class="bulk-field">Location<input id="bulkLocation" maxlength="200" placeholder="Leave blank to keep"></label>
    <label class="bulk-clear"><input id="bulkClearLocation" type="checkbox"> Clear location</label>
    <label class="bulk-field">Source / link<input id="bulkSource" maxlength="500" placeholder="Leave blank to keep"></label>
    <label class="bulk-clear"><input id="bulkClearSource" type="checkbox"> Clear source</label>
    <label class="bulk-field bulk-notes">Notes<textarea id="bulkNotes" maxlength="6000" rows="2" placeholder="Leave blank to keep"></textarea></label>
    <label class="bulk-clear"><input id="bulkClearNotes" type="checkbox"> Clear notes</label>
    <div class="bulk-actions">
      <button class="btn primary" id="bulkApplyButton" onclick="applyBulkClientStatus()">Apply to selected</button>
      <button class="btn" onclick="clearClientSelection()">Clear selection</button>
    </div>
  </div>
  <div class="table-wrap"><table><thead><tr><th class="client-select-cell"><input id="selectVisibleClients" type="checkbox" aria-label="Select all visible clients" title="Select all visible clients" onchange="toggleVisibleClientSelection(this.checked)"></th><th>Client</th><th>Contact</th><th>Sales stage</th><th>Communication</th><th>Call outcome</th><th>Next follow-up</th><th>Actions</th></tr></thead><tbody>
  ${rows.map(c => `<tr class="row-${Object.hasOwn(STAGES, c.stage) ? c.stage : 'new'}">
    <td class="client-select-cell"><input class="client-row-select" type="checkbox" value="${esc(c.id)}" aria-label="Select ${esc(c.name)}" ${selectedClientIds.has(c.id) ? 'checked' : ''} onchange="toggleClientSelection('${c.id}',this.checked)"></td>
    <td><b>${esc(c.name)}</b><br><small style="color:var(--muted)">${esc(c.company)}${c.location ? ' · ' + esc(c.location) : ''}</small></td>
    <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a><br>` : ''}<small>${esc(c.email)}${c.alternateEmails?.length ? ` (+${c.alternateEmails.length} additional)` : ''}</small></td>
    <td>${badge(c.stage)}</td>
    <td><select onchange="quick('${c.id}',{communicationStatus:this.value})">${Object.keys(COMMUNICATION).map(k => `<option value="${k}" ${(c.communicationStatus || 'not_contacted') === k ? 'selected' : ''}>${COMMUNICATION[k]}</option>`).join('')}</select></td>
    <td><select onchange="quick('${c.id}',{callStatus:this.value})">${Object.keys(CALLS).map(k => `<option value="${k}" ${(c.callStatus || 'not_called') === k ? 'selected' : ''}>${CALLS[k]}</option>`).join('')}</select></td>
    <td class="${isLate(c.followUp) ? 'late' : ''}">${fmt(c.followUp)}</td>
    <td class="client-actions-cell"><div class="client-actions">
      <button class="btn small icon-action" onclick="openClient('${c.id}')" title="Open" aria-label="Open">${CLIENT_ACTION_ICONS.open}</button>
      <button class="btn small danger icon-action" onclick="delClient('${c.id}')" title="Delete" aria-label="Delete">${CLIENT_ACTION_ICONS.delete}</button>
      ${c.source && /^https?:\/\//i.test(c.source) && !/linkedin\.com/i.test(c.source) ? `<a class="btn small icon-action" href="${esc(c.source)}" target="_blank" rel="noopener" title="Link" aria-label="Link">${CLIENT_ACTION_ICONS.link}</a>` : ''}
      ${c.phone ? `<a class="btn small icon-action" href="https://wa.me/${esc(c.phone.replace(/\D/g, ''))}" target="_blank" onclick="logTouch('${c.id}','whatsapp','WhatsApp opened')" title="WhatsApp" aria-label="WhatsApp">${CLIENT_ACTION_ICONS.whatsapp}</a>` : ''}
      ${c.source && /linkedin\.com/i.test(c.source) ? `<a class="btn small icon-action" href="${esc(c.source)}" target="_blank" rel="noopener" onclick="logTouch('${c.id}','linkedin','LinkedIn profile opened')" title="LinkedIn" aria-label="LinkedIn">${CLIENT_ACTION_ICONS.linkedin}</a>` : ''}
      ${c.phone ? `<a class="btn small primary icon-action" href="tel:${esc(c.phone)}" onclick="logCall('${c.id}', event)" title="Call" aria-label="Call">${CLIENT_ACTION_ICONS.call}</a>` : ''}
      ${clientEmailAddresses(c).length && !c.optedOut ? `<button class="btn small icon-action" onclick="openSendMailModal('${c.id}')" title="Email" aria-label="Email">${CLIENT_ACTION_ICONS.email}</button>` : ''}
    </div></td>
  </tr>`).join('') || '<tr><td colspan="8" class="empty">No clients in this view.</td></tr>'}
  </tbody></table></div>${total > rows.length ? `<div class="actions" style="justify-content:center"><button class="btn" onclick="listLimit+=200;renderList()">Show more (${total - rows.length} not shown)</button></div>` : ''}`;
  updateClientSelectionUI();
}
function updateClientSelectionUI() {
  const toolbar = $('#bulkStatusToolbar');
  if (!toolbar) return;
  toolbar.hidden = selectedClientIds.size === 0;
  $('#bulkSelectedCount').textContent = `${selectedClientIds.size} selected`;
  const visibleSelected = renderedClientIds.filter(id => selectedClientIds.has(id)).length;
  const selectVisible = $('#selectVisibleClients');
  if (selectVisible) {
    selectVisible.checked = renderedClientIds.length > 0 && visibleSelected === renderedClientIds.length;
    selectVisible.indeterminate = visibleSelected > 0 && visibleSelected < renderedClientIds.length;
  }
}
function toggleClientSelection(id, checked) {
  if (checked) selectedClientIds.add(id); else selectedClientIds.delete(id);
  updateClientSelectionUI();
}
function toggleVisibleClientSelection(checked) {
  renderedClientIds.forEach(id => checked ? selectedClientIds.add(id) : selectedClientIds.delete(id));
  document.querySelectorAll('.client-row-select').forEach(input => { input.checked = checked; });
  updateClientSelectionUI();
}
function clearClientSelection() {
  selectedClientIds.clear();
  document.querySelectorAll('.client-row-select').forEach(input => { input.checked = false; });
  updateClientSelectionUI();
}
async function applyBulkClientStatus() {
  const ids = [...selectedClientIds];
  const stage = $('#bulkStage')?.value || '';
  const communicationStatus = $('#bulkCommunication')?.value || '';
  const callStatus = $('#bulkCall')?.value || '';
  const followUpInput = $('#bulkFollowUp')?.value || '';
  const location = $('#bulkLocation')?.value.trim() || '';
  const source = $('#bulkSource')?.value.trim() || '';
  const notes = $('#bulkNotes')?.value || '';
  const patch = {};
  if (stage) patch.stage = stage;
  if (communicationStatus) patch.communicationStatus = communicationStatus;
  if (callStatus) patch.callStatus = callStatus;
  if (followUpInput) patch.followUp = new Date(followUpInput).toISOString();
  if ($('#bulkClearFollowUp')?.checked) patch.followUp = '';
  if (location) patch.location = location;
  if ($('#bulkClearLocation')?.checked) patch.location = '';
  if (source) patch.source = source;
  if ($('#bulkClearSource')?.checked) patch.source = '';
  if (notes.trim()) patch.notes = notes;
  if ($('#bulkClearNotes')?.checked) patch.notes = '';
  if (!ids.length || !Object.keys(patch).length) return toast('Choose at least one field to update.');
  if (!confirm(`Apply these changes to ${ids.length} selected client(s)?`)) return;

  const button = $('#bulkApplyButton');
  if (button) button.disabled = true;
  const updatedIds = [], failures = [];
  try {
    for (const id of ids) {
      try {
        await api('/clients/' + id, 'PUT', patch);
        updatedIds.push(id);
      } catch (error) {
        const client = clients.find(item => item.id === id);
        failures.push(`${client?.name || id}: ${error.message}`);
      }
    }
    try { await refresh(); }
    catch (error) {
      toast(`Status updates were sent, but the client list could not be refreshed: ${error.message}`);
      return;
    }
    updatedIds.forEach(id => selectedClientIds.delete(id));
    render();
    if (failures.length) {
      const details = failures.slice(0, 3).join('; ');
      toast(`Updated ${updatedIds.length} of ${ids.length}. Failed: ${details}${failures.length > 3 ? `; and ${failures.length - 3} more` : ''}`);
    } else toast(`Updated ${updatedIds.length} client(s).`);
  } finally {
    if (button) button.disabled = false;
  }
}
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer); // wait for a pause in typing before redrawing
  searchTimer = setTimeout(() => {
    listLimit = 200;
    if (page === 'tasks') renderTasks(); else if (page === 'deals') renderDeals(); else if (page === 'history') renderHistory();
    else if (!['dashboard', 'mail', 'settings', 'reports', 'templates', 'assistant'].includes(page)) renderList();
  }, 150);
});

async function quick(id, patch) {
  try {
    const updated = await api('/clients/' + id, 'PUT', patch);
    const index = clients.findIndex(c => c.id === id);
    if (index >= 0) clients[index] = updated;
    await refresh();
    toast('Updated');
    render();
  } catch (error) {
    toast(error.message || 'Could not save this change');
    await refresh(); render();
  }
}
let historyType = 'records';
let historyLimit = 100;
function historyValue(value) {
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value === '' || value === null || value === undefined ? '—' : String(value);
}
function historyEventName(type) {
  return ({ created: 'Record added', record: 'Record updated', deleted: 'Record deleted', stage: 'Stage changed', call: 'Call status', reply: 'Client reply', mail: 'Email', note: 'Note', task: 'Task', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' })[type] || type;
}
async function renderHistory() {
  const query = $('#search').value.trim();
  const result = await api(`/history?limit=${historyLimit}&type=${encodeURIComponent(historyType)}&q=${encodeURIComponent(query)}`);
  const recordValues = activity => {
    const changes = activity.details?.changes || [];
    if (!changes.length) return `<div class="history-note">${esc(activity.note || '')}</div>`;
    return `<div class="history-changes">${changes.map(change => {
      const before = change.before === undefined ? null : historyValue(change.before);
      const after = change.after === undefined ? null : historyValue(change.after);
      return `<div class="history-change"><b>${esc(change.label || change.field)}</b><span>${before === null ? esc(after) : `${esc(before)} <span aria-hidden="true">&rarr;</span> ${esc(after)}`}</span></div>`;
    }).join('')}</div>`;
  };
  $('#view').innerHTML = `<div class="toolbar">
    <select aria-label="History event filter" onchange="historyType=this.value;historyLimit=100;renderHistory()">
      <option value="records" ${historyType === 'records' ? 'selected' : ''}>Record changes</option>
      <option value="" ${historyType === '' ? 'selected' : ''}>All activity</option>
    </select>
    <span class="history-count">${result.total} event(s)</span>
  </div>
  <div class="history-list">${result.activities.map(activity => `<article class="history-entry">
    <div class="history-meta"><time datetime="${esc(activity.at)}">${new Date(activity.at).toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span class="badge history-badge">${esc(historyEventName(activity.type))}</span></div>
    <h3>${clients.some(client => client.id === activity.clientId)
      ? `<button class="history-client-link" onclick="openClient('${esc(activity.clientId)}')">${esc(activity.clientName)}</button>`
      : esc(activity.clientName)}</h3>
    ${recordValues(activity)}
  </article>`).join('') || '<div class="empty">No history events match your search.</div>'}</div>
  ${result.activities.length < result.total && result.limit < 500 ? `<div class="actions" style="justify-content:center"><button class="btn" onclick="historyLimit=Math.min(500,historyLimit+100);renderHistory()">Load older events</button></div>` : result.total > 500 ? '<div class="empty">Showing up to 500 matching events.</div>' : ''}`;
}
async function logCall(id, event) {
  // Let the browser launch the phone app immediately, and log the attempt in CRM.
  const c = clients.find(x => x.id === id);
  if (!c) return;
  api(`/clients/${id}/activity`, 'POST', { type: 'call', note: `Call initiated to ${c.phone}` })
    .then(() => refresh()).then(() => { renderNav(); if (page === 'dashboard') render(); })
    .catch(() => toast('Call opened; activity could not be saved'));
}
async function logTouch(id, type, note) {
  api(`/clients/${id}/activity`, 'POST', { type, note }).catch(() => toast(`${type} opened; activity could not be saved`));
}

// ---------- client modal ----------
async function openClient(id) {
  const c = id ? clients.find(x => x.id === id) : {};
  const acts = id ? await api(`/clients/${id}/activities`) : [];
  $('#modalBox').innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
    <h2 style="margin:0">${id ? esc(c.name) : 'Add Client'}</h2>
    <button class="btn small" onclick="closeModal()" title="Close" style="border:0;background:transparent;font-size:22px;cursor:pointer;color:var(--muted);padding:0 6px;line-height:1">&times;</button>
  </div>
  <div class="form">
    <div><label>Name *</label><input id="f_name" value="${esc(c.name)}"></div>
    <div><label>Company</label><input id="f_company" value="${esc(c.company)}"></div>
    <div><label>Phone</label><input id="f_phone" value="${esc(c.phone)}"></div>
    <div><label>Primary email</label><div style="display:flex;gap:6px"><input id="f_email" value="${esc(c.email)}" style="flex:1">${id && clientEmailAddresses(c).length && !c.optedOut ? `<button type="button" class="btn small primary" onclick="openSendMailModal('${id}')" title="Send email to this client" style="white-space:nowrap">&#9993; Send Mail</button>` : ''}</div></div>
    <div class="full"><label>Additional email addresses (one per line)</label><textarea id="f_alternateEmails" placeholder="accounts@example.com&#10;owner@example.com">${esc((c.alternateEmails || []).join('\n'))}</textarea></div>
    <div><label>Location</label><input id="f_location" value="${esc(c.location || '')}"></div>
    <div><label>Source / Link ${c.source && /^https?:\/\//i.test(c.source) ? `<a href="${esc(c.source)}" target="_blank" rel="noopener" style="font-size:11px;margin-left:6px">&#x2197; Open</a>` : ''}</label><input id="f_source" value="${esc(c.source || '')}"></div>
    <div><label>Stage</label><select id="f_stage">${Object.keys(STAGES).map(k => `<option value="${k}" ${(c.stage || 'new') === k ? 'selected' : ''}>${STAGES[k]}</option>`).join('')}</select></div>
    <div><label>Call status</label><select id="f_call">${Object.keys(CALLS).map(k => `<option value="${k}" ${(c.callStatus || 'not_called') === k ? 'selected' : ''}>${CALLS[k]}</option>`).join('')}</select></div>
    <div><label>Communication status</label><select id="f_comm">${Object.keys(COMMUNICATION).map(k => `<option value="${k}" ${(c.communicationStatus || 'not_contacted') === k ? 'selected' : ''}>${COMMUNICATION[k]}</option>`).join('')}</select></div>
    <div class="full"><label>Next follow-up (reminder)</label><input type="datetime-local" id="f_follow" value="${toLocalInput(c.followUp)}"></div>
    <div class="full"><label>Notes</label><textarea id="f_notes">${esc(c.notes)}</textarea></div>
    <div class="full"><label style="display:flex;gap:8px;align-items:center"><input id="f_optedOut" type="checkbox" style="width:auto" ${c.optedOut ? 'checked' : ''}> Do not email this lead (opted out)</label></div>
  </div>
  <div class="actions">
    ${id && clientEmailAddresses(c).length && !c.optedOut ? `<button type="button" class="btn" onclick="openSendMailModal('${id}')">&#9993; Send email</button>` : ''}
    ${id && c.phone && settings.whatsapp?.accessToken ? `<button type="button" class="btn" onclick="sendWhatsApp('${id}')">WhatsApp Business</button>` : ''}
    ${id ? `<button class="btn danger" onclick="delClient('${id}')">Delete client</button>` : ''}
    <button class="btn" onclick="closeModal()">Close</button>
    <button class="btn primary" onclick="saveClient('${id || ''}')">Save</button>
  </div>
  ${id ? clientAiPanel(id) + await clientExtras(id) : ''}
  ${id ? `<div class="timeline"><b>Log activity / client reply</b>
    <div style="display:flex;gap:8px;margin:10px 0"><input id="a_note" style="flex:1" placeholder="Type note or paste the client's message...">
    <button class="btn small" onclick="addAct('${id}','note')">Add note</button>
    <button class="btn small primary" onclick="addAct('${id}','reply')">Client replied</button></div>
    ${acts.map(a => `<div><small>${fmt(a.at)} · ${a.type}${a.deliveryStatus ? ` · ${esc(a.deliveryStatus)}` : ''}</small><br>${esc(a.note)}</div>`).join('') || '<div class="empty">No activity yet.</div>'}</div>` : ''}`;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

async function saveClient(id) {
  const body = {
    name: $('#f_name').value.trim(), company: $('#f_company').value, phone: $('#f_phone').value, email: $('#f_email').value,
    alternateEmails: $('#f_alternateEmails').value.split(/[\s,;]+/).filter(Boolean),
    location: $('#f_location') ? $('#f_location').value : '', source: $('#f_source') ? $('#f_source').value : '',
    stage: $('#f_stage').value, callStatus: $('#f_call').value, communicationStatus: $('#f_comm').value, notes: $('#f_notes').value, optedOut: $('#f_optedOut').checked,
    followUp: $('#f_follow').value ? new Date($('#f_follow').value).toISOString() : ''
  };
  if (!body.name) return toast('Name is required');
  // Moving to a closed stage clears reminders on the server; otherwise keep the picked date
  const result = id ? await api('/clients/' + id, 'PUT', body) : await api('/clients', 'POST', body);
  if (result.error) return toast(result.error);
  closeModal(); await refresh(); toast('Saved'); render();
}
async function delClient(id) {
  if (!confirm('Delete this client permanently?')) return;
  await api('/clients/' + id, 'DELETE'); closeModal(); await refresh(); render();
}
async function addAct(id, type) {
  const note = $('#a_note').value.trim(); if (!note) return;
  const result = await api(`/clients/${id}/activity`, 'POST', { type, note });
  if (result.error) return toast(result.error);
  await refresh(); openClient(id); renderNav();
}
async function sendWhatsApp(id) {
  const c = clients.find(x => x.id === id); if (!c) return;
  const message = prompt(`WhatsApp message to ${c.name}:`, `Hi ${c.name}, following up from Right Head.`);
  if (!message?.trim()) return;
  if (!confirm(`Send this WhatsApp message to ${c.phone}?`)) return;
  try {
    const result = await api('/whatsapp/send', 'POST', { clientId: id, message });
    toast(result.status === 'accepted' ? 'WhatsApp message accepted by Meta' : 'WhatsApp message sent');
    await refresh(); openClient(id); renderNav();
  } catch (e) { toast(e.message); }
}

// ---------- mass mail ----------
let mailTpls = [];
let singleMailThread = null;
let selectedMailAddresses = new Set();
let mailSelectionQuery = '';
let mailChoiceLimit = 100;
const clientEmailAddresses = c => {
  const seen = new Set();
  return [c.email, ...(Array.isArray(c.alternateEmails) ? c.alternateEmails : [])]
    .filter(email => typeof email === 'string' && email.trim())
    .map(email => email.trim())
    .filter(email => {
      const normalized = email.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
};
const mailAddressKey = (id, email) => `${id}\n${email.toLowerCase()}`;
const canMailClient = c => clientEmailAddresses(c).length && c.stage !== 'rejected' && !c.optedOut && c.communicationStatus !== 'opted_out';

async function renderMail() {
  const camps = await api('/campaigns');
  mailTpls = await api('/templates');
  settings = await api('/settings');
  const smtpOk = settings.smtp.host && settings.smtp.user;
  $('#view').innerHTML = `
  ${smtpOk ? '' : '<div class="note">Email (SMTP) is not configured yet, so campaigns will run in <b>simulation mode</b> (logged but not actually sent). Add SMTP details in Settings.</div>'}
  <div class="grid cols">
    <div class="panel"><h3>New campaign</h3>
      <label>Audience</label>
      <select id="m_aud" onchange="changeMailAudience()"><option value="all">All eligible clients (excluding Red Zone)</option>
        <option value="selected">Choose individual clients</option>
        ${Object.keys(STAGES).filter(k => k !== 'rejected').map(k => `<option value="${k}">${STAGES[k]}</option>`).join('')}</select>
      <div id="m_cnt" class="empty"></div>
      <div id="m_selection" style="display:none">
        <label style="margin-top:8px;display:block">Find clients</label>
        <input id="m_client_search" type="search" placeholder="Search name, company, or email" value="${esc(mailSelectionQuery)}" oninput="mailSelectionQuery=this.value;mailChoiceLimit=100;renderMailSelection()">
        <div class="actions">
          <button class="btn small" onclick="selectVisibleMailClients()">Select visible primary emails</button>
          <button class="btn small" onclick="clearMailClientSelection()">Clear selection</button>
        </div>
        <div id="m_client_summary" class="empty"></div>
        <div id="m_client_choices" class="mail-client-picker"></div>
        <div class="note">Red Zone and opted-out clients are excluded. You can select clients from any other stage.</div>
      </div>
      <label>Start from a template</label>
      <select id="m_tpl" onchange="loadTemplate(this.value)"><option value="">- none -</option>${mailTpls.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <label style="margin-top:8px;display:block">Subject</label><input id="m_sub" placeholder="e.g. Hello {{name}}, a quick update from us">
      <label style="margin-top:8px;display:block">Message (use {{name}}, {{company}})</label>
      <textarea id="m_body" style="min-height:180px" placeholder="Hi {{name}},&#10;&#10;..."></textarea>
      ${aiWriterBox('m_sub', 'm_body')}
      <label class="mail-thread-option"><input id="m_replyToLast" type="checkbox"> Send as follow-up to each recipient’s last email thread (numbered automatically)</label>
      <div class="empty">When enabled, the CRM keeps each recipient’s existing subject and adds “Re:” so the message stays in that conversation; the campaign Subject above is ignored. Automated sequence reminders continue in the same thread after the initial email.</div>
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input id="m_sequence" type="checkbox" style="width:auto" onchange="toggleSequenceEditor()"> Create automated sequence: initial email + 4 follow-ups</label>
      <div class="empty">Clients who don’t reply or onboard are moved to Red Zone 3 days after the final follow-up. Record a reply with “Client replied” to move them to Blue; mark onboarded clients Green.</div>
      <div id="sequenceEditor" class="full"></div>
      <div class="actions"><button class="btn" onclick="saveAsTemplate()">Save as template</button><button id="mailSendBtn" class="btn primary" onclick="sendMail()">Send campaign</button></div>
    </div>
    <div class="panel"><h3>Campaign history</h3>
      ${camps.map(m => `<div class="item"><b>${esc(m.subject)}</b><small>${fmt(m.at)} · audience: ${esc(m.audience)} · ${m.type === 'sequence' ? `${m.sent || 0} email(s), ${m.total} leads · ${m.recipients?.filter(r => r.status === 'awaiting_outcome').length || 0} awaiting final response · ` : `${m.sent}/${m.total} sent · `}${m.simulated ? 'simulation mode · ' : ''}Status: ${esc(m.status)}${m.nextRunAt ? ` · next run ${fmt(m.nextRunAt)}` : ''}${m.failed ? ` · ${m.failed} failed` : ''}${m.skipped ? ` · ${m.skipped} skipped` : ''}${m.recipients?.filter(r => r.status === 'review').length ? ` · ${m.recipients.filter(r => r.status === 'review').length} uncertain delivery(ies)` : ''}</small>
        ${m.type === 'sequence' ? `<div class="actions"><button class="btn small" onclick="sequenceAction('${m.id}','${m.status === 'active' ? 'pause' : m.status === 'paused' ? (m.startedAt ? 'resume' : 'start') : ''}')" ${['active','paused'].includes(m.status) ? '' : 'disabled'}>${m.status === 'active' ? 'Pause' : m.status === 'paused' ? (m.startedAt ? 'Resume' : 'Start') : 'Start'}</button><button class="btn small" onclick="editSequence('${m.id}')" ${['paused','stopped'].includes(m.status) ? '' : 'disabled'}>Edit</button><button class="btn small danger" onclick="sequenceAction('${m.id}','stop')" ${['active','paused'].includes(m.status) ? '' : 'disabled'}>Stop</button></div>` : ''}
        ${m.errors && m.errors.length ? `<details><summary>${m.errors.length} send error(s)</summary>${m.errors.map(e => `<div class="empty">${esc(e)}</div>`).join('')}</details>` : ''}</div>`).join('') || '<div class="empty">No campaigns yet.</div>'}
    </div>
  </div>`;
  if ($('#m_aud').value === 'selected') {
    $('#m_selection').style.display = '';
    renderMailSelection();
  }
  audCount();
}
function mailSelectionMatches() {
  const query = mailSelectionQuery.trim().toLowerCase();
  return clients.filter(canMailClient).filter(c =>
    !query || [c.name, c.company, ...clientEmailAddresses(c)].some(value => String(value || '').toLowerCase().includes(query))
  );
}
function renderMailSelection() {
  const choices = $('#m_client_choices');
  if (!choices) return;
  const matches = mailSelectionMatches();
  const visible = matches.slice(0, mailChoiceLimit);
  const selectedCount = getSelectedMailRecipients().length;
  $('#m_client_summary').textContent = `${selectedCount} address(es) selected · showing ${visible.length} of ${matches.length} eligible clients`;
  choices.innerHTML = visible.map(c => {
    const addresses = clientEmailAddresses(c);
    return `<div class="mail-client-option">
      <b>${esc(c.name || c.company || addresses[0])}</b><small>${esc(c.company || '')}${c.company ? ' · ' : ''}${esc(STAGES[c.stage] || c.stage || 'New')}</small>
      <div class="mail-client-addresses">${addresses.map((email, index) => `<label class="mail-address-option">
        <input type="checkbox" value="${esc(email)}" ${selectedMailAddresses.has(mailAddressKey(c.id, email)) ? 'checked' : ''} onchange="toggleMailAddress('${esc(c.id)}',this.value,this.checked)">
        <span>${esc(email)}${index === 0 ? ' · primary' : ''}</span>
      </label>`).join('')}</div>
    </div>`;
  }).join('') || '<div class="empty">No eligible clients match this search.</div>';
  if (matches.length > visible.length) {
    choices.insertAdjacentHTML('beforeend', `<button class="btn small" style="margin:8px" onclick="showMoreMailClients()">Show more clients</button>`);
  }
}
function changeMailAudience() {
  const selection = $('#m_selection');
  if (selection) selection.style.display = $('#m_aud').value === 'selected' ? '' : 'none';
  if ($('#m_aud').value === 'selected') renderMailSelection();
  audCount();
}
function toggleMailAddress(id, email, checked) {
  const key = mailAddressKey(id, email);
  if (checked) selectedMailAddresses.add(key);
  else selectedMailAddresses.delete(key);
  renderMailSelection();
  audCount();
}
function selectVisibleMailClients() {
  mailSelectionMatches().slice(0, mailChoiceLimit).forEach(c => {
    const primary = clientEmailAddresses(c)[0];
    if (primary) selectedMailAddresses.add(mailAddressKey(c.id, primary));
  });
  renderMailSelection();
  audCount();
}
function clearMailClientSelection() {
  selectedMailAddresses.clear();
  renderMailSelection();
  audCount();
}
function getSelectedMailRecipients() {
  const selected = [], seenEmails = new Set();
  clients.filter(canMailClient).forEach(c => {
    clientEmailAddresses(c).forEach(email => {
      if (!selectedMailAddresses.has(mailAddressKey(c.id, email)) || seenEmails.has(email.toLowerCase())) return;
      seenEmails.add(email.toLowerCase());
      selected.push({ clientId: c.id, email });
    });
  });
  return selected;
}
function showMoreMailClients() {
  mailChoiceLimit += 100;
  renderMailSelection();
}
function loadTemplate(id) {
  const t = mailTpls.find(x => x.id === id); if (!t) return;
  if (($('#m_sub').value || $('#m_body').value) && !confirm('Replace the current subject and message with this template?')) return;
  $('#m_sub').value = t.subject; $('#m_body').value = t.body;
}
async function saveAsTemplate() {
  const subject = $('#m_sub').value.trim(), body = $('#m_body').value.trim();
  if (!subject && !body) return toast('Write a subject or message first');
  const name = prompt('Template name:', subject.slice(0, 50)); if (!name) return;
  const r = await api('/templates', 'POST', { name, subject, body });
  if (r.error) return toast(r.error);
  toast('Saved as template'); renderMail();
}
function toggleSequenceEditor() {
  const box = $('#sequenceEditor');
  if (!$('#m_sequence')?.checked) { box.innerHTML = ''; return; }
  const subject = $('#m_sub').value.trim() || 'Following up, {{name}}';
  const body = $('#m_body').value.trim() || 'Hi {{name}},\n\nI wanted to follow up on my earlier message. Please let me know if this is of interest.\n\nRegards,\nRight Head';
  box.innerHTML = [0, 2, 4, 6, 8].map((day, i) => `<details ${i === 0 ? 'open' : ''} style="margin:10px 0"><summary>${i === 0 ? 'Send now' : `After ${day * 24} hours`}</summary><label>Subject</label><input id="seq_sub_${i}" value="${esc(i ? `Re: ${subject}` : subject)}"><label>Message</label><textarea id="seq_body_${i}" style="min-height:100px">${esc(i ? `Hi {{name}},\n\nFollowing up on my earlier note.\n\n${body}` : body)}</textarea></details>`).join('');
}
async function sequenceAction(id, action) {
  if (!action) return;
  if (action === 'stop' && !confirm('Stop this follow-up sequence for all remaining recipients?')) return;
  try {
    if (action === 'resume') {
      const campaign = (await api('/campaigns')).find(c => c.id === id);
      const review = campaign?.recipients?.filter(r => r.status === 'review').length || 0;
      if (review && !confirm(`${review} message delivery status is unknown after a restart. Resume will skip those messages to avoid sending duplicates. Continue?`)) return;
    }
    await api(`/campaigns/${id}/action`, 'POST', { action }); toast(`Sequence ${action}d`); await renderMail();
  }
  catch (e) { toast(e.message); }
}
async function editSequence(id) {
  const campaign = (await api('/campaigns')).find(c => c.id === id);
  if (!campaign) return;
  const steps = campaign.steps.map(s => ({ ...s }));
  for (let i = 0; i < steps.length; i++) {
    const schedule = steps[i].day === 0 ? 'Send now' : `After ${steps[i].day * 24} hours`;
    const subject = prompt(`${schedule} subject`, steps[i].subject); if (subject === null) return;
    const body = prompt(`${schedule} message`, steps[i].body); if (body === null) return;
    steps[i] = { subject, body };
  }
  try { await api(`/campaigns/${id}/action`, 'POST', { action: 'edit', steps }); toast('Sequence updated'); await renderMail(); }
  catch (e) { toast(e.message); }
}
async function audCount() {
  const audience = $('#m_aud')?.value;
  if (!audience) return;
  if (audience === 'selected') {
    const count = getSelectedMailRecipients().length;
    $('#m_cnt').textContent = `${count} selected email address(es)`;
    return;
  }
  const r = await api('/mail/audience/' + audience);
  $('#m_cnt').textContent = `${r.count} recipient(s) with an eligible email address`;
}
async function sendMail() {
  const subject = $('#m_sub').value.trim(), body = $('#m_body').value.trim();
  if (!subject || !body) return toast('Subject and message are required');
  const audience = $('#m_aud').value;
  const recipients = audience === 'selected'
    ? getSelectedMailRecipients()
    : undefined;
  if (audience === 'selected' && !recipients.length) return toast('Select at least one email address');
  const sequence = $('#m_sequence')?.checked;
  const recipientLabel = audience === 'selected' ? `${recipients.length} selected email address(es)` : 'the selected audience';
  const replyToLast = $('#m_replyToLast')?.checked || false;
  const sendDescription = replyToLast ? ' as numbered replies in each recipient’s last email thread' : '';
  if (!confirm(sequence ? `Create this automated email sequence for ${recipientLabel}${sendDescription}? The first email sends when you press Start, then follow-ups send every 48 hours.` : `Send this campaign to ${recipientLabel}${sendDescription} now?`)) return;
  const button = $('#mailSendBtn');
  if (button) button.disabled = true;
  try {
  toast('Sending... please wait');
  const r = sequence
    ? await api('/sequences', 'POST', { audience, ...(recipients ? { recipients } : {}), replyToLast, steps: [0, 2, 4, 6, 8].map((day, i) => ({ day, subject: $(`#seq_sub_${i}`).value, body: $(`#seq_body_${i}`).value })) })
    : await api('/mail/send', 'POST', { audience, ...(recipients ? { recipients } : {}), subject, body, replyToLast });
  if (r.error) return toast(r.error);
  toast(sequence ? 'Sequence saved as paused. Press Start to send the first email now.' : `Done: ${r.sent}/${r.total} ${r.simulated ? 'simulated' : 'sent'}${r.failed ? ', ' + r.failed + ' failed' : ''}${r.skipped ? ', ' + r.skipped + ' skipped' : ''}`);
  await refresh(); render();
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------- settings & import ----------
async function renderSettings() {
  settings = await api('/settings'); const s = settings.smtp;
  const w = settings.whatsapp || {};
  const general = await aiSettingsPanel();
  const smtpConfigured = s.host && s.user;
  $('#view').innerHTML = `<div class="settings-grid">
    <!-- Block 1: General & AI Settings -->
    ${general}

    <!-- Block 2: Email (SMTP) Outreach -->
    <div class="panel">
      <h3>
        <span>✉️ Email (SMTP) Outreach</span>
        <span class="badge ${smtpConfigured ? 'b-onboarded' : 'b-contacted'}">${smtpConfigured ? 'SMTP Active' : 'Simulation Mode'}</span>
      </h3>
      <div class="form">
        <div><label>SMTP Host</label><input id="s_host" value="${esc(s.host)}" placeholder="smtp.gmail.com"></div>
        <div><label>Port</label><input id="s_port" value="${esc(s.port)}"></div>
        <div><label>Username</label><input id="s_user" value="${esc(s.user)}"></div>
        <div><label>Password / App Password</label><input id="s_pass" type="password" value="${esc(s.pass)}"></div>
        <div class="full"><label>From Address (e.g. Right Head &lt;you@company.com&gt;)</label><input id="s_from" value="${esc(s.from)}"></div>
        <div class="full"><label>Connection Type</label><select id="s_secure"><option value="false" ${s.secure ? '' : 'selected'}>No (STARTTLS, port 587)</option><option value="true" ${s.secure ? 'selected' : ''}>Yes (port 465)</option></select></div>
      </div>
      <div style="background:var(--grey-bg);padding:10px 12px;border-radius:var(--radius-md);margin-top:12px;border:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.45">
        ${smtpConfigured ? 'Outgoing mail server is configured.' : 'When unconfigured, mass emails run in <b>simulation mode</b> (logged safely without sending).'}
      </div>
      <div class="actions">
        <button class="btn primary" onclick="saveSettings()">Save Email Settings</button>
        <button class="btn" id="smtpTestBtn" onclick="testSmtp()">Save &amp; Test Connection</button>
      </div>
    </div>

    <div class="panel">
      <h3><span>WhatsApp Business Cloud API</span><span class="badge ${w.accessToken && w.phoneNumberId ? 'b-onboarded' : 'b-new'}">${w.accessToken && w.phoneNumberId ? 'Configured' : 'Setup needed'}</span></h3>
      <div class="form">
        <div class="full"><label>Permanent access token</label><input id="w_token" type="password" value="${esc(w.accessToken)}" placeholder="Paste Meta access token" autocomplete="new-password"></div>
        <div><label>Phone number ID</label><input id="w_phoneId" value="${esc(w.phoneNumberId || '')}"></div>
        <div><label>Graph API version</label><input id="w_version" value="${esc(w.apiVersion || '')}" placeholder="vXX.X"></div>
        <div><label>Webhook verify token</label><input id="w_verify" type="password" value="${esc(w.verifyToken)}" autocomplete="new-password"></div>
        <div><label>Meta app secret</label><input id="w_secret" type="password" value="${esc(w.appSecret)}" autocomplete="new-password"></div>
      </div>
      <div class="note">Secrets are encrypted in CRM storage. Webhook URL for delivery tracking: <code>${esc(location.origin)}/api/webhooks/whatsapp</code>. Configure the WhatsApp messages webhook in Meta. API accepted messages are marked delivered only when Meta confirms by webhook. Use approved templates as required by Meta.</div>
      <div class="actions"><button class="btn primary" onclick="saveSettings()">Save WhatsApp Settings</button><button class="btn" onclick="testWhatsApp(this)">Test Connection</button></div>
    </div>

    <!-- Block 3: Database Backup & Security -->
    <div class="panel">
      <h3>
        <span>🛡️ Database &amp; Security</span>
        <span class="badge b-onboarded">AES-256 Encrypted</span>
      </h3>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
        <div style="display:flex;gap:12px;align-items:center;background:var(--grey-bg);padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--line);">
          <div style="font-size:22px;line-height:1">💾</div>
          <div style="flex:1;">
            <div style="font-weight:600;font-size:13px;color:var(--ink);">Encrypted CRM Database</div>
            <div style="font-size:11.5px;color:var(--muted);">Neon PostgreSQL in production; SQLite remains available for isolated compatibility tests.</div>
          </div>
        </div>
        <div style="display:flex;gap:12px;align-items:center;background:var(--grey-bg);padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--line);">
          <div style="font-size:22px;line-height:1">🔒</div>
          <div style="flex:1;">
            <div style="font-weight:600;font-size:13px;color:var(--ink);">Field-Level AES-256-GCM Encryption</div>
            <div style="font-size:11.5px;color:var(--muted);">Every client, activity, task, deal, and password is encrypted at rest.</div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.45;margin-top:2px;">
          Store backups as confidential; production exports include decrypted record values. Keep the encryption key separately in your company password manager.
        </div>
      </div>
      <div class="actions">
        <a class="btn primary" href="/api/backup" style="width:100%;justify-content:center;">Download CRM Backup</a>
      </div>
    </div>

    <!-- Block 4: Import Clients Studio -->
    <div class="panel">
      <h3>
        <span>📥 Import Clients Studio</span>
        <span class="badge b-replied">Google Sheets / CSV / Excel</span>
      </h3>
      <div style="margin-bottom:10px;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Auto-matched columns:</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
          <span class="badge b-new" style="font-size:10.5px;">S No.</span>
          <span class="badge b-new" style="font-size:10.5px;">Date Added</span>
          <span class="badge b-new" style="font-size:10.5px;">Name</span>
          <span class="badge b-new" style="font-size:10.5px;">Link</span>
          <span class="badge b-new" style="font-size:10.5px;">Company Name</span>
          <span class="badge b-new" style="font-size:10.5px;">Location</span>
          <span class="badge b-new" style="font-size:10.5px;">Phone No</span>
          <span class="badge b-new" style="font-size:10.5px;">Email</span>
          <span class="badge b-new" style="font-size:10.5px;">Credentials Shared</span>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="background:var(--grey-bg);padding:10px 12px;border-radius:var(--radius-md);border:1px solid var(--line);">
          <label style="font-weight:600;font-size:12px;display:block;margin-bottom:4px;">Option 1: Upload CSV / Excel File</label>
          <input type="file" id="importFile" accept=".csv,.tsv,.xlsx,.xls" style="background:#fff;padding:6px 10px;font-size:12.5px;">
          <div style="display:flex;gap:8px;margin-top:6px;">
            <button class="btn primary small" onclick="importFile()">Upload &amp; Import</button>
            <a class="btn small" href="data:text/csv;charset=utf-8,S%20No.%2CDate%20Added%2CName%2CLink%2CCompany%20Name%2CLocation%2CPhone%20No%2CEmail%2CCredentials%20Shared%20Y%2F%20N%0A1%2C2026-10-18%2CAmit%20Sharma%2Chttps%3A%2F%2Flinkedin.com%2Fin%2Famit%2CABC%20Traders%2CMumbai%2C9876543210%2Camit%40abc.com%2CY" download="sample_client_data.csv">Sample CSV</a>
          </div>
        </div>
        <div>
          <label style="font-weight:600;font-size:12px;display:block;margin-bottom:4px;">Option 2: Direct Paste from Google Sheets (Ctrl+V)</label>
          <textarea id="importPaste" style="min-height:65px;font-family:monospace;font-size:11.5px;padding:6px 8px;" placeholder="Select rows in Google Sheets, copy (Ctrl+C), and paste here..."></textarea>
          <div style="margin-top:6px;">
            <button class="btn primary small" onclick="importPastedText()">Import Pasted Rows</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
async function saveSettings() {
  await api('/settings', 'PUT', { smtp: { host: $('#s_host').value, port: $('#s_port').value, user: $('#s_user').value, pass: $('#s_pass').value, from: $('#s_from').value, secure: $('#s_secure').value === 'true' }, whatsapp: { accessToken: $('#w_token').value, phoneNumberId: $('#w_phoneId').value, apiVersion: $('#w_version').value, verifyToken: $('#w_verify').value, appSecret: $('#w_secret').value } });
  settings = await api('/settings');
  toast('Settings saved');
}
async function testWhatsApp(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Testing...'; }
  try { await saveSettings(); const r = await api('/whatsapp/test', 'POST', {}); toast(`WhatsApp connected${r.phone ? `: ${r.phone}` : ''}`); }
  catch (e) { toast(e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; } }
}
async function testSmtp() {
  const btn = $('#smtpTestBtn'); btn.disabled = true; btn.textContent = 'Testing...';
  try {
    await saveSettings();
    await api('/mail/test', 'POST', {});
    toast('SMTP connection works - login accepted');
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = 'Save & Test Connection';
}
// ---------- header matching for CSV / Excel import ----------
const HEADER_ALIASES = {
  name: ['name', 'fullname', 'clientname', 'customername', 'contactname', 'contactperson', 'person'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'businessname', 'firm'],
  phone: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contactno', 'contactnumber', 'whatsapp', 'whatsappnumber', 'cell', 'telephone', 'tel'],
  email: ['email', 'emailid', 'emailaddress', 'mail', 'mailid'],
  alternateEmails: ['alternateemails', 'additionalemail', 'otheremail', 'secondaryemail', 'email2'],
  source: ['source', 'leadsource'],
  link: ['link', 'website', 'url', 'links', 'linkedin', 'profile', 'profileurl', 'profilelink', 'weburl', 'sheetlink'],
  stage: ['status', 'clientstatus', 'leadstatus', 'stage'],
  followUp: ['followup', 'nextfollowup', 'followupdate', 'nextfollowupdate'],
  lastReply: ['lastreply', 'latestreply'], callStatus: ['callstatus', 'callingstatus'],
  sno: ['sno', 'srno', 'slno', 'serialno', 'serialnumber'],
  dateadded: ['dateadded', 'date', 'addedon', 'addeddate', 'dateaddedon', 'entrydate', 'createddate', 'datecreated'],
  location: ['location', 'city', 'address', 'place', 'state', 'country', 'region'],
  credentialsshared: [
    'credentialsshared', 'credentialssharedyn', 'credentialssharedyorn', 'credentialssharedyesno',
    'credentialssharedyesorn', 'credentialshared', 'credentialsharedyn', 'credentialsharedyesno',
    'credentials', 'credentialsyn', 'credentialsyesno', 'credential', 'credentialsstatus', 'credsshared'
  ],
  remark: ['remark', 'remarks'], notes: ['notes', 'note', 'comments', 'comment'],
  meetingStatus: ['meetingstatus'], kanakNotes: ['kanaknotes'], avvniNotes: ['avvninotes'], emailSent: ['emailsent', 'emailsentyn']
};
for (let n = 1; n <= 12; n++) HEADER_ALIASES['reminder' + n] = ['reminder' + n];
const HEADER_LOOKUP = {};
Object.entries(HEADER_ALIASES).forEach(([field, list]) => list.forEach(a => { HEADER_LOOKUP[a] = field; }));
const STAGE_ALIASES = { new_lead: 'new', fresh: 'new', replied: 'replied', reply: 'replied', converted: 'onboarded', customer: 'onboarded', said_no: 'rejected', not_interested: 'rejected', lost: 'rejected' };

function parseFlexibleDate(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date((parseFloat(s) - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    const day = parseInt(dmy[1], 10), month = parseInt(dmy[2], 10) - 1, year = parseInt(dmy[3], 10);
    const hour = parseInt(dmy[4] || 0, 10), min = parseInt(dmy[5] || 0, 10), sec = parseInt(dmy[6] || 0, 10);
    const d = new Date(Date.UTC(year, month, day, hour, min, sec));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso.toISOString();
  return '';
}

// table = [headerRow, ...dataRows] -> array of objects. Headings are matched ignoring case, spaces, dots and symbols.
// Columns that are not recognised are kept in r.other so nothing is lost.
function rowsToObjects(table) {
  if (!table.length) throw new Error('The file is empty');
  const clean = h => String(h ?? '').replace(/^\uFEFF/, '').trim();
  const heads = table.shift().map(clean);
  const fields = heads.map(h => HEADER_LOOKUP[h.toLowerCase().replace(/[^a-z0-9]/g, '')] || '');
  return table.map(r => {
    const o = { other: [] };
    heads.forEach((h, i) => {
      const value = String(r[i] ?? '').trim(), f = fields[i];
      if (!value) return;
      if (f === 'alternateEmails') { (o.alternateEmails ||= []).push(value); return; }
      if (!f || o[f]) { if (h) o.other.push(`${h}: ${value}`); return; } // unknown or repeated column
      if (f === 'stage') { const s = value.toLowerCase().replace(/[\s-]+/g, '_'); o[f] = STAGE_ALIASES[s] || s; }
      else if (f === 'callStatus') o[f] = value.toLowerCase().replace(/[\s-]+/g, '_');
      else o[f] = value;
    });
    return o;
  });
}

function parseCsv(text) {
  const firstLine = (text.match(/^[^\r\n]*/)?.[0] || '');
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delimiter = tabCount > commaCount && tabCount > semiCount ? '\t'
                  : semiCount > commaCount && semiCount > tabCount ? ';'
                  : ',';

  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === delimiter) {
      cur.push(f); f = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(f); f = '';
      if (cur.some(x => x.trim())) rows.push(cur);
      cur = [];
    } else {
      f += ch;
    }
  }
  cur.push(f);
  if (cur.some(x => x.trim())) rows.push(cur);
  return rowsToObjects(rows);
}

function prepareImportRows(rawRows) {
  return rawRows.map(r => {
    const extras = [];
    if (r.sno) extras.push(`S No: ${r.sno}`);
    if (r.dateadded) extras.push(`Date Added: ${r.dateadded}`);
    if (r.link) extras.push(`Link: ${r.link}`);
    if (r.location) extras.push(`Location: ${r.location}`);
    if (r.credentialsshared) extras.push(`Credentials Shared: ${r.credentialsshared}`);
    if (r.remark) extras.push(`Remark: ${r.remark}`);
    for (let n = 1; n <= 12; n++) {
      const v = r['reminder' + n];
      if (v) extras.push(`Reminder ${n}: ${v}`);
    }
    if (r.meetingStatus) extras.push(`Meeting Status: ${r.meetingStatus}`);
    if (r.kanakNotes) extras.push(`Kanak Notes: ${r.kanakNotes}`);
    if (r.avvniNotes) extras.push(`Avvni Notes: ${r.avvniNotes}`);
    if (r.emailSent) extras.push(`Email Sent: ${r.emailSent}`);
    const existingNotes = r.notes ? String(r.notes).trim() : '';
    const notes = [existingNotes, ...extras, ...(r.other || [])].filter(Boolean).join(' | ');
    const validStage = Object.keys(STAGES).includes(r.stage) ? r.stage : 'new';
    const validCall = Object.keys(CALLS).includes(r.callStatus) ? r.callStatus : 'not_called';
    const row = {};
    if (r.name) row.name = r.name;
    if (r.company) row.company = r.company;
    if (r.phone) row.phone = r.phone;
    if (r.email) row.email = r.email;
    if (r.alternateEmails) row.alternateEmails = r.alternateEmails.flatMap(value => String(value).split(/[\s,;]+/)).filter(Boolean);
    if (r.location) row.location = r.location;
    if (r.source || r.link) row.source = r.source || r.link || '';
    if (r.dateadded) {
      const parsedDate = parseFlexibleDate(r.dateadded);
      if (parsedDate) row.createdAt = parsedDate;
    }
    if (notes) row.notes = notes;
    row.stage = validStage;
    row.callStatus = validCall;
    if (r.followUp) row.followUp = r.followUp;
    return row;
  });
}

async function executeImport(preparedRows) {
  let added = 0, skipped = 0; const reasons = {};
  try {
    for (let i = 0; i < preparedRows.length; i += 500) {
      const result = await api('/clients/import', 'POST', preparedRows.slice(i, i + 500));
      added += result.added; skipped += result.skipped;
      Object.entries(result.reasons || {}).forEach(([k, v]) => { reasons[k] = (reasons[k] || 0) + v; });
    }
  } catch (error) {
    toast(`Partial import: ${added} imported, ${skipped} skipped before the error. ${error.message}`);
    await refresh(); renderNav(); render();
    return;
  }
  const why = Object.entries(reasons).map(([k, v]) => `  ${v} x ${k}`).join('\n');
  alert(`Rows read from file/paste: ${preparedRows.length}\nImported: ${added}\nSkipped: ${skipped}${why ? '\n' + why : ''}`);
  await refresh(); renderNav(); render();
}

async function importFile() {
  const input = $('#importFile');
  const f = input.files[0]; if (!f) return toast('Choose a CSV or Excel file first');
  const name = f.name.toLowerCase();
  let rawRows;
  try {
    if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
      rawRows = parseCsv(await f.text());
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      if (typeof XLSX === 'undefined') throw new Error('The Excel reader did not load. Refresh the page (Ctrl+F5) or save the file as CSV.');
      const ab = await f.arrayBuffer();
      const workbook = XLSX.read(ab, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false, defval: '' });
      rawRows = rowsToObjects(json);
    } else {
      return toast('Please choose a .csv, .tsv, .xlsx or .xls file');
    }
  } catch (error) {
    return toast('Failed to read file: ' + error.message);
  }
  await executeImport(prepareImportRows(rawRows));
}

async function importPastedText() {
  const text = ($('#importPaste')?.value || '').trim();
  if (!text) return toast('Please paste your Google Sheet data into the box first');
  let rawRows;
  try {
    rawRows = parseCsv(text);
  } catch (error) {
    return toast('Failed to parse pasted data: ' + error.message);
  }
  await executeImport(prepareImportRows(rawRows));
}

// ---------- reminders (browser notifications) ----------
let notified = new Set();
function checkReminders() {
  const due = clients.filter(c => c.followUp && !['onboarded', 'rejected'].includes(c.stage) && new Date(c.followUp) <= new Date() && !notified.has(c.id + c.followUp));
  due.forEach(c => {
    notified.add(c.id + c.followUp);
    toast(`Follow-up due: ${c.name}`);
    if ('Notification' in window && Notification.permission === 'granted') new Notification('Follow-up due', { body: `${c.name} ${c.phone || ''}` });
  });
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
window.addEventListener('unhandledrejection', event => {
  console.error('CRM request failed:', event.reason);
  event.preventDefault();
  toast(event.reason && event.reason.message ? event.reason.message : 'The request could not be completed.');
});

(async function init() {
  try { applyTheme(localStorage.getItem('crm-theme') || 'light'); } catch (_) { applyTheme('light'); }
  settings = await api('/settings');
  applyTheme(settings.theme || document.documentElement.dataset.theme);
  $('#brandName').textContent = (settings.company || 'Company') + ' CRM';
  document.title = $('#brandName').textContent;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  await refresh(); render(); checkReminders();
  setInterval(async () => { if (document.hidden) return; await refresh(); checkReminders(); renderNav(); if (page === 'dashboard') renderDashboard(); }, 60000);
})();

// ---------- individual client email composer ----------
async function openSendMailModal(clientId, preferredEmail) {
  const c = clients.find(x => x.id === clientId);
  if (!c) return toast('Client not found');
  singleMailThread = null;
  const addresses = clientEmailAddresses(c);
  if (!addresses.length) return toast('This client has no email address');
  const defaultEmail = addresses.find(email => email.toLowerCase() === String(preferredEmail || '').toLowerCase()) ||
    addresses.find(email => email.toLowerCase() === String(c.email || '').toLowerCase()) || addresses[0];

  // Load templates if not loaded yet
  if (!mailTpls || !mailTpls.length) {
    try { mailTpls = await api('/templates'); } catch { mailTpls = []; }
  }

  $('#modalBox').innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <h2 style="margin:0">&#9993; Send Email to ${esc(c.name)}</h2>
    <button class="btn small" onclick="openClient('${clientId}')" title="Back to client" style="border:0;background:transparent;font-size:22px;cursor:pointer;color:var(--muted);padding:0 6px;line-height:1">&times;</button>
  </div>
  <div style="background:var(--grey-bg, #f8fafc);border:1px solid var(--border, #e2e8f0);padding:10px 14px;border-radius:var(--radius, 8px);margin-bottom:14px;font-size:13px;display:flex;gap:16px;flex-wrap:wrap">
    <div><b>Recipient:</b> ${esc(c.name)}</div>
    ${c.company ? `<div><b>Company:</b> ${esc(c.company)}</div>` : ''}
    ${c.stage ? `<div><b>Stage:</b> ${STAGES[c.stage] || c.stage}</div>` : ''}
  </div>
  <div class="form" style="display:block">
    <div style="margin-bottom:12px">
      <label>Email address</label>
      <select id="sm_to" onchange="refreshSingleMailThread('${clientId}')">${addresses.map(email => `<option value="${esc(email)}" ${email === defaultEmail ? 'selected' : ''}>${esc(email)}${email === defaultEmail ? ' · primary' : ''}</option>`).join('')}</select>
    </div>
    <div style="margin-bottom:12px">
      <label>Choose a Template (optional)</label>
      <select id="sm_tpl" onchange="applyTemplateToSingleMail('${clientId}', this.value)" style="width:100%">
        <option value="">- none (start from scratch) -</option>
        ${(mailTpls || []).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    <div style="margin-bottom:12px">
      <label>Subject *</label>
      <input id="sm_subject" style="width:100%" placeholder="e.g. Follow-up from Right Head regarding..." oninput="this.dataset.edited='true'">
    </div>
    <div id="sm_thread_notice" class="mail-thread-notice" aria-live="polite"></div>
    <label id="sm_new_thread_row" class="mail-thread-option" hidden><input id="sm_new_thread" type="checkbox" onchange="updateSingleMailThreadNotice()"> Start a new email conversation</label>
    <div style="margin-bottom:12px">
      <label>Message * (supports {{name}}, {{company}})</label>
      <textarea id="sm_body" style="width:100%;min-height:170px" placeholder="Hi ${esc(c.name || 'there')},&#10;&#10;..."></textarea>
      ${typeof aiWriterBox === 'function' ? aiWriterBox('sm_subject', 'sm_body') : ''}
    </div>
  </div>
  <div class="actions">
    <button class="btn" onclick="openClient('${clientId}')">Back to Client</button>
    <button id="sm_sendBtn" class="btn primary" onclick="sendSingleMail('${clientId}')" disabled>Send Email</button>
  </div>`;
  $('#modal').classList.remove('hidden');
  await refreshSingleMailThread(clientId);
}

async function refreshSingleMailThread(clientId) {
  const email = $('#sm_to')?.value;
  if (!email) return;
  const sendButton = $('#sm_sendBtn');
  if (sendButton) sendButton.disabled = true;
  try {
    const thread = await api(`/mail/thread?clientId=${encodeURIComponent(clientId)}&email=${encodeURIComponent(email)}`);
    if ($('#sm_to')?.value !== email) return;
    singleMailThread = { ...thread, email };
    updateSingleMailThreadNotice(true);
    if (sendButton) sendButton.disabled = false;
  } catch (error) {
    singleMailThread = null;
    const notice = $('#sm_thread_notice');
    if (notice) notice.textContent = `Could not load this email’s follow-up history: ${error.message}`;
  }
}
function updateSingleMailThreadNotice(resetSubject = false) {
  const thread = singleMailThread;
  const notice = $('#sm_thread_notice'), newThreadRow = $('#sm_new_thread_row'), newThread = $('#sm_new_thread');
  const subject = $('#sm_subject');
  if (!thread || !notice || !newThreadRow || !newThread || !subject) return;
  const continuing = thread.hasHistory && !newThread.checked;
  newThreadRow.hidden = !thread.hasHistory;
  subject.readOnly = continuing;
  if (continuing) {
    const n = thread.nextFollowUpNumber;
    notice.textContent = thread.canReply
      ? `Follow-up #${n}: this message will reply in the existing email thread.`
      : `Follow-up #${n}: the previous email has no saved thread ID, so this uses Re: and may appear as a new conversation.`;
  } else {
    notice.textContent = thread.hasHistory ? 'This email will start a new conversation.' : 'This is the first email to this address.';
  }
  if (resetSubject || !subject.dataset.edited) {
    subject.value = continuing ? `Re: ${thread.threadSubject}` : '';
    delete subject.dataset.edited;
  }
}

function applyTemplateToSingleMail(clientId, tplId) {
  const c = clients.find(x => x.id === clientId);
  if (!c) return;
  const t = (mailTpls || []).find(x => x.id === tplId);
  if (!t) return;
  const sub = $('#sm_subject'), body = $('#sm_body');
  if ((sub.value || body.value) && !confirm('Replace current subject and message with this template?')) return;
  const fill = (str) => String(str || '').replace(/{{\s*(name|company|email|phone)\s*}}/gi, (_, k) => c[k.toLowerCase()] || '');
  const continuing = Boolean(singleMailThread?.hasHistory && !$('#sm_new_thread')?.checked);
  sub.value = continuing ? `Re: ${singleMailThread.threadSubject}` : fill(t.subject);
  body.value = fill(t.body);
}

async function sendSingleMail(clientId) {
  const c = clients.find(x => x.id === clientId);
  if (!c) return toast('Client not found');
  const subject = $('#sm_subject').value.trim();
  const body = $('#sm_body').value.trim();
  const email = $('#sm_to').value;
  if (!singleMailThread || singleMailThread.email !== email) return toast('Wait for this email address’s follow-up history to load.');
  if (!subject || !body) return toast('Subject and message are required');
  const replyToLast = Boolean(singleMailThread?.hasHistory && !$('#sm_new_thread')?.checked);
  const followUpNumber = replyToLast ? singleMailThread.nextFollowUpNumber : 0;

  if (c.stage === 'rejected' && !confirm(`${c.name} is in the Red Zone (said no). Send anyway?`)) return;
  if (!confirm(replyToLast
    ? `Send follow-up #${followUpNumber} to ${email} in the existing email thread?`
    : `Send this email to ${email}?`)) return;

  const btn = $('#sm_sendBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

  try {
    const res = await api('/mail/send-one', 'POST', { clientId, email, subject, body, replyToLast });
    if (res.error) return toast('Failed: ' + res.error);

    toast(res.simulated
      ? `Simulated ${res.isFollowUp ? `follow-up #${res.followUpNumber}` : 'email'} to ${email} (logged in activity)`
      : res.isFollowUp ? `Follow-up #${res.followUpNumber} sent to ${email}` : `Email sent to ${email}`);
    await refresh();
    openClient(clientId);
    renderNav();
    if (page === 'dashboard') renderDashboard();
  } catch (err) {
    const msg = err.message || 'Unknown error';
    if (msg.includes('Sandbox') || msg.includes('resend.com/domains') || msg.includes('only send testing emails')) {
      alert(msg);
    } else {
      toast('Error: ' + msg);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Email'; }
  }
}
