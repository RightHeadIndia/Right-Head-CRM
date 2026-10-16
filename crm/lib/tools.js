// General CRM tools: tasks, deals pipeline, email templates, reports, CSV export.
// Mounted from server.js via mount(app, ctx). Shared helpers are exported for lib/ai.js.

const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
// Used only for the "weighted forecast" on the Reports page. Edit to match how your team closes.
const DEAL_WEIGHT = { lead: 0.1, qualified: 0.25, proposal: 0.5, negotiation: 0.75, won: 1, lost: 0 };
const PRIORITIES = ['low', 'normal', 'high'];
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

// '' -> '', valid date/ISO -> ISO string, 'YYYY-MM-DD' kept as-is, invalid -> null
function cleanDate(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const d = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    return !isNaN(d) && d.toISOString().slice(0, 10) === v ? v : null;
  }
  const datePrefix = /^(\d{4}-\d{2}-\d{2})T/.exec(v);
  if (datePrefix) {
    const d = new Date(`${datePrefix[1]}T00:00:00.000Z`);
    if (isNaN(d) || d.toISOString().slice(0, 10) !== datePrefix[1]) return null;
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}
function cleanMoney(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v === '' || v == null ? 0 : v);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
}

// ---------- tasks ----------
function makeTask(ctx, db, b) {
  if (!isObject(b)) return { error: 'task must be an object' };
  if (typeof b.title !== 'string') return { error: 'title must be text' };
  const title = str(b.title, 200);
  if (!title) return { error: 'title is required' };
  if (b.title.trim().length > 200) return { error: 'title is too long (maximum 200 characters)' };
  if (b.clientId !== undefined && typeof b.clientId !== 'string') return { error: 'clientId must be text' };
  if (b.clientId && !db.clients.some(c => c.id === b.clientId)) return { error: 'client not found' };
  if (b.notes !== undefined && (typeof b.notes !== 'string' || b.notes.length > 2000)) return { error: 'notes must be text no longer than 2000 characters' };
  if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) return { error: 'priority is not valid' };
  if (b.dueAt !== undefined && b.dueAt !== '' && typeof b.dueAt !== 'string') return { error: 'dueAt must be text' };
  const dueAt = cleanDate(b.dueAt);
  if (dueAt === null) return { error: 'dueAt is not a valid date' };
  const t = {
    id: ctx.uid(), title, clientId: b.clientId || '', dueAt,
    priority: PRIORITIES.includes(b.priority) ? b.priority : 'normal',
    notes: str(b.notes, 2000), done: false, doneAt: '', createdAt: ctx.now(), updatedAt: ctx.now()
  };
  db.tasks.push(t);
  if (t.clientId) ctx.log(db, t.clientId, 'task', `Task added: ${t.title}`);
  return { task: t };
}

// ---------- deals ----------
function makeDeal(ctx, db, b) {
  if (!isObject(b)) return { error: 'deal must be an object' };
  if (typeof b.title !== 'string') return { error: 'title must be text' };
  const title = str(b.title, 200);
  if (!title) return { error: 'title is required' };
  if (b.title.trim().length > 200) return { error: 'title is too long (maximum 200 characters)' };
  if (b.clientId !== undefined && typeof b.clientId !== 'string') return { error: 'clientId must be text' };
  if (b.clientId && !db.clients.some(c => c.id === b.clientId)) return { error: 'client not found' };
  if (b.stage !== undefined && !DEAL_STAGES.includes(b.stage)) return { error: 'stage is not valid' };
  if (b.expectedClose !== undefined && b.expectedClose !== '' && typeof b.expectedClose !== 'string') return { error: 'expectedClose must be text' };
  if (b.notes !== undefined && (typeof b.notes !== 'string' || b.notes.length > 2000)) return { error: 'notes must be text no longer than 2000 characters' };
  if (b.lostReason !== undefined && (typeof b.lostReason !== 'string' || b.lostReason.length > 300)) return { error: 'lostReason must be text no longer than 300 characters' };
  const value = cleanMoney(b.value); if (value === null) return { error: 'value must be a positive number' };
  const expectedClose = cleanDate(b.expectedClose); if (expectedClose === null) return { error: 'expectedClose is not a valid date' };
  const stage = DEAL_STAGES.includes(b.stage) ? b.stage : 'lead';
  const d = {
    id: ctx.uid(), title, clientId: b.clientId || '', value, stage, expectedClose,
    notes: str(b.notes, 2000), lostReason: stage === 'lost' ? str(b.lostReason, 300) : '',
    closedAt: stage === 'won' || stage === 'lost' ? ctx.now() : '', createdAt: ctx.now(), updatedAt: ctx.now()
  };
  db.deals.push(d);
  if (d.clientId) ctx.log(db, d.clientId, 'deal', `Deal created: ${d.title} (${d.stage})`);
  return { deal: d };
}

