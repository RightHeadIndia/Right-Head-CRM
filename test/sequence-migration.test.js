const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { openDatabase, readDatabase, writeDatabase } = require('../lib/database');

test('server migrates legacy active and paused sequence schedules on startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sequence-migration-'));
  const file = path.join(dir, 'crm.sqlite');
  const key = crypto.randomBytes(32).toString('base64');
  const password = 'migration-test-password';
  const anchor = Date.now() + 10 * 864e5;
  const date = ms => new Date(ms).toISOString();
  process.env.CRM_ENCRYPTION_KEY = key;
  const database = openDatabase(file, null);
  const db = readDatabase(database);
  const createCampaign = (id, status, nextStep, oldGapDays) => {
    const runAt = anchor + oldGapDays * 864e5;
    return {
      id, type: 'sequence', status, total: 1, nextRunAt: date(runAt),
      steps: [1, 2, 4, 7, 10].map(day => ({ day, subject: `Day ${day}`, body: 'Hello' })),
      recipients: [{ clientId: `${id}-client`, email: `${id}@example.test`, status: 'active', nextStep, runAt: date(runAt), retryAt: '' }]
    };
  };
  const createPreviousSchedule = (id, status, nextStep, runAt) => ({
    id, type: 'sequence', status, total: 1, nextRunAt: date(runAt),
    steps: [1, 3, 5, 7, 9].map(day => ({ day, subject: `Day ${day}`, body: 'Hello' })),
    recipients: [{ clientId: `${id}-client`, email: `${id}@example.test`, status: 'active', nextStep, runAt: date(runAt), retryAt: '' }]
  });
  db.campaigns = [
    createCampaign('active-legacy', 'active', 1, 1),
    createCampaign('paused-legacy', 'paused', 2, 2),
    createPreviousSchedule('active-initial', 'active', 0, anchor + 864e5),
    createPreviousSchedule('active-follow-up', 'active', 1, anchor + 3 * 864e5)
  ];
  writeDatabase(database, db);
  database.close();

  const port = 30000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), APP_PASSWORD: password, CRM_ENCRYPTION_KEY: key, CRM_DB_FILE: file, GROQ_API_KEY: '', AI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      proc.stdout.on('data', chunk => {
        if (String(chunk).includes('CRM running')) { clearTimeout(timer); resolve(); }
      });
      proc.stderr.on('data', chunk => {
        if (/Error/.test(String(chunk))) { clearTimeout(timer); reject(new Error(String(chunk))); }
      });
    });
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`http://127.0.0.1:${port}/api/campaigns`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const campaigns = await response.json();
    const active = campaigns.find(campaign => campaign.id === 'active-legacy');
    const paused = campaigns.find(campaign => campaign.id === 'paused-legacy');
    assert.deepEqual(active.steps.map(step => step.day), [0, 2, 4, 6, 8]);
    assert.deepEqual(paused.steps.map(step => step.day), [0, 2, 4, 6, 8]);
    assert.equal(Date.parse(active.recipients[0].runAt), anchor + 2 * 864e5, 'active next step shifts to the new 48-hour interval');
    assert.equal(Date.parse(paused.recipients[0].runAt), anchor + 2 * 864e5, 'paused sequence preserves its scheduled interval anchor');
    const activeInitial = campaigns.find(campaign => campaign.id === 'active-initial');
    const activeFollowUp = campaigns.find(campaign => campaign.id === 'active-follow-up');
    assert.deepEqual(activeInitial.steps.map(step => step.day), [0, 2, 4, 6, 8]);
    assert.ok(Math.abs(Date.parse(activeInitial.recipients[0].runAt) - Date.now()) < 5000, 'active initial email becomes due immediately');
    assert.deepEqual(activeFollowUp.steps.map(step => step.day), [0, 2, 4, 6, 8]);
    assert.equal(Date.parse(activeFollowUp.recipients[0].runAt), anchor + 3 * 864e5, 'active follow-up retains its 48-hour interval anchor');
  } finally {
    proc.kill();
    await once(proc, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
