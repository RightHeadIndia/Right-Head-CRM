const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PASSWORD = 'test-password-123456';
let proc, base, cookie = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-api-'));

async function call(method, url, body, opts = {}) {
  const r = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(opts.nocookie ? {} : { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

test.before(async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), APP_PASSWORD: PASSWORD, CRM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), CRM_DB_FILE: path.join(dir, 'crm.sqlite'), GROQ_API_KEY: '', AI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', d => { if (String(d).includes('CRM running')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', d => { if (/Error/.test(String(d))) { clearTimeout(t); reject(new Error(String(d))); } });
  });
});
test.after(() => { if (proc) proc.kill(); });

test('everything requires login', async () => {
  assert.equal((await call('GET', '/api/clients', undefined, { nocookie: true })).status, 401);
  const page = await call('GET', '/', undefined, { nocookie: true });
  assert.equal(page.status, 302);
  assert.equal((await call('GET', '/login.html', undefined, { nocookie: true })).status, 200);
  assert.equal((await call('GET', '/api/backup', undefined, { nocookie: true })).status, 401);
});

test('wrong password is refused, right password signs in', async () => {
  assert.equal((await call('POST', '/api/auth/login', { password: 'nope' }, { nocookie: true })).status, 401);
  const ok = await call('POST', '/api/auth/login', { password: PASSWORD }, { nocookie: true });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/auth/session')).json.authenticated, true);
});

test('Excel reader is served locally (CSP blocks CDNs)', async () => {
  const r = await call('GET', '/vendor/xlsx.full.min.js');
  assert.equal(r.status, 200);
  assert.ok(r.text.length > 100000);
  const logo = await call('GET', '/Right%20head%20Logo.png');
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /image\/png/);
});

test('client create / validate / update', async () => {
  assert.equal((await call('POST', '/api/clients', { name: '' })).status, 400);
  const c = await call('POST', '/api/clients', { name: 'Amit', email: 'amit@abc.com', alternateEmails: ['accounts@abc.com', 'amit@abc.com'], phone: '9876543210' });
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.alternateEmails, ['accounts@abc.com']);
  assert.equal((await call('PUT', `/api/clients/${c.json.id}`, { alternateEmails: ['bad-address'] })).status, 400);
  const up = await call('PUT', '/api/clients/' + c.json.id, { callStatus: 'connected' });
  assert.equal(up.json.stage, 'contacted');
  assert.deepEqual(up.json.alternateEmails, ['accounts@abc.com']);
});

test('import is forgiving, skips duplicates and says why', async () => {
  const rows = [
    { company: 'ABC Traders', phone: '98 111 22233', email: 'a@abc.com / sales@abc.com', notes: 'Location: Pune' },
    { company: 'Junk Contact Ltd', email: 'NA', phone: 'call office' },
    { name: 'Dup of Amit', phone: '+91 98765 43210' },
    { name: 'Bad date', email: 'ok@x.in', followUp: 'someday', stage: 'weird' },
    {}, 'junk'
  ];
  const r = await call('POST', '/api/clients/import', rows);
  assert.equal(r.json.added, 3);
  assert.equal(r.json.skipped, 3);
  assert.ok(r.json.reasons['same email or phone already exists'] === 1);
  const all = (await call('GET', '/api/clients')).json;
  const abc = all.find(c => c.name === 'ABC Traders');
  assert.equal(abc.email, 'a@abc.com');
  assert.deepEqual(abc.alternateEmails, ['sales@abc.com']);
  assert.match(abc.notes, /Email as written: a@abc.com \/ sales@abc.com/);
  assert.equal(all.find(c => c.name === 'Bad date').stage, 'new');
  const junk = all.find(c => c.name === 'Junk Contact Ltd');
  assert.equal(junk.phone, '');
  assert.match(junk.notes, /Phone as written: call office/);
  assert.equal((await call('POST', '/api/clients/import', { not: 'array' })).status, 400);
});

