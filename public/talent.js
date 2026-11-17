const STAGES = ['Unspecified', 'Applied', 'Screening', 'Interview', 'Shortlisted', 'Offer', 'Hired', 'Rejected'];
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let candidates = [];
let busy = false;
const api = async (url, method = 'GET', body) => {
  const response = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 401) {
    location.replace('/login.html?product=talent&next=%2Ftalent.html');
    throw new Error('Your session expired. Please sign in again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
};

function populateStageOptions() {
  $('#stageFilter').insertAdjacentHTML('beforeend', STAGES.map(stage => `<option value="${stage}">${stage}</option>`).join(''));
  $('select[name="stage"]').innerHTML = STAGES.map(stage => `<option value="${stage}">${stage}</option>`).join('');
}
function setBusy(value) {
  busy = value;
  $('#saveCandidate').disabled = value;
  $('#saveCandidate').textContent = value ? 'Saving…' : 'Save candidate';
}
function showError(message) {
  const box = $('#statusMessage');
  box.textContent = message;
  box.hidden = !message;
}
function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function updateMetrics() {
  $('#totalCount').textContent = candidates.length;
  $('#activeCount').textContent = candidates.filter(item => ['Screening', 'Interview', 'Shortlisted', 'Offer'].includes(item.stage)).length;
  $('#interviewCount').textContent = candidates.filter(item => item.stage === 'Interview').length;
  $('#hiredCount').textContent = candidates.filter(item => item.stage === 'Hired').length;
}
function render() {
  updateMetrics();
  const query = $('#search').value.trim().toLowerCase();
  const stage = $('#stageFilter').value;
  const visible = candidates.filter(item => {
    const matchesText = [item.name, item.role, item.email, item.phone, item.source].some(value => String(value || '').toLowerCase().includes(query));
    return matchesText && (!stage || item.stage === stage);
  });
  $('#candidateRows').innerHTML = visible.map(item => `<tr data-id="${escapeHTML(item.id)}">
    <td><span class="candidate-name">${escapeHTML(item.name)}</span>${item.email ? `<span class="candidate-email">${escapeHTML(item.email)}</span>` : ''}</td>
    <td>${escapeHTML(item.role)}</td>
    <td>${escapeHTML(item.source || '—')}</td>
    <td><label class="sr-only" for="stage-${escapeHTML(item.id)}">Stage for ${escapeHTML(item.name)}</label><select class="stage-select stage-${escapeHTML(item.stage)}" id="stage-${escapeHTML(item.id)}" data-action="stage">${STAGES.map(option => `<option value="${option}" ${item.stage === option ? 'selected' : ''}>${option}</option>`).join('')}</select></td>
    <td>${displayDate(item.createdAt)}</td>
    <td><div class="row-actions"><button class="action-button" type="button" data-action="edit">Edit</button><button class="action-button delete" type="button" data-action="delete">Delete</button></div></td>
  </tr>`).join('');
  const isEmpty = candidates.length === 0;
  $('#emptyState').hidden = !isEmpty;
  $('#noResults').hidden = isEmpty || visible.length > 0;
  $('#candidateRows').closest('table').hidden = isEmpty || visible.length === 0;
  renderTrackers();
}
async function loadCandidates() {
  showError('');
  try {
    candidates = await api('/candidates');
    render();
  } catch (error) {
    showError(error.message);
  }
}
function openDialog(candidate) {
  const form = $('#candidateForm');
  form.reset();
  $('#formError').textContent = '';
  $('#candidateId').value = candidate?.id || '';
  $('#dialogTitle').textContent = candidate ? 'Edit candidate' : 'Add candidate';
  $('#saveCandidate').textContent = candidate ? 'Save changes' : 'Save candidate';
  if (candidate) {
      for (const field of ['name', 'role', 'stage', 'email', 'phone', 'source', 'notes', 'company', 'recruiter', 'month', 'interviewDate', 'sharedDate', 'finalCall', 'doj', 'feedback', 'remarks']) {
      form.elements[field].value = candidate[field] || (field === 'stage' ? 'Applied' : '');
    }
  } else {
    form.elements.stage.value = 'Applied';
  }
  $('#candidateDialog').showModal();
  form.elements.name.focus();
}
async function submitCandidate(event) {
  event.preventDefault();
  if (busy) return;
  const form = $('#candidateForm');
  const values = Object.fromEntries(new FormData(form).entries());
  const id = $('#candidateId').value;
  delete values.candidateId;
  setBusy(true);
  $('#formError').textContent = '';
  try {
    await api(id ? `/candidates/${encodeURIComponent(id)}` : '/candidates', id ? 'PUT' : 'POST', values);
    $('#candidateDialog').close();
    await loadCandidates();
  } catch (error) {
    $('#formError').textContent = error.message;
  } finally {
    setBusy(false);
  }
}
$('#candidateRows').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const candidate = candidates.find(item => item.id === button.closest('tr').dataset.id);
  if (!candidate) return;
  if (button.dataset.action === 'edit') openDialog(candidate);
  if (button.dataset.action === 'delete' && confirm(`Delete ${candidate.name} from the candidate pipeline?`)) {
    try {
      await api(`/candidates/${encodeURIComponent(candidate.id)}`, 'DELETE');
      await loadCandidates();
    } catch (error) {
      showError(error.message);
    }
  }
});
$('#candidateRows').addEventListener('change', async event => {
  const select = event.target.closest('select[data-action="stage"]');
  if (!select) return;
  const candidate = candidates.find(item => item.id === select.closest('tr').dataset.id);
  if (!candidate) return;
  try {
    await api(`/candidates/${encodeURIComponent(candidate.id)}`, 'PUT', { stage: select.value });
    await loadCandidates();
  } catch (error) {
    showError(error.message);
    select.value = candidate.stage;
  }
});
$('#candidateForm').addEventListener('submit', submitCandidate);
$('#addCandidate').addEventListener('click', () => openDialog());
$('#emptyAdd').addEventListener('click', () => openDialog());
$('#search').addEventListener('input', render);
$('#stageFilter').addEventListener('change', render);
$('#closeDialog').addEventListener('click', () => $('#candidateDialog').close());
$('#cancelDialog').addEventListener('click', () => $('#candidateDialog').close());
$('#logout').addEventListener('click', async () => {
  try {
    await api('/auth/logout', 'POST', {});
    location.replace('/');
  } catch (error) {
    showError(error.message);
  }
});

