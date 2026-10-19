const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const KEY = crypto.randomBytes(32).toString('base64');
process.env.CRM_ENCRYPTION_KEY = KEY;
const { openDatabase, readDatabase, writeDatabase, readRecord, updateRecords } = require('../lib/database');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crm-db-'));
const client = (id, name) => ({ id, name, company: '', phone: '', email: '', stage: 'new', callStatus: 'not_called' });

test('records are encrypted on disk and survive a restart', () => {
  const dir = tmp(), file = path.join(dir, 'crm.sqlite');
  let db = openDatabase(file, null);
  const data = readDatabase(db);
  data.clients.push(client('c1', 'Amit Secret Sharma'));
  data.settings.smtp.pass = 'smtp-secret-pass';
  writeDatabase(db, data);
  db.close();
  const raw = fs.readFileSync(file);
  assert.ok(!raw.includes('Amit Secret'), 'client name must not appear in the file');
  assert.ok(!raw.includes('smtp-secret-pass'), 'SMTP password must not appear in the file');
  db = openDatabase(file, null);
  const again = readDatabase(db);
  assert.equal(again.clients[0].name, 'Amit Secret Sharma');
  assert.equal(again.settings.smtp.pass, 'smtp-secret-pass');
  db.close();
});

test('a wrong encryption key is rejected with a clear message', () => {
  const file = path.join(tmp(), 'crm.sqlite');
  openDatabase(file, null).close();
  process.env.CRM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  assert.throws(() => openDatabase(file, null), /does not match/);
  process.env.CRM_ENCRYPTION_KEY = KEY;
});

test('a bad key format is rejected', () => {
  process.env.CRM_ENCRYPTION_KEY = 'short';
  assert.throws(() => openDatabase(path.join(tmp(), 'x.sqlite'), null), /32-byte/);
  process.env.CRM_ENCRYPTION_KEY = KEY;
});

test('only changed records are written', () => {
  const file = path.join(tmp(), 'crm.sqlite');
  const db = openDatabase(file, null);
  const d = readDatabase(db);
  d.clients.push(client('a', 'A'), client('b', 'B'));
  writeDatabase(db, d);
  const d2 = readDatabase(db);
  d2.clients[1].name = 'B2';
  writeDatabase(db, d2);
  const raw = new DatabaseSync(file, { readOnly: true });
  const v = Object.fromEntries(raw.prepare("SELECT id, version FROM records WHERE collection='clients'").all().map(r => [r.id, r.version]));
  raw.close();
  assert.deepEqual(v, { a: 1, b: 2 });
  db.close();
});

test('two people editing the same record: the second save is refused, not silently merged', () => {
  const db = openDatabase(path.join(tmp(), 'crm.sqlite'), null);
  const seed = readDatabase(db); seed.clients.push(client('a', 'A')); writeDatabase(db, seed);
  const one = readDatabase(db), two = readDatabase(db);
  one.clients[0].name = 'First'; writeDatabase(db, one);
  two.clients[0].name = 'Second';
  assert.throws(() => writeDatabase(db, two), e => e.code === 'CRM_CONCURRENT_UPDATE');
  assert.equal(readDatabase(db).clients[0].name, 'First');
  // editing a DIFFERENT record from a stale copy is fine
  const three = readDatabase(db); three.clients.push(client('b', 'B')); writeDatabase(db, three);
  one.clients.push(client('c', 'C')); // `one` never saw record b: adding c must not delete b
  writeDatabase(db, one);
  assert.deepEqual(readDatabase(db).clients.map(c => c.id), ['a', 'b', 'c']);
  const stale = readDatabase(db); stale.clients = stale.clients.filter(c => c.id !== 'b');
  const fresh = readDatabase(db); fresh.clients[1].name = 'B changed'; writeDatabase(db, fresh);
  assert.throws(() => writeDatabase(db, stale), e => e.code === 'CRM_CONCURRENT_UPDATE'); // deleting b after it was edited: refused
  db.close();
});

test('delete and re-save the same object works', () => {
  const db = openDatabase(path.join(tmp(), 'crm.sqlite'), null);
  const d = readDatabase(db); d.clients.push(client('a', 'A'), client('b', 'B')); writeDatabase(db, d);
  d.clients = d.clients.filter(c => c.id !== 'a'); writeDatabase(db, d);
  d.clients[0].name = 'B2'; writeDatabase(db, d); // same object saved twice
  assert.deepEqual(readDatabase(db).clients.map(c => c.name), ['B2']);
  db.close();
});

test('updateRecords reads the latest record and saves atomically; order is kept', () => {
  const db = openDatabase(path.join(tmp(), 'crm.sqlite'), null);
  const d = readDatabase(db); d.campaigns.push({ id: 'k', sent: 0 }); d.clients.push(client('a', 'A'), client('b', 'B')); writeDatabase(db, d);
  updateRecords(db, ({ get, set }) => { const k = get('campaigns', 'k'); k.sent = 5; set('campaigns', k); const a = get('clients', 'a'); a.name = 'A2'; set('clients', a); });
  assert.equal(readRecord(db, 'campaigns', 'k').sent, 5);
  assert.deepEqual(readDatabase(db).clients.map(c => c.name), ['A2', 'B']);
  assert.equal(readRecord(db, 'clients', 'nope'), null);
  db.close();
});

test('legacy db.json is imported once, with a backup, and left in place', () => {
  const dir = tmp(), legacy = path.join(dir, 'db.json'), file = path.join(dir, 'crm.sqlite');
  fs.writeFileSync(legacy, JSON.stringify({
    clients: [{ id: 'old1', name: 'Legacy Client', stage: 'replied' }, { name: 'No id client' }],
    activities: [{ id: 'x', clientId: 'old1', type: 'note', note: 'hi', at: '2026-01-01T00:00:00.000Z' }],
    campaigns: [], settings: { company: 'Acme', smtp: { host: 'smtp.example.com' } }
  }));
  let db = openDatabase(file, legacy);
  let d = readDatabase(db);
  assert.equal(d.clients.length, 2);
  assert.ok(d.clients.every(c => c.id), 'every client has an id');
  assert.equal(d.settings.company, 'Acme');
  assert.equal(d.settings.smtp.host, 'smtp.example.com');
  assert.equal(d.settings.smtp.port, 587, 'missing settings get defaults');
  assert.ok(d.tasks.length === 0 && d.deals.length === 0);
  assert.ok(fs.existsSync(legacy + '.pre-sqlite.bak') && fs.existsSync(legacy));
  d.clients = []; writeDatabase(db, d); db.close();
  db = openDatabase(file, legacy); // must NOT import again
  assert.equal(readDatabase(db).clients.length, 0);
  db.close();
});

test('a corrupt db.json stops startup and is not touched', () => {
  const dir = tmp(), legacy = path.join(dir, 'db.json');
  fs.writeFileSync(legacy, '{ not json');
  assert.throws(() => openDatabase(path.join(dir, 'crm.sqlite'), legacy), /Could not read/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{ not json');
});

test('1,000 clients: save with one change is fast', () => {
  const db = openDatabase(path.join(tmp(), 'crm.sqlite'), null);
  const d = readDatabase(db);
  for (let i = 0; i < 1000; i++) d.clients.push(client('id' + i, 'Client ' + i));
  writeDatabase(db, d);
  const t = process.hrtime.bigint();
  const e = readDatabase(db); e.clients[500].name = 'Changed'; writeDatabase(db, e);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 250, `read+save took ${ms.toFixed(1)} ms`);
  db.close();
});
