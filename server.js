
 // Company CRM - Express server with local SQLite storage.
const express = require('express');
const fs = require('node:fs');
const path = require('path');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { backup: sqliteBackup } = require('node:sqlite');
const { openDatabase: openSQLiteDatabase, readDatabase: readSQLiteDatabase, writeDatabase: writeSQLiteDatabase, readRecord: readSQLiteRecord, updateRecords: updateSQLiteRecords } = require('./lib/database');
const { openDatabase: openPostgresDatabase, readDatabase: readPostgresDatabase, writeDatabase: writePostgresDatabase, readRecord: readPostgresRecord, updateRecords: updatePostgresRecords, flush, closeDatabase } = require('./lib/database-postgres');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (!APP_PASSWORD) throw new Error('Set APP_PASSWORD before starting the CRM.');
if (APP_PASSWORD.length < 12) throw new Error('APP_PASSWORD must be at least 12 characters long.');
async function startCRM() {
// Production uses Neon whenever DATABASE_URL is set. SQLite is available only
// for explicit local test/development runs with CRM_DB_FILE configured.
const usingPostgres = Boolean(process.env.DATABASE_URL);
if (!usingPostgres && process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production. Configure Neon PostgreSQL in Render.');
if (!usingPostgres && !process.env.CRM_DB_FILE) throw new Error('DATABASE_URL is required. For isolated local SQLite tests only, explicitly set CRM_DB_FILE.');
const DB_FILE = process.env.CRM_DB_FILE || path.join(__dirname, 'data', 'crm.sqlite');
const LEGACY_DB_FILE = path.join(__dirname, 'data', 'db.json');
const database = usingPostgres ? await openPostgresDatabase() : openSQLiteDatabase(DB_FILE, LEGACY_DB_FILE);
const readDatabase = usingPostgres ? readPostgresDatabase : readSQLiteDatabase;
const writeDatabase = usingPostgres ? writePostgresDatabase : writeSQLiteDatabase;
const readRecord = usingPostgres ? readPostgresRecord : readSQLiteRecord;
const updateRecords = usingPostgres ? updatePostgresRecords : updateSQLiteRecords;
const sessions = new Map();
const loginFailures = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'crm_session';
let massMailInProgress = false;

const app = express();
if (process.env.CRM_TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use('/api', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  next();
});
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  next();
});

// Ensure queued PostgreSQL writes have committed before a response is sent.
app.use((req, res, next) => {
  if (!usingPostgres) return next();
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  res.json = body => {
    flush(database).then(() => originalJson(body)).catch(err => {
      console.error('CRM PostgreSQL write failed:', err.message);
      if (!res.headersSent) originalJson({ error: 'Database write failed. Please retry after the database connection is restored.' });
    });
    return res;
  };
  res.send = body => {
    flush(database).then(() => originalSend(body)).catch(err => {
      console.error('CRM PostgreSQL write failed:', err.message);
      if (!res.headersSent) originalJson({ error: 'Database operation failed.' });
    });
    return res;
  };
  next();
});

