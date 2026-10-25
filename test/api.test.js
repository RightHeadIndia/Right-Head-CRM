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
    env: { ...process.env, PORT: String(port), APP_PASSWORD: PASSWORD, CRM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), CRM_DB_FILE: path.join(dir, 'crm.sqlite'), ANTHROPIC_API_KEY: '' },
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
});

test('client create / validate / update', async () => {
  assert.equal((await call('POST', '/api/clients', { name: '' })).status, 400);
  const c = await call('POST', '/api/clients', { name: 'Amit', email: 'amit@abc.com', phone: '9876543210' });
  assert.equal(c.status, 200);
  const up = await call('PUT', '/api/clients/' + c.json.id, { callStatus: 'connected' });
  assert.equal(up.json.stage, 'contacted');
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

test('AI endpoints explain what is missing instead of crashing', async () => {
  const s = await call('GET', '/api/ai/status');
  assert.equal(s.json.configured, false);
  const any = (await call('GET', '/api/clients')).json[0];
  const r = await call('POST', '/api/ai/summary', { clientId: any.id });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'no_key');
});

test('backup downloads a SQLite file', async () => {
  const r = await fetch(base + '/api/backup', { headers: { cookie } });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  assert.ok(!buf.includes('Reds'), 'backup is encrypted');
});
