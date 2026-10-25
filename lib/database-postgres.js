// PostgreSQL-backed adapter for the existing CRM data model.
// Encrypted payload format and key derivation are intentionally compatible with lib/database.js.
'use strict';
const crypto = require('node:crypto');
const { Pool } = require('pg');

const COLLECTIONS = ['clients', 'activities', 'campaigns', 'tasks', 'deals', 'templates'];
const SETTINGS = 'settings', SETTINGS_ID = 'main';
const ALL = [...COLLECTIONS, SETTINGS];
const states = new WeakMap();
const defaultSettings = () => ({ smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' }, company: 'Right Head', currency: '₹', ai: { apiKey: '', model: '' } });
function normalizeSettings(s) { const d = defaultSettings(), x = s && typeof s === 'object' ? s : {}; return { ...d, ...x, smtp: { ...d.smtp, ...(x.smtp || {}) }, ai: { ...d.ai, ...(x.ai || {}) } }; }
function conflict() { const e = new Error('This record was changed by someone else a moment ago. Reload the page and try again.'); e.code = 'CRM_CONCURRENT_UPDATE'; return e; }
function loadKey() { const raw = process.env.CRM_ENCRYPTION_KEY || ''; if (!raw) throw new Error('Set CRM_ENCRYPTION_KEY before starting the CRM.'); const key = Buffer.from(raw, 'base64'); if (key.length !== 32) throw new Error('CRM_ENCRYPTION_KEY must be a base64-encoded 32-byte key.'); return key; }
function encrypt(key, aad, text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad)); const body = Buffer.concat([c.update(text, 'utf8'), c.final()]); return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64'); }
function decrypt(key, aad, value) { if (typeof value !== 'string' || !value.startsWith('v1:')) throw new Error('unknown record format'); const buf = Buffer.from(value.slice(3), 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'); }

async function openDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Configure a Neon PostgreSQL connection string; this server will not fall back to SQLite.');
  const key = loadKey();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, max: Number(process.env.PGPOOL_MAX || 10), connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, application_name: 'right-head-crm' });
  pool.on('error', err => console.error('Unexpected idle PostgreSQL client error:', err.message));
  await pool.query('SELECT 1');
  await pool.query(`CREATE TABLE IF NOT EXISTS public.records (collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id)); CREATE TABLE IF NOT EXISTS public.meta (k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_records_collection ON public.records(collection);`);
  const keyCheck = await pool.query('SELECT v FROM public.meta WHERE k = $1', ['key_check']);
  if (keyCheck.rowCount) {
    try { if (decrypt(key, 'meta/key_check', keyCheck.rows[0].v) !== 'crm-ok') throw new Error('mismatch'); }
    catch { await pool.end(); throw new Error('CRM_ENCRYPTION_KEY does not match this Neon database. Use the original key; do not change or regenerate it.'); }
  } else {
    // Add the marker only when this is a new/compatible empty metadata table.
    await pool.query('INSERT INTO public.meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING', ['key_check', encrypt(key, 'meta/key_check', 'crm-ok')]);
    const verified = await pool.query('SELECT v FROM public.meta WHERE k = $1', ['key_check']);
    try { if (decrypt(key, 'meta/key_check', verified.rows[0].v) !== 'crm-ok') throw new Error('mismatch'); }
    catch { await pool.end(); throw new Error('Neon contains an incompatible key_check. No records were modified.'); }
  }
  const state = { key, pool, records: Object.fromEntries(ALL.map(c => [c, new Map()])), queue: Promise.resolve(), failed: null };
  const rows = await pool.query('SELECT collection, id, version, data FROM public.records ORDER BY collection, id');
  for (const row of rows.rows) {
    if (!state.records[row.collection]) continue;
    try { state.records[row.collection].set(row.id, { json: decrypt(key, `${row.collection}/${row.id}`, row.data), version: Number(row.version) }); }
    catch (err) { await pool.end(); throw new Error(`Could not decrypt record ${row.collection}/${row.id}. Verify CRM_ENCRYPTION_KEY. No data was changed.`); }
  }
  states.set(pool, state);
  return pool;
}
const stateOf = database => { const s = states.get(database); if (!s) throw new Error('database is not open'); if (s.failed) throw new Error('Database persistence failed; restart the CRM after resolving the PostgreSQL issue.'); return s; };
function readDatabase(database) { const st = stateOf(database), out = {}, versions = new Map(); for (const coll of COLLECTIONS) { out[coll] = []; for (const [id, e] of st.records[coll]) { out[coll].push(JSON.parse(e.json)); versions.set(coll + '/' + id, e.version); } } const s = st.records[SETTINGS].get(SETTINGS_ID); out.settings = normalizeSettings(s ? JSON.parse(s.json) : null); delete out.settings.id; if (s) versions.set(SETTINGS + '/' + SETTINGS_ID, s.version); Object.defineProperty(out, '__versions', { value: versions }); return out; }
function readRecord(database, collection, id) { const st = stateOf(database); const e = st.records[collection] && st.records[collection].get(id); return e ? JSON.parse(e.json) : null; }
function persistChanges(database, st, changes) {
  st.queue = st.queue.then(async () => {
    const client = await st.pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of changes) {
        if (c.type === 'put') {
          const encrypted = encrypt(st.key, `${c.coll}/${c.id}`, c.json);
          if (c.expectedVersion === null) {
            try { await client.query('INSERT INTO public.records (collection,id,version,data) VALUES ($1,$2,$3,$4)', [c.coll,c.id,c.version,encrypted]); }
            catch (err) { if (err.code === '23505') throw conflict(); throw err; }
          } else {
            const r = await client.query('UPDATE public.records SET version=$1, data=$2 WHERE collection=$3 AND id=$4 AND version=$5', [c.version, encrypted, c.coll, c.id, c.expectedVersion]);
            if (r.rowCount !== 1) throw conflict();
          }
        } else {
          const r = await client.query('DELETE FROM public.records WHERE collection=$1 AND id=$2 AND version=$3', [c.coll,c.id,c.expectedVersion]);
          if (r.rowCount !== 1) throw conflict();
        }
      }
      await client.query('COMMIT');
    } catch (err) { try { await client.query('ROLLBACK'); } catch {} st.failed = err; throw err; }
    finally { client.release(); }
  });
  return st.queue;
}
function writeDatabase(database, db) {
  const st = stateOf(database), base = db && db.__versions;
  if (!base) throw new Error('writeDatabase needs an object returned by readDatabase');
  const changes = [], present = new Set();
  const consider = (coll, obj) => {
    if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string' || !obj.id) throw new Error(`a ${coll} record has no id`);
    const key = coll + '/' + obj.id; present.add(key); const json = JSON.stringify(obj), cur = st.records[coll].get(obj.id);
    if (!cur) { if (base.has(key)) throw conflict(); changes.push({ type:'put', coll, id:obj.id, json, version:1, expectedVersion:null }); return; }
    if (cur.json === json) return;
    if (base.get(key) !== cur.version) throw conflict();
    changes.push({ type:'put', coll, id:obj.id, json, version:cur.version+1, expectedVersion:cur.version });
  };
  for (const coll of COLLECTIONS) for (const obj of db[coll] || []) consider(coll,obj);
  consider(SETTINGS,{...normalizeSettings(db.settings),id:SETTINGS_ID});
  for (const [key, ver] of base) { if (present.has(key)) continue; const i=key.indexOf('/'), coll=key.slice(0,i), id=key.slice(i+1), cur=st.records[coll] && st.records[coll].get(id); if (!cur) continue; if (cur.version !== ver) throw conflict(); changes.push({type:'del',coll,id,expectedVersion:ver}); }
  for (const c of changes) { if (c.type==='put') st.records[c.coll].set(c.id,{json:c.json,version:c.version}); else st.records[c.coll].delete(c.id); }
  if (changes.length) { const p = persistChanges(database,st,changes); for (const c of changes) { if(c.type==='put') base.set(c.coll+'/'+c.id,c.version); else base.delete(c.coll+'/'+c.id); } p.catch(()=>{}); }
  return undefined;
}
function updateRecords(database, fn) { const st=stateOf(database), staged=new Map(); const get=(coll,id)=>{const s=staged.get(coll+'/'+id);if(s)return JSON.parse(s.json);const e=st.records[coll]&&st.records[coll].get(id);return e?JSON.parse(e.json):undefined;}; const set=(coll,obj)=>{if(!st.records[coll])throw new Error('unknown collection '+coll);if(!obj||typeof obj.id!=='string'||!obj.id)throw new Error(`a ${coll} record has no id`);const key=coll+'/'+obj.id,cur=st.records[coll].get(obj.id),prev=staged.get(key);staged.set(key,{type:'put',coll,id:obj.id,json:JSON.stringify(obj),version:(prev?prev.version:cur?cur.version:0)+1,expectedVersion:prev?prev.version:cur?cur.version:null});}; fn({get,set}); const changes=[...staged.values()]; for(const c of changes)st.records[c.coll].set(c.id,{json:c.json,version:c.version}); if(changes.length)persistChanges(database,st,changes).catch(()=>{}); }
async function flush(database) { const st = states.get(database); if (!st) return; await st.queue; if (st.failed) throw st.failed; }
async function closeDatabase(database) { const st = states.get(database); if (!st) return; try { await flush(database); } finally { await st.pool.end(); states.delete(database); } }
module.exports = { openDatabase, readDatabase, writeDatabase, readRecord, updateRecords, flush, closeDatabase, COLLECTIONS };