// ---------- reports ----------
const stageTarget = a => (/->\s*(\w+)\s*$/.exec(a.note || '') || [])[1];

function buildReport(ctx, db, days = 30) {
  days = Math.min(730, Math.max(1, Math.round(Number(days)) || 30));
  const since = new Date(Date.now() - days * 864e5);
  const inRange = iso => iso && new Date(iso) >= since;
  const cs = db.clients;

  const stages = {}; ctx.STAGES.forEach(k => (stages[k] = cs.filter(c => c.stage === k).length));
  const calls = {}; ctx.CALLS.forEach(k => (calls[k] = cs.filter(c => c.callStatus === k).length));

  const acts = db.activities.filter(a => inRange(a.at));
  const activity = {};
  ['call', 'reply', 'mail', 'note', 'stage', 'task', 'deal'].forEach(t => (activity[t] = acts.filter(a => a.type === t).length));
  const onboardedInRange = acts.filter(a => a.type === 'stage' && stageTarget(a) === 'onboarded').length;
  const rejectedInRange = acts.filter(a => a.type === 'stage' && stageTarget(a) === 'rejected').length;

  const contacted = cs.filter(c => c.stage !== 'new').length;
  const responded = cs.filter(c => ['replied', 'onboarded'].includes(c.stage)).length;

  // sources
  const srcMap = {};
  cs.forEach(c => {
    const k = c.source || 'unknown';
    srcMap[k] = srcMap[k] || { source: k, clients: 0, onboarded: 0 };
    srcMap[k].clients++; if (c.stage === 'onboarded') srcMap[k].onboarded++;
  });
  const sources = Object.values(srcMap).sort((a, b) => b.clients - a.clients).slice(0, 8);

  // deals
  const dealStages = DEAL_STAGES.map(s => {
    const ds = db.deals.filter(d => d.stage === s);
    return { stage: s, count: ds.length, value: ds.reduce((n, d) => n + d.value, 0) };
  });
  const open = db.deals.filter(d => !['won', 'lost'].includes(d.stage));
  const wonAll = db.deals.filter(d => d.stage === 'won');
  const lostAll = db.deals.filter(d => d.stage === 'lost');
  const wonRange = wonAll.filter(d => inRange(d.closedAt));
  const lostRange = lostAll.filter(d => inRange(d.closedAt));
  const sum = a => a.reduce((n, d) => n + d.value, 0);

  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - i);
    const next = new Date(d); next.setMonth(next.getMonth() + 1);
    const w = wonAll.filter(x => x.closedAt && new Date(x.closedAt) >= d && new Date(x.closedAt) < next);
    months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, won: w.length, value: sum(w) });
  }

  // tasks
  const openTasks = db.tasks.filter(t => !t.done);
  const nowMs = Date.now();
  return {
    days, since: since.toISOString(),
    clients: { total: cs.length, created: cs.filter(c => inRange(c.createdAt)).length, stages, calls, contacted, responded,
      responseRate: contacted ? responded / contacted : 0, onboardedInRange, rejectedInRange,
      conversionRate: cs.length ? stages.onboarded / cs.length : 0, sources },
    activity,
    deals: {
      stages: dealStages, openCount: open.length, openValue: sum(open),
      weightedForecast: Math.round(open.reduce((n, d) => n + d.value * DEAL_WEIGHT[d.stage], 0)),
      wonCount: wonRange.length, wonValue: sum(wonRange), lostCount: lostRange.length, lostValue: sum(lostRange),
      winRate: wonRange.length + lostRange.length ? wonRange.length / (wonRange.length + lostRange.length) : 0,
      avgWon: wonRange.length ? Math.round(sum(wonRange) / wonRange.length) : 0,
      overdueOpen: open.filter(d => d.expectedClose && new Date(d.expectedClose) < new Date(new Date().toDateString())).length,
      months
    },
    tasks: {
      open: openTasks.length,
      overdue: openTasks.filter(t => t.dueAt && new Date(t.dueAt).getTime() < nowMs).length,
      completedInRange: db.tasks.filter(t => t.done && inRange(t.doneAt)).length
    }
  };
}

