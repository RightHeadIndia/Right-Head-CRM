// Company CRM - Express server with local SQLite storage.
const express = require('express');
const fs = require('node:fs');
const path = require('path');
const crypto = require('node:crypto');
const { backup } = require('node:sqlite');
const nodemailer = require('nodemailer');
const { openDatabase, readDatabase, writeDatabase, readRecord, updateRecords } = require('./lib/database');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (!APP_PASSWORD) throw new Error('Set APP_PASSWORD before starting the CRM.');
if (APP_PASSWORD.length < 12) throw new Error('APP_PASSWORD must be at least 12 characters long.');
const DB_FILE = process.env.CRM_DB_FILE || path.join(__dirname, 'data', 'crm.sqlite');
const LEGACY_DB_FILE = path.join(__dirname, 'data', 'db.json');
const database = openDatabase(DB_FILE, LEGACY_DB_FILE);
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

app.use((req, res, next) => {
  if (['/login.html', '/login.js', '/login.css'].includes(req.path)) return next();
  if (hasSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in to continue.' });
  res.redirect('/login.html');
});
app.use(express.static(path.join(__dirname, 'public')));

// Keep the existing route modules' load/save interface while persisting every
// collection in SQLite transactions. The database module imports db.json once.
const load = () => readDatabase(database);
const save = db => writeDatabase(database, db);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const now = () => new Date().toISOString();

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
  const backupFile = `${DB_FILE}.backup-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    await backup(database, backupFile);
    const contents = fs.readFileSync(backupFile);
    const date = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="company-crm-${date}.sqlite"`,
      'Cache-Control': 'no-store'
    });
    res.send(contents);
  } catch (error) {
    console.error('CRM backup failed:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not create the database backup.' });
  } finally {
    try { fs.rmSync(backupFile, { force: true }); } catch (error) { console.error('CRM temporary backup cleanup failed:', error.message); }
  }
}));

// stage: new | contacted | replied (BLUE) | onboarded (GREEN) | rejected (RED)
// callStatus: not_called | connected | no_answer | busy | callback
const STAGES = ['new', 'contacted', 'replied', 'onboarded', 'rejected'];
const CALLS = ['not_called', 'connected', 'no_answer', 'busy', 'callback'];

function log(db, clientId, type, note) {
  db.activities.push({ id: uid(), clientId, type, note: note || '', at: now() });
}

const CLIENT_TEXT_LIMITS = { name: 200, company: 200, phone: 50, email: 254, source: 100, notes: 6000, followUp: 40, lastReply: 6000 };
function cleanClientInput(value, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'client data must be an object' };
  const clean = {};
  for (const [field, limit] of Object.entries(CLIENT_TEXT_LIMITS)) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string') value[field] = String(value[field]);
    const text = value[field].trim();
    if (text.length > limit) return { error: `${field} is too long (maximum ${limit} characters)` };
    clean[field] = text;
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

// ---------- clients ----------
app.get('/api/clients', (req, res) => {
  const db = load();
  res.json(db.clients);
});

