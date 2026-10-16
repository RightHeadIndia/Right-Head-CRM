// Local SQLite persistence. Each CRM entity is stored as an individual row so
// SQLite handles durable commits and concurrent readers instead of a shared JSON file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const encodedKey = process.env.CRM_ENCRYPTION_KEY || '';
const ENCRYPTION_KEY = Buffer.from(encodedKey, 'base64');
if (ENCRYPTION_KEY.length !== 32 || ENCRYPTION_KEY.toString('base64') !== encodedKey) {
  throw new Error('Set CRM_ENCRYPTION_KEY to a base64-encoded 32-byte key before starting the CRM.');
}

const COLLECTIONS = ['clients', 'activities', 'campaigns', 'tasks', 'deals', 'templates'];
const snapshots = new WeakMap();
const DEFAULT_SETTINGS = {
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  company: 'Right Head', currency: '\u20B9', ai: { apiKey: '', model: '' }
};

function normalize(db) {
  db = db && typeof db === 'object' ? db : {};
  for (const name of COLLECTIONS) if (!Array.isArray(db[name])) db[name] = [];
  db.settings = db.settings && typeof db.settings === 'object' ? db.settings : {};
  db.settings.smtp = { ...DEFAULT_SETTINGS.smtp, ...(db.settings.smtp || {}) };
  db.settings.company ??= DEFAULT_SETTINGS.company;
  db.settings.currency ??= DEFAULT_SETTINGS.currency;
  if (db.settings.currency === '\u00E2\u201A\u00B9') db.settings.currency = DEFAULT_SETTINGS.currency;
  db.settings.ai = { ...DEFAULT_SETTINGS.ai, ...(db.settings.ai || {}) };
  return db;
}

function isEncrypted(payload) {
  try { return JSON.parse(payload).__crmEncrypted === 1; } catch (_) { return false; }
}
function encryptPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return JSON.stringify({
    __crmEncrypted: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64')
  });
}
function decryptPayload(payload) {
  if (!isEncrypted(payload)) return payload;
  try {
    const envelope = JSON.parse(payload);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (_) {
    throw new Error('CRM data could not be decrypted. Check CRM_ENCRYPTION_KEY; the database was not changed.');
  }
}

function openDatabase(file, legacyJsonFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS crm_records (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      PRIMARY KEY (collection, id)
    );
    CREATE TABLE IF NOT EXISTS crm_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL CHECK (json_valid(payload))
    );
    CREATE TABLE IF NOT EXISTS crm_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS crm_records_collection_idx ON crm_records(collection);
  `);
  database.prepare('INSERT INTO crm_settings (id, payload) VALUES (1, ?) ON CONFLICT(id) DO NOTHING')
    .run(encryptPayload(JSON.stringify(DEFAULT_SETTINGS)));

  const meta = database.prepare('SELECT value FROM crm_meta WHERE key = ?').get('json_migration_v1');
  if (!meta) {
    const count = database.prepare('SELECT COUNT(*) AS n FROM crm_records').get().n;
    if (count > 0) {
      // A previous startup may have committed the imported rows but stopped
      // before recording the marker. Record completion without rewriting data.
      database.prepare('INSERT INTO crm_meta (key, value) VALUES (?, ?)')
        .run('json_migration_v1', new Date().toISOString());
    } else {
      let initial = normalize({});
      if (fs.existsSync(legacyJsonFile)) {
        initial = normalize(JSON.parse(fs.readFileSync(legacyJsonFile, 'utf8')));
        const backupFile = legacyJsonFile + '.pre-sqlite.bak';
        if (!fs.existsSync(backupFile)) fs.copyFileSync(legacyJsonFile, backupFile);
      }
      database.exec('BEGIN IMMEDIATE');
      try {
        const insertRecord = database.prepare('INSERT INTO crm_records (collection, id, payload) VALUES (?, ?, ?)');
        for (const collection of COLLECTIONS) {
          const seen = new Set();
          for (const record of initial[collection]) {
            if (!record || typeof record !== 'object' || record.id == null) {
              throw new Error(`Invalid ${collection} record during JSON migration: expected an object with an id`);
            }
            const id = String(record.id);
            if (seen.has(id)) throw new Error(`Duplicate ${collection} id during JSON migration: ${id}`);
            seen.add(id);
            insertRecord.run(collection, id, JSON.stringify(record));
          }
        }
        database.prepare('UPDATE crm_settings SET payload = ? WHERE id = 1')
          .run(JSON.stringify(initial.settings));
        database.prepare('INSERT INTO crm_meta (key, value) VALUES (?, ?)')
          .run('json_migration_v1', new Date().toISOString());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  }
  encryptExistingPayloads(database);
  return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function encryptExistingPayloads(database) {
  const version = database.prepare('SELECT value FROM crm_meta WHERE key = ?').get('payload_encryption_v1');
  if (version) {
    const settings = database.prepare('SELECT payload FROM crm_settings WHERE id = 1').get();
    if (!settings) throw new Error('CRM database settings are missing.');
    JSON.parse(decryptPayload(settings.payload)); // validate the configured key before serving requests
    return;
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const records = database.prepare('SELECT collection, id, payload FROM crm_records').all();
    const updateRecord = database.prepare('UPDATE crm_records SET payload = ? WHERE collection = ? AND id = ?');
    for (const row of records) if (!isEncrypted(row.payload)) {
      updateRecord.run(encryptPayload(row.payload), row.collection, row.id);
    }
    const settings = database.prepare('SELECT payload FROM crm_settings WHERE id = 1').get();
    if (settings && !isEncrypted(settings.payload)) {
      database.prepare('UPDATE crm_settings SET payload = ? WHERE id = 1').run(encryptPayload(settings.payload));
    } else if (settings) {
      JSON.parse(decryptPayload(settings.payload));
    }
    database.prepare('INSERT INTO crm_meta (key, value) VALUES (?, ?)').run('payload_encryption_v1', new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function readDatabase(database) {
  const db = normalize({});
  const records = database.prepare('SELECT collection, payload FROM crm_records ORDER BY rowid').all();
  for (const row of records) {
    if (Object.hasOwn(db, row.collection)) db[row.collection].push(JSON.parse(decryptPayload(row.payload)));
  }
  const settings = database.prepare('SELECT payload FROM crm_settings WHERE id = 1').get();
  if (settings) db.settings = JSON.parse(decryptPayload(settings.payload));
  normalize(db);
  snapshots.set(db, JSON.parse(JSON.stringify(db)));
  return db;
}

function readRecord(database, collection, id) {
  if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown CRM collection: ${collection}`);
  const row = database.prepare('SELECT payload FROM crm_records WHERE collection = ? AND id = ?').get(collection, String(id));
  return row ? JSON.parse(decryptPayload(row.payload)) : null;
}