test('import supports Google Sheet columns: location, link, and custom fields', async () => {
  const rows = [
    {
      name: 'Priya Sharma',
      company: 'NextGen Retail',
      phone: '9876599999',
      email: 'priya@nextgen.com',
      location: 'Bangalore',
      source: 'https://linkedin.com/in/priyasharma',
      notes: 'S No: 101 | Date Added: 18/10/2026 | Location: Bangalore | Credentials Shared: Y',
      dateAdded: '2026-10-18T00:00:00.000Z'
    }
  ];
  const r = await call('POST', '/api/clients/import', rows);
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 1);
  const all = (await call('GET', '/api/clients')).json;
  const found = all.find(c => c.name === 'Priya Sharma');
  assert.ok(found);
  assert.equal(found.location, 'Bangalore');
  assert.equal(found.source, 'https://linkedin.com/in/priyasharma');
  assert.match(found.notes, /Credentials Shared: Y/);
  assert.equal(found.createdAt, '2026-10-18T00:00:00.000Z');
});

test('tasks, deals, templates, reports, exports', async () => {
  const amit = (await call('GET', '/api/clients')).json.find(c => c.name === 'Amit');
  const t = await call('POST', '/api/tasks', { title: 'Send quote', clientId: amit.id, dueAt: '2026-10-20T10:00:00Z', priority: 'high' });
  assert.equal(t.status, 200);
  assert.equal((await call('PUT', '/api/tasks/' + t.json.id, { done: true })).json.done, true);
  const d = await call('POST', '/api/deals', { title: 'GST pkg', clientId: amit.id, value: 50000, stage: 'proposal' });
  assert.equal((await call('PUT', '/api/deals/' + d.json.id, { stage: 'won' })).json.stage, 'won');
  assert.equal((await call('POST', '/api/deals', { title: 'x', value: -1 })).status, 400);
  assert.equal((await call('POST', '/api/templates', { name: 'Intro', subject: 'Hi {{name}}', body: 'Hello' })).status, 200);
  const rep = (await call('GET', '/api/reports?days=30')).json;
  assert.equal(rep.deals.wonValue, 50000);
  const csv = await call('GET', '/api/export/clients.csv');
  assert.match(csv.text, /^\ufeff?name,company,phone/);
  assert.equal((await call('GET', '/api/export/hack')).status, 404);
  const del = await call('DELETE', '/api/clients/' + amit.id);
  assert.equal(del.status, 200);
  assert.equal((await call('GET', '/api/tasks')).json.length, 0, 'tasks of a deleted client are removed');
  assert.equal((await call('GET', '/api/deals')).json[0].clientId, '', 'deals are kept but unlinked');
});

test('mass mail runs in simulation mode and never mails the Red Zone', async () => {
  const ok = await call('POST', '/api/clients', { name: 'Reds', email: 'red@x.com', stage: 'rejected' });
  assert.equal(ok.status, 200);
  const r = await call('POST', '/api/mail/send', { audience: 'all', subject: 'Hi {{name}}', body: 'Hello' });
  assert.equal(r.status, 200);
  assert.equal(r.json.simulated, true);
  assert.equal(r.json.status, 'complete');
  assert.ok(r.json.sent >= 1);
  const acts = (await call('GET', '/api/clients/' + ok.json.id + '/activities')).json;
  assert.ok(!acts.some(a => a.type === 'mail'));
});

