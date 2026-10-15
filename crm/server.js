// Company CRM - Express server with JSON-file storage (no database install needed)
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || ''; // optional: set to protect the whole app
const DB_FILE = path.join(__dirname, 'data', 'db.json');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Optional basic auth (username: admin, password: APP_PASSWORD)
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const [u, p] = Buffer.from(h.split(' ')[1] || '', 'base64').toString().split(':');
    if (u === 'admin' && p === APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="CRM"').status(401).send('Login required');
  });
}
app.use(express.static(path.join(__dirname, 'public')));

// ---------- storage ----------
function load() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const seed = {
      clients: [], activities: [], campaigns: [], tasks: [], deals: [], templates: [],
      settings: { smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' }, company: 'Right Head', currency: '\u20B9', ai: { apiKey: '', model: '' } }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // older db.json files (before tasks/deals/AI) get the new collections added on the fly
  ['tasks', 'deals', 'templates'].forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });
  db.settings = db.settings || {};
  if (db.settings.currency === undefined) db.settings.currency = '\u20B9';
  db.settings.ai = { apiKey: '', model: '', ...(db.settings.ai || {}) };
  return db;
}
function save(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const now = () => new Date().toISOString();

// stage: new | contacted | replied (BLUE) | onboarded (GREEN) | rejected (RED)
// callStatus: not_called | connected | no_answer | busy | callback
const STAGES = ['new', 'contacted', 'replied', 'onboarded', 'rejected'];
const CALLS = ['not_called', 'connected', 'no_answer', 'busy', 'callback'];

function log(db, clientId, type, note) {
  db.activities.push({ id: uid(), clientId, type, note: note || '', at: now() });
}

// ---------- clients ----------
app.get('/api/clients', (req, res) => {
  const db = load();
  res.json(db.clients);
});

app.post('/api/clients', (req, res) => {
  const db = load();
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
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
  const b = req.body || {};
  const fields = ['name', 'company', 'phone', 'email', 'source', 'notes', 'followUp', 'lastReply'];
  fields.forEach(f => { if (b[f] !== undefined) c[f] = b[f]; });
  if (b.stage && STAGES.includes(b.stage) && b.stage !== c.stage) {
    log(db, c.id, 'stage', `Stage: ${c.stage} -> ${b.stage}`);
    c.stage = b.stage;
    if (b.stage === 'onboarded' || b.stage === 'rejected') c.followUp = ''; // no more reminders
  }
  if (b.callStatus && CALLS.includes(b.callStatus) && b.callStatus !== c.callStatus) {
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
  let added = 0, skipped = 0;
  rows.forEach(r => {
    if (!r.name && !r.email && !r.phone) { skipped++; return; }
    const dup = db.clients.find(c => (r.email && c.email === r.email) || (r.phone && c.phone === r.phone));
    if (dup) { skipped++; return; }
    const c = {
      id: uid(), name: r.name || r.email || r.phone, company: r.company || '', phone: r.phone || '',
      email: r.email || '', source: r.source || 'import', notes: r.notes || '', stage: 'new',
      callStatus: 'not_called', followUp: '', lastReply: '', createdAt: now(), updatedAt: now()
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
  const b = req.body || {};
  if (b.company !== undefined) db.settings.company = b.company;
  if (b.currency !== undefined) db.settings.currency = String(b.currency).slice(0, 4);
  if (b.ai) {
    if (b.ai.apiKey !== undefined && b.ai.apiKey !== '********') db.settings.ai.apiKey = String(b.ai.apiKey).trim();
    if (b.ai.model !== undefined) db.settings.ai.model = String(b.ai.model).trim().slice(0, 80);
  }
  if (b.smtp) {
    const keepPass = b.smtp.pass === '********' || b.smtp.pass === undefined;
    db.settings.smtp = { ...db.settings.smtp, ...b.smtp, pass: keepPass ? db.settings.smtp.pass : b.smtp.pass };
  }
  save(db);
  res.json({ ok: true });
});

// ---------- mass mailing ----------
const fill = (t, c) => String(t).replace(/{{\s*(name|company|email|phone)\s*}}/gi, (_, k) => c[k.toLowerCase()] || '');
const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

function audience(db, audienceKey) {
  let list = db.clients.filter(c => c.email);
  if (audienceKey === 'all') list = list.filter(c => c.stage !== 'rejected'); // never mail red zone by "all"
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
app.post('/api/mail/send-one', async (req, res) => {
  const db = load();
  const { clientId, subject = '', body = '' } = req.body || {};
  const c = db.clients.find(x => x.id === clientId);
  if (!c) return res.status(404).json({ error: 'client not found' });
  if (!c.email) return res.status(400).json({ error: 'this client has no email address' });
  if (!subject.trim() || !body.trim()) return res.status(400).json({ error: 'subject and message are required' });
  const transporter = smtpTransport(db);
  try {
    if (transporter) {
      await transporter.sendMail({ from: db.settings.smtp.from || db.settings.smtp.user, to: c.email, subject, text: body, html: esc(body).replace(/\n/g, '<br>') });
    }
    log(db, c.id, 'mail', `Email: ${subject}${transporter ? '' : ' (simulated)'}`);
    if (c.stage === 'new') c.stage = 'contacted';
    c.updatedAt = now();
    save(db);
    res.json({ ok: true, simulated: !transporter });
  } catch (e) { res.status(502).json({ error: 'Email failed: ' + e.message }); }
});

app.post('/api/mail/send', async (req, res) => {
  const db = load();
  const { audience: key = 'all', subject = '', body = '', dryRun } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
  const list = audience(db, key);
  const s = db.settings.smtp;
  const configured = s.host && s.user && s.pass;
  const simulate = dryRun || !configured;
  let transporter;
  if (!simulate) {
    transporter = nodemailer.createTransport({
      host: s.host, port: Number(s.port) || 587, secure: !!s.secure, auth: { user: s.user, pass: s.pass }
    });
  }
  let sent = 0, failed = 0; const errors = [];
  for (const c of list) {
    try {
      if (!simulate) {
        await transporter.sendMail({
          from: s.from || s.user, to: c.email, subject: fill(subject, c),
          text: fill(body, c), html: esc(fill(body, c)).replace(/\n/g, '<br>')
        });
        await new Promise(r => setTimeout(r, 400)); // gentle rate limit
      }
      log(db, c.id, 'mail', `Mass mail: ${subject}${simulate ? ' (simulated)' : ''}`);
      if (c.stage === 'new') c.stage = 'contacted';
      sent++;
    } catch (e) { failed++; errors.push(`${c.email}: ${e.message}`); }
  }
  const camp = { id: uid(), at: now(), subject, audience: key, total: list.length, sent, failed, simulated: !!simulate };
  db.campaigns.push(camp);
  save(db);
  res.json({ ...camp, errors: errors.slice(0, 5) });
});

// ---------- CRM tools (tasks, deals, templates, reports, CSV export) and Claude AI features ----------
const ctx = { load, save, uid, now, log, STAGES, CALLS };
require('./lib/tools').mount(app, ctx);
require('./lib/ai').mount(app, ctx);

app.listen(PORT, () => console.log(`CRM running at http://localhost:${PORT}`));