app.post('/api/clients', (req, res) => {
  const db = load();
  const result = cleanClientInput(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const b = result.clean;
  const c = {
    id: uid(), name: b.name, company: b.company || '', phone: b.phone || '', email: b.email || '',
    source: b.source || '', notes: b.notes || '',
    stage: STAGES.includes(b.stage) ? b.stage : 'new',
    callStatus: CALLS.includes(b.callStatus) ? b.callStatus : 'not_called',
    followUp: b.followUp || '', lastReply: '', createdAt: now(), updatedAt: now()
  };
  db.clients.push(c);
  log(db, c.id, 'created', 'Client added');
  save(db);
  res.json(c);
});

app.put('/api/clients/:id', (req, res) => {
  const db = load();
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const result = cleanClientInput(req.body, true);
  if (result.error) return res.status(400).json({ error: result.error });
  const b = result.clean;
  const fields = ['name', 'company', 'phone', 'email', 'source', 'notes', 'followUp', 'lastReply'];
  fields.forEach(f => { if (b[f] !== undefined) c[f] = b[f]; });
  if (b.stage && b.stage !== c.stage) {
    log(db, c.id, 'stage', `Stage: ${c.stage} -> ${b.stage}`);
    c.stage = b.stage;
    if (b.stage === 'onboarded' || b.stage === 'rejected') c.followUp = ''; // no more reminders
  }
  if (b.callStatus && b.callStatus !== c.callStatus) {
    log(db, c.id, 'call', `Call status: ${b.callStatus}`);
    c.callStatus = b.callStatus;
    if (c.stage === 'new') c.stage = 'contacted';
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
  db.deals.forEach(d => { if (d.clientId === req.params.id) d.clientId = ''; }); // keep deals so revenue history stays intact
  save(db);
  res.json({ ok: true });
});

app.get('/api/clients/:id/activities', (req, res) => {
  const db = load();
  res.json(db.activities.filter(a => a.clientId === req.params.id).sort((a, b) => b.at.localeCompare(a.at)));
});

// Add a note / record a client reply. type: note | reply | call
app.post('/api/clients/:id/activity', (req, res) => {
  const db = load();
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const { type = 'note', note = '' } = req.body || {};
  if (!['note', 'reply', 'call'].includes(type)) return res.status(400).json({ error: 'activity type is not valid' });
  if (typeof note !== 'string' || note.length > 6000) return res.status(400).json({ error: 'activity note must be text no longer than 6000 characters' });
  log(db, c.id, type, note);
  if (type === 'reply') {
    c.lastReply = note;
    if (c.stage !== 'onboarded' && c.stage !== 'rejected') c.stage = 'replied'; // goes BLUE
  }
  c.updatedAt = now();
  save(db);
  res.json(c);
});

// Bulk import: [{name, company, phone, email}, ...]
app.post('/api/clients/import', (req, res) => {
  const db = load();
  const rows = Array.isArray(req.body) ? req.body : [];
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'request must be an array of clients' });
  if (rows.length > 10000) return res.status(413).json({ error: 'import is limited to 10000 rows at a time' });
  let added = 0, skipped = 0;
  rows.forEach(r => {
    const result = cleanClientInput(r, true);
    if (result.error) { skipped++; return; }
    r = result.clean;
    if (!r.name && !r.email && !r.phone) { skipped++; return; }
    if (!r.name) r.name = r.email || r.phone;
    const email = String(r.email || '').toLowerCase();
    const phone = String(r.phone || '').replace(/\D/g, '');
    const dup = db.clients.find(c => (email && String(c.email || '').toLowerCase() === email) || (phone && String(c.phone || '').replace(/\D/g, '') === phone));
    if (dup) { skipped++; return; }
    const c = {
      id: uid(), name: r.name || r.email || r.phone, company: r.company || '', phone: r.phone || '',
      email: r.email || '', source: r.source || 'import', notes: r.notes || '',
      stage: r.stage || 'new', callStatus: r.callStatus || 'not_called', followUp: r.followUp || '', lastReply: r.lastReply || '',
      createdAt: now(), updatedAt: now()
    };
    db.clients.push(c);
    log(db, c.id, 'created', 'Imported');
    added++;
  });
  save(db);
  res.json({ added, skipped });
});

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const db = load();
  const cs = db.clients;
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const active = cs.filter(c => c.followUp && c.stage !== 'onboarded' && c.stage !== 'rejected');
  const due = active.filter(c => new Date(c.followUp) <= today).sort((a, b) => a.followUp.localeCompare(b.followUp));
  const calls = {}; CALLS.forEach(k => (calls[k] = cs.filter(c => c.callStatus === k).length));
  const stages = {}; STAGES.forEach(k => (stages[k] = cs.filter(c => c.stage === k).length));
  res.json({
    total: cs.length, stages, calls,
    overdue: due.filter(c => new Date(c.followUp) < startToday).length,
    dueToday: due.filter(c => new Date(c.followUp) >= startToday).length,
    reminders: due.slice(0, 8),
    upcoming: active.filter(c => new Date(c.followUp) > today).sort((a, b) => a.followUp.localeCompare(b.followUp)).slice(0, 5),
    replied: cs.filter(c => c.stage === 'replied').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    onboarded: cs.filter(c => c.stage === 'onboarded').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    rejected: cs.filter(c => c.stage === 'rejected').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    campaigns: db.campaigns.slice(-4).reverse()
  });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => {
  const s = load().settings;
  res.json({ ...s, smtp: { ...s.smtp, pass: s.smtp.pass ? '********' : '' }, ai: { model: s.ai.model, apiKey: s.ai.apiKey ? '********' : '' } });
});
app.put('/api/settings', (req, res) => {
  const db = load();
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'settings must be an object' });
  if (b.company !== undefined) {
    if (typeof b.company !== 'string' || b.company.trim().length > 120) return res.status(400).json({ error: 'company must be text no longer than 120 characters' });
    db.settings.company = b.company.trim();
  }
  if (b.currency !== undefined) {
    if (typeof b.currency !== 'string' || !b.currency.trim() || b.currency.trim().length > 4) return res.status(400).json({ error: 'currency must be 1 to 4 characters' });
    db.settings.currency = b.currency.trim();
  }
  if (b.ai) {
    if (typeof b.ai !== 'object' || Array.isArray(b.ai)) return res.status(400).json({ error: 'AI settings must be an object' });
    if (b.ai.apiKey !== undefined && b.ai.apiKey !== '********') {
      if (typeof b.ai.apiKey !== 'string' || b.ai.apiKey.trim().length > 500) return res.status(400).json({ error: 'AI key must be text no longer than 500 characters' });
      db.settings.ai.apiKey = b.ai.apiKey.trim();
    }
    if (b.ai.model !== undefined) {
      if (typeof b.ai.model !== 'string' || b.ai.model.trim().length > 80) return res.status(400).json({ error: 'AI model must be text no longer than 80 characters' });
      db.settings.ai.model = b.ai.model.trim();
    }
  }
  if (b.smtp) {
    if (typeof b.smtp !== 'object' || Array.isArray(b.smtp)) return res.status(400).json({ error: 'SMTP settings must be an object' });
    const stringFields = { host: 255, user: 320, pass: 1000, from: 320 };
    const clean = {};
    for (const [field, limit] of Object.entries(stringFields)) {
      if (b.smtp[field] === undefined || (field === 'pass' && b.smtp.pass === '********')) continue;
      if (typeof b.smtp[field] !== 'string' || b.smtp[field].length > limit) return res.status(400).json({ error: `${field} must be text no longer than ${limit} characters` });
      clean[field] = field === 'pass' ? b.smtp[field] : b.smtp[field].trim();
    }
    if (b.smtp.port !== undefined) {
      const port = Number(b.smtp.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'SMTP port must be between 1 and 65535' });
      clean.port = port;
    }
    if (b.smtp.secure !== undefined) {
      if (typeof b.smtp.secure !== 'boolean') return res.status(400).json({ error: 'SMTP secure must be true or false' });
      clean.secure = b.smtp.secure;
    }
    const keepPass = b.smtp.pass === '********' || b.smtp.pass === undefined;
    db.settings.smtp = { ...db.settings.smtp, ...clean, pass: keepPass ? db.settings.smtp.pass : clean.pass };
  }
  save(db);
  res.json({ ok: true });
});