test('mass mail can target selected clients across stages but excludes Red Zone and opt-outs', async () => {
  const contacted = await call('POST', '/api/clients', {
    name: 'Selected Contacted',
    email: 'selected-contacted@test.example',
    alternateEmails: ['selected-alternate@test.example']
  });
  assert.equal((await call('PUT', `/api/clients/${contacted.json.id}`, { callStatus: 'connected' })).json.stage, 'contacted');
  const rejected = await call('POST', '/api/clients', { name: 'Selected Red Zone', email: 'selected-red@test.example', stage: 'rejected' });
  const optedOut = await call('POST', '/api/clients', { name: 'Selected Opt Out', email: 'selected-optout@test.example' });
  await call('POST', `/api/clients/${optedOut.json.id}/activity`, { type: 'reply', note: 'Please unsubscribe me and do not contact me again.' });

  const r = await call('POST', '/api/mail/send', {
    audience: 'selected',
    recipients: [
      { clientId: contacted.json.id, email: 'selected-alternate@test.example' },
      { clientId: rejected.json.id, email: 'selected-red@test.example' },
      { clientId: optedOut.json.id, email: 'selected-optout@test.example' }
    ],
    subject: 'Following up, {{name}}',
    body: 'Hello {{name}}'
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.audience, 'selected');
  assert.equal(r.json.total, 1);
  assert.equal(r.json.sent, 1);
  const massMailClient = (await call('GET', '/api/clients')).json.find(c => c.id === contacted.json.id);
  const massMailFollowUpHours = (new Date(massMailClient.followUp).getTime() - Date.now()) / 3600000;
  assert.ok(Math.abs(massMailFollowUpHours - 48) < 0.02, 'mass mail follow-up is scheduled 48 hours after sending');
  const firstMailThread = await call('GET', `/api/mail/thread?clientId=${contacted.json.id}&email=selected-alternate%40test.example`);
  assert.equal(firstMailThread.status, 200);
  assert.equal(firstMailThread.json.hasHistory, true);
  assert.equal(firstMailThread.json.nextFollowUpNumber, 1, 'first reminder is automatically numbered 1');
  assert.equal(firstMailThread.json.threadSubject, 'Following up, Selected Contacted');
  const primaryMailThread = await call('GET', `/api/mail/thread?clientId=${contacted.json.id}&email=selected-contacted%40test.example`);
  assert.equal(primaryMailThread.json.hasHistory, false, 'follow-up history is isolated per email address');
  assert.equal((await call('POST', '/api/mail/send', {
    audience: 'selected',
    recipients: [{ clientId: contacted.json.id, email: 'not-saved@test.example' }],
    subject: 'Follow-up',
    body: 'Hello'
  })).status, 400);
  const singleAlternate = await call('POST', '/api/mail/send-one', {
    clientId: contacted.json.id,
    email: 'selected-alternate@test.example',
    subject: 'One-to-one follow-up',
    body: 'Hello {{email}}'
  });
  assert.equal(singleAlternate.status, 200);
  assert.equal(singleAlternate.json.email, 'selected-alternate@test.example');
  assert.equal(singleAlternate.json.isFollowUp, true);
  assert.equal(singleAlternate.json.followUpNumber, 1);
  let mailActivities = (await call('GET', `/api/clients/${contacted.json.id}/activities`)).json.filter(a => a.type === 'mail');
  assert.match(mailActivities[0].emailSubject, /^Re: Following up, Selected Contacted$/);
  assert.equal(mailActivities[0].isFollowUp, true);
  assert.equal(mailActivities[0].followUpNumber, 1);
  const secondFollowUp = await call('POST', '/api/mail/send', {
    audience: 'selected',
    recipients: [{ clientId: contacted.json.id, email: 'selected-alternate@test.example' }],
    subject: 'Another subject (thread subject stays unchanged)',
    body: 'Second reminder',
    replyToLast: true
  });
  assert.equal(secondFollowUp.status, 200);
  assert.equal(secondFollowUp.json.sent, 1);
  mailActivities = (await call('GET', `/api/clients/${contacted.json.id}/activities`)).json.filter(a => a.type === 'mail');
  assert.match(mailActivities[0].emailSubject, /^Re: Following up, Selected Contacted$/);
  assert.equal(mailActivities[0].followUpNumber, 2);
  assert.equal(mailActivities[0].isFollowUp, true);

  const freshThread = await call('POST', '/api/mail/send-one', {
    clientId: contacted.json.id,
    email: 'selected-alternate@test.example',
    subject: 'A new topic',
    body: 'A new conversation',
    replyToLast: false
  });
  assert.equal(freshThread.status, 200);
  assert.equal(freshThread.json.isFollowUp, false, 'a new conversation starts a fresh reminder count');
  const newThread = await call('GET', `/api/mail/thread?clientId=${contacted.json.id}&email=selected-alternate%40test.example`);
  assert.equal(newThread.json.nextFollowUpNumber, 1);
  assert.equal(newThread.json.threadSubject, 'A new topic');
  const singleMailClient = (await call('GET', '/api/clients')).json.find(c => c.id === contacted.json.id);
  const singleMailFollowUpHours = (new Date(singleMailClient.followUp).getTime() - Date.now()) / 3600000;
  assert.ok(Math.abs(singleMailFollowUpHours - 48) < 0.02, 'single email follow-up is scheduled 48 hours after sending');
  assert.equal((await call('POST', '/api/mail/send-one', {
    clientId: contacted.json.id,
    email: 'not-saved@test.example',
    subject: 'Follow-up',
    body: 'Hello'
  })).status, 400);

  const contactedActivities = (await call('GET', `/api/clients/${contacted.json.id}/activities`)).json;
  const rejectedActivities = (await call('GET', `/api/clients/${rejected.json.id}/activities`)).json;
  const optedOutActivities = (await call('GET', `/api/clients/${optedOut.json.id}/activities`)).json;
  assert.ok(contactedActivities.some(a => a.type === 'mail'));
  assert.ok(!rejectedActivities.some(a => a.type === 'mail'));
  assert.ok(!optedOutActivities.some(a => a.type === 'mail'));

  const steps = [1, 3, 5, 7, 9].map(day => ({ day, subject: `Follow-up ${day}`, body: `Hello {{name}}` }));
  const sequence = await call('POST', '/api/sequences', {
    audience: 'selected',
    recipients: [{ clientId: contacted.json.id, email: 'selected-alternate@test.example' }],
    steps
  });
  assert.equal(sequence.status, 200);
  assert.equal(sequence.json.total, 1);
  assert.deepEqual(sequence.json.finalOutcome, { action: 'move_to_red_zone_if_no_reply', waitDays: 3 });
  assert.equal(sequence.json.recipients[0].clientId, contacted.json.id);
  assert.equal(sequence.json.recipients[0].email, 'selected-alternate@test.example');

  const noneEligible = await call('POST', '/api/mail/send', {
    audience: 'selected',
    clientIds: [rejected.json.id, optedOut.json.id],
    subject: 'Follow-up',
    body: 'Hello'
  });
  assert.equal(noneEligible.status, 400);
});

test('AI endpoints explain what is missing instead of crashing', async () => {
  const s = await call('GET', '/api/ai/status');
  assert.equal(s.json.configured, false);
  const any = (await call('GET', '/api/clients')).json[0];
  const r = await call('POST', '/api/ai/summary', { clientId: any.id });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'no_key');
});

