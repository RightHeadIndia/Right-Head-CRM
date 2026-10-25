// SQLite storage for the CRM (Node's built-in node:sqlite, no extra database server).
//
//  - Every record (client, task, deal, setting...) is one row, encrypted with AES-256-GCM using CRM_ENCRYPTION_KEY.
//    The key is never stored in the database. Each row is bound to its own collection/id, so rows cannot be swapped.
//  - All records are decrypted once at startup and kept in memory, so reads never touch the disk or the cipher.
//  - Saving writes ONLY the records that changed, inside one transaction, so a save costs the same whether you
//    have 100 clients or 100,000.
//  - If a record was changed by someone else after you read it, saving throws CRM_CONCURRENT_UPDATE instead of
//    silently overwriting their change.
//  - A db.json from the old version is imported once on first start (a .pre-sqlite.bak copy is made first).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const COLLECTIONS = ['clients', 'activities', 'campaigns', 'tasks', 'deals', 'templates'];
const SETTINGS = 'settings', SETTINGS_ID = 'main';
const ALL = [...COLLECTIONS, SETTINGS];
const states = new WeakMap();

const defaultSettings = () => ({
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  company: 'Right Head', currency: '₹', ai: { apiKey: '', model: '' }
});
function normalizeSettings(s) {
  const d = defaultSettings(), x = s && typeof s === 'object' ? s : {};
  return { ...d, ...x, smtp: { ...d.smtp, ...(x.smtp || {}) }, ai: { ...d.ai, ...(x.ai || {}) } };
}

function conflict() {
  const e = new Error('This record was changed by someone else a moment ago. Reload the page and try again.');
  e.code = 'CRM_CONCURRENT_UPDATE';
  return e;
}

// ---------- encryption ----------
function loadKey() {
  const raw = process.env.CRM_ENCRYPTION_KEY || '';
  if (!raw) throw new Error('Set CRM_ENCRYPTION_KEY before starting the CRM (run "npm run setup" to create one).');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('CRM_ENCRYPTION_KEY must be a base64-encoded 32-byte key (run "npm run setup" to create one).');
  return key;
}
function encrypt(key, aad, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function decrypt(key, aad, value) {
  if (typeof value !== 'string' || !value.startsWith('v1:')) throw new Error('unknown record format');
  const buf = Buffer.from(value.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ---------- open / load / migrate ----------
function openDatabase(file, legacyJsonFile) {
  const key = loadKey();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* not supported on this OS */ }

  // Wrong key? Say so clearly instead of failing on the first client.
  const check = database.prepare('SELECT v FROM meta WHERE k = ?').get('key_check');
  if (check) {
    try { if (decrypt(key, 'meta/key_check', check.v) !== 'crm-ok') throw new Error('mismatch'); }
    catch (_) { database.close(); throw new Error('CRM_ENCRYPTION_KEY does not match this database. Use the key the database was created with.'); }
  } else {
    database.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('key_check', encrypt(key, 'meta/key_check', 'crm-ok'));
  }

  const state = {
    key,
    records: Object.fromEntries(ALL.map(c => [c, new Map()])), // collection -> Map(id -> { json, version })
    upsert: database.prepare('INSERT INTO records (collection, id, version, data) VALUES (?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET version = excluded.version, data = excluded.data'),
    remove: database.prepare('DELETE FROM records WHERE collection = ? AND id = ?')
  };
  states.set(database, state);

  for (const row of database.prepare('SELECT collection, id, version, data FROM records ORDER BY rowid').all()) {
    if (!state.records[row.collection]) continue;
    state.records[row.collection].set(row.id, { json: decrypt(key, `${row.collection}/${row.id}`, row.data), version: row.version });
  }

  const imported = database.prepare('SELECT v FROM meta WHERE k = ?').get('legacy_imported');
  const empty = ALL.every(c => state.records[c].size === 0);
  if (!imported && empty && legacyJsonFile && fs.existsSync(legacyJsonFile)) importLegacy(database, legacyJsonFile);
  return database;
}

function importLegacy(database, legacyJsonFile) {
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(legacyJsonFile, 'utf8')); }
  catch (e) { throw new Error(`Could not read ${legacyJsonFile} for migration (${e.message}). Fix or move the file and start again; it has not been changed.`); }
  const backupFile = legacyJsonFile + '.pre-sqlite.bak';
  if (!fs.existsSync(backupFile)) fs.copyFileSync(legacyJsonFile, backupFile);
  const db = readDatabase(database);
  const seen = new Set();
  for (const coll of COLLECTIONS) {
    db[coll] = (Array.isArray(legacy[coll]) ? legacy[coll] : []).filter(r => r && typeof r === 'object').map(r => {
      let id = typeof r.id === 'string' && r.id ? r.id : '';
      if (!id || seen.has(coll + '/' + id)) id = crypto.randomBytes(6).toString('hex');
      seen.add(coll + '/' + id);
      return { ...r, id };
    });
  }
  db.settings = normalizeSettings(legacy.settings);
  writeDatabase(database, db);
  database.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('legacy_imported', new Date().toISOString());
  console.log(`Imported ${db.clients.length} client(s) from ${path.basename(legacyJsonFile)} into SQLite. The original file was left in place.`);
}