const TA_METRICS = ['Candidate Shared', 'Candidate Shortlisted', 'Candidate Offered', 'Candidate Joined (Name)'];
const TA_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let weeklyReports = [];
const trackerSearch = name => document.querySelector(`[data-search="${name}"]`)?.value.trim().toLowerCase() || '';
const candidateMatch = (candidate, query) => [candidate.name, candidate.company, candidate.role, candidate.recruiter, candidate.stage, candidate.feedback, candidate.remarks].some(value => String(value || '').toLowerCase().includes(query));
const td = value => `<td>${escapeHTML(value || '—')}</td>`;
const stageSelect = candidate => `<select class="stage-select" data-candidate-stage="${escapeHTML(candidate.id)}" aria-label="Status for ${escapeHTML(candidate.name)}">${STAGES.map(stage => `<option ${candidate.stage === stage ? 'selected' : ''}>${stage}</option>`).join('')}</select>`;
function renderTrackers() {
  const interviewQuery = trackerSearch('interviews');
  const interviewRows = candidates.flatMap(c => {
    const entries = c.interviews?.length ? c.interviews : [{ date: c.interviewDate, company: c.company, role: c.role, recruiter: c.recruiter, mode: c.interviewMode, time: c.interviewTime, candidateStatus: c.interviewStatus, clientStatus: c.clientStatus, email: c.email, phone: c.phone, contactDetails: c.contactDetails, remarks: c.remarks || c.feedback }];
    return entries.map(entry => ({ candidate: c, entry }));
  }).filter(({ candidate: c, entry: i }) => candidateMatch({ ...c, company: i.company || c.company, role: i.role || c.role, recruiter: i.recruiter || c.recruiter, stage: i.candidateStatus || c.stage, feedback: i.remarks || c.feedback, remarks: i.clientStatus || c.clientStatus }, interviewQuery));
  $('#interviewRows').innerHTML = interviewRows.map(({ candidate: c, entry: i }) => `<tr>${td(c.name)}${td(i.recruiter || c.recruiter)}${td(i.date || c.interviewDate)}${td(i.company || c.company)}${td(i.role || c.role)}${td(i.mode || c.interviewMode)}${td(i.time || c.interviewTime)}<td>${stageSelect(c)}<small class="raw-status">${escapeHTML(i.candidateStatus || '')}</small></td>${td(i.clientStatus || c.clientStatus)}${td(i.contactDetails || [i.email || c.email, i.phone || c.phone].filter(Boolean).join(' · '))}${td(i.remarks || c.remarks || c.feedback)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button></td></tr>`).join('');
  $('#interviewEmpty').hidden = interviewRows.length > 0;
  const offerQuery = trackerSearch('offers');
  const offerCandidates = candidates.filter(c => ['Shortlisted', 'Offer', 'Hired'].includes(c.stage) && candidateMatch(c, offerQuery));
  $('#offerRows').innerHTML = offerCandidates.map(c => `<tr>${td(c.recruiter)}${td(c.month || c.doj?.slice(0, 7) || c.createdAt?.slice(0, 7))}${td(c.company)}${td(c.role)}${td(c.name)}<td>${stageSelect(c)}</td>${td(c.finalCall)}${td(c.doj)}${td(c.remarks || c.interviews?.at(-1)?.remarks)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button></td></tr>`).join('');
  $('#offerEmpty').hidden = offerCandidates.length > 0;
  renderWeekly();
}
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function mondayFor(date) { const result = new Date(date.getFullYear(), date.getMonth(), date.getDate()); result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); return result; }
function selectedWeekDays() { const [year, month, day] = $('#weekStart').value.split('-').map(Number); const monday = new Date(year, month - 1, day); return TA_DAYS.map((_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return localDateKey(d); }); }
function candidateEvents(candidate) {
  return candidate.statusHistory || [];
}
function metricCandidates(recruiter, metric, dateKey) {
  const matchesRecruiter = value => String(value || '').toLowerCase() === recruiter.toLowerCase();
  if (metric === TA_METRICS[0]) return candidates.filter(c => {
    if (c.interviews?.length) return c.interviews.some(i => matchesRecruiter(i.recruiter || c.recruiter) && String(i.sharedDate || '').slice(0, 10) === dateKey);
    return matchesRecruiter(c.recruiter) && String(c.sharedDate || (c.imported ? '' : c.createdAt) || '').slice(0, 10) === dateKey;
  });
  const stage = metric === TA_METRICS[1] ? 'Shortlisted' : metric === TA_METRICS[2] ? 'Offer' : 'Hired';
  return candidates.filter(c => candidateEvents(c).some(e => matchesRecruiter(e.recruiter || c.recruiter) && e.stage === stage && String(e.at || '').slice(0, 10) === dateKey));
}
function renderWeekly() {
  if (!$('#weeklyRows')) return;
  const recruiters = new Map();
  candidates.forEach(c => [c.recruiter, ...(c.interviews || []).map(i => i.recruiter)].filter(Boolean).forEach(name => { if (name.trim()) recruiters.set(name.toLowerCase(), name.trim()); }));
  weeklyReports.forEach(r => recruiters.set(r.recruiter.toLowerCase(), r.recruiter));
  const days = selectedWeekDays();
  $('#weeklyRows').innerHTML = [...recruiters.values()].sort((a, b) => a.localeCompare(b)).map(recruiter => {
    const report = weeklyReports.find(r => r.recruiter.toLowerCase() === recruiter.toLowerCase());
    const metricRows = TA_METRICS.map(metric => `<tr><th scope="row">${escapeHTML(metric)}</th>${days.map((dayKey, index) => {
      const day = TA_DAYS[index], people = metricCandidates(recruiter, metric, dayKey);
      const auto = metric === TA_METRICS[3] ? people.map(c => c.name).join(', ') || '—' : String(people.length);
      const cell = report?.manual?.[metric]?.[day] || {};
      return `<td class="week-cell"><span class="auto-count" title="Calculated from candidate records">Auto: ${escapeHTML(auto)}</span><label>Target<input type="number" min="0" max="100000" step="1" data-recruiter="${escapeHTML(recruiter)}" data-metric="${escapeHTML(metric)}" data-day="${day}" data-field="target" value="${escapeHTML(cell.target ?? '')}"></label><label>Achievement<input type="number" min="0" max="100000" step="1" data-recruiter="${escapeHTML(recruiter)}" data-metric="${escapeHTML(metric)}" data-day="${day}" data-field="achievement" value="${escapeHTML(cell.achievement ?? '')}"></label></td>`;
    }).join('')}</tr>`).join('');
    return `<section class="recruiter-week"><div class="recruiter-week-heading"><h3>${escapeHTML(recruiter)}</h3><button class="action-button delete" type="button" data-remove-recruiter="${escapeHTML(recruiter)}">Remove</button></div><div class="table-wrap"><table class="weekly-table"><thead><tr><th>Metric</th>${TA_DAYS.map((day, i) => `<th>${day}<small>${days[i].slice(5)}</small></th>`).join('')}</tr></thead><tbody>${metricRows}</tbody></table></div></section>`;
  }).join('') || '<div class="empty-state compact"><strong>No recruiters yet</strong><p>Add a recruiter or assign candidates to a recruiter in their profile.</p></div>';
}
async function loadWeekly() {
  try { weeklyReports = await api(`/ta-weekly?week=${encodeURIComponent($('#weekStart').value)}`); renderWeekly(); }
  catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; }
}
async function saveWeekly() {
  const inputs = [...document.querySelectorAll('#weeklyRows input[data-field]')];
  const recruiters = [...new Set(inputs.map(input => input.dataset.recruiter))];
  try {
    for (const recruiter of recruiters) {
      const manual = Object.fromEntries(TA_METRICS.map(metric => [metric, Object.fromEntries(TA_DAYS.map(day => [day, {}]))]));
      for (const input of inputs.filter(input => input.dataset.recruiter === recruiter)) manual[input.dataset.metric][input.dataset.day][input.dataset.field] = input.value;
      const saved = await api('/ta-weekly', 'PUT', { weekStart: $('#weekStart').value, recruiter, manual });
      const index = weeklyReports.findIndex(row => row.recruiter.toLowerCase() === recruiter.toLowerCase());
      if (index < 0) weeklyReports.push(saved); else weeklyReports[index] = saved;
    }
    $('#weeklyMessage').textContent = 'Weekly targets and achievements saved.'; $('#weeklyMessage').hidden = false; renderWeekly();
  } catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; }
}
function addCandidate() { openDialog(); }
function exportExcel() { location.href = `/api/ta-export.xlsx?week=${encodeURIComponent($('#weekStart').value)}`; }
const IMPORT_FIELDS = [
  ['recruiter', 'Recruiter name', ['recruiter', 'recruiter name', 'ta name', 'ta', 'hr name', 'consultant', 'sourcing ta']],
  ['date', 'Interview date', ['interview date', 'interview on', 'date of interview', 'date']],
  ['company', 'Company', ['company', 'company name', 'client', 'client name', 'organization', 'organisation']],
  ['role', 'Profile', ['profile', 'job profile', 'candidate profile', 'position', 'role', 'designation', 'requirement', 'job title']],
  ['name', 'Candidate name', ['candidate', 'candidate name', 'candidate full name', 'applicant name', 'name']],
  ['mode', 'Interview mode', ['interview mode', 'mode of interview', 'mode', 'round type']],
  ['time', 'Interview time', ['interview time', 'interview timing', 'time', 'slot']],
  ['candidateStatus', 'Candidate status', ['candidate status', 'candidate result', 'result', 'status', 'final status']],
  ['clientStatus', 'Client status', ['client status', 'customer status', 'feedback status']],
  ['email', 'Email', ['email', 'email id', 'candidate email', 'mail id']],
  ['phone', 'Phone', ['phone', 'phone number', 'mobile', 'contact number', 'candidate phone']],
  ['contactDetails', 'Contact details', ['contact details', 'contact info', 'contact']],
  ['remarks', 'Remarks / feedback', ['remarks', 'remark', 'feedback', 'comments', 'notes']],
  ['sharedDate', 'Candidate shared date', ['candidate shared date', 'shared date', 'date shared', 'submission date']],
  ['shortlistedDate', 'Shortlisted date', ['shortlisted date', 'shortlist date', 'selected date']],
  ['offeredDate', 'Offered date', ['offered date', 'offer date', 'date of offer']],
  ['finalCall', 'Final call / final status', ['final call', 'final decision', 'selection decision', 'final status']],
  ['doj', 'DOJ / joined date', ['doj', 'd o j', 'date of joining', 'joining date', 'joined date']],
  ['month', 'Month', ['month', 'reporting month']]
];
let importGrid = [], importHeaderIndex = 0, importMappings = {}, importRows = [], importPreviewPage = 0, importWorkbook = null;
const normalizeHeader = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function bestHeaderIndex(grid) {
  let best = 0, bestScore = -1;
  grid.slice(0, 20).forEach((row, index) => {
    const headers = row.map(normalizeHeader);
    const score = IMPORT_FIELDS.reduce((total, [, , aliases]) => total + (headers.some(header => aliases.some(alias => header === alias || (alias.length >= 12 && header.startsWith(alias)))) ? 1 : 0), 0);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return best;
}
function headerScore(grid) { const row = grid[bestHeaderIndex(grid)] || [], headers = row.map(normalizeHeader); return IMPORT_FIELDS.reduce((total, [, , aliases]) => total + (headers.some(header => aliases.includes(header)) ? 1 : 0), 0); }
function parseTrackerDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localDateKey(value);
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100000 && window.XLSX?.SSF) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed?.y && parsed?.m && parsed?.d) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  if (!text) return '';
  let match = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (match) {
    let [, first, second, year] = match; first = Number(first); second = Number(second); year = Number(year); if (year < 100) year += year < 50 ? 2000 : 1900;
    const day = first > 12 ? first : second > 12 ? second : first;
    const month = first > 12 ? second : second > 12 ? first : second;
    if (day <= 31 && month <= 12) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : localDateKey(parsed);
}
function importCellText(value, field) {
  if (value === null || value === undefined) return '';
  if (['date', 'sharedDate', 'shortlistedDate', 'offeredDate', 'doj'].includes(field)) return parseTrackerDate(value);
  if (field === 'month') {
    if (value instanceof Date || (typeof value === 'number' && window.XLSX?.SSF?.parse_date_code(value)?.y)) return parseTrackerDate(value).slice(0, 7);
    const text = String(value).trim(), numericMonth = text.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (numericMonth && Number(numericMonth[2]) >= 1 && Number(numericMonth[2]) <= 12) return `${numericMonth[1]}-${String(Number(numericMonth[2])).padStart(2, '0')}`;
    const parsed = new Date(text); return !Number.isNaN(parsed.getTime()) && /[a-z]/i.test(text) ? localDateKey(parsed).slice(0, 7) : text;
  }
  if (field === 'time' && typeof value === 'number' && value >= 0 && value < 1 && window.XLSX?.SSF) return XLSX.SSF.format('h:mm AM/PM', value);
  if (value instanceof Date && field === 'time') return value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return String(value).trim();
}
function autoMappings(header) {
  const normalized = header.map(normalizeHeader), mappings = {};
  for (const [field, , aliases] of IMPORT_FIELDS) {
    const index = normalized.findIndex(text => aliases.some(alias => text === alias || (alias.length >= 12 && text.startsWith(alias))));
    mappings[field] = index < 0 ? '' : String(index);
  }
  return mappings;
}
function renderImportMappings() {
  const header = importGrid[importHeaderIndex] || [];
  $('#importMappingFields').innerHTML = IMPORT_FIELDS.map(([field, label]) => `<label>${escapeHTML(label)}<select data-import-map="${field}"><option value="">Do not import</option>${header.map((cell, index) => `<option value="${index}" ${importMappings[field] === String(index) ? 'selected' : ''}>${escapeHTML(String(cell || `Column ${index + 1}`))}</option>`).join('')}</select></label>`).join('');
}
function candidateForImport(row) {
  const normal = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (row.email) return candidates.find(c => normal(c.email) === normal(row.email));
  if (row.phone) { const digits = value => String(value || '').replace(/\D/g, '').slice(-10); return candidates.find(c => digits(c.phone) && digits(c.phone) === digits(row.phone)); }
  return candidates.find(c => normal(c.name) === normal(row.name) && normal(c.role) === normal(row.role));
}
function importInterviewKey(row) { const normalize = key => String(row[key] || '').trim().toLowerCase().replace(/\s+/g, ' '); const identity = ['date', 'company', 'role', 'recruiter', 'mode', 'time'].map(normalize); return (identity.some(Boolean) ? identity : ['candidateStatus', 'clientStatus', 'email', 'phone', 'contactDetails', 'remarks'].map(normalize)).join('|'); }
function isDuplicateImport(row, seen) {
  const candidate = candidateForImport(row);
  if (candidate) {
    const entries = candidate.interviews?.length ? candidate.interviews : candidate.interviewDate || candidate.company || candidate.role || candidate.interviewStatus || candidate.feedback ? [{ date: candidate.interviewDate, company: candidate.company, role: candidate.role, recruiter: candidate.recruiter, mode: candidate.interviewMode, time: candidate.interviewTime, candidateStatus: candidate.interviewStatus, clientStatus: candidate.clientStatus, email: candidate.email, phone: candidate.phone, contactDetails: candidate.contactDetails, remarks: candidate.remarks || candidate.feedback }] : [];
    if (entries.some(item => importInterviewKey({ date: item.date, company: item.company, role: item.role, recruiter: item.recruiter, mode: item.mode, time: item.time, candidateStatus: item.candidateStatus, clientStatus: item.clientStatus, email: item.email, phone: item.phone, contactDetails: item.contactDetails, remarks: item.remarks }) === importInterviewKey(row))) return true;
  }
  const identity = [row.email || row.phone || row.name, row.email || row.phone ? '' : row.role].map(value => String(value || '').toLowerCase()).join('|');
  const key = `${identity}|${importInterviewKey(row)}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}
function mapImportRows() {
  const seen = new Set();
  importRows = importGrid.slice(importHeaderIndex + 1).map(source => {
    const row = {};
    for (const [field] of IMPORT_FIELDS) {
      const index = importMappings[field];
      row[field] = index === '' || index === undefined ? '' : importCellText(source[Number(index)], field);
    }
    row.stage = candidateStageForImport(row.candidateStatus);
    row._duplicate = Boolean(row.name && isDuplicateImport(row, seen));
    return row;
  }).filter(row => IMPORT_FIELDS.some(([field]) => String(row[field] || '').trim()));
  renderImportPreview();
}
function renderImportPreview() {
  const visibleFields = IMPORT_FIELDS.filter(([field]) => importMappings[field] !== '');
  const duplicateCount = importRows.filter(row => row._duplicate).length;
  const rowError = row => !row.name.trim() ? 'Missing candidate name' : row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ? 'Invalid email' : '';
  const invalidCount = importRows.filter(row => rowError(row)).length;
  const pageSize = 50, pageCount = Math.max(1, Math.ceil(importRows.length / pageSize));
  importPreviewPage = Math.min(importPreviewPage, pageCount - 1);
  $('#importSummary').textContent = `${importRows.length} rows · ${duplicateCount} duplicate interview rows will not be added; missing details can be merged · ${invalidCount} missing candidate name${invalidCount === 1 ? '' : 's'} will be skipped`;
  $('#importPreviewHead').innerHTML = `<tr><th>Row</th>${visibleFields.map(([, label]) => `<th>${escapeHTML(label)}</th>`).join('')}<th>Import result</th></tr>`;
  const start = importPreviewPage * pageSize;
  $('#importPreviewRows').innerHTML = importRows.slice(start, start + pageSize).map((row, offset) => { const rowIndex = start + offset; return `<tr class="${row._duplicate ? 'is-duplicate' : ''}"><td>${rowIndex + 1}</td>${visibleFields.map(([field]) => `<td><input data-import-row="${rowIndex}" data-import-value="${field}" value="${escapeHTML(row[field] || '')}" aria-label="Row ${rowIndex + 1} ${escapeHTML(field)}"></td>`).join('')}<td class="duplicate-cell">${row._duplicate ? 'Duplicate · merge missing details' : rowError(row) || 'Ready'}</td></tr>`; }).join('');
  $('#importPageLabel').textContent = `${importRows.length ? start + 1 : 0}–${Math.min(start + pageSize, importRows.length)} of ${importRows.length}`;
  $('#importPrevPage').disabled = importPreviewPage === 0; $('#importNextPage').disabled = importPreviewPage >= pageCount - 1;
  $('#confirmImport').disabled = !importRows.some(row => !rowError(row));
}
async function loadImportFile(file) {
  $('#importError').textContent = '';
  $('#importMapping').hidden = true; $('#importPreviewSection').hidden = true;
  if (!window.XLSX) throw new Error('The local Excel reader did not load. Refresh the page and try again.');
  const bytes = await file.arrayBuffer();
  importWorkbook = XLSX.read(bytes, { type: 'array', cellDates: true });
  if (!importWorkbook.SheetNames.length) throw new Error('The file has no worksheets.');
  const grids = importWorkbook.SheetNames.map(name => XLSX.utils.sheet_to_json(importWorkbook.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true }));
  const selectedIndex = grids.map(headerScore).reduce((best, score, index, scores) => score > scores[best] ? index : best, 0);
  $('#importSheet').innerHTML = importWorkbook.SheetNames.map((name, index) => `<option value="${escapeHTML(name)}" ${index === selectedIndex ? 'selected' : ''}>${escapeHTML(name)}</option>`).join('');
  $('#importSheetWrap').hidden = importWorkbook.SheetNames.length < 2;
  await loadImportSheet(importWorkbook.SheetNames[selectedIndex]);
}
async function loadImportSheet(sheetName) {
  const sheet = importWorkbook?.Sheets[sheetName];
  if (!sheet) throw new Error('The selected worksheet could not be read.');
  prepareImportGrid(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true }));
}
function loadPastedTracker(text) {
  if (!window.XLSX) throw new Error('The local Excel reader did not load. Refresh the page and try again.');
  $('#importMapping').hidden = true; $('#importPreviewSection').hidden = true;
  const options = { type: 'string', cellDates: true };
  if (text.includes('\t')) options.FS = '\t';
  const workbook = XLSX.read(text, options);
  if (!workbook.SheetNames.length) throw new Error('No tabular rows were found in the pasted text.');
  importWorkbook = null;
  $('#importSheetWrap').hidden = true;
  prepareImportGrid(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '', blankrows: true }));
}
function prepareImportGrid(grid) {
  importGrid = grid;
  if (!importGrid.some(row => row.some(cell => String(cell ?? '').trim()))) throw new Error('The selected sheet is empty.');
  if (importGrid.length > 5001) throw new Error('This import supports up to 5000 data rows at a time.');
  importHeaderIndex = bestHeaderIndex(importGrid);
  importPreviewPage = 0;
  $('#importHeaderRow').innerHTML = importGrid.slice(0, 20).map((row, index) => `<option value="${index}" ${index === importHeaderIndex ? 'selected' : ''}>Row ${index + 1}: ${escapeHTML(row.slice(0, 5).map(String).join(' · '))}</option>`).join('');
  importMappings = autoMappings(importGrid[importHeaderIndex] || []);
  $('#importMapping').hidden = false; $('#importPreviewSection').hidden = false;
  renderImportMappings(); mapImportRows();
}
function candidateStageForImport(value) {
  const status = String(value || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  return /reject|declined|not selected|not offered|not shortlisted|not joined/.test(status) ? 'Rejected' : /join|hired/.test(status) ? 'Hired' : /offer|offered/.test(status) ? 'Offer' : /short.?list|selected/.test(status) ? 'Shortlisted' : /interview/.test(status) ? 'Interview' : /screen/.test(status) ? 'Screening' : /applied|shared|submitted/.test(status) ? 'Applied' : 'Unspecified';
}
function recalculateImportDuplicates() { const seen = new Set(); importRows.forEach(row => { row.stage = candidateStageForImport(row.candidateStatus); row._duplicate = Boolean(row.name && isDuplicateImport(row, seen)); }); }
async function submitImport() {
  const button = $('#confirmImport'); button.disabled = true; button.textContent = 'Importing…'; $('#importError').textContent = '';
  try {
    recalculateImportDuplicates();
    const rows = importRows.filter(row => row.name.trim() && (!row.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))).map(row => ({
      name: row.name, role: row.role, company: row.company, recruiter: row.recruiter, email: row.email, phone: row.phone, month: row.month,
      stage: row.stage,
      interview: { date: row.date, company: row.company, role: row.role, recruiter: row.recruiter, mode: row.mode, time: row.time, candidateStatus: row.candidateStatus, clientStatus: row.clientStatus, email: row.email, phone: row.phone, contactDetails: row.contactDetails, remarks: row.remarks, sharedDate: row.sharedDate, shortlistedDate: row.shortlistedDate, offeredDate: row.offeredDate, finalCall: row.finalCall, doj: row.doj }
    }));
    const result = await api('/candidates/import', 'POST', { rows });
    $('#trackerImportDialog').close();
    const message = `Imported ${result.interviewsAdded} interview record${result.interviewsAdded === 1 ? '' : 's'} and ${result.candidatesCreated} new candidate${result.candidatesCreated === 1 ? '' : 's'}. Skipped ${result.duplicatesSkipped} duplicate${result.duplicatesSkipped === 1 ? '' : 's'} (${result.duplicateDetailsMerged} enriched with missing details) and ${result.invalidSkipped} invalid row${result.invalidSkipped === 1 ? '' : 's'}.`;
    showError(''); await loadCandidates();
    $('#importNotice').textContent = message; $('#importNotice').hidden = false;
  } catch (error) { $('#importError').textContent = error.message; }
  finally { button.textContent = 'Import records'; button.disabled = !importRows.some(row => row.name.trim() && (!row.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))); }
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
  const selected = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
  document.querySelectorAll('.tracker-view').forEach(view => { view.hidden = view.id !== `${selected}View`; });
}));
document.querySelectorAll('[data-add-candidate]').forEach(button => button.addEventListener('click', addCandidate));
document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', exportExcel));
document.querySelectorAll('[data-search]').forEach(input => input.addEventListener('input', renderTrackers));
document.querySelectorAll('#interviewRows, #offerRows').forEach(body => body.addEventListener('change', async event => {
  const select = event.target.closest('select[data-candidate-stage]'); if (!select) return;
  const candidate = candidates.find(c => c.id === select.dataset.candidateStage); if (!candidate) return;
  try { await api(`/candidates/${encodeURIComponent(candidate.id)}`, 'PUT', { stage: select.value }); await loadCandidates(); }
  catch (error) { showError(error.message); select.value = candidate.stage; }
}));
document.querySelectorAll('#interviewRows, #offerRows').forEach(body => body.addEventListener('click', event => {
  const button = event.target.closest('[data-edit-candidate]'); if (button) { const c = candidates.find(item => item.id === button.dataset.editCandidate); if (c) openDialog(c); }
}));
$('#weekStart').value = localDateKey(mondayFor(new Date()));
$('#weekStart').addEventListener('change', () => { const date = new Date(`${$('#weekStart').value}T00:00:00`); if (!Number.isNaN(date.getTime())) { $('#weekStart').value = localDateKey(mondayFor(date)); loadWeekly(); } });
$('#addRecruiter').addEventListener('click', () => { const name = prompt('Recruiter / TA name'); if (!name?.trim()) return; const key = name.trim().toLowerCase(); if (!weeklyReports.some(r => r.recruiter.toLowerCase() === key) && !candidates.some(c => c.recruiter?.toLowerCase() === key)) weeklyReports.push({ id: `draft-${Date.now()}`, weekStart: $('#weekStart').value, recruiter: name.trim(), manual: {} }); renderWeekly(); });
$('#saveWeekly').addEventListener('click', saveWeekly);
$('#importTracker').addEventListener('click', () => { $('#trackerImportForm').reset(); $('#trackerImportFile').value = ''; $('#importError').textContent = ''; $('#importMapping').hidden = true; $('#importPreviewSection').hidden = true; $('#importSheetWrap').hidden = true; importWorkbook = null; $('#trackerImportDialog').showModal(); });
$('#trackerImportFile').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file) return; try { await loadImportFile(file); } catch (error) { $('#importError').textContent = error.message; } });
$('#parsePastedTracker').addEventListener('click', () => { try { const text = $('#trackerPasteData').value.trim(); if (!text) throw new Error('Paste the header row and at least one tracker row first.'); loadPastedTracker(text); $('#importError').textContent = ''; } catch (error) { $('#importError').textContent = error.message; } });
$('#importSheet').addEventListener('change', async () => { try { await loadImportSheet($('#importSheet').value); } catch (error) { $('#importError').textContent = error.message; } });
$('#importHeaderRow').addEventListener('change', () => { importHeaderIndex = Number($('#importHeaderRow').value); importMappings = autoMappings(importGrid[importHeaderIndex] || []); renderImportMappings(); mapImportRows(); });
$('#importMappingFields').addEventListener('change', event => { const select = event.target.closest('[data-import-map]'); if (!select) return; importMappings[select.dataset.importMap] = select.value; mapImportRows(); });
$('#importPreviewRows').addEventListener('change', event => { const input = event.target.closest('[data-import-row]'); if (!input) return; const rowIndex = Number(input.dataset.importRow); importRows[rowIndex][input.dataset.importValue] = input.value; recalculateImportDuplicates(); renderImportPreview(); });
$('#importPrevPage').addEventListener('click', () => { importPreviewPage = Math.max(0, importPreviewPage - 1); renderImportPreview(); });
$('#importNextPage').addEventListener('click', () => { importPreviewPage++; renderImportPreview(); });
$('#confirmImport').addEventListener('click', submitImport);
document.querySelectorAll('[data-close-import]').forEach(button => button.addEventListener('click', () => $('#trackerImportDialog').close()));
$('#weeklyRows').addEventListener('click', async event => { const button = event.target.closest('[data-remove-recruiter]'); if (!button) return; const name = button.dataset.removeRecruiter; if (candidates.some(c => c.recruiter?.toLowerCase() === name.toLowerCase())) return alert('This recruiter is assigned to candidate records. Change those candidate profiles first.'); const record = weeklyReports.find(r => r.recruiter.toLowerCase() === name.toLowerCase()); try { if (record && !String(record.id).startsWith('draft-')) await api(`/ta-weekly/${encodeURIComponent(record.id)}`, 'DELETE'); weeklyReports = weeklyReports.filter(r => r.recruiter.toLowerCase() !== name.toLowerCase()); renderWeekly(); } catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; } });
populateStageOptions();
loadCandidates();
loadWeekly();