// ---------- CSV ----------
// Spreadsheet formula-injection guard: cells starting with = @ tab CR (or +/- that is not a plain number/phone) get a leading '
function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = (cols, rows) => '\uFEFF' + [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';

function mount(app, ctx) {
  const { load, save, uid, now, log } = ctx;
  const byId = (arr, id) => arr.find(x => x.id === id);

  // ----- tasks -----
  app.get('/api/tasks', (req, res) => res.json(load().tasks));
  app.post('/api/tasks', (req, res) => {
    const db = load();
    const r = makeTask(ctx, db, req.body || {});
    if (r.error) return res.status(400).json(r);
    save(db); res.json(r.task);
  });
  app.put('/api/tasks/:id', (req, res) => {
    const db = load(); const t = byId(db.tasks, req.params.id), b = req.body;
    if (!t) return res.status(404).json({ error: 'not found' });
    if (!isObject(b)) return res.status(400).json({ error: 'task update must be an object' });
    if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 200)) return res.status(400).json({ error: 'title must be 1 to 200 characters' });
    if (b.notes !== undefined && (typeof b.notes !== 'string' || b.notes.length > 2000)) return res.status(400).json({ error: 'notes must be text no longer than 2000 characters' });
    if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'priority is not valid' });
    if (b.clientId !== undefined && typeof b.clientId !== 'string') return res.status(400).json({ error: 'clientId must be text' });
    if (b.dueAt !== undefined && b.dueAt !== '' && typeof b.dueAt !== 'string') return res.status(400).json({ error: 'dueAt must be text' });
    if (b.done !== undefined && typeof b.done !== 'boolean') return res.status(400).json({ error: 'done must be true or false' });
    if (b.title !== undefined) t.title = b.title.trim();
    if (b.notes !== undefined) t.notes = b.notes;
    if (b.priority !== undefined) t.priority = b.priority;
    if (b.clientId !== undefined) {
      if (b.clientId && !byId(db.clients, b.clientId)) return res.status(400).json({ error: 'client not found' });
      t.clientId = b.clientId || '';
    }
    if (b.dueAt !== undefined) { const d = cleanDate(b.dueAt); if (d === null) return res.status(400).json({ error: 'dueAt is not a valid date' }); t.dueAt = d; }
    if (b.done !== undefined && !!b.done !== t.done) {
      t.done = !!b.done; t.doneAt = t.done ? now() : '';
      if (t.done && t.clientId) log(db, t.clientId, 'task', `Task done: ${t.title}`);
    }
    t.updatedAt = now(); save(db); res.json(t);
  });
  app.delete('/api/tasks/:id', (req, res) => {
    const db = load(); db.tasks = db.tasks.filter(t => t.id !== req.params.id); save(db); res.json({ ok: true });
  });

  // ----- deals -----
  app.get('/api/deals', (req, res) => res.json(load().deals));
  app.post('/api/deals', (req, res) => {
    const db = load();
    const r = makeDeal(ctx, db, req.body || {});
    if (r.error) return res.status(400).json(r);
    save(db); res.json(r.deal);
  });
  app.put('/api/deals/:id', (req, res) => {
    const db = load(); const d = byId(db.deals, req.params.id), b = req.body;
    if (!d) return res.status(404).json({ error: 'not found' });
    if (!isObject(b)) return res.status(400).json({ error: 'deal update must be an object' });
    if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 200)) return res.status(400).json({ error: 'title must be 1 to 200 characters' });
    if (b.notes !== undefined && (typeof b.notes !== 'string' || b.notes.length > 2000)) return res.status(400).json({ error: 'notes must be text no longer than 2000 characters' });
    if (b.value !== undefined && typeof b.value !== 'number' && typeof b.value !== 'string') return res.status(400).json({ error: 'value must be a number' });
    if (b.stage !== undefined && !DEAL_STAGES.includes(b.stage)) return res.status(400).json({ error: 'stage is not valid' });
    if (b.clientId !== undefined && typeof b.clientId !== 'string') return res.status(400).json({ error: 'clientId must be text' });
    if (b.lostReason !== undefined && (typeof b.lostReason !== 'string' || b.lostReason.length > 300)) return res.status(400).json({ error: 'lostReason must be text no longer than 300 characters' });
    if (b.title !== undefined) d.title = b.title.trim();
    if (b.notes !== undefined) d.notes = b.notes;
    if (b.value !== undefined) { const v = cleanMoney(b.value); if (v === null) return res.status(400).json({ error: 'value must be a non-negative number' }); d.value = v; }
    if (b.expectedClose !== undefined) { if (b.expectedClose !== '' && typeof b.expectedClose !== 'string') return res.status(400).json({ error: 'expectedClose must be text' }); const v = cleanDate(b.expectedClose); if (v === null) return res.status(400).json({ error: 'expectedClose is not a valid date' }); d.expectedClose = v; }
    if (b.clientId !== undefined) {
      if (b.clientId && !byId(db.clients, b.clientId)) return res.status(400).json({ error: 'client not found' });
      d.clientId = b.clientId || '';
    }
    if (b.stage && b.stage !== d.stage) {
      if (d.clientId) log(db, d.clientId, 'deal', `Deal "${d.title}": ${d.stage} -> ${b.stage}`);
      d.stage = b.stage;
      d.closedAt = b.stage === 'won' || b.stage === 'lost' ? now() : '';
    }
    if (b.lostReason !== undefined) d.lostReason = d.stage === 'lost' ? str(b.lostReason, 300) : '';
    d.updatedAt = now(); save(db); res.json(d);
  });
  app.delete('/api/deals/:id', (req, res) => {
    const db = load(); db.deals = db.deals.filter(d => d.id !== req.params.id); save(db); res.json({ ok: true });
  });

  // ----- email templates -----
  app.get('/api/templates', (req, res) => res.json(load().templates));
  app.post('/api/templates', (req, res) => {
    const db = load(), b = req.body;
    if (!isObject(b)) return res.status(400).json({ error: 'template must be an object' });
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 100) return res.status(400).json({ error: 'name must be 1 to 100 characters' });
    if (b.subject !== undefined && (typeof b.subject !== 'string' || b.subject.length > 300)) return res.status(400).json({ error: 'subject must be text no longer than 300 characters' });
    if (b.body !== undefined && (typeof b.body !== 'string' || b.body.length > 20000)) return res.status(400).json({ error: 'body must be text no longer than 20000 characters' });
    const t = { id: uid(), name: b.name.trim(), subject: b.subject || '', body: b.body || '', createdAt: now(), updatedAt: now() };
    db.templates.push(t); save(db); res.json(t);
  });
  app.put('/api/templates/:id', (req, res) => {
    const db = load(); const t = byId(db.templates, req.params.id), b = req.body;
    if (!t) return res.status(404).json({ error: 'not found' });
    if (!isObject(b)) return res.status(400).json({ error: 'template update must be an object' });
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 100)) return res.status(400).json({ error: 'name must be 1 to 100 characters' });
    if (b.subject !== undefined && (typeof b.subject !== 'string' || b.subject.length > 300)) return res.status(400).json({ error: 'subject must be text no longer than 300 characters' });
    if (b.body !== undefined && (typeof b.body !== 'string' || b.body.length > 20000)) return res.status(400).json({ error: 'body must be text no longer than 20000 characters' });
    if (b.name !== undefined) t.name = b.name.trim();
    if (b.subject !== undefined) t.subject = b.subject;
    if (b.body !== undefined) t.body = b.body;
    t.updatedAt = now(); save(db); res.json(t);
  });
  app.delete('/api/templates/:id', (req, res) => {
    const db = load(); db.templates = db.templates.filter(t => t.id !== req.params.id); save(db); res.json({ ok: true });
  });

  // ----- reports -----
  app.get('/api/reports', (req, res) => res.json(buildReport(ctx, load(), req.query.days)));

  // ----- CSV export -----
  const EXPORTS = {
    clients: db => ({
      cols: ['name', 'company', 'phone', 'email', 'stage', 'callStatus', 'followUp', 'source', 'notes', 'lastReply', 'createdAt', 'updatedAt'],
      rows: db.clients
    }),
    deals: db => ({
      cols: ['title', 'client', 'company', 'value', 'stage', 'expectedClose', 'closedAt', 'lostReason', 'notes', 'createdAt'],
      rows: db.deals.map(d => { const c = byId(db.clients, d.clientId) || {}; return { ...d, client: c.name || '', company: c.company || '' }; })
    }),
    tasks: db => ({
      cols: ['title', 'client', 'dueAt', 'priority', 'status', 'doneAt', 'notes', 'createdAt'],
      rows: db.tasks.map(t => ({ ...t, client: (byId(db.clients, t.clientId) || {}).name || '', status: t.done ? 'done' : 'open' }))
    }),
    activities: db => ({
      cols: ['at', 'client', 'type', 'note'],
      rows: db.activities.slice().sort((a, b) => b.at.localeCompare(a.at)).map(a => ({ ...a, client: (byId(db.clients, a.clientId) || {}).name || '' }))
    })
  };
  app.get('/api/export/:what', (req, res) => {
    const name = req.params.what.replace(/\.csv$/, '');
    if (!EXPORTS[name]) return res.status(404).json({ error: 'unknown export' });
    const { cols, rows } = EXPORTS[name](load());
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="crm-${name}-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(toCsv(cols, rows));
  });
}

module.exports = { mount, buildReport, makeTask, makeDeal, cleanDate, DEAL_STAGES, PRIORITIES, csvCell };