// ---------- mass mailing ----------
const fill = (t, c) => String(t).replace(/{{\s*(name|company|email|phone)\s*}}/gi, (_, k) => c[k.toLowerCase()] || '');
const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

function audience(db, audienceKey) {
  let list = db.clients.filter(c => c.email && c.stage !== 'rejected'); // a refusal suppresses every campaign audience
  if (audienceKey === 'all') return list;
  else list = list.filter(c => c.stage === audienceKey);
  return list;
}

app.get('/api/mail/audience/:key', (req, res) => {
  res.json({ count: audience(load(), req.params.key).length });
});

app.get('/api/campaigns', (req, res) => res.json(load().campaigns.slice().reverse()));

function smtpTransport(db) {
  const s = db.settings.smtp;
  if (!(s.host && s.user && s.pass)) return null; // not configured -> simulation mode
  return nodemailer.createTransport({ host: s.host, port: Number(s.port) || 587, secure: !!s.secure, auth: { user: s.user, pass: s.pass } });
}

// Send one email to one client (used by the AI "Draft message" box after the user reviews the text)
app.post('/api/mail/send-one', asyncRoute(async (req, res) => {
  const db = load();
  const { clientId, subject = '', body = '' } = req.body || {};
  const c = db.clients.find(x => x.id === clientId);
  if (!c) return res.status(404).json({ error: 'client not found' });
  if (!c.email) return res.status(400).json({ error: 'this client has no email address' });
  if (typeof subject !== 'string' || typeof body !== 'string' || !subject.trim() || !body.trim()) return res.status(400).json({ error: 'subject and message are required' });
  if (subject.length > 300 || body.length > 20000) return res.status(400).json({ error: 'subject or message is too long' });
  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim();
  const transporter = smtpTransport(db);
  if (transporter) {
    try {
      await transporter.sendMail({ from: db.settings.smtp.from || db.settings.smtp.user, to: c.email, subject: cleanSubject, text: body, html: esc(body).replace(/\n/g, '<br>') });
    } catch (error) {
      console.error('Single email send failed:', error.message);
      return res.status(502).json({ error: 'Email send failed. Check the SMTP settings and try again.' });
    }
  }
  // Sending is asynchronous; reload before recording so unrelated edits made
  // while SMTP was working are kept.
  const latest = load();
  const current = latest.clients.find(x => x.id === c.id);
  log(latest, c.id, 'mail', `Email: ${cleanSubject}${transporter ? '' : ' (simulated)'}`);
  if (current) {
    if (current.stage === 'new') current.stage = 'contacted';
    current.updatedAt = now();
  }
  save(latest);
  res.json({ ok: true, simulated: !transporter, clientDeleted: !current });
}));

