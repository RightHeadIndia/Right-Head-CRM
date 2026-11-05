
// Company CRM - Express server with encrypted Neon PostgreSQL persistence and an isolated SQLite compatibility mode.
const express = require('express');
const fs = require('node:fs');
const path = require('path');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { backup: sqliteBackup } = require('node:sqlite');
const { openDatabase: openSQLiteDatabase, readDatabase: readSQLiteDatabase, writeDatabase: writeSQLiteDatabase, readRecord: readSQLiteRecord, updateRecords: updateSQLiteRecords } = require('./lib/database');
const { openDatabase: openPostgresDatabase, readDatabase: readPostgresDatabase, writeDatabase: writePostgresDatabase, readRecord: readPostgresRecord, updateRecords: updatePostgresRecords, flush, closeDatabase, tryAdvisoryLock } = require('./lib/database-postgres');

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
const revokedSessions = new Set();
const loginFailures = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'crm_session';
let massMailInProgress = false;

const app = express();
if (process.env.CRM_TRUST_PROXY === '1' || process.env.NODE_ENV === 'production' || process.env.RENDER) app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb', verify(req, res, buffer) { req.rawBody = Buffer.from(buffer); } }));
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

function createSessionToken() {
  const rand = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + SESSION_MS;
  const payload = `${rand}.${exp}`;
  const sig = crypto.createHmac('sha256', APP_PASSWORD).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function sessionId(req) {
  const cookie = req.headers.cookie || '';
  const part = cookie.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + '='));
  return part ? decodeURIComponent(part.slice(COOKIE_NAME.length + 1)) : '';
}

function hasSession(req) {
  const token = sessionId(req);
  if (!token) return false;
  if (revokedSessions.has(token)) return false;

  const parts = token.split('.');
  if (parts.length === 3) {
    const [rand, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp <= Date.now()) return false;
    const payload = `${rand}.${expStr}`;
    const expectedSig = crypto.createHmac('sha256', APP_PASSWORD).update(payload).digest('hex');
    try {
      if (crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        return true;
      }
    } catch {
      return false;
    }
  }

  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires <= Date.now()) { sessions.delete(token); return false; }
  return true;
}

