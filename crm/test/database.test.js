const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const key = crypto.randomBytes(32).toString('base64');
process.env.CRM_ENCRYPTION_KEY = key;
const databaseModulePath = require.resolve('../lib/database');
const { openDatabase, readDatabase, writeDatabase } = require('../lib/database');

function tempFiles(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-crm-'));
  const databases = new Set();
  t.after(() => {
    for (const database of databases) {
      try { database.close(); } catch (_) { /* already closed */ }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    sqlite: path.join(directory, 'crm.sqlite'),
    legacy: path.join(directory, 'db.json'),
    track(database) { databases.add(database); return database; }
  };
}

test('imports existing JSON once, preserves its backup, and encrypts the migrated records', t => {
  const files = tempFiles(t);
  const legacy = {
    clients: [{ id: 'c1', name: 'Ada', email: 'ada@example.test' }],
    activities: [{ id: 'a1', clientId: 'c1', type: 'note', note: 'private note', at: '2026-01-01T00:00:00.000Z' }],
    campaigns: [], tasks: [], deals: [], templates: [],
    settings: { company: 'Example Co', currency: '\u00E2\u201A\u00B9', smtp: { host: 'mail.example.test', pass: 'smtp-secret' }, ai: { apiKey: 'ai-secret' } }
  };
  fs.writeFileSync(files.legacy, JSON.stringify(legacy));

  const database = files.track(openDatabase(files.sqlite, files.legacy));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${files.legacy}.pre-sqlite.bak`, 'utf8')), legacy);
  assert.deepEqual(readDatabase(database).clients, legacy.clients);
  assert.equal(readDatabase(database).settings.ai.apiKey, 'ai-secret');
  assert.equal(readDatabase(database).settings.currency, '\u20B9');
  const raw = database.prepare('SELECT payload FROM crm_records').all().map(row => row.payload).join('\n');
  const rawSettings = database.prepare('SELECT payload FROM crm_settings').get().payload;
  assert.equal(raw.includes('Ada'), false);
  assert.equal(raw.includes('private note'), false);
  assert.equal(rawSettings.includes('smtp-secret'), false);
  assert.equal(rawSettings.includes('ai-secret'), false);

  const secondOpen = files.track(openDatabase(files.sqlite, files.legacy));
  assert.equal(readDatabase(secondOpen).clients.length, 1);
  secondOpen.close();
  database.prepare('DELETE FROM crm_meta WHERE key = ?').run('json_migration_v1');
  const recovered = files.track(openDatabase(files.sqlite, files.legacy));
  assert.deepEqual(readDatabase(recovered).clients, legacy.clients);
  assert.equal(readDatabase(recovered).settings.smtp.pass, 'smtp-secret');
});

test('detects conflicting edits rather than overwriting another request', t => {
  const files = tempFiles(t);
  const first = files.track(openDatabase(files.sqlite, files.legacy));
  const second = files.track(openDatabase(files.sqlite, files.legacy));

  const original = readDatabase(first);
  original.clients.push({ id: 'c1', name: 'Before' });
  writeDatabase(first, original);
  const stale = readDatabase(second);
  const staleRecord = stale.clients[0];
  staleRecord.name = 'Stale edit';

  const current = readDatabase(first);
  current.clients[0].name = 'Current edit';
  writeDatabase(first, current);
  assert.throws(() => writeDatabase(second, stale), { code: 'CRM_CONCURRENT_UPDATE' });
  assert.equal(readDatabase(first).clients[0].name, 'Current edit');
});

test('refuses to open encrypted data with the wrong key without changing it', t => {
  const files = tempFiles(t);
  const database = files.track(openDatabase(files.sqlite, files.legacy));
  const db = readDatabase(database);
  db.clients.push({ id: 'c1', name: 'Protected' });
  writeDatabase(database, db);
  database.close();

  const before = fs.readFileSync(files.sqlite);
  process.env.CRM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  delete require.cache[databaseModulePath];
  try {
    const wrongKeyModule = require('../lib/database');
    assert.throws(() => wrongKeyModule.openDatabase(files.sqlite, files.legacy), /could not be decrypted/);
    assert.deepEqual(fs.readFileSync(files.sqlite), before);
  } finally {
    process.env.CRM_ENCRYPTION_KEY = key;
    delete require.cache[databaseModulePath];
    require('../lib/database');
  }
});
