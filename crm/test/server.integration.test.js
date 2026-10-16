const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

test('server login protects APIs and backups include saved CRM data', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-crm-server-'));
  const key = crypto.randomBytes(32).toString('base64');
  const password = 'integration-company-password';
  const databasePath = path.join(directory, 'crm.sqlite');
  const backupPath = path.join(directory, 'download.sqlite');
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, APP_PASSWORD: password, CRM_ENCRYPTION_KEY: key, CRM_DB_FILE: databasePath, PORT: String(port) },
    stdio: 'ignore'
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/login.html`);
      if (response.ok) { ready = true; break; }
    } catch (_) { /* server is still starting */ }
    await delay(100);
  }
  assert.equal(ready, true, 'server should start with the generated secrets');

  assert.equal((await fetch(`${base}/api/clients`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];

  const page = await fetch(`${base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const create = await fetch(`${base}/api/clients`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.test', company: 'Analytical Engines' })
  });
  assert.equal(create.status, 200);
  const client = await create.json();
  assert.equal(client.name, 'Ada Lovelace');

  const taskResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Follow up', clientId: client.id, dueAt: '2026-10-20', priority: 'high' })
  });
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  const dealResponse = await fetch(`${base}/api/deals`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'CRM renewal', clientId: client.id, value: 12000, stage: 'proposal' })
  });
  assert.equal(dealResponse.status, 200);
  const deal = await dealResponse.json();
  const templateResponse = await fetch(`${base}/api/templates`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Welcome', subject: 'Hello {{name}}', body: 'Thank you.' })
  });
  assert.equal(templateResponse.status, 200);
  const template = await templateResponse.json();
  assert.equal((await fetch(`${base}/api/reports?days=30`, { headers: { cookie } })).status, 200);

  const rejected = await fetch(`${base}/api/clients`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Declined Contact', email: 'declined@example.test', stage: 'rejected' })
  });
  assert.equal(rejected.status, 200);
  const audience = await fetch(`${base}/api/mail/audience/all`, { headers: { cookie } });
  assert.equal((await audience.json()).count, 1, 'red-zone clients must be excluded from every campaign');
  const campaignResponse = await fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ audience: 'all', subject: 'Hello {{name}}', body: 'A reviewed test message' })
  });
  assert.equal(campaignResponse.status, 200);
  const campaign = await campaignResponse.json();
  assert.equal(campaign.status, 'complete');
  assert.equal(campaign.sent, 1);
  assert.equal(campaign.simulated, true, 'without SMTP settings the server must simulate, not send');
  const csv = await fetch(`${base}/api/export/clients.csv`, { headers: { cookie } });
  assert.equal(csv.status, 200);
  assert.deepEqual(Buffer.from(await csv.arrayBuffer()).subarray(0, 3), Buffer.from([0xEF, 0xBB, 0xBF]), 'CSV exports should include a real UTF-8 BOM');
  const importedResponse = await fetch(`${base}/api/clients/import`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify([{ name: 'Imported Sheet Row', stage: 'replied', callStatus: 'connected', followUp: '2026-10-20T09:00:00.000Z', lastReply: 'Interested' }])
  });
  assert.equal(importedResponse.status, 200);
  assert.deepEqual(await importedResponse.json(), { added: 1, skipped: 0 });

  const backup = await fetch(`${base}/api/backup`, { headers: { cookie } });
  assert.equal(backup.status, 200);
  fs.writeFileSync(backupPath, Buffer.from(await backup.arrayBuffer()));

  process.env.CRM_ENCRYPTION_KEY = key;
  const { openDatabase, readDatabase } = require('../lib/database');
  const snapshot = openDatabase(backupPath, path.join(directory, 'missing.json'));
  try {
    const saved = readDatabase(snapshot);
    assert.equal(saved.clients.length, 3);
    assert.equal(saved.clients.find(record => record.id === client.id).stage, 'contacted');
    const imported = saved.clients.find(record => record.name === 'Imported Sheet Row');
    assert.equal(imported.stage, 'replied');
    assert.equal(imported.callStatus, 'connected');
    assert.equal(imported.followUp, '2026-10-20T09:00:00.000Z');
    assert.equal(imported.lastReply, 'Interested');
    assert.equal(saved.campaigns[0].sent, 1);
    assert.equal(saved.tasks[0].id, task.id);
    assert.equal(saved.deals[0].id, deal.id);
    assert.equal(saved.templates[0].id, template.id);
  } finally {
    snapshot.close();
  }
});