test('communication opt-out blocks email and callback outcomes create a reminder task', async () => {
  const c = await call('POST', '/api/clients', { name: 'Callback Test', email: 'callback@test.example', phone: '919876543210' });
  assert.equal(c.status, 200);
  const markedContacted = await call('PUT', '/api/clients/' + c.json.id, { communicationStatus: 'contacted' });
  assert.equal(markedContacted.json.communicationStatus, 'contacted');
  assert.equal((await call('GET', '/api/clients')).json.find(x => x.id === c.json.id).communicationStatus, 'contacted', 'communication status persists across list reloads');
  const callback = await call('PUT', '/api/clients/' + c.json.id, { callStatus: 'callback' });
  assert.equal(callback.json.callStatus, 'callback');
  assert.ok(callback.json.followUp, 'callback sets a reminder date');
  const tasks = (await call('GET', '/api/tasks')).json;
  assert.ok(tasks.some(t => t.clientId === c.json.id && /Call back/.test(t.title) && !t.done));
  const reply = await call('POST', '/api/clients/' + c.json.id + '/activity', { type: 'reply', note: 'Please unsubscribe me and do not contact me again.' });
  assert.equal(reply.json.optedOut, true);
  assert.equal(reply.json.communicationStatus, 'opted_out');
  assert.equal((await call('POST', '/api/mail/send-one', { clientId: c.json.id })).status, 409);
});