function sessionId(req) {
  const cookie = req.headers.cookie || '';
  const part = cookie.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + '='));
  return part ? part.slice(COOKIE_NAME.length + 1) : '';
}
function hasSession(req) {
  const id = sessionId(req);
  const expires = sessions.get(id);
  if (!expires) return false;
  if (expires <= Date.now()) { sessions.delete(id); return false; }
  return true;
}
function setSessionCookie(req, res, id) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
}
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get('/api/auth/session', (req, res) => res.json({ authenticated: hasSession(req) }));
app.post('/api/auth/login', (req, res) => {
  for (const [id, expires] of sessions) if (expires <= Date.now()) sessions.delete(id);
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = loginFailures.get(key) || { count: 0, until: 0 };
  if (current.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  const supplied = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
  const expected = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(supplied, expected)) {
    current.count++;
    if (current.count >= 5) { current.count = 0; current.until = Date.now() + 15 * 60 * 1000; }
    loginFailures.set(key, current);
    return res.status(401).json({ error: 'Incorrect company password.' });
  }
  loginFailures.delete(key);
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + SESSION_MS);
  setSessionCookie(req, res, id);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => {
  sessions.delete(sessionId(req));
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/favicon.ico', (req, res) => res.status(204).end()); // no icon file; stops the browser's 404/redirect
app.use((req, res, next) => {
  if (['/login.html', '/login.js', '/login.css'].includes(req.path)) return next();
  if (hasSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in to continue.' });
  res.redirect('/login.html');
});
// The Excel reader is served from node_modules because the Content-Security-Policy above blocks scripts from other sites.
app.get('/vendor/xlsx.full.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')));
app.use(express.static(path.join(__dirname, 'public')));

// Keep the existing route modules' load/save interface while persisting every
// collection in SQLite transactions. The database module imports db.json once.
const load = () => readDatabase(database);
const save = db => writeDatabase(database, db);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const now = () => new Date().toISOString();
const STAGES = ['new', 'contacted', 'replied', 'onboarded', 'rejected'];
const CALLS = ['not_called', 'connected', 'no_answer', 'busy', 'callback'];
const CLIENT_TEXT_LIMITS = { name: 200, company: 200, phone: 50, email: 254, source: 500, location: 200, notes: 6000, followUp: 40, lastReply: 6000 };
function cleanClientInput(value, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'client data must be an object' };
  const fields = { name: 200, company: 200, location: 200, phone: 50, email: 254, source: 500, notes: 6000, followUp: 40, lastReply: 6000 };
  const clean = {};
  for (const [field, max] of Object.entries(fields)) {
    if (value[field] === undefined) continue;
    if (value[field] === null) { clean[field] = ''; continue; }
    if (typeof value[field] !== 'string' && typeof value[field] !== 'number') return { error: `${field} must be text` };
    clean[field] = String(value[field]).trim().slice(0, max);
  }
  if (!partial && !clean.name) return { error: 'name is required' };
  if (clean.name !== undefined && !clean.name) return { error: 'name is required' };
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) return { error: 'email is not valid' };
  if (clean.followUp && Number.isNaN(new Date(clean.followUp).getTime())) return { error: 'followUp is not a valid date-time' };
  if (value.stage !== undefined) {
    if (!STAGES.includes(value.stage)) return { error: 'stage is not valid' };
    clean.stage = value.stage;
  }
  if (value.callStatus !== undefined) {
    if (!CALLS.includes(value.callStatus)) return { error: 'callStatus is not valid' };
    clean.callStatus = value.callStatus;
  }
  return { clean };
}
function log(db, clientId, type, note) {
  db.activities.push({ id: uid(), clientId, type, note: String(note || ''), at: now() });
}

// A process restart can interrupt a mass-mail request. Preserve that state so
// the UI does not imply the campaign completed or invite a blind retry.
const startupDb = load();
let recoveredCampaign = false;
for (const campaign of startupDb.campaigns) {
  if (campaign.status === 'sending') {
    campaign.status = 'interrupted';
    campaign.finishedAt = now();
    recoveredCampaign = true;
  }
}
if (recoveredCampaign) save(startupDb);