function setSessionCookie(req, res, id) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const secure = isHttps ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
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
  const id = createSessionToken();
  sessions.set(id, Date.now() + SESSION_MS);
  setSessionCookie(req, res, id);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => {
  const id = sessionId(req);
  if (id) {
    revokedSessions.add(id);
    sessions.delete(id);
  }
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/favicon.ico', (req, res) => res.status(204).end()); // no icon file; stops the browser's 404/redirect
app.use((req, res, next) => {
  let decodedPath = req.path;
  try { decodedPath = decodeURIComponent(req.path); } catch (_) {}

  const isPublic =
    ['/login.html', '/login.js', '/login.css', '/Right head Logo.png', '/logo.png'].includes(decodedPath) ||
    ['/Right head Logo.png', '/logo.png'].includes(req.path) ||
    /\.(png|jpg|jpeg|svg|ico|webp|gif)$/i.test(decodedPath) ||
    decodedPath.startsWith('/vendor/');

  if (req.path === '/api/webhooks/whatsapp') return next();
  if (isPublic) return next();
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
const EMAIL_FOLLOW_UP_HOURS = 48;
const LEGACY_SEQUENCE_DAYS = [1, 2, 4, 7, 10];
const PREVIOUS_SEQUENCE_DAYS = [1, 3, 5, 7, 9];
const SEQUENCE_DAYS = [0, 2, 4, 6, 8];
const CLIENT_TEXT_LIMITS = { name: 200, company: 200, phone: 50, email: 254, source: 500, location: 200, notes: 6000, followUp: 40, lastReply: 6000 };
const COMMUNICATION = ['not_contacted', 'contacted', 'replied', 'opted_out'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function emailAddresses(client) {
  return [...new Set([client.email, ...(Array.isArray(client.alternateEmails) ? client.alternateEmails : [])]
    .filter(email => typeof email === 'string' && EMAIL_PATTERN.test(email.trim()))
    .map(email => email.trim()))];
}
function sameEmail(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function cleanClientInput(value, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'client data must be an object' };
  const fields = { name: 200, company: 200, location: 200, phone: 50, email: 254, source: 500, notes: 6000, followUp: 40, lastReply: 6000 };
  const clean = {};
  if (value.optedOut !== undefined) {
    if (typeof value.optedOut !== 'boolean') return { error: 'optedOut must be true or false' };
    clean.optedOut = value.optedOut;
  }
  if (value.communicationStatus !== undefined) {
    if (!COMMUNICATION.includes(value.communicationStatus)) return { error: 'communicationStatus is not valid' };
    clean.communicationStatus = value.communicationStatus;
  }
  for (const [field, max] of Object.entries(fields)) {
    if (value[field] === undefined) continue;
    if (value[field] === null) { clean[field] = ''; continue; }
    if (typeof value[field] !== 'string' && typeof value[field] !== 'number') return { error: `${field} must be text` };
    clean[field] = String(value[field]).trim().slice(0, max);
  }
  if (!partial && !clean.name) return { error: 'name is required' };
  if (clean.name !== undefined && !clean.name) return { error: 'name is required' };
  if (clean.email && !EMAIL_PATTERN.test(clean.email)) return { error: 'email is not valid' };
  if (value.alternateEmails !== undefined) {
    if (!Array.isArray(value.alternateEmails) || value.alternateEmails.length > 20) return { error: 'alternateEmails must be a list of up to 20 email addresses' };
    const addresses = [];
    for (const rawEmail of value.alternateEmails) {
      if (typeof rawEmail !== 'string') return { error: 'alternate email addresses must be text' };
      const email = rawEmail.trim();
      if (!email || sameEmail(email, clean.email) || addresses.some(existing => sameEmail(existing, email))) continue;
      if (email.length > 254 || !EMAIL_PATTERN.test(email)) return { error: `alternate email address is not valid: ${email.slice(0, 100)}` };
      addresses.push(email);
    }
    clean.alternateEmails = addresses;
  }
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
function log(db, clientId, type, note, details) {
  const client = db.clients.find(item => item.id === clientId);
  db.activities.push({ id: uid(), clientId, ...(client ? { clientName: client.name } : {}), type, note: String(note || ''), ...(details ? { details } : {}), at: now() });
}
const CLIENT_AUDIT_FIELDS = ['name', 'company', 'location', 'phone', 'email', 'alternateEmails', 'source', 'stage', 'callStatus', 'communicationStatus', 'followUp', 'notes', 'optedOut', 'lastReply'];
const CLIENT_AUDIT_LABELS = {
  name: 'Name', company: 'Company', location: 'Location', phone: 'Phone', email: 'Email',
  alternateEmails: 'Additional emails', source: 'Source', stage: 'Stage', callStatus: 'Call status',
  communicationStatus: 'Communication status', followUp: 'Follow-up', notes: 'Notes',
  optedOut: 'Email opt-out', lastReply: 'Last reply'
};
function clientAuditSnapshot(client) {
  return Object.fromEntries(CLIENT_AUDIT_FIELDS.map(field => [
    field, Array.isArray(client[field]) ? [...client[field]] : client[field] ?? ''
  ]));
}
function clientAuditChanges(before, after, includeEmpty = false) {
  return CLIENT_AUDIT_FIELDS.flatMap(field => {
    const previous = before?.[field];
    const current = after?.[field];
    if (JSON.stringify(previous) === JSON.stringify(current)) return [];
    if (!before && !includeEmpty && (current === '' || current === false || (Array.isArray(current) && !current.length))) return [];
    return [{ field, label: CLIENT_AUDIT_LABELS[field], ...(before ? { before: previous } : {}), ...(after ? { after: current } : {}) }];
  });
}
function stopClientSequences(db, clientId, reason) {
  let changed = false;
  for (const campaign of db.campaigns) {
    if (campaign.type !== 'sequence' || !['active', 'paused'].includes(campaign.status)) continue;
    const recipients = campaign.recipients?.filter(r => r.clientId === clientId && ['active', 'retry', 'sending', 'awaiting_outcome'].includes(r.status)) || [];
    if (!recipients.length) continue;
    recipients.forEach(recipient => { recipient.status = 'stopped'; recipient.stopReason = reason; });
    changed = true;
    if (!campaign.recipients.some(r => ['active', 'retry', 'sending', 'awaiting_outcome'].includes(r.status))) { campaign.status = 'complete'; campaign.finishedAt = now(); campaign.nextRunAt = ''; }
  }
  return changed;
}

// A process restart can interrupt a mass-mail request. Preserve that state so
// the UI does not imply the campaign completed or invite a blind retry.
const startupDb = load();
let recoveredCampaign = false;
for (const campaign of startupDb.campaigns) {
  const isLegacySequence = campaign.type === 'sequence' &&
    Array.isArray(campaign.steps) &&
    campaign.steps.length === LEGACY_SEQUENCE_DAYS.length &&
    campaign.steps.every((step, index) => step.day === LEGACY_SEQUENCE_DAYS[index]);
  if (isLegacySequence) {
    campaign.steps = campaign.steps.map((step, index) => ({ ...step, day: PREVIOUS_SEQUENCE_DAYS[index] }));
    if (['active', 'paused'].includes(campaign.status)) {
      for (const recipient of campaign.recipients || []) {
        const nextStep = recipient.nextStep;
        const oldRunAt = recipient.runAt && new Date(recipient.runAt).getTime();
        if (recipient.status !== 'active' || !Number.isInteger(nextStep) || nextStep < 1 || nextStep >= PREVIOUS_SEQUENCE_DAYS.length || !Number.isFinite(oldRunAt)) continue;
        const previousSentAt = oldRunAt - (LEGACY_SEQUENCE_DAYS[nextStep] - LEGACY_SEQUENCE_DAYS[nextStep - 1]) * 864e5;
        recipient.runAt = new Date(previousSentAt + (PREVIOUS_SEQUENCE_DAYS[nextStep] - PREVIOUS_SEQUENCE_DAYS[nextStep - 1]) * 864e5).toISOString();
      }
      updateSequenceNextRun(campaign);
    }
    campaign.updatedAt = now();
    recoveredCampaign = true;
  }
  const isPreviousSequence = campaign.type === 'sequence' &&
    Array.isArray(campaign.steps) &&
    campaign.steps.length === PREVIOUS_SEQUENCE_DAYS.length &&
    campaign.steps.every((step, index) => step.day === PREVIOUS_SEQUENCE_DAYS[index]);
  if (isPreviousSequence) {
    campaign.steps = campaign.steps.map((step, index) => ({ ...step, day: SEQUENCE_DAYS[index] }));
    if (campaign.status === 'active') {
      for (const recipient of campaign.recipients || []) {
        const nextStep = recipient.nextStep;
        const oldRunAt = recipient.runAt && new Date(recipient.runAt).getTime();
        if (recipient.status !== 'active' || !Number.isInteger(nextStep) || nextStep < 0 || nextStep >= SEQUENCE_DAYS.length) continue;
        if (nextStep === 0) {
          recipient.runAt = now();
        } else if (Number.isFinite(oldRunAt)) {
          const previousSentAt = oldRunAt - (PREVIOUS_SEQUENCE_DAYS[nextStep] - PREVIOUS_SEQUENCE_DAYS[nextStep - 1]) * 864e5;
          recipient.runAt = new Date(previousSentAt + (SEQUENCE_DAYS[nextStep] - SEQUENCE_DAYS[nextStep - 1]) * 864e5).toISOString();
        }
      }
      updateSequenceNextRun(campaign);
    }
    campaign.updatedAt = now();
    recoveredCampaign = true;
  }
  if (campaign.status === 'sending') {
    campaign.status = 'interrupted';
    campaign.finishedAt = now();
    recoveredCampaign = true;
  }
  if (campaign.type === 'sequence' && campaign.recipients?.some(r => r.status === 'sending')) {
    // The remote mail server may or may not have accepted the in-flight message
    // before the process stopped. Hold for review instead of risking a duplicate.
    campaign.status = 'paused';
    campaign.recipients.forEach(r => { if (r.status === 'sending') { r.status = 'review'; r.stopReason = 'delivery uncertain after restart'; } });
    campaign.updatedAt = now(); recoveredCampaign = true;
  }
}
if (recoveredCampaign) {
  save(startupDb);
  if (usingPostgres) await flush(database);
}

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
    alternateEmails: b.alternateEmails || [],
    optedOut: b.optedOut || false,
    communicationStatus: b.communicationStatus || (b.optedOut ? 'opted_out' : 'not_contacted'),
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
  log(db, c.id, 'created', 'Client record added', { changes: clientAuditChanges(null, clientAuditSnapshot(c)) });
  save(db);

  res.json(c);
});

app.put('/api/clients/:id', async (req, res, next) => {
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
  const before = clientAuditSnapshot(c);

  const fields = [
    'name',
    'company',
    'location',
    'phone',
    'email',
    'alternateEmails',
    'source',
    'notes',
    'followUp',
    'lastReply',
    'optedOut',
    'communicationStatus'
  ];

  fields.forEach(field => {
    if (b[field] !== undefined) {
      c[field] = b[field];
    }
  });
  if (c.communicationStatus === 'opted_out') c.optedOut = true;
  if (c.optedOut) { c.communicationStatus = 'opted_out'; stopClientSequences(db, c.id, 'opted out'); }
  else if (c.communicationStatus === 'replied' || c.stage === 'replied') stopClientSequences(db, c.id, 'replied');

  if (b.stage && b.stage !== c.stage) {
    log(db, c.id, 'stage', `Stage: ${c.stage} -> ${b.stage}`);
    c.stage = b.stage;

    if (b.stage === 'replied') {
      c.communicationStatus = 'replied';
      stopClientSequences(db, c.id, 'replied');
    } else if (b.stage === 'onboarded' || b.stage === 'rejected') {
      c.followUp = '';
      stopClientSequences(db, c.id, b.stage);
    }
  }

  if (b.callStatus && b.callStatus !== c.callStatus) {
    log(db, c.id, 'call', `Call status: ${b.callStatus}`);
    c.callStatus = b.callStatus;

    if (c.stage === 'new') {
      c.stage = 'contacted';
    }
    if (b.callStatus === 'callback') {
      const dueAt = c.followUp || new Date(Date.now() + 864e5).toISOString();
      c.followUp = dueAt;
      db.tasks.push({ id: uid(), title: `Call back ${c.name}`, clientId: c.id, dueAt, priority: 'high', notes: 'Automatically created from the callback call outcome.', done: false, doneAt: '', createdAt: now(), updatedAt: now() });
      log(db, c.id, 'task', `Callback reminder created for ${dueAt}`);
    }
  }

  const changes = clientAuditChanges(before, clientAuditSnapshot(c));
  if (changes.length) log(db, c.id, 'record', 'Client record updated', { changes });
  c.updatedAt = now();
  save(db);
  // A status dropdown immediately reloads the client list after this response.
  // Wait for queued PostgreSQL writes so that reloads and other app instances
  // cannot read the previous communication status.
  try { await flush(database); } catch (error) { return next(error); }

  res.json(c);
});

app.delete('/api/clients/:id', (req, res) => {
  const db = load();
  const client = db.clients.find(x => x.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'not found' });
  log(db, client.id, 'deleted', 'Client record deleted');
  db.clients = db.clients.filter(x => x.id !== req.params.id);
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

app.get('/api/history', (req, res) => {
  const db = load();
  const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  const limitValue = Number.parseInt(req.query.limit, 10);
  const limit = Number.isInteger(limitValue) ? Math.min(500, Math.max(1, limitValue)) : 100;
  const clientsById = new Map(db.clients.map(client => [client.id, client]));
  const activities = db.activities
    .map(activity => ({
      ...activity,
      clientName: activity.clientName || clientsById.get(activity.clientId)?.name || 'Deleted client'
    }))
    .filter(activity => !type || (type === 'records'
      ? ['created', 'record', 'deleted'].includes(activity.type)
      : activity.type === type))
    .filter(activity => !query || [
      activity.clientName, activity.note,
      ...(activity.details?.changes || []).flatMap(change => [change.label, change.before, change.after])
    ].some(value => String(value ?? '').toLowerCase().includes(query)))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  res.json({ activities: activities.slice(0, limit), total: activities.length, limit });
});

// Add a note / record a client reply. type: note | reply | call
app.post('/api/clients/:id/activity', (req, res) => {
  const db = load();
  const c = db.clients.find(x => x.id === req.params.id);

  if (!c) {
    return res.status(404).json({ error: 'not found' });
  }

  const { type = 'note', note = '' } = req.body || {};

  if (!['note', 'reply', 'call', 'whatsapp', 'linkedin'].includes(type)) {
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
    if (/\b(unsubscribe|stop emailing|stop contacting|remove me|do not contact|don't contact|opt.?out)\b/i.test(note)) {
      c.optedOut = true;
      c.communicationStatus = 'opted_out';
      stopClientSequences(db, c.id, 'opted out');
    } else { c.communicationStatus = 'replied'; stopClientSequences(db, c.id, 'replied'); }
  }
  if (type === 'call') c.communicationStatus = c.optedOut ? 'opted_out' : 'contacted';
  if (type === 'whatsapp' || type === 'linkedin') c.communicationStatus = c.optedOut ? 'opted_out' : 'contacted';

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
      if (text) r[field] = text.slice(0, field === 'email' ? 5000 : limit);
    }

    const emailAsWritten = r.email || '';
    const foundEmails = emailAsWritten.match(/[^\s@,;/<>]+@[^\s@,;/<>]+\.[^\s@,;/<>]+/g) || [];
    if (foundEmails.length) {
      r.email = foundEmails[0];
      r.alternateEmails = [...new Set(foundEmails.slice(1).map(email => email.toLowerCase()))];
      if (foundEmails.length > 1 || emailAsWritten !== foundEmails[0]) extra.push(`Email as written: ${emailAsWritten}`);
    } else if (emailAsWritten) {
      extra.push(`Email as written: ${emailAsWritten}`);
      delete r.email;
    }

    if (raw.alternateEmails !== undefined) {
      const rawAlternates = Array.isArray(raw.alternateEmails) ? raw.alternateEmails : [raw.alternateEmails];
      for (const value of rawAlternates) {
        const text = String(value || '').trim();
        const matches = text.match(/[^\s@,;/<>]+@[^\s@,;/<>]+\.[^\s@,;/<>]+/g) || [];
        if (!matches.length && text) extra.push(`Alternate email as written: ${text}`);
        for (const email of matches) {
          if (!EMAIL_PATTERN.test(email) || email.length > 254) {
            extra.push(`Alternate email as written: ${email}`);
            continue;
          }
          r.alternateEmails ||= [];
          if (!sameEmail(email, r.email) && !r.alternateEmails.some(existing => sameEmail(existing, email))) r.alternateEmails.push(email);
        }
      }
    }
    if (r.alternateEmails?.length > 20) {
      extra.push(`${r.alternateEmails.length - 20} alternate email address(es) omitted`);
      r.alternateEmails = r.alternateEmails.slice(0, 20);
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

    const incomingEmails = [r.email, ...(r.alternateEmails || [])].filter(Boolean);
    const phone = digits(r.phone);

    const dup = db.clients.find(c =>
      incomingEmails.some(email => emailAddresses(c).some(existing => sameEmail(existing, email))) ||
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
      alternateEmails: r.alternateEmails || [],
      optedOut: false,
      communicationStatus: 'not_contacted',
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
    log(db, c.id, 'created', 'Client record imported', { changes: clientAuditChanges(null, clientAuditSnapshot(c)) });
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
    calls[k] = cs.filter(c => CALLS.includes(c.callStatus) ? c.callStatus === k : k === 'not_called').length;
  });
  const communication = {};
  COMMUNICATION.forEach(k => { communication[k] = cs.filter(c => (c.communicationStatus || 'not_contacted') === k).length; });

  const stages = {};
  STAGES.forEach(k => {
    stages[k] = cs.filter(c => STAGES.includes(c.stage) ? c.stage === k : k === 'new').length;
  });

  res.json({
    total: cs.length,
    stages,
    calls,
    communication,
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
    whatsapp: { ...s.whatsapp, accessToken: s.whatsapp.accessToken ? '********' : '', verifyToken: s.whatsapp.verifyToken ? '********' : '', appSecret: s.whatsapp.appSecret ? '********' : '' },
    theme: s.theme || 'light',
    ai: {
      model: s.ai.model,
      provider: s.ai.provider || 'groq',
      baseUrl: s.ai.baseUrl || '',
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
    if (b.ai.provider !== undefined) {
      if (!['groq', 'openai-compatible'].includes(b.ai.provider)) return res.status(400).json({ error: 'AI provider must be groq or openai-compatible' });
      db.settings.ai.provider = b.ai.provider;
    }
    if (b.ai.baseUrl !== undefined) {
      if (typeof b.ai.baseUrl !== 'string' || b.ai.baseUrl.trim().length > 300) return res.status(400).json({ error: 'AI API URL must be text no longer than 300 characters' });
      const baseUrl = b.ai.baseUrl.trim().replace(/\/$/, '');
      if (baseUrl) {
        let parsed; try { parsed = new URL(baseUrl); } catch { return res.status(400).json({ error: 'AI API URL must be a valid HTTPS URL' }); }
        if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) return res.status(400).json({ error: 'AI API URL must use HTTPS' });
      }
      db.settings.ai.baseUrl = baseUrl;
    }
  }

  if (b.whatsapp) {
    if (typeof b.whatsapp !== 'object' || Array.isArray(b.whatsapp)) return res.status(400).json({ error: 'WhatsApp settings must be an object' });
    const fields = { accessToken: 2000, phoneNumberId: 100, apiVersion: 20, verifyToken: 200, appSecret: 500 };
    const next = { ...db.settings.whatsapp };
    for (const [field, max] of Object.entries(fields)) {
      const value = b.whatsapp[field];
      if (value === undefined || (['accessToken', 'verifyToken', 'appSecret'].includes(field) && value === '********')) continue;
      if (typeof value !== 'string' || value.length > max) return res.status(400).json({ error: `WhatsApp ${field} must be text no longer than ${max} characters` });
      next[field] = value.trim();
    }
    if (next.apiVersion && !/^v\d+\.\d+$/.test(next.apiVersion)) return res.status(400).json({ error: 'WhatsApp API version must look like vXX.X' });
    db.settings.whatsapp = next;
  }

  if (b.theme !== undefined) {
    if (!['light', 'dark'].includes(b.theme)) return res.status(400).json({ error: 'theme must be light or dark' });
    db.settings.theme = b.theme;
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

// Official WhatsApp Cloud API: credentials are kept in encrypted CRM settings.
function whatsappSettings() { return load().settings.whatsapp || {}; }
function whatsappConfigured(w) { return Boolean(w.accessToken && w.phoneNumberId && w.apiVersion); }
app.get('/api/whatsapp/status', (req, res) => {
  const w = whatsappSettings();
  res.json({ configured: whatsappConfigured(w), webhookConfigured: Boolean(w.appSecret && w.verifyToken), phoneNumberId: w.phoneNumberId || '' });
});
app.post('/api/whatsapp/test', asyncRoute(async (req, res) => {
  const w = whatsappSettings();
  if (!whatsappConfigured(w)) return res.status(400).json({ error: 'Save the WhatsApp access token, phone number ID, and API version in Settings first.' });
  const r = await fetch(`https://graph.facebook.com/${w.apiVersion}/${encodeURIComponent(w.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${w.accessToken}` }, signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: data.error?.message || 'WhatsApp connection test failed.' });
  res.json({ ok: true, phone: data.display_phone_number || '', name: data.verified_name || '' });
}));
app.post('/api/whatsapp/send', asyncRoute(async (req, res) => {
  const { clientId, message = '' } = req.body || {};
  const db = load(), c = db.clients.find(x => x.id === clientId), w = db.settings.whatsapp || {};
  if (!c) return res.status(404).json({ error: 'client not found' });
  if (!c.phone) return res.status(400).json({ error: 'this client has no phone number' });
  if (!message.trim() || message.length > 6000) return res.status(400).json({ error: 'message must be text no longer than 6000 characters' });
  if (!whatsappConfigured(w)) return res.status(400).json({ error: 'WhatsApp Cloud API is not configured in Settings.' });
  const cleanPhone = c.phone.replace(/\D/g, '');
  const digits = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;
  const response = await fetch(`https://graph.facebook.com/${w.apiVersion}/${encodeURIComponent(w.phoneNumberId)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${w.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: digits, type: 'text', text: { preview_url: false, body: message.trim() } }),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return res.status(502).json({ error: result.error?.message || 'WhatsApp message was not accepted.' });
  const messageId = result.messages?.[0]?.id || '';
  const activity = { id: uid(), clientId: c.id, type: 'whatsapp', note: `WhatsApp API accepted message${messageId ? ` (${messageId})` : ''}: ${message.trim()}`, providerMessageId: messageId, deliveryStatus: 'accepted', at: now() };
  db.activities.push(activity); c.communicationStatus = 'contacted'; c.updatedAt = now(); save(db);
  res.json({ ok: true, status: 'accepted', messageId });
}));

// Meta calls this public endpoint to verify subscriptions and deliver signed status updates.
app.get('/api/webhooks/whatsapp', (req, res) => {
  const w = whatsappSettings();
  if (req.query['hub.mode'] === 'subscribe' && w.verifyToken && req.query['hub.verify_token'] === w.verifyToken) return res.status(200).send(req.query['hub.challenge'] || '');
  res.sendStatus(403);
});
app.post('/api/webhooks/whatsapp', (req, res) => {
  const w = whatsappSettings(), signature = String(req.headers['x-hub-signature-256'] || ''), secret = w.appSecret || '';
  if (!secret || !signature.startsWith('sha256=')) return res.sendStatus(401);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  const db = load(); let changed = false;
  for (const entry of req.body?.entry || []) for (const change of entry.changes || []) {
    for (const status of change.value?.statuses || []) {
      const activity = db.activities.find(a => a.type === 'whatsapp' && a.providerMessageId === status.id);
      if (activity) { activity.deliveryStatus = status.status; activity.statusAt = status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : now(); changed = true; }
    }
    for (const message of change.value?.messages || []) {
      const phone = String(message.from || '').replace(/\D/g, '');
      if (!phone || !message.text?.body) continue;
      const client = db.clients.find(c => {
        const savedPhone = String(c.phone || '').replace(/\D/g, '');
        return savedPhone && (savedPhone.endsWith(phone) || phone.endsWith(savedPhone));
      });
      if (!client) continue;
      client.lastReply = message.text.body;
      if (!['onboarded', 'rejected'].includes(client.stage)) client.stage = 'replied';
      client.communicationStatus = /\b(unsubscribe|stop|remove me|do not contact|don't contact|opt.?out)\b/i.test(message.text.body) ? 'opted_out' : 'replied';
      client.optedOut = client.communicationStatus === 'opted_out'; client.updatedAt = now();
      log(db, client.id, 'reply', `WhatsApp reply: ${message.text.body}`);
      stopClientSequences(db, client.id, client.optedOut ? 'opted out' : 'replied'); changed = true;
    }
  }
  if (changed) save(db);
  res.sendStatus(200);
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

function emailHtml(text) {
  const message = esc(text).replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,sans-serif;line-height:1.5">${message}</div><div style="margin-top:20px"><a href="https://rightheadindia.in" style="text-decoration:none"><img src="https://i0.wp.com/rightheadindia.in/wp-content/uploads/2021/10/footer-logo.png?fit=139%2C75&amp;ssl=1" alt="Right Head" width="139" height="75" style="display:block;width:139px;height:75px;border:0"></a></div>`;
}

function audience(db, audienceKey) {
  let list = db.clients.filter(c => emailAddresses(c).length && c.stage !== 'rejected' && !c.optedOut && c.communicationStatus !== 'opted_out');
  if (audienceKey === 'all' || audienceKey === 'selected') return list;
  return list.filter(c => c.stage === audienceKey);
}
function resolveMailTargets(db, audienceKey, options = {}) {
  const eligible = audience(db, audienceKey);
  const eligibleById = new Map(eligible.map(client => [client.id, client]));
  const requested = Array.isArray(options.recipients) && options.recipients.length
    ? options.recipients
    : Array.isArray(options.clientIds)
      ? options.clientIds.map(clientId => ({ clientId }))
      : eligible.map(client => ({ clientId: client.id }));
  if (!requested.length) return { error: 'Select at least one client email address.' };
  if (requested.length > 5000) return { error: 'A campaign is limited to 5000 recipient addresses.' };
  const targets = [], seenEmails = new Set();
  for (const item of requested) {
    if (!item || typeof item !== 'object' || typeof item.clientId !== 'string') return { error: 'Each recipient must include a valid client.' };
    const client = eligibleById.get(item.clientId);
    if (!client) continue;
    const available = emailAddresses(client);
    const email = item.email === undefined ? available[0] : typeof item.email === 'string' ? item.email.trim() : '';
    if (!email || !available.some(address => sameEmail(address, email))) return { error: `Email address is not saved for ${client.name}.` };
    const normalizedEmail = email.toLowerCase();
    if (seenEmails.has(normalizedEmail)) continue;
    seenEmails.add(normalizedEmail);
    targets.push({ client, email });
  }
  return { targets };
}

app.get('/api/mail/audience/:key', (req, res) => {
  res.json({ count: audience(load(), req.params.key).length });
});

app.get('/api/campaigns', (req, res) => {
  res.json(load().campaigns.slice().reverse());
});

app.get('/api/mail/thread', (req, res) => {
  const { clientId = '', email = '' } = req.query || {};
  const db = load();
  const client = db.clients.find(item => item.id === clientId);
  if (!client) return res.status(404).json({ error: 'client not found' });
  if (typeof email !== 'string' || !emailAddresses(client).some(address => sameEmail(address, email))) {
    return res.status(400).json({ error: 'choose an email address saved for this client' });
  }
  const thread = mailThreadContext(db, client.id, email);
  res.json({
    hasHistory: thread.hasHistory,
    nextFollowUpNumber: thread.nextFollowUpNumber,
    threadSubject: thread.threadSubject,
    canReply: Boolean(thread.messageId || thread.gmailThreadId)
  });
});

const FINAL_REPLY_WAIT_DAYS = 3;
function updateSequenceNextRun(campaign) {
  const dates = (campaign.recipients || [])
    .filter(r => ['active', 'retry', 'sending', 'awaiting_outcome'].includes(r.status))
    .map(r => r.retryAt || r.runAt || campaign.nextRunAt)
    .filter(Boolean).filter(value => Number.isFinite(new Date(value).getTime())).map(value => new Date(value).toISOString());
  campaign.nextRunAt = dates.sort()[0] || '';
}
function sameSequenceRecipient(a, b) {
  return a.clientId === b.clientId && sameEmail(a.email || '', b.email || '');
}
function validSequenceSteps(steps) {
  return Array.isArray(steps) && steps.length === SEQUENCE_DAYS.length && steps.every(s =>
    s && typeof s.subject === 'string' && s.subject.trim() && s.subject.length <= 300 &&
    typeof s.body === 'string' && s.body.trim() && s.body.length <= 20000
  );
}
app.post('/api/sequences', (req, res) => {
  const b = req.body || {};
  const key = b.audience || 'all';
  if (!['all', 'selected', ...STAGES.filter(stage => stage !== 'rejected')].includes(key)) return res.status(400).json({ error: 'unknown audience' });
  if (!validSequenceSteps(b.steps)) return res.status(400).json({ error: 'Provide five personalized sequence emails for the initial email and four 48-hour follow-ups.' });
  if (b.replyToLast !== undefined && typeof b.replyToLast !== 'boolean') return res.status(400).json({ error: 'replyToLast must be true or false' });
  if (key === 'selected' && !((Array.isArray(b.recipients) && b.recipients.length) || (Array.isArray(b.clientIds) && b.clientIds.length))) {
    return res.status(400).json({ error: 'Select at least one eligible client for this sequence.' });
  }
  const db = load();
  const result = resolveMailTargets(db, key, b);
  if (result.error) return res.status(400).json({ error: result.error });
  const list = result.targets;
  if (key === 'selected' && !list.length) return res.status(400).json({ error: 'No selected clients have an eligible email address. Red Zone and opted-out clients cannot be mailed.' });
  const campaign = {
    id: uid(), at: now(), subject: b.steps[0].subject.trim(), audience: key, total: list.length,
    sent: 0, failed: 0, skipped: 0, errors: [], simulated: false,
    replyToLast: b.replyToLast === true,
    type: 'sequence', status: list.length ? 'paused' : 'complete', steps: b.steps.map((s, i) => ({ day: SEQUENCE_DAYS[i], subject: s.subject.trim(), body: s.body.trim() })),
    finalOutcome: { action: 'move_to_red_zone_if_no_reply', waitDays: FINAL_REPLY_WAIT_DAYS },
    recipients: list.map(({ client, email }) => ({ clientId: client.id, email, nextStep: 0, status: 'active', attempts: 0, retryAt: '', runAt: '' })),
    createdAt: now(), finishedAt: '', nextRunAt: ''
  };
  db.campaigns.push(campaign); save(db); res.json(campaign);
});
app.post('/api/campaigns/:id/action', (req, res) => {
  const db = load(), c = db.campaigns.find(x => x.id === req.params.id);
  if (!c || c.type !== 'sequence') return res.status(404).json({ error: 'sequence not found' });
  const { action } = req.body || {};
  if (action === 'edit') {
    if (!validSequenceSteps(req.body.steps)) return res.status(400).json({ error: 'Provide five valid sequence emails.' });
    if (!['paused', 'stopped'].includes(c.status)) return res.status(409).json({ error: 'Pause the sequence before editing it.' });
    c.steps = req.body.steps.map((s, i) => ({ day: SEQUENCE_DAYS[i], subject: s.subject.trim(), body: s.body.trim() }));
    c.subject = c.steps[0].subject;
    if (c.status === 'stopped') {
      c.recipients.forEach(r => { if (r.status === 'stopped' && r.nextStep < c.steps.length) r.status = 'active'; });
      c.status = 'paused'; c.finishedAt = '';
    }
  } else if (action === 'start' || action === 'resume') {
    if (!['paused', 'interrupted'].includes(c.status)) return res.status(409).json({ error: 'Only a paused sequence can be started or resumed.' });
    const uncertain = c.recipients.filter(r => r.status === 'review');
    uncertain.forEach(r => { r.status = 'skipped'; r.stopReason = 'uncertain delivery skipped to prevent duplicate'; });
    c.skipped = (c.skipped || 0) + uncertain.length;
    const remaining = c.recipients.find(r => ['active', 'retry', 'awaiting_outcome'].includes(r.status));
    if (!remaining) { c.status = 'complete'; c.finishedAt = now(); c.nextRunAt = ''; c.updatedAt = now(); save(db); return res.json(c); }
    c.status = 'active'; c.startedAt ||= now();
    const startMs = Date.now();
    for (const r of c.recipients) {
      if (r.status !== 'active') continue;
      const dueDay = c.steps[r.nextStep]?.day ?? 0;
      const previousDay = c.steps[r.nextStep - 1]?.day ?? 0;
      r.runAt = new Date(startMs + (dueDay - previousDay) * 864e5).toISOString();
    }
    updateSequenceNextRun(c);
    c.finishedAt = '';
  } else if (action === 'pause') {
    if (c.status !== 'active') return res.status(409).json({ error: 'Only an active sequence can be paused.' });
    c.status = 'paused';
  } else if (action === 'stop') {
    c.status = 'stopped'; c.finishedAt = now();
    c.recipients.forEach(r => {
      if (['active', 'retry', 'awaiting_outcome'].includes(r.status)) {
        r.status = 'stopped'; r.runAt = ''; r.retryAt = '';
      }
    });
    c.nextRunAt = '';
  } else return res.status(400).json({ error: 'action must be start, pause, resume, stop or edit' });
  c.updatedAt = now(); save(db); res.json(c);
  if (action === 'start' || action === 'resume') setImmediate(() => { void runSequenceScheduler(); });
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

// ---------- Gmail API sender (free, HTTPS, no SMTP port issues) ----------
function gmailConfigured() {
  return Boolean(
    (process.env.GMAIL_CLIENT_ID || '').trim() &&
    (process.env.GMAIL_CLIENT_SECRET || '').trim() &&
    (process.env.GMAIL_REFRESH_TOKEN || '').trim()
  );
}

async function sendWithGmail({ to, subject, text, html, threading = {} }) {
  const clientId = (process.env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GMAIL_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GMAIL_REFRESH_TOKEN || '').trim();
  const from = (process.env.GMAIL_FROM || '').trim() || 'contact@righthead.in';
  const messageId = threading.messageId || createMailMessageId();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN environment variable.');
  }

  // Step 1: Get a fresh access token using the refresh token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(10000)
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error('Gmail OAuth2 token refresh failed: ' + (tokenData.error_description || tokenData.error || tokenRes.status));
  }

  const accessToken = tokenData.access_token;

  // Step 2: Build an RFC 2822 email message
  const boundary = `alternative_${Date.now().toString(36)}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const rawMessage = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Message-ID: ${messageId}`,
    ...(threading.inReplyTo ? [`In-Reply-To: ${threading.inReplyTo}`] : []),
    ...(threading.references?.length ? [`References: ${threading.references.join(' ')}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    '',
    text,
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    '',
    html,
    '',
    `--${boundary}--`
  ].join('\r\n');

  // Step 3: Base64url encode and send via Gmail API (HTTPS, port 443)
  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encoded, ...(threading.gmailThreadId ? { threadId: threading.gmailThreadId } : {}) }),
    signal: AbortSignal.timeout(20000)
  });

  const sendData = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    const errMsg = sendData.error?.message || sendData.error?.status || `Gmail API error ${sendRes.status}`;
    throw new Error('Gmail API send failed: ' + errMsg);
  }

  return { ...sendData, rfcMessageId: messageId };
}

async function sendWithResend({ to, subject, text, html, threading = {} }) {
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
    body: JSON.stringify({
      from,
      to: finalTo,
      subject: finalSubject,
      text: finalText,
      html: finalHtml,
      headers: {
        'Message-ID': threading.messageId,
        ...(threading.inReplyTo ? { 'In-Reply-To': threading.inReplyTo } : {}),
        ...(threading.references?.length ? { References: threading.references.join(' ') } : {})
      }
    }),
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

function emailFromMailActivity(activity, db) {
  if (typeof activity.emailAddress === 'string') return activity.emailAddress;
  const match = String(activity.note || '').match(/^(?:Email|Mass mail|Sequence[^:]*?) to ([^:]+):/i);
  if (match) return match[1].trim();
  if (/^Sequence day \d+:/i.test(String(activity.note || ''))) {
    const client = db.clients.find(item => item.id === activity.clientId);
    const addresses = client ? emailAddresses(client) : [];
    if (addresses.length === 1) {
      const campaign = db.campaigns
        .filter(item => item.type === 'sequence' && new Date(item.at || item.createdAt) <= new Date(activity.at) &&
          item.recipients?.some(recipient => recipient.clientId === activity.clientId && sameEmail(recipient.email, addresses[0])))
        .sort((a, b) => String(b.at || b.createdAt).localeCompare(String(a.at || a.createdAt)))[0];
      if (campaign) return addresses[0];
    }
  }
  return '';
}
function subjectFromMailActivity(activity) {
  if (typeof activity.emailSubject === 'string' && activity.emailSubject) return activity.emailSubject;
  const match = String(activity.note || '').match(/^(?:Email to [^:]+|Mass mail to [^:]+|Sequence day \d+):\s*(.*?)(?: \(simulated\))?$/i);
  return match?.[1]?.trim() || '';
}
function mailThreadContext(db, clientId, email) {
  const allMessages = db.activities
    .filter(activity => activity.clientId === clientId && activity.type === 'mail' && sameEmail(emailFromMailActivity(activity, db), email))
    .sort((a, b) => a.at.localeCompare(b.at));
  const latestActivity = allMessages.at(-1);
  const threadKey = latestActivity?.threadKey || (latestActivity ? `legacy:${clientId}:${email.toLowerCase()}` : '');
  const messages = threadKey.startsWith('legacy:')
    ? allMessages.filter(activity => !activity.threadKey || activity.threadKey === threadKey)
    : threadKey ? allMessages.filter(activity => activity.threadKey === threadKey) : allMessages;
  const last = messages.at(-1);
  const latestThreaded = messages.slice().reverse().find(activity => activity.messageId);
  const subject = last?.threadSubject || last?.emailSubject || subjectFromMailActivity(last || {});
  const priorReferences = latestThreaded?.references || [];
  const references = [...new Set([...priorReferences, ...(latestThreaded?.messageId ? [latestThreaded.messageId] : [])])].slice(-20);
  return {
    hasHistory: messages.length > 0,
    nextFollowUpNumber: messages.length,
    threadSubject: subject.replace(/^(?:\s*re:\s*)+/i, '').trim(),
    threadKey,
    messageId: latestThreaded?.messageId || '',
    gmailThreadId: messages.slice().reverse().find(activity => activity.gmailThreadId)?.gmailThreadId || '',
    references
  };
}
function createMailMessageId() {
  return `<${crypto.randomBytes(16).toString('hex')}@rightheadindia.in>`;
}
function replySubject(subject) {
  const clean = String(subject || '').replace(/^(?:\s*re:\s*)+/i, '').trim();
  return clean ? `Re: ${clean}` : 'Re: Follow-up';
}
function makeMailThreading(context, messageId, shouldReply = true) {
  const replyContext = shouldReply ? context : {};
  return {
    messageId,
    ...(replyContext.messageId ? { inReplyTo: replyContext.messageId } : {}),
    references: replyContext.references || [],
    ...(replyContext.gmailThreadId ? { gmailThreadId: replyContext.gmailThreadId } : {})
  };
}
function mailActivityFields({ email, subject, context, replyToLast, threading, delivery }) {
  const isFollowUp = replyToLast && context.hasHistory;
  const threadSubject = isFollowUp ? context.threadSubject : subject;
  return {
    emailAddress: email,
    emailSubject: subject,
    threadSubject,
    threadKey: isFollowUp && context.threadKey ? context.threadKey : threading.messageId,
    followUpNumber: isFollowUp ? context.nextFollowUpNumber : 0,
    isFollowUp,
    messageId: delivery ? (delivery.rfcMessageId || threading.messageId) : '',
    providerMessageId: delivery?.id || '',
    gmailThreadId: delivery?.threadId || (isFollowUp ? context.gmailThreadId : ''),
    references: isFollowUp ? [...context.references, ...(context.messageId ? [context.messageId] : [])].slice(-20) : []
  };
}

let sequenceTickRunning = false;
async function runSequenceScheduler() {
  if (sequenceTickRunning || massMailInProgress) return;
  sequenceTickRunning = true;
  let releaseLock = null;
  try {
    if (usingPostgres) {
      releaseLock = await tryAdvisoryLock(database, 'righthead-crm-email-sequences');
      if (!releaseLock) return;
    }
    const startDb = load();
    const dueCampaigns = startDb.campaigns.filter(c => c.type === 'sequence' && c.status === 'active' && c.nextRunAt && new Date(c.nextRunAt) <= new Date());
    for (const candidate of dueCampaigns) {
      let campaign = load().campaigns.find(c => c.id === candidate.id);
      if (!campaign || campaign.status !== 'active') continue;
      for (const initialRecipient of campaign.recipients || []) {
        campaign = load().campaigns.find(c => c.id === candidate.id);
        if (!campaign || campaign.status !== 'active') break;
        const recipientState = campaign.recipients.find(r => sameSequenceRecipient(r, initialRecipient));
        if (!recipientState || !['active', 'retry', 'awaiting_outcome'].includes(recipientState.status)) continue;
        const recipientDueAt = recipientState.retryAt || recipientState.runAt || campaign.nextRunAt;
        if (recipientDueAt && new Date(recipientDueAt) > new Date()) continue;
        const client = readRecord(database, 'clients', recipientState.clientId);
        const step = campaign.steps?.[recipientState.nextStep];
        const destination = recipientState.email || client?.email || '';
        const addressStillSaved = client && emailAddresses(client).some(email => sameEmail(email, destination));
        if (recipientState.status === 'awaiting_outcome') {
          const db = load();
          const saved = db.campaigns.find(c => c.id === candidate.id);
          const state = saved?.recipients.find(r => sameSequenceRecipient(r, recipientState));
          const current = db.clients.find(c => c.id === recipientState.clientId);
          if (state && state.status === 'awaiting_outcome') {
            if (!current || current.optedOut || current.communicationStatus === 'opted_out' || !addressStillSaved) {
              state.status = 'stopped';
              state.stopReason = current?.optedOut || current?.communicationStatus === 'opted_out'
                ? 'opted out'
                : 'client or email address is no longer available';
            } else if (!emailAddresses(current).some(email => sameEmail(email, destination))) {
              state.status = 'stopped';
              state.stopReason = 'client email address changed';
            } else if (['replied', 'onboarded', 'rejected'].includes(current.stage) || current.communicationStatus === 'replied') {
              state.status = 'complete';
            } else {
              log(db, current.id, 'stage', `Stage: ${current.stage} -> rejected (no reply after final follow-up)`);
              current.stage = 'rejected';
              current.followUp = '';
              current.updatedAt = now();
              stopClientSequences(db, current.id, 'no reply after final follow-up');
            }
            if (saved) {
              const pending = saved.recipients.some(r => ['active', 'retry', 'sending', 'awaiting_outcome'].includes(r.status));
              if (!pending) { saved.status = 'complete'; saved.finishedAt = now(); }
              updateSequenceNextRun(saved);
              save(db); await flush(database);
            }
          }
          continue;
        }
        if (!client || !addressStillSaved || client.optedOut || ['opted_out', 'replied'].includes(client.communicationStatus) || ['replied', 'onboarded', 'rejected'].includes(client.stage) || !step) {
          const db = load(), saved = db.campaigns.find(c => c.id === candidate.id), r = saved?.recipients.find(x => sameSequenceRecipient(x, recipientState));
          if (r) { r.status = !step ? 'complete' : 'stopped'; r.runAt = ''; r.retryAt = ''; }
          if (saved) {
            saved.skipped = (saved.skipped || 0) + (step ? 1 : 0);
            const pending = saved.recipients.some(x => ['active', 'retry', 'sending', 'awaiting_outcome'].includes(x.status));
            if (!pending) { saved.status = 'complete'; saved.finishedAt = now(); }
            updateSequenceNextRun(saved); save(db); await flush(database);
          }
          continue;
        }

        // Persist a claim before I/O so a restart or overlapping tick will not send the same step twice.
        const claimDb = load(), claimCamp = claimDb.campaigns.find(c => c.id === candidate.id), claim = claimCamp?.recipients.find(r => sameSequenceRecipient(r, recipientState));
        if (!claim || !['active', 'retry'].includes(claim.status)) continue;
        claim.status = 'sending'; claim.retryAt = ''; save(claimDb); await flush(database);

        const smtp = load().settings.smtp;
        const useGmail = gmailConfigured();
        const smtpConfigured = Boolean(smtp.host && smtp.user && smtp.pass);
        const resendConfigured = Boolean((process.env.RESEND_API_KEY || '').trim());
        const configured = useGmail || smtpConfigured || resendConfigured;
        try {
          const mailClient = { ...client, email: destination };
          const threadContext = mailThreadContext(load(), client.id, destination);
          const replyToLast = Boolean(candidate.replyToLast || recipientState.nextStep > 0);
          const isFollowUp = replyToLast && threadContext.hasHistory;
          const subject = isFollowUp ? replySubject(threadContext.threadSubject) : fill(step.subject, mailClient);
          const body = fill(step.body, mailClient);
          const threading = makeMailThreading(threadContext, createMailMessageId(), isFollowUp);
          let delivery = null;
          if (configured) {
            const html = emailHtml(body);
            if (useGmail) delivery = await sendWithGmail({ to: destination, subject, text: body, html, threading });
            else if (smtpConfigured) {
              const info = await buildTransport(smtp).sendMail({
                from: smtp.from || smtp.user, to: destination, subject, text: body, html,
                messageId: threading.messageId,
                ...(threading.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
                ...(threading.references.length ? { references: threading.references } : {})
              });
              delivery = { rfcMessageId: info.messageId };
            } else delivery = await sendWithResend({ to: destination, subject, text: body, html, threading });
          }
          const mailFields = mailActivityFields({
            email: destination, subject, context: threadContext, replyToLast,
            threading, delivery
          });
          const db = load(), c = db.clients.find(x => x.id === client.id), saved = db.campaigns.find(x => x.id === candidate.id);
          const r = saved?.recipients.find(x => sameSequenceRecipient(x, recipientState));
          if (r && r.status === 'sending') {
            r.attempts = 0; r.nextStep++; r.status = r.nextStep >= saved.steps.length ? 'awaiting_outcome' : 'active';
            r.retryAt = '';
            saved.sent = (saved.sent || 0) + 1; saved.simulated = saved.simulated || !configured;
            const activity = {
              id: uid(), clientId: client.id, type: 'mail',
              note: `${mailFields.isFollowUp ? `Follow-up #${mailFields.followUpNumber}: ` : ''}${step.day === 0 ? 'Initial sequence email' : `Sequence follow-up after ${step.day} days`}: ${subject}${configured ? '' : ' (simulated)'}`,
              deliveryStatus: configured ? 'accepted' : 'simulated',
              at: now(),
              ...mailFields
            };
            db.activities.push(activity);
            if (c) {
              if (c.stage === 'new') c.stage = 'contacted';
              c.communicationStatus = 'contacted';
              c.followUp = r.status === 'awaiting_outcome'
                ? new Date(Date.now() + FINAL_REPLY_WAIT_DAYS * 864e5).toISOString()
                : new Date(Date.now() + (saved.steps[r.nextStep].day - step.day) * 864e5).toISOString();
              c.updatedAt = now();
            }
            const nextActive = saved.recipients.some(x => ['active', 'retry', 'sending', 'awaiting_outcome'].includes(x.status));
            r.runAt = r.status === 'awaiting_outcome'
              ? new Date(Date.now() + FINAL_REPLY_WAIT_DAYS * 864e5).toISOString()
              : new Date(Date.now() + (saved.steps[r.nextStep].day - step.day) * 864e5).toISOString();
            if (!nextActive) { saved.status = 'complete'; saved.finishedAt = now(); }
            updateSequenceNextRun(saved);
            save(db); await flush(database);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (e) {
          const db = load(), saved = db.campaigns.find(x => x.id === candidate.id), r = saved?.recipients.find(x => sameSequenceRecipient(x, recipientState));
          if (r && r.status === 'sending') {
            r.attempts = (r.attempts || 0) + 1;
            if (r.attempts >= 3) { r.status = 'failed'; r.runAt = ''; saved.failed = (saved.failed || 0) + 1; }
            else { r.status = 'retry'; r.retryAt = new Date(Date.now() + r.attempts * 5 * 60000).toISOString(); r.runAt = ''; }
            saved.errors = [...(saved.errors || []).slice(-18), `${destination}: ${e.message}`];
            const pending = saved.recipients.filter(x => ['active', 'retry', 'sending', 'awaiting_outcome'].includes(x.status));
            if (!pending.length) { saved.status = 'complete'; saved.finishedAt = now(); saved.nextRunAt = ''; }
            updateSequenceNextRun(saved);
            save(db); await flush(database);
          }
        }
      }
    }
  } catch (e) { console.error('Sequence scheduler error:', e.message); }
  finally {
    if (releaseLock) { try { await releaseLock(); } catch (e) { console.error('Could not release sequence scheduler lock:', e.message); } }
    sequenceTickRunning = false;
  }
}


app.post('/api/mail/test', asyncRoute(async (req, res) => {
  const db = load();
  const s = db.settings.smtp;
  const smtpConfigured = Boolean(s.host && s.user && s.pass);
  const useGmail = gmailConfigured();
  const resendConfigured = Boolean((process.env.RESEND_API_KEY || '').trim());

  // --- Gmail API test (preferred — free, HTTPS, works on Render) ---
  if (useGmail) {
    const testTo = (req.body?.to || process.env.GMAIL_FROM || '').trim().replace(/.*<|>/g, '');
    try {
      await sendWithGmail({
        to: testTo,
        subject: 'Right Head CRM - Test Email',
        text: 'Your Right Head CRM email integration is working. Emails will send from contact@righthead.in.',
        html: emailHtml('Your Right Head CRM email integration is working. Emails will send from contact@righthead.in.')
      });
      res.json({ ok: true, message: 'Gmail API verified. Email sent from ' + (process.env.GMAIL_FROM || 'contact@righthead.in') + '.' });
    } catch (e) {
      console.error('Gmail API test failed:', e.message);
      res.status(502).json({ error: 'Gmail API test failed: ' + e.message });
    }
    return;
  }

  // --- SMTP test (if SMTP configured in Settings) ---
  if (smtpConfigured) {
    try {
      const transporter = buildTransport(s);
      await transporter.verify();
      res.json({ ok: true, message: 'SMTP connection verified. Emails will send from ' + (s.from || s.user) + '.' });
    } catch (e) {
      console.error('SMTP test failed:', e.code || '', e.message);
      res.status(502).json({ error: smtpErrorMessage(e) });
    }
    return;
  }

  // --- Resend test (fallback) ---
  if (!resendConfigured) {
    return res.status(400).json({
      error: 'No email method configured. Set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN in Render to use Gmail (free), or fill in SMTP settings.'
    });
  }

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
      html: emailHtml('Your Right Head CRM email integration is working.')
    });
    res.json({ ok: true, message: 'Test email accepted by Resend.' });
  } catch (error) {
    console.error('Resend test failed:', error.message);
    res.status(502).json({ error: 'Email test failed: ' + error.message });
  }
}));


app.post('/api/mail/send-one', asyncRoute(async (req, res) => {
  const db = load();
  const { clientId, email: requestedEmail, subject = '', body = '', replyToLast = true } = req.body || {};
  const c = db.clients.find(x => x.id === clientId);

  if (!c) return res.status(404).json({ error: 'client not found' });
  const availableEmails = emailAddresses(c);
  const email = requestedEmail === undefined ? availableEmails[0] : typeof requestedEmail === 'string' ? requestedEmail.trim() : '';
  if (!email || !availableEmails.some(address => sameEmail(address, email))) return res.status(400).json({ error: 'choose an email address saved for this client' });
  if (c.optedOut || c.communicationStatus === 'opted_out') return res.status(409).json({ error: 'this client opted out of email' });

  if (typeof subject !== 'string' || typeof body !== 'string' ||
      !subject.trim() || !body.trim()) {
    return res.status(400).json({ error: 'subject and message are required' });
  }

  if (subject.length > 300 || body.length > 20000) {
    return res.status(400).json({ error: 'subject or message is too long' });
  }
  if (typeof replyToLast !== 'boolean') return res.status(400).json({ error: 'replyToLast must be true or false' });

  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim();
  const threadContext = mailThreadContext(db, c.id, email);
  const isFollowUp = replyToLast && threadContext.hasHistory;
  const cleanThreadSubject = isFollowUp ? replySubject(threadContext.threadSubject) : cleanSubject;
  const threading = makeMailThreading(threadContext, createMailMessageId(), isFollowUp);
  const s = db.settings.smtp;
  const smtpConfigured = Boolean(s.host && s.user && s.pass);
  const useGmail = gmailConfigured();
  const resendConfigured = Boolean((process.env.RESEND_API_KEY || '').trim());
  const configured = useGmail || smtpConfigured || resendConfigured;
  let delivery = null;

  if (configured) {
    try {
      const mailClient = { ...c, email };
      const personalizedSubject = isFollowUp ? cleanThreadSubject : fill(cleanSubject, mailClient);
      const personalizedBody = fill(body, mailClient);

      if (useGmail) {
        // Best option: Gmail API (free, HTTPS, sends from contact@righthead.in)
        delivery = await sendWithGmail({
          to: email,
          subject: personalizedSubject,
          text: personalizedBody,
          html: emailHtml(personalizedBody),
          threading
        });
      } else if (smtpConfigured) {
        // SMTP fallback
        const transporter = buildTransport(s);
        const info = await transporter.sendMail({
          from: s.from || s.user,
          to: email,
          subject: personalizedSubject,
          text: personalizedBody,
          html: emailHtml(personalizedBody),
          messageId: threading.messageId,
          ...(threading.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
          ...(threading.references.length ? { references: threading.references } : {})
        });
        delivery = { rfcMessageId: info.messageId };
      } else {
        // Resend API fallback
        delivery = await sendWithResend({
          to: email,
          subject: personalizedSubject,
          text: personalizedBody,
          html: emailHtml(personalizedBody),
          threading
        });
      }
    } catch (error) {
      console.error('Single email send failed:', error.message);
      return res.status(502).json({
        error: 'Email send failed: ' + (smtpConfigured && !useGmail ? smtpErrorMessage(error) : error.message)
      });
    }
  }

  const latest = load();
  const current = latest.clients.find(x => x.id === c.id);

  const personalizedSubject = isFollowUp ? cleanThreadSubject : fill(cleanSubject, { ...c, email });
  const activity = {
    id: uid(), clientId: c.id, type: 'mail',
    note: `${isFollowUp ? `Follow-up #${threadContext.nextFollowUpNumber}: ` : ''}Email to ${email}: ${personalizedSubject}${configured ? '' : ' (simulated)'}`,
    deliveryStatus: configured ? 'accepted' : 'simulated',
    at: now(),
    ...mailActivityFields({
      email, subject: personalizedSubject, context: threadContext, replyToLast,
      threading, delivery
    })
  };
  latest.activities.push(activity);

  if (current) {
    if (current.stage === 'new') current.stage = 'contacted';
    current.communicationStatus = 'contacted';
    current.followUp = new Date(Date.now() + EMAIL_FOLLOW_UP_HOURS * 60 * 60 * 1000).toISOString();
    current.updatedAt = now();
  }

  save(latest);
  res.json({
    ok: true,
    simulated: !configured,
    email,
    isFollowUp,
    followUpNumber: isFollowUp ? threadContext.nextFollowUpNumber : 0,
    clientDeleted: !current
  });
}));

app.post('/api/mail/send', asyncRoute(async (req, res) => {
  const db = load();
  const {
    audience: key = 'all',
    subject = '',
    body = '',
    dryRun,
    replyToLast = false
  } = req.body || {};

  if (typeof subject !== 'string' || typeof body !== 'string' ||
      !subject.trim() || !body.trim()) {
    return res.status(400).json({ error: 'subject and message are required' });
  }

  if (subject.length > 300 || body.length > 20000) {
    return res.status(400).json({ error: 'subject or message is too long' });
  }
  if (typeof replyToLast !== 'boolean') return res.status(400).json({ error: 'replyToLast must be true or false' });

  if (!['all', 'selected', ...STAGES.filter(stage => stage !== 'rejected')].includes(key)) {
    return res.status(400).json({ error: 'unknown audience' });
  }

  const { clientIds, recipients } = req.body || {};
  if (key === 'selected' && !((Array.isArray(recipients) && recipients.length) || (Array.isArray(clientIds) && clientIds.length))) {
    return res.status(400).json({ error: 'Select at least one eligible client for this campaign.' });
  }

  if (massMailInProgress) {
    return res.status(409).json({
      error: 'A mass-mail campaign is already running. Wait for it to finish before starting another.'
    });
  }

  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim();
  const resolved = resolveMailTargets(db, key, { clientIds, recipients });
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const list = resolved.targets.map(({ client, email }) => ({ ...client, mailTo: email }));
  if (key === 'selected' && !list.length) return res.status(400).json({ error: 'No selected clients have an eligible email address. Red Zone and opted-out clients cannot be mailed.' });
  const s = db.settings.smtp;
  const smtpConfigured = Boolean(s.host && s.user && s.pass);
  const useGmail = gmailConfigured();
  const resendConfigured = Boolean((process.env.RESEND_API_KEY || '').trim());
  const configured = useGmail || smtpConfigured || resendConfigured;
  const simulate = dryRun === true || !configured;
  const transporter = smtpConfigured && !useGmail && !simulate ? buildTransport(s) : null;

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
      replyToLast,
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
      const eligible = recipient && emailAddresses(recipient).some(email => sameEmail(email, c.mailTo)) && !recipient.optedOut && recipient.communicationStatus !== 'opted_out' &&
        recipient.stage !== 'rejected' &&
        (key === 'all' || key === 'selected' || recipient.stage === key);

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
      let mailFields = null;
      const threadContext = mailThreadContext(load(), recipient.id, c.mailTo);
      const isFollowUp = replyToLast && threadContext.hasHistory;
      const threading = makeMailThreading(threadContext, createMailMessageId(), isFollowUp);
      const personalizedSubject = isFollowUp ? replySubject(threadContext.threadSubject) : fill(cleanSubject, { ...recipient, email: c.mailTo });

      try {
        if (!simulate) {
          const mailClient = { ...recipient, email: c.mailTo };
          const personalizedBody = fill(body, mailClient);
          let delivery;

          if (useGmail && !simulate) {
            delivery = await sendWithGmail({
              to: c.mailTo,
              subject: personalizedSubject,
              text: personalizedBody,
              html: emailHtml(personalizedBody),
              threading
            });
          } else if (transporter) {
            // Send via SMTP (directly from contact@righthead.in)
            const info = await transporter.sendMail({
              from: s.from || s.user,
              to: c.mailTo,
              subject: personalizedSubject,
              text: personalizedBody,
              html: emailHtml(personalizedBody),
              messageId: threading.messageId,
              ...(threading.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
              ...(threading.references.length ? { references: threading.references } : {})
            });
            delivery = { rfcMessageId: info.messageId };
          } else {
            // Fallback to Resend API
            delivery = await sendWithResend({
              to: c.mailTo,
              subject: personalizedSubject,
              text: personalizedBody,
              html: emailHtml(personalizedBody),
              threading
            });
          }

          mailFields = mailActivityFields({
            email: c.mailTo, subject: personalizedSubject, context: threadContext,
            replyToLast, threading, delivery
          });
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          mailFields = mailActivityFields({
            email: c.mailTo, subject: personalizedSubject, context: threadContext,
            replyToLast, threading, delivery: null
          });
        }

        sent++;
        delivered = true;
      } catch (e) {
        failed++;
        console.error(`Mass mail send failed for ${c.mailTo}:`, e.message);
        errors.push(`${c.mailTo}: ${transporter ? smtpErrorMessage(e) : e.message}`);
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
            note: `${mailFields?.isFollowUp ? `Follow-up #${mailFields.followUpNumber}: ` : ''}Mass mail to ${c.mailTo}: ${personalizedSubject}${simulate ? ' (simulated)' : ''}`,
            deliveryStatus: simulate ? 'simulated' : 'accepted',
            at,
            ...mailFields
          });

          if (latestRecipient.stage === 'new') {
            latestRecipient.stage = 'contacted';
          }
          latestRecipient.communicationStatus = 'contacted';

          latestRecipient.followUp = new Date(Date.now() + EMAIL_FOLLOW_UP_HOURS * 60 * 60 * 1000).toISOString();
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

// ---------- CRM tools and configurable AI features ----------
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
const sequenceScheduler = setInterval(runSequenceScheduler, 60 * 1000);
sequenceScheduler.unref();
setTimeout(runSequenceScheduler, 1500).unref();

function shutdown() {
  clearInterval(sequenceScheduler);
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
