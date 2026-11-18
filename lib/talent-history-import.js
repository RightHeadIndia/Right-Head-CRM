'use strict';

const XLSX = require('xlsx');
const crypto = require('node:crypto');

const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const text = value => value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
const compact = value => text(value).replace(/\s+/g, ' ');
const sheetType = name => {
  const key = normalize(name);
  if (key.includes('interview')) return 'interview';
  if (key.includes('cv') && key.includes('shared')) return 'cv-shared';
  if (key.includes('shortlist') || key.includes('offer')) return 'offers';
  if (key.includes('weekly')) return 'weekly';
  if (key.includes('fint') || key.includes('sol')) return 'sourcing';
  return 'other';
};
function dateText(value, cell) {
  if (typeof value === 'number' && cell?.z && XLSX.SSF.is_date(cell.z)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed?.y) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  return text(value);
}
function extractWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: true });
  const sheets = workbook.SheetNames.map(name => {
    const sheet = workbook.Sheets[name], originalRange = sheet['!ref'] || '';
    const byRow = new Map(); let minRow = Infinity, maxRow = -1, minCol = Infinity, maxCol = -1;
    // XLSX !ref can cover huge formatted-but-empty regions. Walk actual cells
    // instead of every coordinate in that rectangle, and retain source rows.
    for (const address of Object.keys(sheet)) {
      if (address[0] === '!' || !/^[A-Z]{1,3}\d+$/.test(address)) continue;
      const cell = sheet[address]; if (!cell || (cell.v === undefined && !cell.f)) continue;
      const point = XLSX.utils.decode_cell(address), rowCells = byRow.get(point.r) || [];
      rowCells.push([point.c, cell.v instanceof Date ? cell.v.toISOString() : cell.v ?? '', cell.w ?? '', cell.t ?? '', cell.f ?? '', cell.z ?? '']);
      byRow.set(point.r, rowCells); minRow = Math.min(minRow, point.r); maxRow = Math.max(maxRow, point.r); minCol = Math.min(minCol, point.c); maxCol = Math.max(maxCol, point.c);
    }
    const rowIndexes = [...byRow.keys()].sort((a, b) => a - b), rows = rowIndexes.map(index => byRow.get(index).sort((a, b) => a[0] - b[0]));
    const range = rowIndexes.length ? XLSX.utils.encode_range({ s: { r: minRow, c: minCol }, e: { r: maxRow, c: maxCol } }) : originalRange;
    return { name, type: sheetType(name), hidden: Boolean(workbook.Workbook?.Sheets?.find(item => item.name === name)?.Hidden), range, rowStart: rowIndexes[0] ?? 0, rowIndexes, merges: (sheet['!merges'] || []).map(merge => XLSX.utils.encode_range(merge)), rows };
  });
  const detected = sheets.filter(sheet => sheet.type !== 'other');
  return { sheets, detected: detected.map(({ name, type, hidden, range, merges, rows }) => ({ name, type, hidden, range, merges: merges.length, rowCount: rows.length, populatedRows: rows.filter(row => row.length).length })) };
}
function gridFor(sheet) {
  const width = Math.max(0, ...sheet.rows.map(row => row.reduce((max, cell) => Math.max(max, cell[0] + 1), 0)));
  return sheet.rows.map(row => { const result = Array(width).fill(''); for (const [col, value, formatted] of row) result[col] = formatted || text(value); return result; });
}
function findHeader(grid, required) {
  let best = -1, score = 0;
  grid.slice(0, 30).forEach((row, index) => {
    const headers = row.map(normalize);
    const found = required.reduce((count, aliases) => count + Number(headers.some(value => aliases.includes(value))), 0);
    if (found > score) { best = index; score = found; }
  });
  return best;
}
function headerMap(row, aliases) {
  const normalized = row.map(normalize), result = {};
  for (const [field, names] of Object.entries(aliases)) result[field] = normalized.findIndex(value => names.includes(value));
  return result;
}
function get(row, index) { return index < 0 ? '' : text(row[index]); }
function dateOnly(value) {
  const s = text(value); if (!s) return '';
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) { let [, a, b, y] = m; y = Number(y); if (y < 100) y += y < 50 ? 2000 : 1900; const d = Number(a) > 12 ? Number(a) : Number(b) > 12 ? Number(b) : Number(a); const mo = Number(a) > 12 ? Number(b) : Number(b) > 12 ? Number(a) : Number(b); if (mo <= 12 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)[, ]+([0-9]{4})$/i);
  if (m) { const month = new Date(`${m[2]} 1, 2000`).getMonth() + 1; if (month) return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return s;
}
function stageFor(value) {
  const s = normalize(value);
  return /black.?list/.test(s) ? 'Blacklisted' : /reject|declin|not selected|not offered|not shortlisted|not joined|withdrawn/.test(s) ? 'Rejected' : /join|hired/.test(s) ? 'Joining' : /offer|offered/.test(s) ? 'Offer' : /short.?list|selected/.test(s) ? 'Shortlisted' : /interview/.test(s) ? 'Interview' : 'Screening';
}
function parseSheet(sheet) {
  const grid = gridFor(sheet), candidates = [], type = sheet.type;
  if (type === 'interview') {
    let pending = [];
    const addPending = eventDate => {
      for (const entry of pending) candidates.push({ name: entry.name, role: entry.role, company: entry.company, recruiter: entry.recruiter, stage: stageFor(entry.candidateStatus), source: 'Interview Tracker', imported: true, interview: { ...entry, date: entry.date || eventDate } });
      pending = [];
    };
    grid.forEach((row, index) => {
      const a = compact(row[0]), b = compact(row[1]), c = compact(row[2]), d = compact(row[3]);
      const marker = a && !b && !c && !d ? dateOnly(a) : '';
      if (marker && (marker !== a || /^\d/.test(a) || /\d{4}/.test(a))) { addPending(marker); return; }
      if (!a || !d || normalize(a) === 'recruiter' || normalize(d).includes('candidate')) return;
      const time = compact(row[5]);
      const entry = { recruiter: a, company: b, role: c, name: d, mode: compact(row[4]), time, candidateStatus: compact(row[6]), clientStatus: compact(row[7]), email: compact(row[8]), phone: compact(row[9]), remarks: [compact(row[10]), compact(row[11])].filter(Boolean).join('\n') };
      pending.push(entry);
    });
    addPending('');
  } else if (type === 'offers') {
    const index = findHeader(grid, [['ta name', 'recruiter', 'recruiter name'], ['candidate']],), row = grid[index >= 0 ? index : 1] || [];
    const map = headerMap(row, { recruiter: ['ta name', 'recruiter', 'recruiter name'], month: ['month'], company: ['company'], role: ['profile', 'role', 'position'], name: ['candidate', 'candidate name'], status: ['status'], finalCall: ['final call'], doj: ['doj', 'date of joining'], remarks: ['remarks', 'remark', 'feedback', 'comments'] });
    for (const source of grid.slice(index + 1)) {
      const name = get(source, map.name); if (!name) continue;
      const status = get(source, map.status), date = dateOnly(get(source, map.doj));
      candidates.push({ name, role: get(source, map.role), company: get(source, map.company), recruiter: get(source, map.recruiter), month: get(source, map.month), stage: stageFor(`${status} ${get(source, map.finalCall)}`), source: 'Shortlisted Offered', imported: true, finalCall: get(source, map.finalCall), doj: date, remarks: get(source, map.remarks) });
    }
  } else if (type === 'sourcing') {
    const index = findHeader(grid, [['candidate name', 'candidate'], ['skill', 'profile']]);
    const map = headerMap(grid[index >= 0 ? index : 0] || [], { date: ['date'], role: ['skill', 'profile', 'role'], name: ['candidate name', 'candidate'], phone: ['mobile', 'phone'], email: ['email'], remarks: ['status feedback', 'status', 'feedback', 'remarks'] });
    for (const source of grid.slice((index >= 0 ? index : 0) + 1)) {
      const name = get(source, map.name); if (!name) continue;
      const extras = source.map((value, i) => value ? `${grid[index >= 0 ? index : 0][i] || `Column ${i + 1}`}: ${value}` : '').filter(Boolean).join('\n');
      candidates.push({ name, role: get(source, map.role), phone: get(source, map.phone), email: get(source, map.email), stage: stageFor(get(source, map.remarks)), source: 'Fint Sol', imported: true, notes: extras.slice(0, 6000) });
    }
  }
  return candidates;
}
function parseCvSharedSheet(sheet) {
  const grid = gridFor(sheet), rows = [];
  let currentDate = '';
  for (let index = 0; index < grid.length; index++) {
    const row = grid[index], first = compact(row[0]);
    const isDateBand = first && row.slice(1).every(value => !compact(value));
    if (isDateBand) {
      const parsed = dateOnly(first);
      if (parsed !== first || /^\d{4}-\d{1,2}-\d{1,2}$/.test(first) || /^\d{1,2}\s+[a-z]+[,]?\s+\d{4}$/i.test(first)) { currentDate = parsed; continue; }
    }
    const name = compact(row[4]);
    if (!name || normalize(name) === 'candidate') continue;
    rows.push({
      sharedAt: currentDate,
      recruiter: compact(row[0]),
      shareStatus: compact(row[1]),
      company: compact(row[2]),
      role: compact(row[3]),
      candidateName: name,
      designation: compact(row[5]),
      location: compact(row[6]),
      workLocation: compact(row[7]),
      experience: compact(row[8]),
      currentCompany: compact(row[9]),
      currentCtc: compact(row[10]),
      expectedCtc: compact(row[11]),
      noticePeriod: compact(row[12]),
      remarks: compact(row[13]),
      phone: compact(row[14]),
      email: compact(row[15]),
      sourceRow: (sheet.rowIndexes?.[index] ?? index + (sheet.rowStart || 0)) + 1
    });
  }
  return rows;
}
function summarizeWorkbook(buffer) {
  const workbook = extractWorkbook(buffer);
  return { detected: workbook.detected, summaries: workbook.sheets.map(sheet => ({ name: sheet.name, type: sheet.type, hidden: sheet.hidden, rows: sheet.rows.filter(row => row.length).length })) };
}
function rebuildWorkbook(archive) {
  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { Sheets: [] };
  for (const saved of archive.sheets || []) {
    const sheet = {};
    for (let rowIndex = 0; rowIndex < saved.rows.length; rowIndex++) for (const [col, value, formatted, type, formula, format] of saved.rows[rowIndex]) {
      const address = XLSX.utils.encode_cell({ r: saved.rowIndexes?.[rowIndex] ?? (saved.rowStart || 0) + rowIndex, c: col });
      sheet[address] = { t: type || (typeof value === 'number' ? 'n' : 's'), v: value };
      if (formula) sheet[address].f = formula;
      if (format) sheet[address].z = format;
      if (formatted) sheet[address].w = formatted;
    }
    if (saved.range) sheet['!ref'] = saved.range;
    sheet['!merges'] = (saved.merges || []).map(value => XLSX.utils.decode_range(value));
    XLSX.utils.book_append_sheet(workbook, sheet, saved.name.slice(0, 31));
    workbook.Workbook.Sheets.push({ name: saved.name.slice(0, 31), Hidden: saved.hidden ? 1 : 0 });
  }
  return workbook;
}
function importWorkbook(db, buffer, selectedNames, sourceName = 'Historical workbook') {
  const workbook = extractWorkbook(buffer), selected = new Set(selectedNames), sheets = workbook.sheets.filter(sheet => selected.has(sheet.name));
  if (!sheets.length) throw new Error('Select at least one worksheet to import.');
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  let archive = db.taHistoricalImports.find(item => item.id === digest);
  if (!archive) { archive = { id: digest, sourceName: String(sourceName).slice(0, 255), importedAt: new Date().toISOString(), sheets: [], report: { worksheets: [], candidatesCreated: 0, interviewsAdded: 0, duplicatesSkipped: 0, cvSharesAdded: 0 } }; db.taHistoricalImports.push(archive); }
  archive.report.cvSharesAdded ||= 0;
  const result = { worksheets: [], candidatesCreated: 0, interviewsAdded: 0, duplicatesSkipped: 0, cvSharesAdded: 0, sourcingRows: 0, weeklyRows: 0 };
  for (const sheet of sheets) {
    if (archive.sheets.some(existing => existing.name === sheet.name)) { result.worksheets.push({ name: sheet.name, status: 'already imported' }); continue; }
    const parsedCandidates = parseSheet(sheet), parsedCvShares = sheet.type === 'cv-shared' ? parseCvSharedSheet(sheet) : []; let created = 0, interviewsAdded = 0, duplicatesSkipped = 0, cvSharesAdded = 0;
    if (sheet.type === 'cv-shared') {
      db.taCvShares ||= [];
      const key = row => [row.sharedAt, row.recruiter, row.shareStatus, row.company, row.role, row.candidateName].map(normalize).join('|');
      // Build the duplicate index once. Calling Array.some for every imported
      // row made large historical sheets quadratic in the number of CV shares.
      const existingKeys = new Set(db.taCvShares.map(key));
      const importedAt = new Date().toISOString();
      for (const share of parsedCvShares) {
        const shareKey = key(share);
        if (existingKeys.has(shareKey)) { duplicatesSkipped++; continue; }
        existingKeys.add(shareKey);
        db.taCvShares.push({ id: crypto.randomUUID(), ...share, imported: true, createdAt: importedAt, updatedAt: importedAt });
        cvSharesAdded++;
      }
    }
    if (sheet.type === 'weekly') result.weeklyRows += sheet.rows.filter(row => row.length).length;
    for (const incoming of parsedCandidates) {
      if (sheet.type === 'sourcing') result.sourcingRows++;
      const norm = value => normalize(value);
      let candidate = db.candidates.find(item => incoming.email && item.email && norm(incoming.email) === norm(item.email));
      if (!candidate && incoming.phone) { const digits = value => String(value || '').replace(/\D/g, '').slice(-10); candidate = db.candidates.find(item => digits(incoming.phone) && digits(item.phone) === digits(incoming.phone)); }
      if (!candidate) candidate = db.candidates.find(item => norm(item.name) === norm(incoming.name) && norm(item.role) === norm(incoming.role) && norm(item.company) === norm(incoming.company));
      if (!candidate) {
        candidate = { id: crypto.randomUUID(), name: incoming.name.slice(0, 200), role: (incoming.role || '').slice(0, 200), company: (incoming.company || '').slice(0, 200), recruiter: (incoming.recruiter || '').slice(0, 200), email: (incoming.email || '').slice(0, 254), phone: (incoming.phone || '').slice(0, 50), source: incoming.source, notes: incoming.notes || '', month: incoming.month || '', finalCall: incoming.finalCall || '', doj: incoming.doj || '', remarks: incoming.remarks || '', stage: incoming.stage, imported: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), statusHistory: [], interviews: [] };
        db.candidates.push(candidate); created++;
      }
      if (incoming.interview) {
        const interview = incoming.interview;
        const key = value => ['date', 'company', 'role', 'recruiter', 'mode', 'time', 'candidateStatus', 'clientStatus', 'remarks', 'finalCall', 'doj'].map(field => norm(value[field])).join('|');
        candidate.interviews ||= [];
        if (candidate.interviews.some(existing => key(existing) === key(interview))) duplicatesSkipped++;
        else { candidate.interviews.push(interview); interviewsAdded++; }
      }
      for (const field of ['email', 'phone', 'company', 'recruiter', 'month', 'finalCall', 'doj', 'notes', 'remarks']) if (!candidate[field] && incoming[field]) candidate[field] = incoming[field];
      if (candidate.stage === 'Unspecified' || candidate.stage === 'Applied') candidate.stage = 'Screening';
      if (candidate.stage === 'Hired') candidate.stage = 'Joining';
      if (candidate.stage === 'Screening' && incoming.stage !== 'Screening') candidate.stage = incoming.stage;
      candidate.updatedAt = new Date().toISOString();
    }
    const storedSheet = { name: sheet.name, type: sheet.type, hidden: sheet.hidden, range: sheet.range, rowStart: sheet.rowStart, rowIndexes: sheet.rowIndexes, merges: sheet.merges, rows: sheet.rows };
    archive.sheets.push(storedSheet);
    const recordsImported = parsedCandidates.length + parsedCvShares.length;
    const sheetReport = { name: sheet.name, type: sheet.type, hidden: sheet.hidden, originalRows: sheet.rows.length, populatedRows: sheet.rows.filter(row => row.length).length, candidatesCreated: created, recordsImported, interviewsAdded, cvSharesAdded, duplicatesSkipped, archived: true };
    archive.report.worksheets.push(sheetReport); archive.report.candidatesCreated += created; archive.report.interviewsAdded += interviewsAdded; archive.report.duplicatesSkipped += duplicatesSkipped; archive.report.cvSharesAdded += cvSharesAdded;
    result.worksheets.push({ ...sheetReport, status: 'imported' }); result.candidatesCreated += created; result.interviewsAdded += interviewsAdded; result.duplicatesSkipped += duplicatesSkipped; result.cvSharesAdded += cvSharesAdded;
  }
  archive.updatedAt = new Date().toISOString();
  return { importId: digest, ...result, report: archive.report };
}

module.exports = { extractWorkbook, summarizeWorkbook, importWorkbook, rebuildWorkbook, sheetType, parseSheet, parseCvSharedSheet, dateOnly };