app.get('/api/backup', asyncRoute(async (req, res) => {
  let backupFile = '';
  try {
    const date = new Date().toISOString().slice(0, 10);
    if (!usingPostgres) {
      backupFile = `${DB_FILE}.backup-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
      await sqliteBackup(database, backupFile);
      const contents = fs.readFileSync(backupFile);
      res.set({ 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="company-crm-${date}.sqlite"`, 'Cache-Control': 'no-store' });
      return res.send(contents);
    }
    await flush(database);
    const contents = JSON.stringify({ exportedAt: new Date().toISOString(), format: 'right-head-crm-json-v1', data: load() }, null, 2);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="right-head-crm-${date}.json"`, 'Cache-Control': 'no-store' });
    return res.send(contents);
  } catch (error) {
    console.error('CRM backup failed:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not create the CRM backup.' });
  } finally {
    if (backupFile) try { fs.rmSync(backupFile, { force: true }); } catch (error) { console.error('CRM temporary backup cleanup failed:', error.message); }
  }
}));

app.get('/api/clients', (req, res) => {
  const db = load();
  res.json(db.clients);
});

app.post('/api/clients', (req, res) => {
  const db = load();
  const raw = req.body || {};
  const result = cleanClientInput(raw);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const b = result.clean;

  const createdAt =
    raw.dateAdded && !Number.isNaN(new Date(raw.dateAdded).getTime())
      ? new Date(raw.dateAdded).toISOString()
      : now();

  const c = {
    id: uid(),
    name: b.name,
    company: b.company || '',
    location: b.location || '',
    phone: b.phone || '',
    email: b.email || '',
    source: b.source || '',
    notes: b.notes || '',
    stage: b.stage || 'new',
    callStatus: b.callStatus || 'not_called',
    followUp: b.followUp || '',
    lastReply: b.lastReply || '',
    createdAt,
    updatedAt: now()
  };

  db.clients.push(c);
  log(db, c.id, 'created', 'Client added');
  save(db);

  res.json(c);
});

app.put('/api/clients/:id', (req, res) => {
  const db = load();
  const c = db.clients.find(x => x.id === req.params.id);

  if (!c) {
    return res.status(404).json({ error: 'not found' });
  }

  const result = cleanClientInput(req.body, true);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const b = result.clean;

  const fields = [
    'name',
    'company',
    'location',
    'phone',
    'email',
    'source',
    'notes',
    'followUp',
    'lastReply'
  ];

  fields.forEach(field => {
    if (b[field] !== undefined) {
      c[field] = b[field];
    }
  });

  if (b.stage && b.stage !== c.stage) {
    log(db, c.id, 'stage', `Stage: ${c.stage} -> ${b.stage}`);
    c.stage = b.stage;

    if (b.stage === 'onboarded' || b.stage === 'rejected') {
      c.followUp = '';
    }
  }

  if (b.callStatus && b.callStatus !== c.callStatus) {
    log(db, c.id, 'call', `Call status: ${b.callStatus}`);
    c.callStatus = b.callStatus;

    if (c.stage === 'new') {
      c.stage = 'contacted';
    }
  }

  c.updatedAt = now();
  save(db);

  res.json(c);
});

app.delete('/api/clients/:id', (req, res) => {
  const db = load();
  db.clients = db.clients.filter(x => x.id !== req.params.id);
  db.activities = db.activities.filter(a => a.clientId !== req.params.id);
  db.tasks = db.tasks.filter(t => t.clientId !== req.params.id);
  db.deals.forEach(d => {
    if (d.clientId === req.params.id) d.clientId = '';
  });
  save(db);
  res.json({ ok: true });
});

app.get('/api/clients/:id/activities', (req, res) => {
  const db = load();
  res.json(
    db.activities
      .filter(a => a.clientId === req.params.id)
      .sort((a, b) => b.at.localeCompare(a.at))
  );
});

// Add a note / record a client reply. type: note | reply | call
app.post('/api/clients/:id/activity', (req, res) => {
  const db = load();
  const c = db.clients.find(x => x.id === req.params.id);

  if (!c) {
    return res.status(404).json({ error: 'not found' });
  }

  const { type = 'note', note = '' } = req.body || {};

  if (!['note', 'reply', 'call'].includes(type)) {
    return res.status(400).json({ error: 'activity type is not valid' });
  }

  if (typeof note !== 'string' || note.length > 6000) {
    return res.status(400).json({
      error: 'activity note must be text no longer than 6000 characters'
    });
  }

  log(db, c.id, type, note);

  if (type === 'reply') {
    c.lastReply = note;

    if (c.stage !== 'onboarded' && c.stage !== 'rejected') {
      c.stage = 'replied';
    }
  }

  c.updatedAt = now();
  save(db);
  res.json(c);
});

 // Bulk import: [{name, company, phone, email, ...}]
// Forgiving by design: invalid values are moved into Notes instead of discarding the whole client.
app.post('/api/clients/import', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'request must be an array of clients' });
  }

  if (req.body.length > 10000) {
    return res.status(413).json({ error: 'import is limited to 10000 rows at a time' });
  }

  const db = load();
  let added = 0;
  let skipped = 0;
  const reasons = {};

  const skip = why => {
    skipped++;
    reasons[why] = (reasons[why] || 0) + 1;
  };

  // Compare phone numbers using their last 10 digits.
  const digits = value => {
    const d = String(value || '').replace(/\D/g, '');
    return d.length > 10 ? d.slice(-10) : d;
  };

  req.body.forEach(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return skip('row is not valid');
    }

    const r = {};
    const extra = [];

    for (const [field, limit] of Object.entries(CLIENT_TEXT_LIMITS)) {
      if (raw[field] === undefined || raw[field] === null) continue;

      const text = String(raw[field]).trim();
      if (text) r[field] = text.slice(0, limit);
    }

    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
      const found = r.email.match(/[^\s@,;/<>]+@[^\s@,;/<>]+\.[^\s@,;/<>]+/);
      extra.push(`Email as written: ${r.email}`);
      if (found) r.email = found[0];
      else delete r.email;
    }

    if (r.phone && !/\d/.test(r.phone)) {
      extra.push(`Phone as written: ${r.phone}`);
      delete r.phone;
    }

    if (r.followUp && Number.isNaN(new Date(r.followUp).getTime())) {
      extra.push(`Follow-up as written: ${r.followUp}`);
      delete r.followUp;
    }

    if (extra.length) {
      r.notes = [r.notes, ...extra].filter(Boolean).join(' | ')
        .slice(0, CLIENT_TEXT_LIMITS.notes);
    }

    if (!r.name) r.name = r.company || r.email || r.phone || '';

    if (!r.name) {
      return skip('no name, company, email or phone in the row');
    }

    const email = String(r.email || '').toLowerCase();
    const phone = digits(r.phone);

    const dup = db.clients.find(c =>
      (email && String(c.email || '').toLowerCase() === email) ||
      (phone && digits(c.phone) === phone)
    );

    if (dup) {
      return skip('same email or phone already exists');
    }

    const createdAt =
      raw.dateAdded && !Number.isNaN(new Date(raw.dateAdded).getTime())
        ? new Date(raw.dateAdded).toISOString()
        : now();

    const c = {
      id: uid(),
      name: r.name,
      company: r.company || '',
      location: r.location || '',
      phone: r.phone || '',
      email: r.email || '',
      source: r.source || 'import',
      notes: r.notes || '',
      stage: STAGES.includes(raw.stage) ? raw.stage : 'new',
      callStatus: CALLS.includes(raw.callStatus) ? raw.callStatus : 'not_called',
      followUp: r.followUp || '',
      lastReply: r.lastReply || '',
      createdAt,
      updatedAt: now()
    };

    db.clients.push(c);
    log(db, c.id, 'created', 'Imported');
    added++;
  });

  save(db);
  res.json({ added, skipped, reasons });
});

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const db = load();
  const cs = db.clients;
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);

  const active = cs.filter(c =>
    c.followUp && c.stage !== 'onboarded' && c.stage !== 'rejected'
  );

  const due = active
    .filter(c => new Date(c.followUp) <= today)
    .sort((a, b) => a.followUp.localeCompare(b.followUp));

  const calls = {};
  CALLS.forEach(k => {
    calls[k] = cs.filter(c => c.callStatus === k).length;
  });

  const stages = {};
  STAGES.forEach(k => {
    stages[k] = cs.filter(c => c.stage === k).length;
  });

  res.json({
    total: cs.length,
    stages,
    calls,
    overdue: due.filter(c => new Date(c.followUp) < startToday).length,
    dueToday: due.filter(c => new Date(c.followUp) >= startToday).length,
    reminders: due.slice(0, 8),
    upcoming: active
      .filter(c => new Date(c.followUp) > today)
      .sort((a, b) => a.followUp.localeCompare(b.followUp))
      .slice(0, 5),
    replied: cs
      .filter(c => c.stage === 'replied')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 6),
    onboarded: cs
      .filter(c => c.stage === 'onboarded')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 6),
    rejected: cs
      .filter(c => c.stage === 'rejected')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 6),
    campaigns: db.campaigns.slice(-4).reverse()
  });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => {
  const s = load().settings;

  res.json({
    ...s,
    smtp: { ...s.smtp, pass: s.smtp.pass ? '********' : '' },
    ai: {
      model: s.ai.model,
      apiKey: s.ai.apiKey ? '********' : ''
    }
  });
});

app.put('/api/settings', (req, res) => {
  const db = load();
  const b = req.body;

  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return res.status(400).json({ error: 'settings must be an object' });
  }

  if (b.company !== undefined) {
    if (typeof b.company !== 'string' || b.company.trim().length > 120) {
      return res.status(400).json({ error: 'company must be text no longer than 120 characters' });
    }
    db.settings.company = b.company.trim();
  }

  if (b.currency !== undefined) {
    if (typeof b.currency !== 'string' || !b.currency.trim() || b.currency.trim().length > 4) {
      return res.status(400).json({ error: 'currency must be 1 to 4 characters' });
    }
    db.settings.currency = b.currency.trim();
  }

  if (b.ai) {
    if (typeof b.ai !== 'object' || Array.isArray(b.ai)) {
      return res.status(400).json({ error: 'AI settings must be an object' });
    }

    if (b.ai.apiKey !== undefined && b.ai.apiKey !== '********') {
      if (typeof b.ai.apiKey !== 'string' || b.ai.apiKey.trim().length > 500) {
        return res.status(400).json({ error: 'AI key must be text no longer than 500 characters' });
      }
      db.settings.ai.apiKey = b.ai.apiKey.trim();
    }

    if (b.ai.model !== undefined) {
      if (typeof b.ai.model !== 'string' || b.ai.model.trim().length > 80) {
        return res.status(400).json({ error: 'AI model must be text no longer than 80 characters' });
      }
      db.settings.ai.model = b.ai.model.trim();
    }
  }

  if (b.smtp) {
    if (typeof b.smtp !== 'object' || Array.isArray(b.smtp)) {
      return res.status(400).json({ error: 'SMTP settings must be an object' });
    }

    const stringFields = { host: 255, user: 320, pass: 1000, from: 320 };
    const clean = {};

    for (const [field, limit] of Object.entries(stringFields)) {
      if (b.smtp[field] === undefined ||
          (field === 'pass' && b.smtp.pass === '********')) continue;

      if (typeof b.smtp[field] !== 'string' || b.smtp[field].length > limit) {
        return res.status(400).json({
          error: `${field} must be text no longer than ${limit} characters`
        });
      }

      clean[field] = field === 'pass' ? b.smtp[field] : b.smtp[field].trim();
    }

    if (b.smtp.port !== undefined) {
      const port = Number(b.smtp.port);

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: 'SMTP port must be between 1 and 65535' });
      }

      clean.port = port;
    }

    if (b.smtp.secure !== undefined) {
      if (typeof b.smtp.secure !== 'boolean') {
        return res.status(400).json({ error: 'SMTP secure must be true or false' });
      }

      clean.secure = b.smtp.secure;
    }

    const keepPass = b.smtp.pass === '********' || b.smtp.pass === undefined;

    db.settings.smtp = {
      ...db.settings.smtp,
      ...clean,
      pass: keepPass ? db.settings.smtp.pass : clean.pass
    };
  }

  save(db);
  res.json({ ok: true });
});

 // ---------- mass mailing ----------
const fill = (t, c) =>
  String(t).replace(/{{\s*(name|company|email|phone)\s*}}/gi,
    (_, k) => c[k.toLowerCase()] || '');

const esc = s =>
  String(s).replace(/[&<>]/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  }[m]));

function audience(db, audienceKey) {
  let list = db.clients.filter(c => c.email && c.stage !== 'rejected');
  if (audienceKey === 'all') return list;
  return list.filter(c => c.stage === audienceKey);
}

app.get('/api/mail/audience/:key', (req, res) => {
  res.json({ count: audience(load(), req.params.key).length });
});

app.get('/api/campaigns', (req, res) => {
  res.json(load().campaigns.slice().reverse());
});

function buildTransport(s) {
  const port = Number(s.port) || 587;
  const host = String(s.host || '').trim();
  const secure = port === 465 ? true :
    (port === 587 || port === 25 ? false : !!s.secure);
  const pass = /gmail|googlemail/i.test(host)
    ? String(s.pass || '').replace(/\s+/g, '')
    : String(s.pass || '');

  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && port !== 25,
    auth: { user: String(s.user || '').trim(), pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { servername: host }
  });
}

function smtpErrorMessage(e) {
  const code = e && e.code;
  const resp = (e && e.response) || '';
  const msg = String((e && e.message) || 'unknown error');

  if (code === 'EAUTH' || /535|534|auth/i.test(resp + msg)) {
    return 'Login rejected. For Gmail use an App Password, not your normal password.';
  }
  if (code === 'ENOTFOUND' || code === 'EDNS') {
    return 'SMTP host not found. Check the server name, e.g. smtp.gmail.com.';
  }
  if (code === 'ECONNREFUSED') {
    return 'Connection refused. Check port 587 or 465 and hosting restrictions.';
  }
  if (/timed? ?out/i.test(msg)) {
    return 'Connection timed out. Check the SMTP host, port, and hosting restrictions.';
  }
  if (/wrong version number|ssl routines|packet length/i.test(msg)) {
    return 'SSL/TLS mismatch. Use port 587 with Secure = No, or port 465 with Secure = Yes.';
  }
  if (/self.signed|certificate|altnames/i.test(msg)) {
    return 'Mail server certificate error: ' + msg;
  }
  if (code === 'EENVELOPE' || (/Invalid (recipient|sender)|From/i.test(msg) && /address/i.test(msg))) {
    return 'Sender or recipient address is invalid: ' + msg;
  }
  return msg.slice(0, 300);
}

function smtpTransport(db) {
  const s = db.settings.smtp;
  if (!(s.host && s.user && s.pass)) return null;
  return buildTransport(s);
}

async function sendWithResend({ to, subject, text, html }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.RESEND_FROM || '').trim() || 'onboarding@resend.dev';
  const sandboxTo = (process.env.RESEND_SANDBOX_REDIRECT_TO || '').trim();

  if (!apiKey) {
    throw new Error(
      'Missing RESEND_API_KEY environment variable.'
    );
  }

  const finalTo = sandboxTo || to;
  const finalSubject = sandboxTo ? `[Test for ${to}] ${subject}` : subject;
  const finalHtml = sandboxTo
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;padding:8px 12px;margin-bottom:14px;border-radius:6px;font-size:13px;color:#92400e;"><strong>Resend Sandbox Mode:</strong> Originally intended for <code>${to}</code></div>${html}`
    : html;
  const finalText = sandboxTo
    ? `[Resend Sandbox Mode - Originally intended for: ${to}]\n\n${text}`
    : text;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: finalTo, subject: finalSubject, text: finalText, html: finalHtml }),
    signal: AbortSignal.timeout(20000)
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    let errorMsg =
      result.message ||
      (typeof result.error === 'string' ? result.error : result.error?.message) ||
      `Resend API error: ${response.status}`;

    if (errorMsg.includes('only send testing emails to your own email address')) {
      const registeredEmail = errorMsg.match(/\(([^)]+)\)/)?.[1] || 'your registered account email';
      errorMsg = `Resend Sandbox Restriction: Resend is using onboarding@resend.dev, which can only send to ${registeredEmail}. To send to real clients, verify your domain at resend.com/domains and set RESEND_FROM in Render (e.g. Right Head <contact@righthead.in>). For testing other clients right now, you can set RESEND_SANDBOX_REDIRECT_TO=${registeredEmail} in Render.`;
    }
    throw new Error(errorMsg);
  }

  return result;
}