app.post('/api/mail/send', asyncRoute(async (req, res) => {
  const db = load();
  const { audience: key = 'all', subject = '', body = '', dryRun } = req.body || {};
  if (typeof subject !== 'string' || typeof body !== 'string' || !subject.trim() || !body.trim()) return res.status(400).json({ error: 'subject and message are required' });
  if (subject.length > 300 || body.length > 20000) return res.status(400).json({ error: 'subject or message is too long' });
  if (!['all', ...STAGES.filter(stage => stage !== 'rejected')].includes(key)) return res.status(400).json({ error: 'unknown audience' });
  if (massMailInProgress) return res.status(409).json({ error: 'A mass-mail campaign is already running. Wait for it to finish before starting another.' });
  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim();
  const list = audience(db, key);
  const s = db.settings.smtp;
  const configured = s.host && s.user && s.pass;
  const simulate = dryRun === true || !configured;
  let transporter;
  if (!simulate) {
    transporter = nodemailer.createTransport({
      host: s.host, port: Number(s.port) || 587, secure: !!s.secure, auth: { user: s.user, pass: s.pass }
    });
  }
  massMailInProgress = true;
  try {
  const camp = {
    id: uid(), at: now(), subject: cleanSubject, audience: key, total: list.length,
    sent: 0, failed: 0, skipped: 0, errors: [], simulated: !!simulate,
    status: list.length ? 'sending' : 'complete', finishedAt: list.length ? '' : now()
  };
  const initial = load();
  initial.campaigns.push(camp);
  save(initial);
  let sent = 0, failed = 0, skipped = 0; const errors = [];
  for (const c of list) {
    // A client may have opted out or been removed while the campaign was
    // running; use the latest record immediately before each send.
    const recipient = readRecord(database, 'clients', c.id);
    const eligible = recipient && recipient.email && recipient.stage !== 'rejected' && (key === 'all' || recipient.stage === key);
    if (!eligible) {
      skipped++;
      updateRecords(database, ({ get, set }) => {
        const running = get('campaigns', camp.id);
        if (!running) return;
        running.sent = sent; running.failed = failed; running.skipped = skipped;
        if (sent + failed + skipped >= list.length) { running.status = 'complete'; running.finishedAt = now(); }
        set('campaigns', running);
      });
      continue;
    }
    let delivered = false;
    try {
      if (!simulate) {
        await transporter.sendMail({
          from: s.from || s.user, to: recipient.email, subject: fill(cleanSubject, recipient),
          text: fill(body, recipient), html: esc(fill(body, recipient)).replace(/\n/g, '<br>')
        });
        await new Promise(r => setTimeout(r, 400)); // gentle rate limit
      }
      sent++;
      delivered = true;
    } catch (e) { failed++; errors.push(`${recipient.email}: ${String(e.message || 'send failed').slice(0, 300)}`); }

    updateRecords(database, ({ get, set }) => {
      const running = get('campaigns', camp.id);
      if (running) {
        running.sent = sent; running.failed = failed; running.skipped = skipped;
        running.errors = errors.slice(0, 20);
        if (sent + failed + skipped >= list.length) { running.status = 'complete'; running.finishedAt = now(); }
        set('campaigns', running);
      }
      const latestRecipient = get('clients', recipient.id);
      if (delivered && latestRecipient) {
        const at = now();
        set('activities', { id: uid(), clientId: latestRecipient.id, type: 'mail', note: `Mass mail: ${cleanSubject}${simulate ? ' (simulated)' : ''}`, at });
        if (latestRecipient.stage === 'new') latestRecipient.stage = 'contacted';
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

// ---------- CRM tools (tasks, deals, templates, reports, CSV export) and Claude AI features ----------
const ctx = { load, save, uid, now, log, STAGES, CALLS };
require('./lib/tools').mount(app, ctx);
require('./lib/ai').mount(app, ctx);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('CRM request failed:', error.message);
  const status = error.code === 'CRM_CONCURRENT_UPDATE' ? 409 : 500;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: status === 500 ? 'The request could not be completed.' : error.message });
  res.status(status).send(status === 500 ? 'The request could not be completed.' : error.message);
});

const server = app.listen(PORT, () => console.log(`CRM running at http://localhost:${PORT}`));
function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