test('follow-up sequences support controls, edits, and stop on a reply or replied stage', async () => {
  const lead = await call('POST', '/api/clients', { name: 'Sequence Test', email: 'sequence@test.example' });
  const steps = [1, 3, 5, 7, 9].map(day => ({ day, subject: `Day ${day} for {{name}}`, body: `Hello {{name}}, this is day ${day}.` }));
  const created = await call('POST', '/api/sequences', { audience: 'new', clientIds: [lead.json.id], steps });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, 'paused');
  assert.deepEqual(created.json.steps.map(step => step.day), [1, 3, 5, 7, 9]);
  const startedAt = Date.now();
  let action = await call('POST', `/api/campaigns/${created.json.id}/action`, { action: 'start' });
  assert.equal(action.json.status, 'active');
  const firstStepDelay = Date.parse(action.json.recipients[0].runAt) - startedAt;
  assert.ok(firstStepDelay >= 23 * 60 * 60 * 1000 && firstStepDelay <= 25 * 60 * 60 * 1000, 'initial email is scheduled for Day 1');
  action = await call('POST', `/api/campaigns/${created.json.id}/action`, { action: 'pause' });
  assert.equal(action.json.status, 'paused');
  steps[0].subject = 'Edited Day 1 for {{name}}';
  action = await call('POST', `/api/campaigns/${created.json.id}/action`, { action: 'edit', steps });
  assert.equal(action.json.steps[0].subject, steps[0].subject);
  await call('POST', `/api/campaigns/${created.json.id}/action`, { action: 'resume' });
  const stageReply = await call('PUT', `/api/clients/${lead.json.id}`, { stage: 'replied' });
  assert.equal(stageReply.json.communicationStatus, 'replied');
  let campaign = (await call('GET', '/api/campaigns')).json.find(c => c.id === created.json.id);
  assert.equal(campaign.recipients[0].status, 'stopped', 'moving to Replied stops remaining sequence emails');
  const reply = await call('POST', '/api/clients/' + lead.json.id + '/activity', { type: 'reply', note: 'I am interested.' });
  assert.equal(reply.status, 200);
  campaign = (await call('GET', '/api/campaigns')).json.find(c => c.id === created.json.id);
  assert.equal(campaign.status, 'complete');
  assert.equal(campaign.recipients[0].status, 'stopped');
});

test('WhatsApp credentials are masked and signed inbound webhook replies are recorded', async () => {
  const secret = 'test-meta-app-secret';
  await call('PUT', '/api/settings', { theme: 'dark', whatsapp: { accessToken: 'private-token', phoneNumberId: '123456789', apiVersion: 'v21.0', verifyToken: 'verify-me', appSecret: secret } });
  const settings = (await call('GET', '/api/settings')).json;
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.whatsapp.accessToken, '********');
  assert.equal(settings.whatsapp.appSecret, '********');
  assert.equal((await call('GET', '/api/whatsapp/status')).json.configured, true);
  const lead = await call('POST', '/api/clients', { name: 'WhatsApp Test', phone: '919999111222', email: 'wa@test.example' });
  const verify = await call('GET', '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-value');
  assert.equal(verify.text, 'challenge-value');
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '919999111222', text: { body: 'STOP' } }] } }] }] });
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const event = await fetch(base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: raw });
  assert.equal(event.status, 200);
  const updated = (await call('GET', '/api/clients')).json.find(c => c.id === lead.json.id);
  assert.equal(updated.optedOut, true);
  assert.equal(updated.stage, 'replied');
});

test('AI settings retain the Groq default and mask provider keys', async () => {
  await call('PUT', '/api/settings', { ai: { provider: 'groq', model: 'openai/gpt-oss-20b', apiKey: 'test-provider-key' } });
  const settings = (await call('GET', '/api/settings')).json;
  assert.equal(settings.ai.provider, 'groq');
  assert.equal(settings.ai.apiKey, '********');
  const status = (await call('GET', '/api/ai/status')).json;
  assert.equal(status.provider, 'groq');
  await call('PUT', '/api/settings', { ai: { apiKey: '' } });
});

test('backup downloads a SQLite file', async () => {
  const r = await fetch(base + '/api/backup', { headers: { cookie } });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  assert.ok(!buf.includes('Reds'), 'backup is encrypted');
});
