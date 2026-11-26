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
function timeText(value) {
  if (value instanceof Date) return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw), fraction = serial >= 1 ? serial % 1 : serial;
    if (fraction >= 0 && fraction < 1 && (serial < 1 || serial < 100000)) {
      const minutes = Math.round(fraction * 1440) % 1440;
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }
  }
  return raw;
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
  return sheet.rows.map(row => {
    const result = Array(width).fill('');
    for (const [col, value, formatted, , , format] of row) {
      if (typeof value === 'number' && format && XLSX.SSF.is_date(format)) {
        const parsed = XLSX.SSF.parse_date_code(value);
        result[col] = parsed?.d > 0 ? dateText(value, { z: format }) : timeText(value);
      } else result[col] = formatted || text(value);
    }
    return result;
  });
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
  const s = text(value).replace(/[\u200B-\u200D\uFEFF]/g, '').trim(); if (!s) return '';
  const named = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s/.-]+([a-z]{3,9})[,.\s/-]+(\d{4})$/i);
  if (named) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const month = months[named[2].slice(0, 3).toLowerCase()], year = Number(named[3]), day = Number(named[1]);
    if (month) { const date = new Date(Date.UTC(year, month - 1, day)); if (year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
  }
  if (/^\d{4,6}(?:\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= 20000 && serial <= 100000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    }
  }
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) { let [, a, b, y] = m; y = Number(y); if (y < 100) y += y < 50 ? 2000 : 1900; const d = Number(a) > 12 ? Number(a) : Number(b) > 12 ? Number(b) : Number(a); const mo = Number(a) > 12 ? Number(b) : Number(b) > 12 ? Number(a) : Number(b); if (mo <= 12 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s/-]+([a-z]+)[,\s/-]+([0-9]{4})$/i);
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
    const aliases = {
      name: ['candidate', 'candidate name', 'name'], recruiter: ['recruiter', 'recruiter name', 'ta name'],
      date: ['interview date', 'date'], company: ['company', 'client'], role: ['profile', 'role', 'position'],
      mode: ['mode', 'interview mode', 'interview type', 'type'], time: ['time', 'interview time'],
      candidateStatus: ['candidate status', 'candidate interview status', 'interview status', 'status'],
      clientStatus: ['client status', 'company status', 'client feedback'], contactDetails: ['contact details', 'contact'],
      email: ['email', 'email id'], phone: ['phone', 'mobile', 'phone number'], remarks: ['remarks', 'remark', 'feedback', 'comments']
    };
    const headerIndex = findHeader(grid, [aliases.name, aliases.recruiter]);
    const headerlessWidth = Math.max(0, ...grid.map(row => row.length));
    const headerlessLegacy = headerIndex < 0 && headerlessWidth > 0 && headerlessWidth < 11;
    const map = headerIndex >= 0 ? headerMap(grid[headerIndex], aliases) : headerlessLegacy ? {
      name: 3, recruiter: 0, date: -1, company: 1, role: 2, mode: 4, time: 5,
      candidateStatus: 6, clientStatus: 7, email: 8, phone: 9, contactDetails: -1, remarks: 10
    } : {
      name: 0, recruiter: 1, date: 2, company: 3, role: 4, mode: 5, time: 6,
      candidateStatus: 7, clientStatus: 8, contactDetails: 9, remarks: 10, email: -1, phone: -1
    };
    if (map.name < 0 || map.recruiter < 0) return candidates;
    const remarksColumns = headerIndex < 0 ? headerlessLegacy ? [10, 11].filter(index => index < headerlessWidth) : [map.remarks] : grid[headerIndex].map((value, index) => aliases.remarks.includes(normalize(value)) ? index : -1).filter(index => index >= 0);
    const sourceRows = headerIndex >= 0 ? grid.slice(headerIndex + 1) : grid;
    let pending = [];
    const savePending = eventDate => {
      for (const entry of pending) {
        const date = entry.date || eventDate || '';
        const contactDetails = entry.contactDetails || [entry.email, entry.phone].filter(Boolean).join(' · ');
        candidates.push({
          name: entry.name, role: entry.role, company: entry.company, recruiter: entry.recruiter,
          email: entry.email, phone: entry.phone, stage: stageFor(entry.candidateStatus), source: 'Interview Tracker', imported: true,
          interview: { ...entry, contactDetails, date }
        });
      }
      pending = [];
    };
    for (const row of sourceRows) {
      const populated = row.map(compact).filter(Boolean);
      if (!populated.length) continue;
      const name = compact(row[map.name]), recruiter = compact(row[map.recruiter]);
      if (!name || normalize(name).includes('candidate')) {
        if (populated.length === 1) {
          const marker = dateOnly(populated[0]);
          if (marker) { savePending(marker); continue; }
        }
        continue;
      }
      const email = compact(row[map.email]), phone = compact(row[map.phone]);
      const remarks = remarksColumns.map(index => compact(row[index])).filter(Boolean);
      pending.push({
        name, recruiter, date: dateOnly(row[map.date]), company: compact(row[map.company]), role: compact(row[map.role]),
        mode: compact(row[map.mode]), time: timeText(row[map.time]), candidateStatus: compact(row[map.candidateStatus]),
        clientStatus: compact(row[map.clientStatus]), contactDetails: compact(row[map.contactDetails]), email, phone,
        remarks: [...new Set(remarks)].join('\n')
      });
    }
    savePending('');
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
  const aliases = {
    sharedAt: ['date', 'share date', 'shared date'], recruiter: ['recruiter', 'recruiter name', 'ta name'],
    shareStatus: ['share status', 'share status time', 'status time', 'status'], company: ['company', 'client'],
    role: ['profile', 'role', 'position'], candidateName: ['candidate', 'candidate name'], designation: ['designation', 'title'],
    location: ['location'], workLocation: ['work location'], experience: ['experience', 'total experience'],
    currentCompany: ['current company'], currentCtc: ['current ctc'], expectedCtc: ['expected ctc'],
    noticePeriod: ['notice period'], remarks: ['remarks', 'remark', 'comments'], phone: ['phone', 'mobile', 'contact'], email: ['email', 'email id']
  };
  const fields = Object.keys(aliases);
  const headerIndex = grid.findIndex((row, index) => index < 30 && ['sharedAt', 'recruiter', 'candidateName'].every(field => row.map(normalize).some(value => aliases[field].includes(value))));
  const columns = headerIndex >= 0 ? headerMap(grid[headerIndex], aliases) : null;
  if (columns && fields.some(field => columns[field] < 0)) throw new Error(`The CV Shared header is missing required columns: ${fields.filter(field => columns[field] < 0).join(', ')}.`);
  if (columns && new Set(fields.map(field => columns[field])).size !== fields.length) throw new Error('The CV Shared header must map each of the 17 fields to a separate column.');

  let currentDate = '';
  for (let index = headerIndex >= 0 ? headerIndex + 1 : 0; index < grid.length; index++) {
    const row = grid[index], first = compact(row[0]);
    if (!row.some(value => compact(value))) continue;
    if (columns && ['sharedAt', 'recruiter', 'candidateName'].every(field => row.map(normalize).some(value => aliases[field].includes(value)))) continue;
    if (!columns) {
      const isDateBand = first && row.slice(1).every(value => !compact(value));
      if (isDateBand) {
        const parsed = dateOnly(first);
        if (/^\d{4}-\d{2}-\d{2}$/.test(parsed)) { currentDate = parsed; continue; }
      }
    }

    let record;
    if (columns) {
      record = Object.fromEntries(fields.map(field => [field, compact(get(row, columns[field]))]));
      if (!record.candidateName && dateOnly(record.sharedAt) && row.filter(value => compact(value)).length === 1) { currentDate = dateOnly(record.sharedAt); continue; }
      record.sharedAt = dateOnly(record.sharedAt) || currentDate;
    } else {
      const dateAt = first && /^\d{4}-\d{1,2}-\d{1,2}(?:[T\s]|$)/.test(first) ? dateOnly(first) : '';
      const leadingOffset = !dateAt && !first && /^\d{4}-\d{1,2}-\d{1,2}(?:[T\s]|$)/.test(compact(row[1])) ? 1 : 0;
      const hasDateColumn = Boolean(dateAt || leadingOffset);
      const offset = leadingOffset;
      const at = (field, legacyIndex) => compact(row[legacyIndex + offset]);
      record = {
        sharedAt: hasDateColumn ? dateOnly(row[offset]) : currentDate,
        recruiter: at('recruiter', hasDateColumn ? 1 : 0), shareStatus: at('shareStatus', hasDateColumn ? 2 : 1),
        company: at('company', hasDateColumn ? 3 : 2), role: at('role', hasDateColumn ? 4 : 3),
        candidateName: at('candidateName', hasDateColumn ? 5 : 4), designation: at('designation', hasDateColumn ? 6 : 5),
        location: at('location', hasDateColumn ? 7 : 6), workLocation: at('workLocation', hasDateColumn ? 8 : 7),
        experience: at('experience', hasDateColumn ? 9 : 8), currentCompany: at('currentCompany', hasDateColumn ? 10 : 9),
        currentCtc: at('currentCtc', hasDateColumn ? 11 : 10), expectedCtc: at('expectedCtc', hasDateColumn ? 12 : 11),
        noticePeriod: at('noticePeriod', hasDateColumn ? 13 : 12), remarks: at('remarks', hasDateColumn ? 14 : 13),
        phone: at('phone', hasDateColumn ? 15 : 14), email: at('email', hasDateColumn ? 16 : 15)
      };
    }
    if (!record.candidateName || normalize(record.candidateName) === 'candidate') throw new Error(`CV Shared row ${(sheet.rowIndexes?.[index] ?? index + (sheet.rowStart || 0)) + 1} contains data but has no Candidate value.`);
    if (record.sharedAt && !/^\d{4}-\d{2}-\d{2}$/.test(record.sharedAt)) throw new Error(`CV Shared row ${(sheet.rowIndexes?.[index] ?? index + (sheet.rowStart || 0)) + 1} has an invalid Date value: ${record.sharedAt}.`);
    record.sourceRow = (sheet.rowIndexes?.[index] ?? index + (sheet.rowStart || 0)) + 1;
    rows.push(record);
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
    const priorSheetIndex = archive.sheets.findIndex(existing => existing.name === sheet.name);
    const parsedCandidates = parseSheet(sheet), parsedCvShares = sheet.type === 'cv-shared' ? parseCvSharedSheet(sheet) : []; let created = 0, interviewsAdded = 0, duplicatesSkipped = 0, cvSharesAdded = 0;
    if (sheet.type === 'cv-shared') {
      db.taCvShares ||= [];
      db.taCvShares = db.taCvShares.filter(share => !(share.imported && normalize(share.recruiter) === 'date' && normalize(share.shareStatus) === 'recruiter' && normalize(share.candidateName) === 'profile'));
      const key = row => [row.sharedAt, row.recruiter, row.shareStatus, row.company, row.role, row.candidateName].map(normalize).join('|');
      // Build the duplicate index once. Calling Array.some for every imported
      // row made large historical sheets quadratic in the number of CV shares.
      const existingKeys = new Set(db.taCvShares.map(key));
      const importedAt = new Date().toISOString();
      for (const share of parsedCvShares) {
        const shareKey = key(share);
        const shifted = db.taCvShares.find(existing => existing.imported && !existing.sharedAt && /^\d{4}-\d{2}-\d{2}/.test(String(existing.recruiter || '')) && normalize(existing.designation) === normalize(share.candidateName) && normalize(existing.role) === normalize(share.company));
        if (shifted) {
          Object.assign(shifted, Object.fromEntries(['sharedAt', 'recruiter', 'shareStatus', 'company', 'role', 'candidateName', 'designation', 'location', 'workLocation', 'experience', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod', 'remarks', 'phone', 'email', 'sourceRow'].map(field => [field, share[field]])), { updatedAt: importedAt });
          existingKeys.add(shareKey);
          cvSharesAdded++;
          continue;
        }
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
    if (priorSheetIndex >= 0) archive.sheets[priorSheetIndex] = storedSheet;
    else archive.sheets.push(storedSheet);
    const recordsImported = parsedCandidates.length + parsedCvShares.length;
    const priorReportIndex = archive.report.worksheets.findIndex(existing => existing.name === sheet.name);
    const previousSheetReport = priorReportIndex >= 0 ? archive.report.worksheets[priorReportIndex] : null;
    const sheetReport = { name: sheet.name, type: sheet.type, hidden: sheet.hidden, originalRows: sheet.rows.length, populatedRows: sheet.rows.filter(row => row.length).length, candidatesCreated: created, recordsImported, interviewsAdded, cvSharesAdded: Math.max(cvSharesAdded, previousSheetReport?.cvSharesAdded || 0), duplicatesSkipped, archived: true };
    if (priorReportIndex >= 0) archive.report.worksheets[priorReportIndex] = sheetReport;
    else archive.report.worksheets.push(sheetReport);
    archive.report.candidatesCreated = archive.report.worksheets.reduce((total, item) => total + (item.candidatesCreated || 0), 0);
    archive.report.interviewsAdded = archive.report.worksheets.reduce((total, item) => total + (item.interviewsAdded || 0), 0);
    archive.report.duplicatesSkipped = archive.report.worksheets.reduce((total, item) => total + (item.duplicatesSkipped || 0), 0);
    archive.report.cvSharesAdded = archive.report.worksheets.reduce((total, item) => total + (item.cvSharesAdded || 0), 0);
    result.worksheets.push({ ...sheetReport, status: 'imported' }); result.candidatesCreated += created; result.interviewsAdded += interviewsAdded; result.duplicatesSkipped += duplicatesSkipped; result.cvSharesAdded += cvSharesAdded;
  }
  archive.updatedAt = new Date().toISOString();
  return { importId: digest, ...result, report: archive.report };
}

module.exports = { extractWorkbook, summarizeWorkbook, importWorkbook, rebuildWorkbook, sheetType, parseSheet, parseCvSharedSheet, dateOnly };