app.post('/api/mail/test', asyncRoute(async (req, res) => {
  const testTo = (req.body?.to || process.env.RESEND_TEST_TO || '').trim();

  if (!testTo) {
    return res.status(400).json({
      error: 'Set RESEND_TEST_TO in Render environment variables or provide a recipient in the request body.'
    });
  }

  try {
    await sendWithResend({
      to: testTo,
      subject: 'Right Head CRM - Test Email',
      text: 'Your Right Head CRM email integration is working.',
      html: '<p>Your Right Head CRM email integration is working.</p>'
    });

    res.json({
      ok: true,
      message: 'Test email accepted by Resend.'
    });
  } catch (error) {
    console.error('Resend test failed:', error.message);
    res.status(502).json({
      error: 'Email test failed: ' + error.message
    });
  }
}));


app.post('/api/mail/send-one', asyncRoute(async (req, res) => {
  const db = load();
  const { clientId, subject = '', body = '' } = req.body || {};
  const c = db.clients.find(x => x.id === clientId);

  if (!c) return res.status(404).json({ error: 'client not found' });
  if (!c.email) return res.status(400).json({ error: 'this client has no email address' });

  if (typeof subject !== 'string' || typeof body !== 'string' ||
      !subject.trim() || !body.trim()) {
    return res.status(400).json({ error: 'subject and message are required' });
  }

  if (subject.length > 300 || body.length > 20000) {
    return res.status(400).json({ error: 'subject or message is too long' });
  }

  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim();
  const configured = Boolean((process.env.RESEND_API_KEY || '').trim());

  if (configured) {
    try {
      const personalizedSubject = fill(cleanSubject, c);
      const personalizedBody = fill(body, c);
      await sendWithResend({
        to: c.email,
        subject: personalizedSubject,
        text: personalizedBody,
        html: esc(personalizedBody).replace(/\n/g, '<br>')
      });
    } catch (error) {
      console.error('Single email send failed:', error.message);
      return res.status(502).json({
        error: 'Email send failed: ' + error.message
      });
    }
  }

  const latest = load();
  const current = latest.clients.find(x => x.id === c.id);

  log(latest, c.id, 'mail',
    `Email: ${cleanSubject}${configured ? '' : ' (simulated)'}`);

  if (current) {
    if (current.stage === 'new') current.stage = 'contacted';
    current.updatedAt = now();
  }

  save(latest);
  res.json({
    ok: true,
    simulated: !configured,
    clientDeleted: !current
  });
}));

