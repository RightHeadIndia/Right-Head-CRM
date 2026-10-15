/* Claude-powered features UI. Loaded before app.js; uses its helpers at call time. */

const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })();
const DRAFT_GOALS = {
  intro: 'First introduction', followup: 'Follow-up (no reply yet)', reply: 'Reply to their latest message', proposal: 'Nudge on proposal / quote',
  welcome: 'Welcome after onboarding', reengage: 'Re-engage (gone quiet)', thanks: 'Thank-you after a call'
};
const GOAL_BY_STAGE = { new: 'intro', contacted: 'followup', replied: 'reply', onboarded: 'welcome', rejected: 'thanks' };
const TONES = { friendly: 'Friendly', professional: 'Professional', casual: 'Casual', formal: 'Formal' };
const INTENT = {
  interested: 'Interested', question: 'Has a question', objection: 'Objection', not_now: 'Not now', not_interested: 'Not interested',
  unsubscribe: 'Wants to stop', out_of_office: 'Auto-reply / away', other: 'Other'
};

// Calls an AI endpoint, shows friendly errors, disables the button while waiting. Returns null on failure.
async function aiCall(path, body, btn) {
  const label = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking...'; }
  try {
    const r = await api(path, 'POST', { ...body, tz: TZ });
    if (r.error) { toast(r.error); return null; }
    return r;
  } catch (e) { toast('Could not reach the server. Is it running?'); return null; }
  finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}

// Tiny safe markdown: escape first, then allow **bold** and "- " bullet lists
function md(s) {
  const inline = t => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let out = '', list = false;
  esc(s).split('\n').forEach(l => {
    const m = /^\s*[-*•]\s+(.*)$/.exec(l);
    if (m) { if (!list) { out += '<ul>'; list = true; } out += `<li>${inline(m[1])}</li>`; }
    else { if (list) { out += '</ul>'; list = false; } if (l.trim()) out += `<p>${inline(l)}</p>`; }
  });
  return out + (list ? '</ul>' : '');
}
const copyText = async t => { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (_) { toast('Could not copy - select the text and copy it manually'); } };

// ======================= AI panel inside the client modal =======================
let aiClientId = '', lastAnalysis = null;
const aiClient = () => clients.find(c => c.id === aiClientId);

function clientAiPanel(id) {
  aiClientId = id; lastAnalysis = null;
  return `<div class="aibox"><b>&#10024; AI help</b>
    <div class="ai-btns">
      <button class="btn small" onclick="aiSummarize(this)">Summarize client</button>
      <button class="btn small" onclick="aiShowDraftForm()">Draft message</button>
      <button class="btn small" onclick="aiAnalyze(this)">Analyze reply</button>
    </div>
    <div id="aiOut"></div></div>`;
}

