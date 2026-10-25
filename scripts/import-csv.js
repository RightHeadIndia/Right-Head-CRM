// Standalone script to import client data from a CSV, TSV, or Google Sheet export.
// Usage: node scripts/import-csv.js <path-to-file.csv>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load environment from .env if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const { openDatabase: openSQLiteDatabase, readDatabase, writeDatabase } = require('../lib/database');
const { openDatabase: openPostgresDatabase, flush, closeDatabase } = require('../lib/database-postgres');
const DB_FILE = process.env.CRM_DB_FILE || path.join(__dirname, '..', 'data', 'crm.sqlite');

const HEADER_ALIASES = {
  name: ['name', 'fullname', 'clientname', 'customername', 'contactname', 'contactperson', 'person'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'businessname', 'firm'],
  phone: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contactno', 'contactnumber', 'whatsapp', 'whatsappnumber', 'cell', 'telephone', 'tel'],
  email: ['email', 'emailid', 'emailaddress', 'mail', 'mailid'],
  source: ['source', 'leadsource'],
  link: ['link', 'website', 'url', 'links', 'linkedin', 'profile', 'profileurl', 'profilelink', 'weburl', 'sheetlink'],
  stage: ['status', 'clientstatus', 'leadstatus', 'stage'],
  followUp: ['followup', 'nextfollowup', 'followupdate', 'nextfollowupdate'],
  lastReply: ['lastreply', 'latestreply'], callStatus: ['callstatus', 'callingstatus'],
  sno: ['sno', 'srno', 'slno', 'serialno', 'serialnumber'],
  dateadded: ['dateadded', 'date', 'addedon', 'addeddate', 'dateaddedon', 'entrydate', 'createddate', 'datecreated'],
  location: ['location', 'city', 'address', 'place', 'state', 'country', 'region'],
  credentialsshared: [
    'credentialsshared', 'credentialssharedyn', 'credentialssharedyorn', 'credentialssharedyesno',
    'credentialssharedyesorn', 'credentialshared', 'credentialsharedyn', 'credentialsharedyesno',
    'credentials', 'credentialsyn', 'credentialsyesno', 'credential', 'credentialsstatus', 'credsshared'
  ],
  remark: ['remark', 'remarks'], notes: ['notes', 'note', 'comments', 'comment'],
  meetingStatus: ['meetingstatus'], kanakNotes: ['kanaknotes'], avvniNotes: ['avvninotes'], emailSent: ['emailsent', 'emailsentyn']
};
for (let n = 1; n <= 12; n++) HEADER_ALIASES['reminder' + n] = ['reminder' + n];
const HEADER_LOOKUP = {};
Object.entries(HEADER_ALIASES).forEach(([field, list]) => list.forEach(a => { HEADER_LOOKUP[a] = field; }));

const CLIENT_TEXT_LIMITS = { name: 200, company: 200, phone: 50, email: 254, source: 500, location: 200, notes: 6000, followUp: 40, lastReply: 6000 };
const STAGES = ['new', 'contacted', 'replied', 'onboarded', 'rejected'];
const CALLS = ['not_called', 'connected', 'no_answer', 'busy', 'callback'];

function parseFlexibleDate(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date((parseFloat(s) - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    const day = parseInt(dmy[1], 10), month = parseInt(dmy[2], 10) - 1, year = parseInt(dmy[3], 10);
    const hour = parseInt(dmy[4] || 0, 10), min = parseInt(dmy[5] || 0, 10), sec = parseInt(dmy[6] || 0, 10);
    const d = new Date(Date.UTC(year, month, day, hour, min, sec));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso.toISOString();
  return '';
}

function parseCsv(text) {
  const firstLine = (text.match(/^[^\r\n]*/)?.[0] || '');
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delimiter = tabCount > commaCount && tabCount > semiCount ? '\t'
                  : semiCount > commaCount && semiCount > tabCount ? ';'
                  : ',';

  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === delimiter) {
      cur.push(f); f = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(f); f = '';
      if (cur.some(x => x.trim())) rows.push(cur);
      cur = [];
    } else {
      f += ch;
    }
  }
  cur.push(f);
  if (cur.some(x => x.trim())) rows.push(cur);
  return rows;
}

function rowsToObjects(table) {
  if (!table.length) throw new Error('The file is empty');
  const clean = h => String(h ?? '').replace(/^\uFEFF/, '').trim();
  const heads = table.shift().map(clean);
  const fields = heads.map(h => HEADER_LOOKUP[h.toLowerCase().replace(/[^a-z0-9]/g, '')] || '');
  return table.map(r => {
    const o = { other: [] };
    heads.forEach((h, i) => {
      const value = String(r[i] ?? '').trim(), f = fields[i];
      if (!value) return;
      if (!f || o[f]) { if (h) o.other.push(`${h}: ${value}`); return; }
      o[f] = value;
    });
    return o;
  });
}