app.post('/api/mail/send', asyncRoute(async (req, res) => {
  const db = load();
  const {
    audience: key = 'all',
    subject = '',
    body = '',
    dryRun
  } = req.body || {};

  if (typeof subject !== 'string' || typeof body !== 'string' ||
      !subject.trim() || !body.trim()) {
    return res.status(400).json({ error: 'subject and message are required' });
  }

  if (subject.length > 300 || body.length > 20000) {
    return res.status(400).json({ error: 'subject or message is too long' });
  }

  if (!['all', ...STAGES.filter(stage => stage !== 'rejected')].includes(key)) {
    return res.status(400).json({ error: 'unknown audience' });
  }

  if (massMailInProgress) {
    return res.status(409).json({
      error: 'A mass-mail campaign is already running. Wait for it to finish before starting another.'
    });
  }

  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim();
  const list = audience(db, key);
  const configured = Boolean((process.env.RESEND_API_KEY || '').trim());
  const simulate = dryRun === true || !configured;

  massMailInProgress = true;

  try {
    const camp = {
      id: uid(),
      at: now(),
      subject: cleanSubject,
      audience: key,
      total: list.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      simulated: !!simulate,
      status: list.length ? 'sending' : 'complete',
      finishedAt: list.length ? '' : now()
    };

    const initial = load();
    initial.campaigns.push(camp);
    save(initial);

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];

    for (const c of list) {
      const recipient = readRecord(database, 'clients', c.id);
      const eligible = recipient && recipient.email &&
        recipient.stage !== 'rejected' &&
        (key === 'all' || recipient.stage === key);

      if (!eligible) {
        skipped++;

        updateRecords(database, ({ get, set }) => {
          const running = get('campaigns', camp.id);
          if (!running) return;

          running.sent = sent;
          running.failed = failed;
          running.skipped = skipped;

          if (sent + failed + skipped >= list.length) {
            running.status = 'complete';
            running.finishedAt = now();
          }

          set('campaigns', running);
        });

        continue;
      }

      let delivered = false;

      try {
        if (!simulate) {
          const personalizedSubject = fill(cleanSubject, recipient);
          const personalizedBody = fill(body, recipient);
          await sendWithResend({
            to: recipient.email,
            subject: personalizedSubject,
            text: personalizedBody,
            html: esc(personalizedBody).replace(/\n/g, '<br>')
          });

          await new Promise(resolve => setTimeout(resolve, 500));
        }

        sent++;
        delivered = true;
      } catch (e) {
        failed++;
        console.error(`Mass mail send failed for ${recipient.email}:`, e.message);
        errors.push(`${recipient.email}: ${e.message}`);
      }

      updateRecords(database, ({ get, set }) => {
        const running = get('campaigns', camp.id);

        if (running) {
          running.sent = sent;
          running.failed = failed;
          running.skipped = skipped;
          running.errors = errors.slice(0, 20);

          if (sent + failed + skipped >= list.length) {
            running.status = 'complete';
            running.finishedAt = now();
          }

          set('campaigns', running);
        }

        const latestRecipient = get('clients', recipient.id);

        if (delivered && latestRecipient) {
          const at = now();

          set('activities', {
            id: uid(),
            clientId: latestRecipient.id,
            type: 'mail',
            note: `Mass mail: ${cleanSubject}${simulate ? ' (simulated)' : ''}`,
            at
          });

          if (latestRecipient.stage === 'new') {
            latestRecipient.stage = 'contacted';
          }

          latestRecipient.updatedAt = at;
          set('clients', latestRecipient);
        }
      });
    }

    const completed = load().campaigns.find(x => x.id === camp.id) || camp;
    res.json({ ...completed, errors: errors.slice(0, 5) });
  } finally {
    massMailInProgress = false;
  }
}));

// ---------- CRM tools and Claude AI features ----------
const ctx = { load, save, uid, now, log, STAGES, CALLS };

require('./lib/tools').mount(app, ctx);
require('./lib/ai').mount(app, ctx);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  console.error('CRM request failed:', error.message);

  const status = error.code === 'CRM_CONCURRENT_UPDATE' ? 409 : 500;

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      error: status === 500
        ? 'The request could not be completed.'
        : error.message
    });
  }

  res.status(status).send(
    status === 500
      ? 'The request could not be completed.'
      : error.message
  );
});

const server = app.listen(PORT, () => {
  console.log(`CRM running at http://localhost:${PORT}`);
});

function shutdown() {
  server.close(async () => {
    try {
      if (usingPostgres) await closeDatabase(database);
      else database.close();
    } catch (err) { console.error('Database shutdown error:', err.message); }
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
}

startCRM().catch(err => {
  console.error('CRM startup failed:', err.message);
  process.exitCode = 1;
});