async function aiSummarize(btn) {
  const r = await aiCall('/ai/summary', { clientId: aiClientId }, btn); if (!r) return;
  const risk = { none: 'No risk', low: 'Low risk', medium: 'Medium risk', high: 'High risk' }[r.risk];
  $('#aiOut').innerHTML = `<div class="ai-card"><p>${esc(r.summary)} <span class="badge risk-${r.risk}">${risk}</span></p>
    ${r.key_points.length ? `<b>Key points</b><ul>${r.key_points.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${r.open_items.length ? `<b>Still open</b><ul>${r.open_items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <p><b>Suggested next step:</b> ${esc(r.next_step)}</p></div>`;
}

function aiShowDraftForm(prefill) {
  const c = aiClient(); if (!c) return;
  $('#aiOut').innerHTML = `<div class="ai-card"><div class="form">
    <div><label>What is it for?</label><select id="ai_goal">${Object.keys(DRAFT_GOALS).map(k => `<option value="${k}" ${GOAL_BY_STAGE[c.stage] === k ? 'selected' : ''}>${DRAFT_GOALS[k]}</option>`).join('')}</select></div>
    <div><label>Channel</label><select id="ai_channel"><option value="email" ${c.email || !c.phone ? 'selected' : ''}>Email</option><option value="whatsapp" ${!c.email && c.phone ? 'selected' : ''}>WhatsApp</option><option value="sms">SMS</option></select></div>
    <div><label>Tone</label><select id="ai_tone">${Object.keys(TONES).map(k => `<option value="${k}">${TONES[k]}</option>`).join('')}</select></div>
    <div><label>Or start from a template</label><select id="ai_tpl" onchange="aiFromTemplate(this.value)"><option value="">-</option></select></div>
    <div class="full"><label>Anything to include? (optional)</label><input id="ai_extra" placeholder="e.g. mention the demo on Friday, offer a 10% discount"></div>
  </div><div class="actions"><button class="btn primary small" onclick="aiDraft(this)">Write draft</button></div>
  <div id="aiDraftOut"></div></div>`;
  api('/templates').then(list => { window.aiTpls = list; const s = $('#ai_tpl'); if (s) s.innerHTML += list.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join(''); });
}
function aiFromTemplate(id) {
  const t = (window.aiTpls || []).find(x => x.id === id), c = aiClient(); if (!t || !c) return;
  renderDraftOut({ subject: fillTpl(t.subject, c), body: fillTpl(t.body, c), channel: 'email' });
  $('#ai_channel').value = 'email';
}

async function aiDraft(btn) {
  const r = await aiCall('/ai/draft', {
    clientId: aiClientId, goal: $('#ai_goal').value, channel: $('#ai_channel').value, tone: $('#ai_tone').value, instructions: $('#ai_extra').value
  }, btn);
  if (r) renderDraftOut(r);
}

// Editable draft with send / copy actions. Nothing is sent without the user clicking.
function renderDraftOut(d) {
  const c = aiClient(); if (!c) return;
  let out = $('#aiDraftOut');
  if (!out) { aiShowDraftForm(); out = $('#aiDraftOut'); }
  const wa = d.channel === 'whatsapp' || d.channel === 'sms';
  out.innerHTML = `<div style="margin-top:12px">
    ${wa ? '' : `<label>Subject</label><input id="dr_subject" value="${esc(d.subject)}">`}
    <label style="margin-top:8px;display:block">Message (edit before using)</label><textarea id="dr_body" style="min-height:170px">${esc(d.body)}</textarea>
    <div class="note" style="margin-top:8px">AI drafts can be wrong. Check names, facts and any [bracketed] blanks before sending.</div>
    <div class="actions">
      <button class="btn small" onclick="copyText($('#dr_body').value)">Copy</button>
      ${d.channel === 'whatsapp' && c.phone ? `<button class="btn small" onclick="window.open('https://wa.me/'+'${esc(c.phone.replace(/\D/g, ''))}'+'?text='+encodeURIComponent($('#dr_body').value),'_blank')">Open in WhatsApp</button>` : ''}
      ${!wa && c.email ? `<button class="btn small primary" onclick="aiSendEmail(this)">Send email now</button>` : ''}
    </div></div>`;
}

async function aiSendEmail(btn) {
  const c = aiClient(); const subject = $('#dr_subject').value.trim(), body = $('#dr_body').value.trim();
  if (!subject || !body) return toast('Subject and message are required');
  if (/\[[^\]]+\]/.test(body + subject) && !confirm('The message still contains [bracketed] blanks. Send anyway?')) return;
  if (c.stage === 'rejected' && !confirm(`${c.name} is in the Red Zone (said no). Send anyway?`)) return;
  if (!confirm(`Send this email to ${c.email}?`)) return;
  btn.disabled = true;
  const r = await api('/mail/send-one', 'POST', { clientId: c.id, subject, body });
  btn.disabled = false;
  if (r.error) return toast(r.error);
  toast(r.simulated ? 'Simulated send (SMTP not configured) - logged in activity' : 'Email sent');
  await refresh(); openClient(c.id); renderNav();
}

async function aiAnalyze(btn) {
  const c = aiClient(); const typed = ($('#a_note') ? $('#a_note').value : '').trim();
  if (!typed && !c.lastReply) return toast("Paste the client's message into the box below first, then click Analyze reply.");
  const r = await aiCall('/ai/analyze-reply', { clientId: c.id, text: typed || undefined }, btn); if (!r) return;
  lastAnalysis = { ...r, isNew: !!typed };
  const days = r.follow_up_days;
  const changes = [r.suggested_stage !== c.stage && ['replied', 'onboarded', 'rejected'].includes(r.suggested_stage) ? `move to ${STAGES[r.suggested_stage]}` : '', days ? `set follow-up in ${days} day(s)` : '', typed ? 'record the message as a client reply' : ''].filter(Boolean);
  $('#aiOut').innerHTML = `<div class="ai-card">
    <p><span class="badge sent-${r.sentiment}">${r.sentiment}</span> <span class="badge b-new">${INTENT[r.intent]}</span></p>
    <p>${esc(r.summary)}</p><p><b>Next step:</b> ${esc(r.next_step)}</p>
    ${r.suggested_reply ? `<b>Suggested reply</b><textarea id="ai_reply" style="min-height:90px">${esc(r.suggested_reply)}</textarea>
      <div class="actions" style="justify-content:flex-start"><button class="btn small" onclick="copyText($('#ai_reply').value)">Copy</button>
      <button class="btn small" onclick="aiReplyToDraft()">Edit &amp; send...</button></div>` : '<p class="empty">No reply recommended.</p>'}
    <div class="actions" style="justify-content:flex-start"><button class="btn primary small" onclick="aiApplyAnalysis(this)" ${changes.length ? '' : 'disabled'}>Apply: ${esc(changes.join(', ') || 'nothing to change')}</button></div></div>`;
}
function aiReplyToDraft() {
  const c = aiClient();
  aiShowDraftForm();
  const email = c.email || !c.phone;
  $('#ai_channel').value = email ? 'email' : 'whatsapp';
  renderDraftOut({ subject: email ? 'Re: ' : '', body: $('#ai_reply') ? $('#ai_reply').value : lastAnalysis.suggested_reply, channel: email ? 'email' : 'whatsapp' });
}
async function aiApplyAnalysis(btn) {
  const a = lastAnalysis, c = aiClient(); if (!a || !c) return;
  const stage = ['replied', 'onboarded', 'rejected'].includes(a.suggested_stage) ? a.suggested_stage : '';
  if ((stage === 'rejected' || stage === 'onboarded') && !confirm(`Move ${c.name} to ${STAGES[stage]}? This also clears their follow-up reminder.`)) return;
  btn.disabled = true;
  if (a.isNew) await api(`/clients/${c.id}/activity`, 'POST', { type: 'reply', note: a.text });
  const patch = {};
  if (stage) patch.stage = stage;
  if (a.follow_up_days && stage !== 'rejected' && stage !== 'onboarded') { const d = new Date(); d.setDate(d.getDate() + a.follow_up_days); d.setHours(10, 0, 0, 0); patch.followUp = d.toISOString(); }
  if (Object.keys(patch).length) await api('/clients/' + c.id, 'PUT', patch);
  await api(`/clients/${c.id}/activity`, 'POST', { type: 'note', note: `AI analysis: ${a.summary} Next: ${a.next_step}` });
  await refresh(); toast('Applied'); openClient(c.id); render();
}

// ======================= Campaign writer (mass mail page + templates page) =======================
let aiVariants = [];
function aiWriterBox(subjectId, bodyId) {
  return `<details class="aibox"><summary>&#10024; Write with AI</summary>
    <label>What is this email about?</label>
    <textarea id="aw_goal" style="min-height:70px" placeholder="e.g. Tell small shop owners about our new GST filing service and offer a free 15-minute consultation this month"></textarea>
    <div class="ai-btns"><select id="aw_tone" style="width:auto">${Object.keys(TONES).map(k => `<option value="${k}">${TONES[k]}</option>`).join('')}</select>
      <select id="aw_n" style="width:auto"><option value="1">1 version</option><option value="2" selected>2 versions</option><option value="3">3 versions</option></select>
      <button class="btn primary small" onclick="aiWrite('${subjectId}','${bodyId}',this)">Generate</button></div>
    <div id="aw_out"></div></details>`;
}
async function aiWrite(subjectId, bodyId, btn) {
  const goal = $('#aw_goal').value.trim(); if (!goal) return toast('Describe what the email is about first');
  const r = await aiCall('/ai/campaign', { goal, tone: $('#aw_tone').value, variants: +$('#aw_n').value, audience: $('#m_aud') ? $('#m_aud').value : 'all' }, btn); if (!r) return;
  aiVariants = r.variants;
  $('#aw_out').innerHTML = r.variants.map((v, i) => `<div class="ai-card"><b>${esc(v.label)}</b> &middot; <span style="color:var(--muted)">${esc(v.subject)}</span>
    <div class="pre">${esc(v.body)}</div>
    <div class="actions" style="justify-content:flex-start"><button class="btn small primary" onclick="aiUseVariant(${i},'${subjectId}','${bodyId}')">Use this version</button></div></div>`).join('') +
    '<div class="note">Check the text, then fill any [bracketed] blanks before sending. {{name}} and {{company}} are filled in for each client automatically.</div>';
}
function aiUseVariant(i, subjectId, bodyId) {
  const v = aiVariants[i]; if (!v) return;
  $('#' + subjectId).value = v.subject; $('#' + bodyId).value = v.body;
  toast('Copied into the form - edit as needed');
}

// ======================= CRM assistant page =======================
let chat = [], chatBusy = false;
const CHAT_IDEAS = ['Who should I follow up with today?', 'Summarize my pipeline and anything at risk', 'Which clients replied but have no follow-up set?', 'How did we do in the last 30 days?', 'List my overdue tasks'];

async function renderAssistant() {
  const st = await api('/ai/status');
  $('#view').innerHTML = `${st.configured ? '' : '<div class="note">AI is not set up yet. Add your Anthropic API key in <a href="#settings">Settings</a>.</div>'}
  <div class="chat"><div id="chatLog" class="chat-log"></div>
    <div class="chat-in"><textarea id="chatInput" rows="2" placeholder="Ask about your clients, deals, tasks or results... (Enter to send, Shift+Enter for a new line)"></textarea>
      <div><button class="btn primary" id="chatSend" onclick="chatSend()">Send</button><br><button class="btn small" style="margin-top:6px" onclick="chat=[];renderAssistant()">Clear</button></div></div></div>`;
  $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); } });
  drawChat();
}
function drawChat() {
  const log = $('#chatLog'); if (!log) return;
  log.innerHTML = (chat.length ? chat.map(m => `<div class="msg ${m.role}">${m.role === 'assistant' ? md(m.content) : `<p>${esc(m.content)}</p>`}
      ${(m.actions || []).map(a => `<div class="chip-act">&#10003; ${esc(a.text)}</div>`).join('')}</div>`).join('')
    : `<div class="empty" style="padding:14px">Try one of these:</div><div class="chips">${CHAT_IDEAS.map(q => `<button class="btn small" onclick="chatSend(this.textContent)">${esc(q)}</button>`).join('')}</div>`)
    + (chatBusy ? '<div class="msg assistant"><p class="empty">Thinking...</p></div>' : '');
  log.scrollTop = log.scrollHeight;
}
async function chatSend(text) {
  if (chatBusy) return;
  const inp = $('#chatInput'); text = (text || inp.value).trim(); if (!text) return;
  inp.value = ''; chat.push({ role: 'user', content: text }); chatBusy = true; drawChat();
  const r = await aiCall('/ai/assistant', { messages: chat.map(m => ({ role: m.role, content: m.content })) });
  chatBusy = false;
  if (r) {
    chat.push({ role: 'assistant', content: r.reply, actions: r.actions });
    if (r.actions && r.actions.length) { await refresh(); renderNav(); }
  } else chat.pop(); // failed: remove the question so it can be re-sent (error already shown)
  if (page === 'assistant') { drawChat(); if (!r && $('#chatInput')) $('#chatInput').value = text; }
}

// ======================= Settings: general + AI =======================
async function aiSettingsPanel() {
  const st = await api('/ai/status'); const s = settings;
  const where = st.source === 'env' ? 'Using the ANTHROPIC_API_KEY set on the server.' : st.source === 'settings' ? 'Using the key saved below.' : 'No key yet.';
  return `<div class="panel"><h3>General &amp; AI</h3>
    <div class="form">
      <div><label>Company name</label><input id="g_company" value="${esc(s.company)}"></div>
      <div><label>Currency symbol (deals, reports)</label><input id="g_cur" value="${esc(s.currency)}" maxlength="4"></div>
      <div class="full"><label>Anthropic API key (for the AI features)</label><input id="g_key" type="password" value="${esc(s.ai && s.ai.apiKey)}" placeholder="sk-ant-..." autocomplete="off"></div>
      <div class="full"><label>Claude model (leave blank for the default: ${esc(st.model)})</label><input id="g_model" value="${esc(s.ai && s.ai.model)}" placeholder="${esc(st.model)}"></div>
    </div>
    <p class="empty">${where} Get a key at console.anthropic.com. When you use an AI button, the details of that client (name, company, notes, recent activity and messages) are sent to Anthropic to generate the answer. The CRM assistant can also look at any client when you ask about them.</p>
    <div class="actions"><button class="btn" onclick="aiTest(this)">Test AI connection</button><button class="btn primary" onclick="saveGeneral()">Save</button></div></div>`;
}
async function saveGeneral() {
  await api('/settings', 'PUT', { company: $('#g_company').value, currency: $('#g_cur').value, ai: { apiKey: $('#g_key').value, model: $('#g_model').value } });
  settings = await api('/settings');
  $('#brandName').textContent = (settings.company || 'Company') + ' CRM'; document.title = $('#brandName').textContent;
  toast('Saved'); renderSettings();
}
async function aiTest() {
  await saveGeneral(); // save first so the key just typed is the one tested
  toast('Testing...');
  const r = await aiCall('/ai/test', {});
  if (r) toast('AI is working (model: ' + r.model + ')');
}
