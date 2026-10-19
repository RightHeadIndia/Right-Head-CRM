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
const badge = s => `<span class="badge b-${s}">${STAGES[s].split(' ')[0] === 'Said' ? 'Said No' : STAGES[s].split(' ')[0]}</span>`;
const fmt = d => d ? new Date(d).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
const isLate = d => d && new Date(d) < new Date();
const toLocalInput = d => { if (!d) return ''; const t = new Date(d); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 16); };

let clients = [];
let page = location.hash.slice(1) || 'dashboard';
let settings = {};
let openTaskCount;

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
    <div class="sep">Sales tools</div>${item('tasks')}${item('deals')}${item('reports')}
    <div class="sep">Outreach</div>${item('mail')}${item('templates')}
    <div class="sep">AI</div>${item('assistant')}
    <div class="sep">System</div>${item('settings')}`;
}

function go(p) { page = p; location.hash = p; render(); }
window.addEventListener('hashchange', () => { page = location.hash.slice(1) || 'dashboard'; render(); });

async function render() {
  $('#pageTitle').textContent = PAGES[page]?.title || 'Dashboard';
  renderNav();
  if (page === 'dashboard') return renderDashboard();
  if (page === 'mail') return renderMail();
  if (page === 'tasks') return renderTasks();
  if (page === 'deals') return renderDeals();
  if (page === 'reports') return renderReports();
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
    <div class="panel amber"><h3>Follow-up Reminders <a onclick="go('followups')">view all</a></h3>
      ${listItems(d.reminders, c => `<span class="${isLate(c.followUp) ? 'late' : ''}">${isLate(c.followUp) ? 'Overdue: ' : 'Today: '}${fmt(c.followUp)}</span> · ${esc(c.phone)}`)}
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
  if (q) rows = rows.filter(c => [c.name, c.company, c.phone, c.email].join(' ').toLowerCase().includes(q));
  rows.sort(cfg.sort || ((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  const stageFilter = page === 'clients' || page === 'calls'
    ? `<select id="stageF" onchange="renderList()"><option value="">All stages</option>${Object.keys(STAGES).map(k => `<option value="${k}" ${$('#stageF')?.value === k ? 'selected' : ''}>${STAGES[k]}</option>`).join('')}</select>` : '';
  if ($('#stageF') && $('#stageF').value) rows = rows.filter(c => c.stage === $('#stageF').value);
  $('#view').innerHTML = `<div class="toolbar">${stageFilter}<span style="color:var(--muted)">${rows.length} record(s)</span>${page === 'clients' ? exportBtn('clients') : ''}</div>
  <div class="table-wrap"><table><thead><tr><th>Client</th><th>Contact</th><th>Stage</th><th>Call status</th><th>Next follow-up</th><th>Actions</th></tr></thead><tbody>
  ${rows.map(c => `<tr class="row-${c.stage}">
    <td><b>${esc(c.name)}</b><br><small style="color:var(--muted)">${esc(c.company)}</small></td>
    <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a><br>` : ''}<small>${esc(c.email)}</small></td>
    <td>${badge(c.stage)}</td>
    <td><select onchange="quick('${c.id}',{callStatus:this.value})">${Object.keys(CALLS).map(k => `<option value="${k}" ${c.callStatus === k ? 'selected' : ''}>${CALLS[k]}</option>`).join('')}</select></td>
    <td class="${isLate(c.followUp) ? 'late' : ''}">${fmt(c.followUp)}</td>
    <td><button class="btn small" onclick="openClient('${c.id}')">Open</button>
      <button class="btn small danger" onclick="delClient('${c.id}')">Delete</button>
      ${c.phone ? `<a class="btn small" href="https://wa.me/${esc(c.phone.replace(/\D/g, ''))}" target="_blank">WhatsApp</a>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">No clients in this view.</td></tr>'}
  </tbody></table></div>`;
}
$('#search').addEventListener('input', () => {
  if (page === 'tasks') renderTasks(); else if (page === 'deals') renderDeals();
  else if (!['dashboard', 'mail', 'settings', 'reports', 'templates', 'assistant'].includes(page)) renderList();
});

async function quick(id, patch) { await api('/clients/' + id, 'PUT', patch); await refresh(); toast('Updated'); render(); }

// ---------- client modal ----------
async function openClient(id) {
  const c = id ? clients.find(x => x.id === id) : {};
  const acts = id ? await api(`/clients/${id}/activities`) : [];
  $('#modalBox').innerHTML = `<h2>${id ? esc(c.name) : 'Add Client'}</h2>
  <div class="form">
    <div><label>Name *</label><input id="f_name" value="${esc(c.name)}"></div>
    <div><label>Company</label><input id="f_company" value="${esc(c.company)}"></div>
    <div><label>Phone</label><input id="f_phone" value="${esc(c.phone)}"></div>
    <div><label>Email</label><input id="f_email" value="${esc(c.email)}"></div>
    <div><label>Stage</label><select id="f_stage">${Object.keys(STAGES).map(k => `<option value="${k}" ${(c.stage || 'new') === k ? 'selected' : ''}>${STAGES[k]}</option>`).join('')}</select></div>
    <div><label>Call status</label><select id="f_call">${Object.keys(CALLS).map(k => `<option value="${k}" ${(c.callStatus || 'not_called') === k ? 'selected' : ''}>${CALLS[k]}</option>`).join('')}</select></div>
    <div class="full"><label>Next follow-up (reminder)</label><input type="datetime-local" id="f_follow" value="${toLocalInput(c.followUp)}"></div>
    <div class="full"><label>Notes</label><textarea id="f_notes">${esc(c.notes)}</textarea></div>
  </div>
  <div class="actions">
    ${id ? `<button class="btn danger" onclick="delClient('${id}')">Delete client</button>` : ''}
    <button class="btn" onclick="closeModal()">Close</button>
    <button class="btn primary" onclick="saveClient('${id || ''}')">Save</button>
  </div>
  ${id ? clientAiPanel(id) + await clientExtras(id) : ''}
  ${id ? `<div class="timeline"><b>Log activity / client reply</b>
    <div style="display:flex;gap:8px;margin:8px 0"><input id="a_note" placeholder="Type note or paste the client's message...">
    <button class="btn small" onclick="addAct('${id}','note')">Add note</button>
    <button class="btn small primary" onclick="addAct('${id}','reply')">Client replied</button></div>
    ${acts.map(a => `<div><small>${fmt(a.at)} · ${a.type}</small><br>${esc(a.note)}</div>`).join('') || '<div class="empty">No activity yet.</div>'}</div>` : ''}`;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

async function saveClient(id) {
  const body = {
    name: $('#f_name').value.trim(), company: $('#f_company').value, phone: $('#f_phone').value, email: $('#f_email').value,
    stage: $('#f_stage').value, callStatus: $('#f_call').value, notes: $('#f_notes').value,
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

// ---------- mass mail ----------
let mailTpls = [];
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
      <select id="m_aud" onchange="audCount()"><option value="all">All clients with email (excluding Red Zone)</option>
        ${Object.keys(STAGES).filter(k => k !== 'rejected').map(k => `<option value="${k}">${STAGES[k]}</option>`).join('')}</select>
      <div id="m_cnt" class="empty"></div>
      <label>Start from a template</label>
      <select id="m_tpl" onchange="loadTemplate(this.value)"><option value="">- none -</option>${mailTpls.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <label style="margin-top:8px;display:block">Subject</label><input id="m_sub" placeholder="e.g. Hello {{name}}, a quick update from us">
      <label style="margin-top:8px;display:block">Message (use {{name}}, {{company}})</label>
      <textarea id="m_body" style="min-height:180px" placeholder="Hi {{name}},&#10;&#10;..."></textarea>
      ${aiWriterBox('m_sub', 'm_body')}
      <div class="actions"><button class="btn" onclick="saveAsTemplate()">Save as template</button><button id="mailSendBtn" class="btn primary" onclick="sendMail()">Send campaign</button></div>
    </div>
    <div class="panel"><h3>Campaign history</h3>
      ${camps.map(m => `<div class="item"><b>${esc(m.subject)}</b><small>${fmt(m.at)} · audience: ${esc(m.audience)} · ${m.sent}/${m.total} sent${m.simulated ? ' (simulated)' : ''}${m.failed ? ' · ' + m.failed + ' failed' : ''}${m.skipped ? ' · ' + m.skipped + ' skipped' : ''}${m.status === 'sending' ? ' · sending' : m.status === 'interrupted' ? ' · interrupted' : ''}</small>${m.errors && m.errors.length ? `<details><summary>${m.errors.length} send error(s)</summary>${m.errors.map(e => `<div class="empty">${esc(e)}</div>`).join('')}</details>` : ''}</div>`).join('') || '<div class="empty">No campaigns yet.</div>'}
    </div>
  </div>`;
  audCount();
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
async function audCount() { const r = await api('/mail/audience/' + $('#m_aud').value); $('#m_cnt').textContent = `${r.count} recipient(s) with an email address`; }
async function sendMail() {
  const subject = $('#m_sub').value.trim(), body = $('#m_body').value.trim();
  if (!subject || !body) return toast('Subject and message are required');
  if (!confirm('Send this campaign now?')) return;
  const button = $('#mailSendBtn');
  if (button) button.disabled = true;
  try {
  toast('Sending... please wait');
  const r = await api('/mail/send', 'POST', { audience: $('#m_aud').value, subject, body });
  if (r.error) return toast(r.error);
  toast(`Done: ${r.sent}/${r.total} ${r.simulated ? 'simulated' : 'sent'}${r.failed ? ', ' + r.failed + ' failed' : ''}${r.skipped ? ', ' + r.skipped + ' skipped' : ''}`);
  await refresh(); render();
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------- settings & import ----------
async function renderSettings() {
  settings = await api('/settings'); const s = settings.smtp;
  const general = await aiSettingsPanel();
  $('#view').innerHTML = `<div class="grid cols">${general}
  <div class="panel"><h3>Email (SMTP) for mass mailing</h3>
    <div class="form">
      <div><label>SMTP host</label><input id="s_host" value="${esc(s.host)}" placeholder="smtp.gmail.com"></div>
      <div><label>Port</label><input id="s_port" value="${esc(s.port)}"></div>
      <div><label>Username</label><input id="s_user" value="${esc(s.user)}"></div>
      <div><label>Password / App password</label><input id="s_pass" type="password" value="${esc(s.pass)}"></div>
      <div class="full"><label>From (e.g. Right Head &lt;you@company.com&gt;)</label><input id="s_from" value="${esc(s.from)}"></div>
      <div class="full"><label>Secure (SSL, port 465)</label><select id="s_secure"><option value="false" ${s.secure ? '' : 'selected'}>No (STARTTLS, port 587)</option><option value="true" ${s.secure ? 'selected' : ''}>Yes (port 465)</option></select></div>
    </div><div class="actions"><button class="btn primary" onclick="saveSettings()">Save settings</button></div></div>
  <div class="panel"><h3>Database backup</h3>
    <p class="empty">Download a checkpointed SQLite backup. CRM records and saved credentials in the database are encrypted; keep this backup and the encryption key in separate restricted locations.</p>
    <div class="actions"><a class="btn primary" href="/api/backup">Download encrypted backup</a></div></div>
  <div class="panel"><h3>Import clients from CSV or Excel</h3>
    <p style="font-size:13px;color:var(--muted)">First row must be headers. Supported: <code>name,company,phone,email</code> plus <code>S No., Date Added, Link, Company Name, Location, Phone No, Email, Meeting Status, Kanak Notes, Avvni Notes, Email Sent Y/N, Credentials Shared Y/N, Remark, Reminder 1..6</code>. Duplicates (same email or phone) are skipped.</p>
    <input type="file" id="importFile" accept=".csv,.xlsx,.xls">
    <div class="actions"><button class="btn primary" onclick="importFile()">Import</button>
    <a class="btn" href="data:text/csv;charset=utf-8,name,company,phone,email%0AAmit Sharma,ABC Traders,9876543210,amit@abc.com" download="sample.csv">Sample CSV</a></div></div>
  </div>`;
}
async function saveSettings() {
  await api('/settings', 'PUT', { smtp: { host: $('#s_host').value, port: $('#s_port').value, user: $('#s_user').value, pass: $('#s_pass').value, from: $('#s_from').value, secure: $('#s_secure').value === 'true' } });
  toast('Settings saved');
}
// ---------- header matching for CSV / Excel import ----------
const HEADER_ALIASES = {
  name: ['name', 'fullname', 'clientname', 'customername', 'contactname', 'contactperson', 'person'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'businessname', 'firm'],
  phone: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contactno', 'contactnumber', 'whatsapp', 'whatsappnumber', 'cell', 'telephone', 'tel'],
  email: ['email', 'emailid', 'emailaddress', 'mail', 'mailid'],
  source: ['source', 'leadsource'], link: ['link', 'website', 'url'],
  stage: ['status', 'clientstatus', 'leadstatus', 'stage'],
  followUp: ['followup', 'nextfollowup', 'followupdate', 'nextfollowupdate'],
  lastReply: ['lastreply', 'latestreply'], callStatus: ['callstatus', 'callingstatus'],
  sno: ['sno', 'srno', 'slno', 'serialno'], dateadded: ['dateadded', 'date', 'addedon'],
  location: ['location', 'city', 'address'], credentialsshared: ['credentialsshared', 'credentialssharedyn'],
  remark: ['remark', 'remarks'], notes: ['notes', 'note', 'comments', 'comment'],
  meetingStatus: ['meetingstatus'], kanakNotes: ['kanaknotes'], avvniNotes: ['avvninotes'], emailSent: ['emailsent', 'emailsentyn']
};
for (let n = 1; n <= 12; n++) HEADER_ALIASES['reminder' + n] = ['reminder' + n];
const HEADER_LOOKUP = {};
Object.entries(HEADER_ALIASES).forEach(([field, list]) => list.forEach(a => { HEADER_LOOKUP[a] = field; }));
const STAGE_ALIASES = { new_lead: 'new', fresh: 'new', replied: 'replied', reply: 'replied', converted: 'onboarded', customer: 'onboarded', said_no: 'rejected', not_interested: 'rejected', lost: 'rejected' };

// table = [headerRow, ...dataRows] -> array of objects. Headings are matched ignoring case, spaces, dots and symbols.
// Columns that are not recognised are kept in r.other so nothing is lost.
function rowsToObjects(table) {
  if (!table.length) throw new Error('The file is empty');
  const clean = h => String(h ?? '').replace(/^﻿/, '').trim();
  const heads = table.shift().map(clean);
  const fields = heads.map(h => HEADER_LOOKUP[h.toLowerCase().replace(/[^a-z0-9]/g, '')] || '');
  return table.map(r => {
    const o = { other: [] };
    heads.forEach((h, i) => {
      const value = String(r[i] ?? '').trim(), f = fields[i];
      if (!value) return;
      if (!f || o[f]) { if (h) o.other.push(`${h}: ${value}`); return; } // unknown or repeated column
      if (f === 'stage') { const s = value.toLowerCase().replace(/[\s-]+/g, '_'); o[f] = STAGE_ALIASES[s] || s; }
      else if (f === 'callStatus') o[f] = value.toLowerCase().replace(/[\s-]+/g, '_');
      else o[f] = value;
    });
    return o;
  });
}

function parseCsv(text) {
  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { cur.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; cur.push(f); f = ''; if (cur.some(x => x.trim())) rows.push(cur); cur = []; }
    else f += ch;
  }
  cur.push(f); if (cur.some(x => x.trim())) rows.push(cur);
  return rowsToObjects(rows);
}
async function importFile() {
  const input = $('#importFile');
  const f = input.files[0]; if (!f) return toast('Choose a CSV or Excel file first');
  const name = f.name.toLowerCase();
  let rows;
  try {
    if (name.endsWith('.csv')) {
      rows = parseCsv(await f.text());
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const ab = await f.arrayBuffer();
      const workbook = XLSX.read(ab, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false, defval: '' });
      rows = rowsToObjects(rows);
    } else {
      return toast('Please choose a .csv, .xlsx or .xls file');
    }
  } catch (error) {
    return toast('Failed to read file: ' + error.message);
  }

  // Map imported columns to CRM fields; store extra columns (S No, Date Added, Link,
  // Location, Credentials Shared, Remark, Reminder 1-6, Meeting Status, Kanak Notes,
  // Avvni Notes, Email Sent Y/N) in notes so nothing is lost.
  rows = rows.map(r => {
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
    if (r.name) row.name = r.name || r.company || r.email || r.phone || '';
    if (r.company) row.company = r.company;
    if (r.phone) row.phone = r.phone;
    if (r.email) row.email = r.email;
    if (r.source || r.link) row.source = r.source || r.link || '';
    if (notes) row.notes = notes;
    row.stage = validStage;
    row.callStatus = validCall;
    if (r.followUp) row.followUp = r.followUp;
    return row;
  });

  let added = 0, skipped = 0;
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const result = await api('/clients/import', 'POST', rows.slice(i, i + 500));
      added += result.added; skipped += result.skipped;
    }
  } catch (error) {
    toast(`Partial import: ${added} imported, ${skipped} skipped before the error. ${error.message}`);
    await refresh(); renderNav(); render();
    return;
  }
  toast(`Imported ${added}, skipped ${skipped}`); await refresh(); renderNav(); render();
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
  settings = await api('/settings');
  $('#brandName').textContent = (settings.company || 'Company') + ' CRM';
  document.title = $('#brandName').textContent;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  await refresh(); render(); checkReminders();
  setInterval(async () => { await refresh(); checkReminders(); renderNav(); }, 60000);
})();