async function importCsvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found at "${filePath}"`);
    process.exit(1);
  }

  console.log(`Reading "${filePath}"...`);
  const content = fs.readFileSync(filePath, 'utf8');
  const rawTable = parseCsv(content);
  if (rawTable.length < 2) {
    console.error('Error: File must contain a header row and at least one data row.');
    process.exit(1);
  }

  const objects = rowsToObjects(rawTable);
  console.log(`Found ${objects.length} data rows in file.`);

  const usingPostgres = Boolean(process.env.DATABASE_URL);
  if (!usingPostgres && process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production.');
  if (!usingPostgres && !process.env.CRM_DB_FILE) throw new Error('Set DATABASE_URL to import into Neon. For isolated local tests, explicitly set CRM_DB_FILE.');
  const database = usingPostgres ? await openPostgresDatabase() : openSQLiteDatabase(DB_FILE);
  const db = readDatabase(database);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = () => new Date().toISOString();
  const digits = v => { const d = String(v || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };

  let added = 0, skipped = 0;
  const reasons = {};
  const skip = why => { skipped++; reasons[why] = (reasons[why] || 0) + 1; };

  for (const raw of objects) {
    const extras = [];
    if (raw.sno) extras.push(`S No: ${raw.sno}`);
    if (raw.dateadded) extras.push(`Date Added: ${raw.dateadded}`);
    if (raw.link) extras.push(`Link: ${raw.link}`);
    if (raw.location) extras.push(`Location: ${raw.location}`);
    if (raw.credentialsshared) extras.push(`Credentials Shared: ${raw.credentialsshared}`);
    if (raw.remark) extras.push(`Remark: ${raw.remark}`);
    for (let n = 1; n <= 12; n++) {
      const v = raw['reminder' + n];
      if (v) extras.push(`Reminder ${n}: ${v}`);
    }
    const existingNotes = raw.notes ? String(raw.notes).trim() : '';
    const fullNotes = [existingNotes, ...extras, ...(raw.other || [])].filter(Boolean).join(' | ');

    const r = {};
    for (const [field, limit] of Object.entries(CLIENT_TEXT_LIMITS)) {
      if (raw[field] === undefined || raw[field] === null) continue;
      const text = String(raw[field]).trim();
      if (text) r[field] = text.slice(0, limit);
    }
    if (raw.location) r.location = String(raw.location).trim().slice(0, CLIENT_TEXT_LIMITS.location);
    if (raw.link && !r.source) r.source = String(raw.link).trim().slice(0, CLIENT_TEXT_LIMITS.source);
    if (fullNotes) r.notes = fullNotes.slice(0, CLIENT_TEXT_LIMITS.notes);

    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
      const found = r.email.match(/[^\s@,;/<>]+@[^\s@,;/<>]+\.[^\s@,;/<>]+/);
      if (found) r.email = found[0]; else delete r.email;
    }
    if (r.phone && !/\d/.test(r.phone)) delete r.phone;

    if (!r.name) r.name = r.company || r.email || r.phone || '';
    if (!r.name) { skip('no name, company, email or phone in the row'); continue; }

    const email = String(r.email || '').toLowerCase(), phone = digits(r.phone);
    const dup = db.clients.find(c => (email && String(c.email || '').toLowerCase() === email) || (phone && digits(c.phone) === phone));
    if (dup) { skip('same email or phone already exists'); continue; }

    let createdAt = now();
    if (raw.dateadded) {
      const p = parseFlexibleDate(raw.dateadded);
      if (p) createdAt = p;
    }

    const c = {
      id: uid(),
      name: r.name,
      company: r.company || '',
      phone: r.phone || '',
      email: r.email || '',
      source: r.source || 'import',
      location: r.location || '',
      notes: r.notes || '',
      stage: STAGES.includes(raw.stage) ? raw.stage : 'new',
      callStatus: CALLS.includes(raw.callStatus) ? raw.callStatus : 'not_called',
      followUp: r.followUp || '',
      lastReply: '',
      createdAt,
      updatedAt: now()
    };

    db.clients.push(c);
    db.activities.push({ id: uid(), clientId: c.id, type: 'created', note: 'Imported from CSV', at: now() });
    added++;
  }

  writeDatabase(database, db);
  if (usingPostgres) { await flush(database); await closeDatabase(database); } else database.close();

  console.log(`\nImport Summary:`);
  console.log(`  Successfully added: ${added} client(s)`);
  console.log(`  Skipped:            ${skipped} row(s)`);
  if (Object.keys(reasons).length) {
    console.log(`  Skip breakdown:`);
    for (const [k, v] of Object.entries(reasons)) {
      console.log(`    - ${v}x ${k}`);
    }
  }
  console.log(`\nDone! Total clients in CRM: ${db.clients.length}`);
}

const targetFile = process.argv[2];
if (!targetFile) {
  console.log('Usage: node scripts/import-csv.js <path-to-file.csv>');
  console.log('Example: node scripts/import-csv.js data/clients.csv');
  process.exit(0);
}

importCsvFile(path.resolve(process.cwd(), targetFile)).catch(err => { console.error('Import failed:', err.message); process.exitCode = 1; });