function updateRecords(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const getRow = database.prepare('SELECT payload FROM crm_records WHERE collection = ? AND id = ?');
    const putRow = database.prepare(`INSERT INTO crm_records (collection, id, payload) VALUES (?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET payload = excluded.payload`);
    const access = {
      get(collection, id) {
        if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown CRM collection: ${collection}`);
        const row = getRow.get(collection, String(id));
        return row ? JSON.parse(decryptPayload(row.payload)) : null;
      },
      set(collection, record) {
        if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown CRM collection: ${collection}`);
        if (!record || typeof record !== 'object' || record.id == null) throw new Error(`Invalid ${collection} record`);
        putRow.run(collection, String(record.id), encryptPayload(JSON.stringify(record)));
      }
    };
    const result = operation(access);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function writeDatabase(database, value) {
  const db = normalize(value);
  const before = snapshots.get(value) || normalize({});
  database.exec('BEGIN IMMEDIATE');
  try {
    const getRecord = database.prepare('SELECT payload FROM crm_records WHERE collection = ? AND id = ?');
    const removeRecord = database.prepare('DELETE FROM crm_records WHERE collection = ? AND id = ?');
    const putRecord = database.prepare(`INSERT INTO crm_records (collection, id, payload) VALUES (?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET payload = excluded.payload`);
    for (const collection of COLLECTIONS) {
      const oldRecords = new Map(before[collection].map(record => [String(record.id), JSON.stringify(record)]));
      const newRecords = new Map();
      for (const record of db[collection]) {
        if (!record || typeof record !== 'object' || record.id == null) {
          throw new Error(`Invalid ${collection} record: expected an object with an id`);
        }
        const id = String(record.id);
        if (newRecords.has(id)) throw new Error(`Duplicate ${collection} id: ${id}`);
        newRecords.set(id, JSON.stringify(record));
      }
      for (const id of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
        const oldPayload = oldRecords.get(id) ?? null;
        const newPayload = newRecords.get(id) ?? null;
        if (oldPayload === newPayload) continue;
        const storedRaw = getRecord.get(collection, id)?.payload ?? null;
        const stored = storedRaw === null ? null : decryptPayload(storedRaw);
        if (stored !== oldPayload) {
          const error = new Error(`This ${collection} record changed in another request. Reload the page and try again.`);
          error.code = 'CRM_CONCURRENT_UPDATE';
          throw error;
        }
        if (newPayload === null) removeRecord.run(collection, id);
        else putRecord.run(collection, id, encryptPayload(newPayload));
      }
    }
    const oldSettings = JSON.stringify(before.settings || {});
    const storedSettingsRaw = database.prepare('SELECT payload FROM crm_settings WHERE id = 1').get()?.payload ?? null;
    const storedSettings = storedSettingsRaw === null ? null : decryptPayload(storedSettingsRaw);
    const newSettings = JSON.stringify(db.settings);
    if (newSettings !== oldSettings) {
      if (storedSettings !== oldSettings) {
        const error = new Error('Settings changed in another request. Reload the page and try again.');
        error.code = 'CRM_CONCURRENT_UPDATE';
        throw error;
      }
      database.prepare(`INSERT INTO crm_settings (id, payload) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(encryptPayload(newSettings));
    }
    database.exec('COMMIT');
    snapshots.set(value, JSON.parse(JSON.stringify(db)));
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { openDatabase, readDatabase, writeDatabase, readRecord, updateRecords };