const stateOf = database => {
  const s = states.get(database);
  if (!s) throw new Error('database is not open');
  return s;
};

// ---------- reads (from memory) ----------
function readDatabase(database) {
  const st = stateOf(database), out = {}, versions = new Map();
  for (const coll of COLLECTIONS) {
    out[coll] = [];
    for (const [id, e] of st.records[coll]) { out[coll].push(JSON.parse(e.json)); versions.set(coll + '/' + id, e.version); }
  }
  const s = st.records[SETTINGS].get(SETTINGS_ID);
  out.settings = normalizeSettings(s ? JSON.parse(s.json) : null);
  delete out.settings.id;
  if (s) versions.set(SETTINGS + '/' + SETTINGS_ID, s.version);
  Object.defineProperty(out, '__versions', { value: versions }); // remembers what this copy was based on
  return out;
}
function readRecord(database, collection, id) {
  const e = stateOf(database).records[collection] && stateOf(database).records[collection].get(id);
  return e ? JSON.parse(e.json) : null;
}

// ---------- writes (changed records only, one transaction) ----------
function applyChanges(database, st, changes) {
  if (!changes.length) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const c of changes) {
      if (c.type === 'put') st.upsert.run(c.coll, c.id, c.version, encrypt(st.key, `${c.coll}/${c.id}`, c.json));
      else st.remove.run(c.coll, c.id);
    }
    database.exec('COMMIT');
  } catch (e) {
    try { database.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
  for (const c of changes) { // memory is updated only after the commit succeeded
    if (c.type === 'put') st.records[c.coll].set(c.id, { json: c.json, version: c.version });
    else st.records[c.coll].delete(c.id);
  }
}

function writeDatabase(database, db) {
  const st = stateOf(database), base = db && db.__versions;
  if (!base) throw new Error('writeDatabase needs an object returned by readDatabase');
  const changes = [], present = new Set();
  const consider = (coll, obj) => {
    if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string' || !obj.id) throw new Error(`a ${coll} record has no id`);
    const key = coll + '/' + obj.id;
    present.add(key);
    const json = JSON.stringify(obj), cur = st.records[coll].get(obj.id);
    if (!cur) { if (base.has(key)) throw conflict(); changes.push({ type: 'put', coll, id: obj.id, json, version: 1 }); return; }
    if (cur.json === json) return; // unchanged: no write at all
    if (base.get(key) !== cur.version) throw conflict();
    changes.push({ type: 'put', coll, id: obj.id, json, version: cur.version + 1 });
  };
  for (const coll of COLLECTIONS) for (const obj of db[coll] || []) consider(coll, obj);
  consider(SETTINGS, { ...normalizeSettings(db.settings), id: SETTINGS_ID });
  for (const [key, ver] of base) {
    if (present.has(key)) continue;
    const i = key.indexOf('/'), coll = key.slice(0, i), id = key.slice(i + 1), cur = st.records[coll] && st.records[coll].get(id);
    if (!cur) continue;
    if (cur.version !== ver) throw conflict();
    changes.push({ type: 'del', coll, id });
  }
  applyChanges(database, st, changes);
  for (const c of changes) { if (c.type === 'put') base.set(c.coll + '/' + c.id, c.version); else base.delete(c.coll + '/' + c.id); }
}

// For code that must act on the very latest record (mass mailing): get() sees current data, set() saves immediately.
function updateRecords(database, fn) {
  const st = stateOf(database), staged = new Map();
  const get = (coll, id) => {
    const s = staged.get(coll + '/' + id);
    if (s) return JSON.parse(s.json);
    const e = st.records[coll] && st.records[coll].get(id);
    return e ? JSON.parse(e.json) : undefined;
  };
  const set = (coll, obj) => {
    if (!st.records[coll]) throw new Error('unknown collection ' + coll);
    if (!obj || typeof obj.id !== 'string' || !obj.id) throw new Error(`a ${coll} record has no id`);
    const key = coll + '/' + obj.id, cur = st.records[coll].get(obj.id), prev = staged.get(key);
    staged.set(key, { type: 'put', coll, id: obj.id, json: JSON.stringify(obj), version: (prev ? prev.version : cur ? cur.version : 0) + 1 });
  };
  fn({ get, set });
  applyChanges(database, st, [...staged.values()]);
}

module.exports = { openDatabase, readDatabase, writeDatabase, readRecord, updateRecords, COLLECTIONS };
