const STAGES = ['Screening', 'Interview', 'Shortlisted', 'Offer', 'Joining', 'Joined', 'Rejected', 'Blacklisted', 'Withdrawn'];
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function debounce(callback, delay = 180) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), delay); };
}
let candidates = [];
let cvShares = [];
let recruiterDirectory = [];
const selectedCandidateIds = new Set();
const selectedCvShareIds = new Set();
const selectedImportArchiveIds = new Set();
const selectedImportedShareIds = new Set();
let cvSharePage = 0;
let importedSharePage = 0;
let visibleCvSharePageIds = [];
let visibleImportedSharePageIds = [];
let busy = false;
let talentRefreshPromise = null;
let lastTalentRefreshAt = 0;
let lastTalentUserInteractionAt = 0;
let weeklyEntriesDirty = false;
let hasLoadedTalentWorkspace = false;
const TALENT_VIEW_STATE_KEY = 'right-head-talent-view-state';
const TRACKER_TABS = ['interviews', 'offers', 'joined', 'weekly', 'cvshares', 'recruiters', 'importhistory', 'pipeline'];
function readTalentViewState() {
  try { return JSON.parse(localStorage.getItem(TALENT_VIEW_STATE_KEY) || '{}'); }
  catch { return {}; }
}
const savedTalentViewState = readTalentViewState();
function saveTalentViewState(patch = {}) {
  try { localStorage.setItem(TALENT_VIEW_STATE_KEY, JSON.stringify({ ...readTalentViewState(), ...patch })); }
  catch { /* Keep the current view usable when storage is unavailable. */ }
}
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

function renderRecruiterOptions() {
  const candidateNames = new Set([
    ...(candidates || []).map(candidate => candidate.name),
    ...(cvShares || []).map(share => share.candidateName)
  ].map(value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()).filter(Boolean));
  const nonNames = new Set(['confirmed', 'awaiting confirmation', 'to be aligned', 'selected', 'rejected', 'shortlisted', 'interview', 'screening', 'offer', 'joining', 'joined', 'on hold', 'not selected']);
  const isRecruiterName = value => {
    const name = String(value || '').trim().replace(/\s+/g, ' ');
    return name.length >= 2 && /[a-z]/i.test(name) && !/[\d@]/.test(name) && !/\b(?:gmail|yahoo|outlook|hotmail)\b/i.test(name) && !/^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(name) && !nonNames.has(name.toLocaleLowerCase()) && !candidateNames.has(name.toLocaleLowerCase());
  };
  const assignedNames = [
    ...(candidates || []).flatMap(candidate => [candidate.recruiter, ...(candidate.interviews || []).map(interview => interview.recruiter)]),
    ...(cvShares || []).map(share => share.recruiter),
    ...(weeklyReports || []).map(report => report.recruiter)
  ];
  const sorted = [...new Set([...recruiterDirectory.map(person => person.name), ...assignedNames].map(value => String(value || '').trim()).filter(isRecruiterName))].sort((a, b) => a.localeCompare(b));

  const options = sorted.map(name => `<option value="${escapeHTML(name)}"></option>`).join('');
  if ($('#recruiterNames')) $('#recruiterNames').innerHTML = options;
  const filter = $('#recruiterFilter');
  if (filter) {
    const selected = filter.value || '';
    filter.innerHTML = `<option value="">All recruiters</option>${sorted.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('')}`;
    if ([...filter.options].some(option => option.value === selected)) filter.value = selected;
  }
  const directoryHTML = sorted.map(name => {
    const person = recruiterDirectory.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    return `<div class="recruiter-directory-row"><span>${escapeHTML(name)}</span><button class="secondary-button" type="button" data-rename-recruiter="${escapeHTML(person?.id || '')}" data-recruiter-name="${escapeHTML(name)}">Rename</button><button class="action-button delete" type="button" data-delete-recruiter="${escapeHTML(person?.id || '')}" data-recruiter-name="${escapeHTML(name)}">Delete</button></div>`;
  }).join('') || '<p class="muted">No recruiters yet.</p>';
  ['#recruiterDirectory', '#analyticsRecruiterDirectory'].forEach(selector => { const directory = $(selector); if (directory) directory.innerHTML = directoryHTML; });
}
async function loadRecruiters() {
  try { recruiterDirectory = await api('/ta-recruiters'); renderRecruiterOptions(); renderWeekly(); renderRecruiterAnalytics(); }
  catch (error) { showError(error.message); }
}
async function fetchTalentWorkspaceData(showLoading = false) {
  if (showLoading && !candidates.length) $('#recruiterAnalytics').innerHTML = '<div class="empty-state compact"><strong>Loading recruiter analytics</strong><p>Fetching recruiters, candidates, CV shares, and weekly activity…</p></div>';
  try {
    const weekStart = $('#weekStart').value;
    const [nextCandidates, nextCvShares, nextWeekly, nextRecruiters] = await Promise.all([
      api('/candidates'), api('/ta-cv-shares'), api(`/ta-weekly?week=${encodeURIComponent(weekStart)}`), api('/ta-recruiters')
    ]);
    const currentSnapshot = JSON.stringify([candidates, cvShares, weeklyReports, recruiterDirectory]);
    const nextSnapshot = JSON.stringify([nextCandidates, nextCvShares, nextWeekly, nextRecruiters]);
    lastTalentRefreshAt = Date.now();
    if (hasLoadedTalentWorkspace && currentSnapshot === nextSnapshot) return true;
    candidates = Array.isArray(nextCandidates) ? nextCandidates : [];
    cvShares = Array.isArray(nextCvShares) ? nextCvShares : [];
    weeklyReports = Array.isArray(nextWeekly) ? nextWeekly : [];
    recruiterDirectory = Array.isArray(nextRecruiters) ? nextRecruiters : [];
    populateYearFilters();
    renderRecruiterOptions();
    render();
    renderWeekly();
    renderRecruiterAnalytics();
    hasLoadedTalentWorkspace = true;
    return true;
  } catch (error) {
    $('#recruiterAnalytics').innerHTML = `<div class="empty-state compact"><strong>Recruiter analytics could not load</strong><p>${escapeHTML(error.message)}</p><button type="button" class="secondary-button" id="retryRecruiterAnalytics">Retry loading data</button></div>`;
    $('#retryRecruiterAnalytics')?.addEventListener('click', loadRecruiterAnalyticsData);
    return false;
  }
}
function loadRecruiterAnalyticsData(showLoading = false) {
  if (talentRefreshPromise) return talentRefreshPromise;
  if (weeklyEntriesDirty) {
    $('#weeklyMessage').textContent = 'Save your weekly entries before refreshing so your unsaved inputs are not replaced.';
    $('#weeklyMessage').hidden = false;
    return Promise.resolve(false);
  }
  talentRefreshPromise = fetchTalentWorkspaceData(showLoading).finally(() => { talentRefreshPromise = null; });
  return talentRefreshPromise;
}
async function saveRecruiterName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return '';
  const saved = await api('/ta-recruiters', 'POST', { name });
  if (!recruiterDirectory.some(person => person.name.toLocaleLowerCase() === saved.name.toLocaleLowerCase())) recruiterDirectory.push(saved);
  recruiterDirectory.sort((a, b) => a.name.localeCompare(b.name));
  renderRecruiterOptions();
  return saved.name;
}
async function addRecruiterFromInput(inputId) {
  const input = $(inputId), name = input.value.trim();
  if (!name) { input.focus(); return; }
  try { await saveRecruiterName(name); input.value = ''; await loadWeekly(); $('#weeklyMessage').textContent = `${name} added to the recruiter directory.`; $('#weeklyMessage').hidden = false; }
  catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; }
}

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
  return Number.isNaN(date.getTime()) ? '”?' : date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatInterviewDate(value) {
  const key = normalizedDateKey(value);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '—';
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return '—';
  const monthLabel = new Intl.DateTimeFormat('en', { month: 'short' }).format(date);
  return `${day}/${monthLabel}/${year}`;
}
function formatInterviewTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw), fraction = serial >= 1 ? serial % 1 : serial;
    if (fraction >= 0 && fraction < 1 && serial < 100000) {
      const minutes = Math.round(fraction * 1440) % 1440;
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!match) return raw;
  let hours = Number(match[1]);
  const suffix = match[3]?.toLowerCase();
  if (suffix) { if (hours === 12) hours = 0; if (suffix === 'pm') hours += 12; }
  if (hours > 23 || Number(match[2]) > 59) return raw;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}
function normalizedDateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : localDateKey(value);
  // Excel sheets and older tracker imports can expose dates as serial numbers.
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 100000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  const text = String(value).trim();
  if (/^\d{4,6}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial >= 20000 && serial <= 100000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    }
  }
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[3]) >= 1 && Number(match[3]) <= 31) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    // Tracker sheets are day-first (DD/MM/YYYY); accept month-first when the
    // first component cannot be a month, and reject impossible calendar dates.
    let day = Number(match[1]), month = Number(match[2]);
    if (day > 12 && month <= 12) [day, month] = [month, day];
    const year = Number(match[3]), check = new Date(year, month - 1, day);
    if (year > 0 && check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day) return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  match = text.match(/^(\d{1,2})[\s/-]+([a-z]{3,})[\s,/-]+(\d{4})$/i);
  if (match) {
    const month = new Date(`${match[2]} 1, 2000`).getMonth() + 1, day = Number(match[1]), year = Number(match[3]);
    const check = new Date(year, month - 1, day);
    if (month && check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : localDateKey(parsed);
}
function firstDateKey(...values) { return values.map(normalizedDateKey).find(Boolean) || ''; }
function candidateMonthKey(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return `${match[1]}-${String(match[2]).padStart(2, '0')}-01`;
  match = text.match(/^(\d{4})$/);
  if (match) return `${match[1]}-01-01`;
  return normalizedDateKey(text);
}
function candidateDate(candidate, entry) {
  return firstDateKey(entry?.date, candidate.interviewDate, candidate.sharedDate, candidate.doj, candidate.offeredDate, candidate.shortlistedDate, candidate.month, ...(candidate.interviews || []).map(item => item.date), ...(candidate.statusHistory || []).map(item => item.at || item.date), candidate.createdAt);
}
function offerDate(candidate) {
  return firstDateKey(candidate.doj, candidate.offeredDate, candidate.shortlistedDate, candidateMonthKey(candidate.month), candidate.createdAt);
}
function candidateMatchesDateFilter(candidate) {
  const eventDates = [candidate.interviewDate, candidate.sharedDate, candidate.doj, candidate.offeredDate, candidate.shortlistedDate, candidate.rejectedDate,
    ...(candidate.interviews || []).flatMap(item => [item.date, item.sharedDate]),
    ...(candidate.statusHistory || []).map(item => item.at || item.date)].filter(Boolean);
  const dates = eventDates.length ? eventDates : [candidate.month, candidate.createdAt];
  return dates.some(dateFilterMatch);
}
function cvShareDate(share) { return firstDateKey(share.sharedAt, share.createdAt); }
function compareDates(left, right) {
  const a = normalizedDateKey(left), b = normalizedDateKey(right);
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return ($('#dateSort').value === 'oldest' ? 1 : -1) * a.localeCompare(b);
}
function dateFilterMatch(value) {
  const key = normalizedDateKey(value), month = $('#filterMonth').value, date = $('#filterDate').value, year = $('#filterYear').value;
  if (!month && !date && !year) return true;
  if (!key) return false;
  return (!month || key.slice(5, 7) === month) && (!date || key === date) && (!year || key.slice(0, 4) === year);
}
function recruiterFilterMatches(value) {
  const selected = $('#recruiterFilter')?.value || '';
  return !selected || String(value || '').trim().toLocaleLowerCase() === selected.toLocaleLowerCase();
}
function candidateMatchesRecruiter(candidate) {
  const selected = $('#recruiterFilter')?.value || '';
  if (!selected) return true;
  const names = [candidate.recruiter, ...(candidate.interviews || []).map(row => row.recruiter), ...(candidate.statusHistory || []).map(row => row.recruiter)];
  return names.some(name => recruiterFilterMatches(name));
}
function sortByDate(rows) {
  return rows.sort((a, b) => compareDates(candidateDate(a.candidate || a, a.entry), candidateDate(b.candidate || b, b.entry)));
}
function populateYearFilters() {
  const current = $('#filterYear').value;
  const dates = candidates.flatMap(candidate => [
    candidate.interviewDate, candidate.sharedDate, candidate.doj, candidate.offeredDate,
    candidate.shortlistedDate, candidate.rejectedDate, candidate.createdAt,
    candidate.month,
    ...(candidate.interviews || []).flatMap(item => [item.date, item.sharedDate]),
    ...(candidate.statusHistory || []).map(item => item.at || item.date)
  ]).concat(cvShares.map(cvShareDate));
  const years = [...new Set(dates.map(value => candidateMonthKey(value)).map(key => key.slice(0, 4)).filter(year => /^\d{4}$/.test(year)))].sort((a, b) => b.localeCompare(a));
  $('#filterYear').innerHTML = `<option value="">All years</option>${years.map(year => `<option value="${year}">${year}</option>`).join('')}`;
  const selected = current || '';
  $('#filterYear').value = years.includes(selected) ? selected : '';
}
function updateMetrics() {
  const filtered = candidates.filter(candidate => candidateMatchesDateFilter(candidate) && candidateMatchesRecruiter(candidate));
  $('#totalCount').textContent = filtered.length;
  $('#activeCount').textContent = filtered.filter(item => ['Screening', 'Interview', 'Shortlisted', 'Offer'].includes(item.stage)).length;
  $('#interviewCount').textContent = filtered.filter(item => item.stage === 'Interview').length;
  $('#hiredCount').textContent = filtered.filter(item => ['Joining', 'Joined'].includes(item.stage)).length;
}
function render() {
  updateMetrics();
  const query = $('#search').value.trim().toLowerCase();
  const stage = $('#stageFilter').value;
  const visible = candidates.filter(item => !['Joined', 'Joining'].includes(item.stage) && [item.name, item.role, item.email, item.phone, item.source, item.company, item.recruiter].some(value => String(value || '').toLowerCase().includes(query)) && (!stage || item.stage === stage) && candidateMatchesDateFilter(item) && candidateMatchesRecruiter(item))
    .sort((a, b) => compareDates(candidateDate(a), candidateDate(b)));
  $('#candidateRows').innerHTML = visible.map(item => `<tr data-id="${escapeHTML(item.id)}">
    <td><input type="checkbox" data-candidate-select="${escapeHTML(item.id)}" aria-label="Select ${escapeHTML(item.name)}"></td>
    <td><span class="candidate-name">${escapeHTML(item.name)}</span>${item.email ? `<span class="candidate-email">${escapeHTML(item.email)}</span>` : ''}</td>
    <td>${escapeHTML(item.role)}</td>
    <td>${escapeHTML(item.company || '”?')}</td>
    <td>${escapeHTML(item.recruiter || '”?')}</td>
    <td>${item.sharedDate ? displayDate(item.sharedDate) : '”?'}</td>
    <td>${escapeHTML(item.source || '”?')}</td>
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
    renderRecruiterOptions();
    populateYearFilters();
    const existingIds = new Set(candidates.map(candidate => candidate.id));
    for (const id of selectedCandidateIds) if (!existingIds.has(id)) selectedCandidateIds.delete(id);
    render();
    renderWeekly();
  } catch (error) {
    showError(error.message);
  }
}
function syncSelectionUI() {
  document.querySelectorAll('[data-candidate-select]').forEach(box => { box.checked = selectedCandidateIds.has(box.dataset.candidateSelect); });
  document.querySelectorAll('[data-select-all]').forEach(box => {
    const rows = [...box.closest('table').querySelectorAll('tbody [data-candidate-select]')];
    const checked = rows.filter(row => selectedCandidateIds.has(row.dataset.candidateSelect)).length;
    box.checked = rows.length > 0 && checked === rows.length;
    box.indeterminate = checked > 0 && checked < rows.length;
  });
  $('#selectedCandidateCount').textContent = selectedCandidateIds.size;
  $('#candidateBulkActions').hidden = selectedCandidateIds.size === 0;
}
async function deleteCandidate(candidate) {
  if (!confirm(`Delete ${candidate.name} and all of their interview history? This cannot be undone.`)) return;
  try {
    await api(`/candidates/${encodeURIComponent(candidate.id)}`, 'DELETE');
    selectedCandidateIds.delete(candidate.id);
    await loadCandidates();
  } catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
}
function openDialog(candidate) {
  const form = $('#candidateForm');
  form.reset();
  $('#formError').textContent = '';
  $('#candidateId').value = candidate?.id || '';
  $('#dialogTitle').textContent = candidate ? 'Edit candidate' : 'Add candidate';
  $('#saveCandidate').textContent = candidate ? 'Save changes' : 'Save candidate';
  if (candidate) {
      const latestInterview = candidate.interviews?.at(-1) || {};
      const interviewValues = {
        recruiter: latestInterview.recruiter, company: latestInterview.company, role: latestInterview.role,
        interviewDate: latestInterview.date, interviewMode: latestInterview.mode, interviewTime: latestInterview.time,
        interviewStatus: latestInterview.candidateStatus, clientStatus: latestInterview.clientStatus,
        contactDetails: latestInterview.contactDetails, email: latestInterview.email, phone: latestInterview.phone,
        remarks: latestInterview.remarks
      };
      for (const field of ['name', 'role', 'stage', 'email', 'phone', 'source', 'notes', 'company', 'recruiter', 'month', 'interviewDate', 'interviewMode', 'interviewTime', 'interviewStatus', 'clientStatus', 'contactDetails', 'sharedDate', 'shortlistedDate', 'offeredDate', 'rejectedDate', 'finalCall', 'doj', 'feedback', 'remarks']) {
      const value = candidate[field] || interviewValues[field] || (field === 'stage' ? 'Screening' : '');
      form.elements[field].value = field === 'interviewTime' ? formatInterviewTime(value) : value;
    }
  } else {
    form.elements.stage.value = 'Screening';
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
    values.recruiter = await saveRecruiterName(values.recruiter);
    const existing = candidates.find(candidate => candidate.id === id);
    if (existing?.interviews?.length) {
      const interviewFields = { interviewDate: 'date', interviewMode: 'mode', interviewTime: 'time', interviewStatus: 'candidateStatus', clientStatus: 'clientStatus', contactDetails: 'contactDetails' };
      values.interviews = existing.interviews.map((interview, index) => index === existing.interviews.length - 1
        ? { ...interview, ...Object.fromEntries(Object.entries(interviewFields).map(([formField, recordField]) => [recordField, values[formField] || ''])), recruiter: values.recruiter, company: values.company, role: values.role, email: values.email, phone: values.phone, remarks: values.remarks }
        : interview);
    }
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
  if (button.dataset.action === 'delete') deleteCandidate(candidate);
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
document.body.addEventListener('change', event => {
  const selectAll = event.target.closest('[data-select-all]');
  if (selectAll) {
    const ids = [...selectAll.closest('table').querySelectorAll('tbody [data-candidate-select]')].map(box => box.dataset.candidateSelect);
    ids.forEach(id => selectAll.checked ? selectedCandidateIds.add(id) : selectedCandidateIds.delete(id));
    syncSelectionUI();
    return;
  }
  const checkbox = event.target.closest('[data-candidate-select]');
  if (!checkbox) return;
  if (checkbox.checked) selectedCandidateIds.add(checkbox.dataset.candidateSelect);
  else selectedCandidateIds.delete(checkbox.dataset.candidateSelect);
  syncSelectionUI();
});
$('#clearCandidateSelection').addEventListener('click', () => { selectedCandidateIds.clear(); syncSelectionUI(); });
$('#deleteSelectedCandidates').addEventListener('click', async () => {
  const ids = [...selectedCandidateIds];
  if (!ids.length || !confirm(`Delete ${ids.length} selected candidate${ids.length === 1 ? '' : 's'} and all linked interview history? This cannot be undone.`)) return;
  const button = $('#deleteSelectedCandidates'); button.disabled = true; button.textContent = 'Deleting…';
  try {
    const result = await api('/candidates', 'DELETE', { ids });
    selectedCandidateIds.clear();
    $('#workspaceMessage').textContent = `Deleted ${result.deleted} candidate${result.deleted === 1 ? '' : 's'}.`;
    $('#workspaceMessage').hidden = false;
    await loadCandidates();
  } catch (error) {
    $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false;
  } finally { button.disabled = false; button.textContent = 'Delete selected'; syncSelectionUI(); }
});
$('#candidateForm').addEventListener('submit', submitCandidate);
$('#addCandidate').addEventListener('click', () => openDialog());
$('#emptyAdd').addEventListener('click', () => openDialog());
$('#addCvShare').addEventListener('click', () => openCvShareDialog());
$('#pasteCvShares').addEventListener('click', () => { $('#pasteCvSharesError').textContent = ''; $('#pasteCvSharesDialog').showModal(); $('#pasteCvSharesText').focus(); });
$('#pasteCvSharesForm').addEventListener('submit', importPastedCvShares);
$('#closePasteCvShares').addEventListener('click', () => $('#pasteCvSharesDialog').close());
$('#cancelPasteCvShares').addEventListener('click', () => $('#pasteCvSharesDialog').close());
$('#cvShareForm').addEventListener('submit', submitCvShare);
$('#closeCvShareDialog').addEventListener('click', () => $('#cvShareDialog').close());
$('#cancelCvShareDialog').addEventListener('click', () => $('#cvShareDialog').close());
$('#cvShareRows').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-cv-share]'), remove = event.target.closest('[data-delete-cv-share]');
  if (edit) { const share = cvShares.find(item => item.id === edit.dataset.editCvShare); if (share) openCvShareDialog(share); return; }
  if (!remove) return;
  const share = cvShares.find(item => item.id === remove.dataset.deleteCvShare); if (!share || !confirm(`Delete the CV share for ${share.candidateName}?`)) return;
  try { await api(`/ta-cv-shares/${encodeURIComponent(share.id)}`, 'DELETE'); await loadCvShares(); }
  catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
});
$('#cvShareRows').addEventListener('change', event => {
  const box = event.target.closest('[data-cv-share-select]'); if (!box) return;
  if (box.checked) selectedCvShareIds.add(box.dataset.cvShareSelect); else selectedCvShareIds.delete(box.dataset.cvShareSelect);
  renderCvShares();
});
$('#selectAllCvShares').addEventListener('change', event => {
  visibleCvSharePageIds.forEach(id => event.target.checked ? selectedCvShareIds.add(id) : selectedCvShareIds.delete(id));
  renderCvShares();
});
$('#cvSharePrevPage').addEventListener('click', () => { cvSharePage = Math.max(0, cvSharePage - 1); renderCvShares(); });
$('#cvShareNextPage').addEventListener('click', () => { cvSharePage++; renderCvShares(); });
$('#clearCvShareSelection').addEventListener('click', () => { selectedCvShareIds.clear(); renderCvShares(); });
$('#deleteSelectedCvShares').addEventListener('click', async event => {
  const ids = [...selectedCvShareIds]; if (!ids.length || !confirm(`Delete ${ids.length} selected CV share${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await api('/ta-cv-shares/bulk-delete', 'POST', { ids });
    selectedCvShareIds.clear(); await loadCvShares();
    $('#workspaceMessage').textContent = `Deleted ${result.deleted} CV share${result.deleted === 1 ? '' : 's'}.`; $('#workspaceMessage').hidden = false;
  } catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
  finally { button.disabled = false; }
});
$('#importedShareRows').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-imported-share]'), remove = event.target.closest('[data-delete-imported-share]');
  if (edit) { const share = cvShares.find(item => item.id === edit.dataset.editImportedShare); if (share) openCvShareDialog(share); return; }
  if (!remove) return;
  const share = cvShares.find(item => item.id === remove.dataset.deleteImportedShare);
  if (!share || !confirm(`Delete the imported CV share for ${share.candidateName}? This also removes it from CV Shared.`)) return;
  try { await api(`/ta-cv-shares/${encodeURIComponent(share.id)}`, 'DELETE'); await loadCvShares(); }
  catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
});
$('#importedShareRows').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-imported-share-select]'); if (!checkbox) return;
  if (checkbox.checked) selectedImportedShareIds.add(checkbox.dataset.importedShareSelect); else selectedImportedShareIds.delete(checkbox.dataset.importedShareSelect);
  renderImportedShareHistory();
});
$('#selectAllImportedShares').addEventListener('change', event => {
  visibleImportedSharePageIds.forEach(id => event.target.checked ? selectedImportedShareIds.add(id) : selectedImportedShareIds.delete(id));
  renderImportedShareHistory();
});
$('#importedSharePrevPage').addEventListener('click', () => { importedSharePage = Math.max(0, importedSharePage - 1); renderImportedShareHistory(); });
$('#importedShareNextPage').addEventListener('click', () => { importedSharePage++; renderImportedShareHistory(); });
$('#deleteSelectedImportedShares').addEventListener('click', async event => {
  const ids = [...selectedImportedShareIds];
  if (!ids.length || !confirm(`Delete ${ids.length} selected imported CV share row${ids.length === 1 ? '' : 's'} from the live CV Shared tracker? This cannot be undone.`)) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await api('/ta-cv-shares/bulk-delete', 'POST', { ids });
    selectedImportedShareIds.clear(); await loadCvShares();
    $('#workspaceMessage').textContent = `Deleted ${result.deleted} imported CV share row${result.deleted === 1 ? '' : 's'}.`; $('#workspaceMessage').hidden = false;
  } catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
  finally { button.disabled = false; }
});
$('#historyAddRecruiter').addEventListener('click', async () => {
  const name = prompt('Recruiter / TA name');
  if (!name?.trim()) return;
  try { const saved = await saveRecruiterName(name); $('#importedShareRecruiter').value = saved; }
  catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
});
$('#assignImportedShareRecruiter').addEventListener('click', async event => {
  const typed = $('#importedShareRecruiter').value.trim(), ids = [...selectedImportedShareIds];
  if (!typed || !ids.length) { $('#workspaceMessage').textContent = 'Select imported rows and enter a recruiter name.'; $('#workspaceMessage').hidden = false; return; }
  const button = event.currentTarget; button.disabled = true;
  try {
    const recruiter = await saveRecruiterName(typed);
    const result = await api('/ta-cv-shares/bulk-update', 'POST', { ids, recruiter });
    selectedImportedShareIds.clear();
    $('#workspaceMessage').textContent = `Assigned ${recruiter} to ${result.updated} imported CV share row${result.updated === 1 ? '' : 's'}.`; $('#workspaceMessage').hidden = false;
    await loadCvShares();
  } catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
  finally { button.disabled = false; }
});
$('#historicalImportReports').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-import-archive-select]'); if (!checkbox) return;
  if (checkbox.checked) selectedImportArchiveIds.add(checkbox.dataset.importArchiveSelect); else selectedImportArchiveIds.delete(checkbox.dataset.importArchiveSelect);
  loadImportReports();
});
$('#selectAllImportArchives').addEventListener('change', event => {
  importReports.forEach(item => event.target.checked ? selectedImportArchiveIds.add(item.id) : selectedImportArchiveIds.delete(item.id));
  loadImportReports();
});
$('#clearImportArchiveSelection').addEventListener('click', () => { selectedImportArchiveIds.clear(); loadImportReports(); });
$('#historicalImportReports').addEventListener('click', async event => {
  const rename = event.target.closest('[data-edit-import-archive]'), remove = event.target.closest('[data-delete-import-archive]');
  if (rename) {
    const item = importReports.find(report => report.id === rename.dataset.editImportArchive); if (!item) return;
    const sourceName = prompt('Edit archive name', item.sourceName); if (!sourceName?.trim() || sourceName.trim() === item.sourceName) return;
    try { await api(`/ta-imports/${encodeURIComponent(item.id)}`, 'PUT', { sourceName: sourceName.trim() }); await loadImportReports(); }
    catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
    return;
  }
  if (remove) {
    const item = importReports.find(report => report.id === remove.dataset.deleteImportArchive); if (!item || !confirm(`Delete the archived workbook "${item.sourceName}"? Imported tracker rows will remain in their trackers.`)) return;
    try { await api(`/ta-imports/${encodeURIComponent(item.id)}`, 'DELETE'); selectedImportArchiveIds.delete(item.id); await loadImportReports(); }
    catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
  }
});
$('#deleteSelectedImportArchives').addEventListener('click', async () => {
  const ids = [...selectedImportArchiveIds];
  if (!ids.length || !confirm(`Delete ${ids.length} archived workbook${ids.length === 1 ? '' : 's'}? Imported tracker rows will remain.`)) return;
  try { const result = await api('/ta-imports', 'DELETE', { ids }); selectedImportArchiveIds.clear(); await loadImportReports(); $('#workspaceMessage').textContent = `Deleted ${result.deleted} workbook archive${result.deleted === 1 ? '' : 's'}.`; $('#workspaceMessage').hidden = false; }
  catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
});
$('#refreshImportHistory').addEventListener('click', async () => { await Promise.all([loadImportReports(), loadCvShares()]); });
$('#search').addEventListener('input', debounce(render));
$('#stageFilter').addEventListener('change', render);
function persistDateFilters() {
  saveTalentViewState({ month: $('#filterMonth').value, date: $('#filterDate').value, year: $('#filterYear').value, recruiter: $('#recruiterFilter').value, sort: $('#dateSort').value });
}
['filterMonth', 'filterDate', 'filterYear', 'recruiterFilter', 'dateSort'].forEach(id => $(`#${id}`).addEventListener('change', () => { cvSharePage = 0; persistDateFilters(); render(); renderWeekly(); }));
$('#clearDateFilters').addEventListener('click', () => { $('#filterMonth').value = ''; $('#filterDate').value = ''; $('#filterYear').value = ''; $('#recruiterFilter').value = ''; $('#dateSort').value = 'newest'; cvSharePage = 0; persistDateFilters(); render(); renderWeekly(); });
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
const td = value => `<td>${escapeHTML(value || '”?')}</td>`;
const stageSelect = candidate => `<select class="stage-select" data-candidate-stage="${escapeHTML(candidate.id)}" aria-label="Status for ${escapeHTML(candidate.name)}">${STAGES.map(stage => `<option ${candidate.stage === stage ? 'selected' : ''}>${stage}</option>`).join('')}</select>`;
const interviewContact = (interview, candidate) => {
  const details = String(interview.contactDetails || '').trim();
  const supplemental = [interview.email || candidate.email, interview.phone || candidate.phone]
    .map(value => String(value || '').trim()).filter(value => value && !details.toLowerCase().includes(value.toLowerCase()));
  return [details, ...new Set(supplemental)].filter(Boolean).join(' · ');
};
function recruiterIdentity(record, nameField = 'candidateName') {
  const email = String(record.email || '').trim().toLowerCase();
  const phone = String(record.phone || '').replace(/\D/g, '').slice(-10);
  return email ? `email:${email}` : phone ? `phone:${phone}` : `name:${String(record[nameField] || record.name || '').trim().toLowerCase()}|${String(record.role || record.profile || '').trim().toLowerCase()}|${String(record.company || '').trim().toLowerCase()}`;
}
function recruiterSaturdayTarget(date) {
  if (date.getDay() !== 6) return 4;
  const saturdayNumber = Math.ceil(date.getDate() / 7);
  return [2, 4].includes(saturdayNumber) ? 0 : 2;
}
function renderRecruiterWeekly(recruiters) {
  const root = $('#recruiterWeeklyAnalytics');
  if (!root) return;
  if (!recruiters.length) { root.innerHTML = '<p class="empty-state compact">Recruiter weekly totals will appear when recruiter records are available.</p>'; return; }
  const input = $('#recruiterWeekStart');
  if (!input.value) input.value = localDateKey(mondayFor(new Date()));
  const [year, month, day] = input.value.split('-').map(Number);
  const monday = new Date(year, month - 1, day);
  if (Number.isNaN(monday.getTime())) { root.innerHTML = '<p class="empty-state compact">Choose a valid Monday to view weekly recruiter data.</p>'; return; }
  const days = Array.from({ length: 6 }, (_, index) => { const date = new Date(monday); date.setDate(date.getDate() + index); return { date, key: localDateKey(date), target: recruiterSaturdayTarget(date) }; });
  const normalize = value => String(value || '').trim().toLocaleLowerCase();
  const sameRecruiter = (value, name) => normalize(value) === normalize(name);
  const countsFor = recruiter => {
    const metrics = days.map(() => ({ shares: 0, shortlisted: new Set(), interviews: 0, offers: new Set(), joins: new Set(), rejected: new Set() }));
    const periodCandidates = { shortlisted: new Set(), offers: new Set(), joins: new Set(), rejected: new Set() };
    cvShares.forEach(share => {
      const date = cvShareDate(share), index = days.findIndex(item => item.key === date);
      if (index >= 0 && sameRecruiter(share.recruiter, recruiter)) metrics[index].shares++;
    });
    candidates.forEach(candidate => {
      const events = candidateEvents(candidate);
      events.forEach(event => {
        const index = days.findIndex(item => item.key === normalizedDateKey(event.at || event.date));
        if (index < 0 || !sameRecruiter(event.recruiter || candidate.recruiter, recruiter)) return;
        if (event.stage === 'Shortlisted') { metrics[index].shortlisted.add(candidate.id); periodCandidates.shortlisted.add(candidate.id); }
        if (event.stage === 'Offer') { metrics[index].offers.add(candidate.id); periodCandidates.offers.add(candidate.id); }
        if (['Joining', 'Joined'].includes(event.stage)) { metrics[index].joins.add(candidate.id); periodCandidates.joins.add(candidate.id); }
        if (event.stage === 'Rejected') { metrics[index].rejected.add(candidate.id); periodCandidates.rejected.add(candidate.id); }
      });
      const legacy = candidate.interviewDate || candidate.interviewMode || candidate.interviewStatus || candidate.company || candidate.role
        ? [{ date: candidate.interviewDate, recruiter: candidate.recruiter, candidateStatus: candidate.interviewStatus, clientStatus: candidate.clientStatus, finalCall: candidate.finalCall }]
        : [];
      (candidate.interviews?.length ? candidate.interviews : legacy).forEach(interview => {
        const index = days.findIndex(item => item.key === normalizedDateKey(interview.date || candidate.interviewDate));
        if (index < 0 || !sameRecruiter(interview.recruiter || candidate.recruiter, recruiter)) return;
        if (days[index].key <= localDateKey(new Date())) metrics[index].interviews++;
      });
    });
    return metrics.map((item, index) => ({ ...item, shortlisted: item.shortlisted.size, offers: item.offers.size, joins: item.joins.size, rejected: item.rejected.size, target: days[index].target, periodCandidates }));
  };
  const labels = [['CV profiles shared', 'shares'], ['Candidates shortlisted', 'shortlisted'], ['Interviews conducted', 'interviews'], ['Offers / closures', 'offers'], ['Candidates joined', 'joins'], ['Candidates rejected', 'rejected']];
  const totals = values => Object.fromEntries(labels.map(([, key]) => [key, values.reduce((sum, item) => sum + item[key], 0)]));
  root.innerHTML = recruiters.map(recruiter => {
    const values = countsFor(recruiter.name), total = totals(values), weeklyTarget = values.reduce((sum, item) => sum + item.target, 0);
    for (const key of ['shortlisted', 'offers', 'joins', 'rejected']) total[key] = values[0]?.periodCandidates[key].size || 0;
    const rows = labels.map(([label, key]) => {
      const cells = values.map((item, index) => {
        if (key !== 'shares') return `<td>${item[key]}</td>`;
        const target = item.target;
        const state = target === 0 ? 'off' : item.shares >= target ? 'met' : '';
        return `<td><strong class="recruiter-day-count ${state}">${item.shares}</strong><small>${target ? `of ${target}` : 'Off'}</small></td>`;
      }).join('');
      const totalTarget = key === 'shares' ? `<strong class="recruiter-week-target">${total.shares} / ${weeklyTarget}</strong>` : `<strong>${total[key]}</strong>`;
      return `<tr><th scope="row">${label}</th>${cells}<td class="recruiter-week-total">${totalTarget}</td></tr>`;
    }).join('');
    const columns = days.map(item => `<th>${item.date.toLocaleDateString(undefined, { weekday: 'short' })}<small>${item.date.getDate()} ${item.date.toLocaleDateString(undefined, { month: 'short' })}${item.date.getDay() === 6 ? `<br>${item.target ? 'Half day · target 2' : 'Off day'}` : '<br>Target 4 shares'}</small></th>`).join('');
    return `<article class="recruiter-weekly-card"><div class="recruiter-weekly-card-heading"><h4>${escapeHTML(recruiter.name)}</h4><span>Profile share target: ${weeklyTarget} this week</span></div><div class="table-wrap recruiter-weekly-table-wrap"><table class="recruiter-weekly-table"><thead><tr><th>Weekly metric</th>${columns}<th>Week total</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
  }).join('');
}
function renderRecruiterMonthly(recruiters) {
  const root = $('#recruiterMonthlyAnalytics');
  if (!root) return;
  const input = $('#recruiterMonth');
  if (!input.value) input.value = localDateKey(new Date()).slice(0, 7);
  const monthKey = input.value;
  if (!/^\d{4}-\d{2}$/.test(monthKey)) { root.innerHTML = '<p class="empty-state compact">Choose a month to view recruiter activity.</p>'; return; }
  if (!recruiters.length) { root.innerHTML = '<p class="empty-state compact">Monthly recruiter totals will appear when recruiter records are available.</p>'; return; }
  const [year, month] = monthKey.split('-').map(Number);
  const monthDate = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0).getDate();
  const days = Array.from({ length: monthEnd }, (_, index) => {
    const date = new Date(year, month - 1, index + 1);
    return { date, key: localDateKey(date), target: date.getDay() === 6 ? recruiterSaturdayTarget(date) : date.getDay() === 0 ? 0 : 4 };
  });
  const shareTarget = days.reduce((sum, item) => sum + item.target, 0);
  const sameRecruiter = value => String(value || '').trim().toLocaleLowerCase();
  const reportFor = recruiter => {
    const report = { shares: 0, profiles: new Set(), shortlisted: new Set(), interviews: 0, offers: new Set(), joins: new Set(), rejected: new Set() };
    cvShares.forEach(share => {
      const date = normalizedDateKey(cvShareDate(share));
      if (sameRecruiter(share.recruiter) !== sameRecruiter(recruiter.name) || !date.startsWith(`${monthKey}-`)) return;
      report.shares++;
      report.profiles.add(recruiterIdentity(share));
    });
    candidates.forEach(candidate => {
      const events = candidateEvents(candidate);
      events.forEach(event => {
        const date = normalizedDateKey(event.at || event.date);
        if (sameRecruiter(event.recruiter || candidate.recruiter) !== sameRecruiter(recruiter.name) || !date.startsWith(`${monthKey}-`)) return;
        if (event.stage === 'Shortlisted') report.shortlisted.add(candidate.id || candidate.name);
        if (event.stage === 'Offer') report.offers.add(candidate.id || candidate.name);
        if (['Joining', 'Joined'].includes(event.stage)) report.joins.add(candidate.id || candidate.name);
        if (event.stage === 'Rejected') report.rejected.add(candidate.id || candidate.name);
      });
      const legacy = candidate.interviewDate || candidate.interviewMode || candidate.interviewStatus || candidate.company || candidate.role
        ? [{ date: candidate.interviewDate, recruiter: candidate.recruiter, candidateStatus: candidate.interviewStatus, clientStatus: candidate.clientStatus, finalCall: candidate.finalCall }]
        : [];
      (candidate.interviews?.length ? candidate.interviews : legacy).forEach(interview => {
        const date = normalizedDateKey(interview.date || candidate.interviewDate);
        if (sameRecruiter(interview.recruiter || candidate.recruiter) !== sameRecruiter(recruiter.name) || !date.startsWith(`${monthKey}-`)) return;
        const candidateId = candidate.id || candidate.name;
        if (date <= localDateKey(new Date())) report.interviews++;
      });
      if (normalizedDateKey(candidate.sharedDate).startsWith(`${monthKey}-`) && sameRecruiter(candidate.recruiter) === sameRecruiter(recruiter.name)) report.profiles.add(recruiterIdentity(candidate, 'name'));
    });
    report.profiles = report.profiles.size;
    return report;
  };
  const dailyFor = recruiter => {
    const rows = days.map(item => ({ ...item, shares: 0, shortlisted: new Set(), interviews: 0, offers: new Set(), joins: new Set(), rejected: new Set() }));
    cvShares.forEach(share => {
      const index = days.findIndex(item => item.key === normalizedDateKey(cvShareDate(share)));
      if (index >= 0 && sameRecruiter(share.recruiter) === sameRecruiter(recruiter.name)) rows[index].shares++;
    });
    candidates.forEach(candidate => {
      const events = candidateEvents(candidate);
      events.forEach(event => {
        const index = days.findIndex(item => item.key === normalizedDateKey(event.at || event.date));
        if (index < 0 || sameRecruiter(event.recruiter || candidate.recruiter) !== sameRecruiter(recruiter.name)) return;
        const id = candidate.id || candidate.name;
        if (event.stage === 'Shortlisted') rows[index].shortlisted.add(id);
        if (event.stage === 'Offer') rows[index].offers.add(id);
        if (['Joining', 'Joined'].includes(event.stage)) rows[index].joins.add(id);
        if (event.stage === 'Rejected') rows[index].rejected.add(id);
      });
      const legacy = candidate.interviewDate || candidate.interviewMode || candidate.interviewStatus || candidate.company || candidate.role
        ? [{ date: candidate.interviewDate, recruiter: candidate.recruiter, candidateStatus: candidate.interviewStatus, clientStatus: candidate.clientStatus, finalCall: candidate.finalCall }]
        : [];
      (candidate.interviews?.length ? candidate.interviews : legacy).forEach(interview => {
        const index = days.findIndex(item => item.key === normalizedDateKey(interview.date || candidate.interviewDate));
        if (index < 0 || sameRecruiter(interview.recruiter || candidate.recruiter) !== sameRecruiter(recruiter.name)) return;
        if (days[index].key <= localDateKey(new Date())) rows[index].interviews++;
        const id = candidate.id || candidate.name;
      });
    });
    return rows.map(item => ({ ...item, shortlisted: item.shortlisted.size, offers: item.offers.size, joins: item.joins.size, rejected: item.rejected.size }));
  };
  const title = monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  root.innerHTML = recruiters.map(recruiter => {
    const report = reportFor(recruiter), sharePercent = shareTarget ? Math.min(100, Math.round(report.shares / shareTarget * 100)) : 0;
    const daily = dailyFor(recruiter);
    const metrics = [['CV profiles shared', report.shares], ['Unique profiles', report.profiles], ['Shortlisted', report.shortlisted.size], ['Interviews conducted', report.interviews], ['Offers / closures', report.offers.size], ['Candidates joined', report.joins.size], ['Candidates rejected', report.rejected.size]];
    const labels = [['CV profiles shared', 'shares'], ['Candidates shortlisted', 'shortlisted'], ['Interviews conducted', 'interviews'], ['Offers / closures', 'offers'], ['Candidates joined', 'joins'], ['Candidates rejected', 'rejected']];
    const headers = days.map(item => `<th>${item.date.toLocaleDateString(undefined, { weekday: 'short' })}<small>${item.date.getDate()} ${item.date.toLocaleDateString(undefined, { month: 'short' })}${item.date.getDay() === 6 ? `<br>${item.target ? 'Half day · target 2' : 'Off day'}` : item.date.getDay() === 0 ? '<br>Off day' : '<br>Target 4 shares'}</small></th>`).join('');
    const rows = labels.map(([label, key]) => {
      const cells = daily.map(item => key === 'shares'
        ? `<td><strong class="recruiter-day-count ${item.target === 0 ? 'off' : item.shares >= item.target ? 'met' : ''}">${item.shares}</strong><small>${item.target ? `of ${item.target}` : 'Off'}</small></td>`
        : `<td>${item[key]}</td>`).join('');
      const total = key === 'shares' ? report.shares : key === 'interviews' ? report.interviews : report[key].size;
      const totalCell = key === 'shares' ? `<strong class="recruiter-week-target">${total} / ${shareTarget}</strong>` : `<strong>${total}</strong>`;
      return `<tr><th scope="row">${label}</th>${cells}<td class="recruiter-week-total">${totalCell}</td></tr>`;
    }).join('');
    return `<article class="recruiter-weekly-card recruiter-monthly-card"><div class="recruiter-weekly-card-heading"><h4>${escapeHTML(recruiter.name)} · ${escapeHTML(title)}</h4><span>Shares: ${report.shares} / ${shareTarget} monthly target</span></div><div class="recruiter-monthly-progress" role="img" aria-label="${sharePercent}% of monthly share target reached"><i style="width:${sharePercent}%"></i></div><div class="recruiter-monthly-metrics">${metrics.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><div class="table-wrap recruiter-monthly-table-wrap"><table class="recruiter-weekly-table"><thead><tr><th>Monthly metric</th>${headers}<th>Month total</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
  }).join('');
}
function renderRecruiterAnalytics() {
  const people = new Map();
  const ensure = name => {
    const label = String(name || '').trim(); if (!label) return null;
    const key = label.toLocaleLowerCase();
    if (!people.has(key)) people.set(key, { name: label, cvShares: 0, profiles: new Set(), shortlisted: new Set(), interviews: 0, selected: new Set(), rejected: new Set() });
    return people.get(key);
  };
  candidates.forEach(candidate => {
    ensure(candidate.recruiter);
    (candidate.interviews || []).forEach(interview => ensure(interview.recruiter));
  });
  cvShares.forEach(share => ensure(share.recruiter));
  weeklyReports.forEach(report => ensure(report.recruiter));
  recruiterDirectory.forEach(person => ensure(person.name));
  // Use the same complete recruiter option list shown in the workspace filter.
  // This retains valid recruiters whose names also happen to match a candidate.
  [...($('#recruiterFilter')?.options || [])].forEach(option => { if (option.value) ensure(option.value); });
  const stageEvents = candidate => candidateEvents(candidate);
  cvShares.forEach(share => {
    const row = ensure(share.recruiter); if (!row || !dateFilterMatch(cvShareDate(share))) return;
    row.cvShares++;
    row.profiles.add(recruiterIdentity(share));
  });
  candidates.forEach(candidate => {
    const identity = recruiterIdentity(candidate, 'name');
    if (candidate.sharedDate && dateFilterMatch(candidate.sharedDate)) ensure(candidate.recruiter)?.profiles.add(identity);
    const events = stageEvents(candidate);
    for (const event of events) {
      if (!dateFilterMatch(event.at || event.date)) continue;
      const row = ensure(event.recruiter || candidate.recruiter); if (!row) continue;
      if (event.stage === 'Shortlisted') row.shortlisted.add(candidate.id);
      if (['Offer', 'Joining', 'Joined'].includes(event.stage)) row.selected.add(candidate.id);
      if (event.stage === 'Rejected') row.rejected.add(candidate.id);
    }
    const legacyInterview = candidate.interviewDate || candidate.interviewMode || candidate.interviewStatus || candidate.company || candidate.role
      ? [{ date: candidate.interviewDate, recruiter: candidate.recruiter, mode: candidate.interviewMode, candidateStatus: candidate.interviewStatus, clientStatus: candidate.clientStatus }]
      : [];
    const interviewRows = candidate.interviews?.length ? candidate.interviews : legacyInterview;
    interviewRows.forEach(interview => {
      const row = ensure(interview.recruiter || candidate.recruiter);
      const interviewDate = normalizedDateKey(interview.date || candidate.interviewDate);
      if (row && interviewDate && interviewDate <= localDateKey(new Date()) && dateFilterMatch(interviewDate)) row.interviews++;
    });
  });
  const rows = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  const selectedRecruiter = $('#recruiterFilter')?.value || '';
  const visibleRows = selectedRecruiter
    ? rows.filter(row => row.name.toLocaleLowerCase() === selectedRecruiter.toLocaleLowerCase())
    : rows;
  const totals = visibleRows.reduce((sum, row) => ({ cvShares: sum.cvShares + row.cvShares, profiles: sum.profiles + row.profiles.size, shortlisted: sum.shortlisted + row.shortlisted.size, interviews: sum.interviews + row.interviews, selected: sum.selected + row.selected.size, rejected: sum.rejected + row.rejected.size }), { cvShares: 0, profiles: 0, shortlisted: 0, interviews: 0, selected: 0, rejected: 0 });
  const metricCards = [['CVs shared', totals.cvShares], ['Profiles shared', totals.profiles], ['Shortlisted', totals.shortlisted], ['Interviews conducted', totals.interviews], ['Selected / offered', totals.selected], ['Rejected', totals.rejected]];
  $('#recruiterAnalyticsMetrics').innerHTML = metricCards.map(([label, value]) => `<article class="recruiter-analytics-metric"><span>${label}</span><strong>${value}</strong></article>`).join('');
  if (!rows.length || !visibleRows.length) { $('#recruiterAnalytics').innerHTML = `<div class="empty-state compact"><strong>${selectedRecruiter ? 'No activity for this recruiter in the selected period' : 'No recruiter records yet'}</strong><p>${selectedRecruiter ? 'Change the date filters or choose another recruiter.' : 'Assign recruiters to candidates or CV shares to start building recruiter-wise totals.'}</p></div>`; renderRecruiterWeekly(visibleRows); renderRecruiterMonthly(visibleRows); return; }
  const metrics = [['CV shares', 'cvShares'], ['Shortlisted', 'shortlisted'], ['Interviews conducted', 'interviews'], ['Selected', 'selected'], ['Rejected', 'rejected']];
  const maxByMetric = Object.fromEntries(metrics.map(([, key]) => [key, Math.max(1, ...visibleRows.map(row => key === 'shortlisted' || key === 'selected' || key === 'rejected' ? row[key].size : key === 'interviews' ? row.interviews : row.cvShares))]));
  $('#recruiterAnalytics').innerHTML = visibleRows.map(row => {
    const values = { cvShares: row.cvShares, profiles: row.profiles.size, shortlisted: row.shortlisted.size, interviews: row.interviews, selected: row.selected.size, rejected: row.rejected.size };
    const bars = metrics.map(([label, key]) => `<div class="recruiter-analytics-bar"><span>${label}</span><div class="riq-bar"><i style="width:${Math.round(values[key] / maxByMetric[key] * 100)}%"></i></div><strong>${values[key]}</strong></div>`).join('');
    const details = selectedRecruiter && row.name.toLocaleLowerCase() === selectedRecruiter.toLocaleLowerCase() ? renderRecruiterRecordDetails(row.name) : '';
    return `<article class="recruiter-analytics-card"><div class="recruiter-analytics-head"><h3>${escapeHTML(row.name)}</h3><span>${values.profiles} unique profiles shared</span></div><div class="recruiter-analytics-counts"><div><span>CV shares</span><strong>${values.cvShares}</strong></div><div><span>Shortlisted</span><strong>${values.shortlisted}</strong></div><div><span>Interviews</span><strong>${values.interviews}</strong></div><div><span>Selected</span><strong>${values.selected}</strong></div><div><span>Rejected</span><strong>${values.rejected}</strong></div></div><div class="recruiter-analytics-bars">${bars}</div>${details}</article>`;
  }).join('');
  renderRecruiterWeekly(visibleRows);
  renderRecruiterMonthly(visibleRows);
}
function renderRecruiterRecordDetails(name) {
  const matches = value => String(value || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase();
  const shares = cvShares.filter(share => matches(share.recruiter) && dateFilterMatch(cvShareDate(share)));
  const statusRows = candidates.flatMap(candidate => {
    const events = candidateEvents(candidate);
    return events.filter(event => matches(event.recruiter || candidate.recruiter) && dateFilterMatch(event.at || event.date)).map(event => ({ date: event.at || event.date, candidate: candidate.name, company: candidate.company, profile: candidate.role, status: event.stage }));
  }).sort((a, b) => compareDates(a.date, b.date));
  const interviewRows = candidates.flatMap(candidate => {
    const entries = candidate.interviews?.length ? candidate.interviews : (candidate.interviewDate || candidate.interviewStatus ? [{ date: candidate.interviewDate, recruiter: candidate.recruiter, candidateStatus: candidate.interviewStatus, clientStatus: candidate.clientStatus }] : []);
    return entries.filter(interview => matches(interview.recruiter || candidate.recruiter) && dateFilterMatch(interview.date || candidate.interviewDate)).map(interview => ({ date: interview.date || candidate.interviewDate, candidate: candidate.name, company: interview.company || candidate.company, profile: interview.role || candidate.role, status: [interview.candidateStatus, interview.clientStatus, interview.finalCall].filter(Boolean).join(' · ') }));
  }).sort((a, b) => compareDates(a.date, b.date));
  const table = (title, rows, fields) => `<section class="recruiter-detail-group"><h4>${title} <span>${rows.length}</span></h4>${rows.length ? `<div class="table-wrap"><table><thead><tr>${fields.map(([label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${fields.map(([, key]) => `<td>${escapeHTML(key === 'date' ? (row[key] ? displayDate(row[key]) : '”?') : row[key] || '”?')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="recruiter-detail-empty">No matching records in this period.</p>'}</section>`;
  const shareRows = shares.map(share => ({ date: cvShareDate(share), candidate: share.candidateName, company: share.company, profile: share.role || share.designation, status: share.shareStatus }));
  return `<details class="recruiter-record-details"><summary>View all recruiter records</summary>${table('CV shares', shareRows, [['Date', 'date'], ['Candidate', 'candidate'], ['Company', 'company'], ['Profile', 'profile'], ['Share status', 'status']])}${table('Candidate status history', statusRows, [['Date', 'date'], ['Candidate', 'candidate'], ['Company', 'company'], ['Profile', 'profile'], ['Status', 'status']])}${table('Interview records', interviewRows, [['Date', 'date'], ['Candidate', 'candidate'], ['Company', 'company'], ['Profile', 'profile'], ['Outcome', 'status']])}</details>`;
}
function renderTrackers() {
  const interviewQuery = trackerSearch('interviews');
  const interviewRows = candidates.flatMap(c => {
    const entries = c.interviews?.length ? c.interviews : [{ date: c.interviewDate, company: c.company, role: c.role, recruiter: c.recruiter, mode: c.interviewMode, time: c.interviewTime, candidateStatus: c.interviewStatus, clientStatus: c.clientStatus, email: c.email, phone: c.phone, contactDetails: c.contactDetails, remarks: c.remarks || c.feedback }];
    return entries.map(entry => ({ candidate: c, entry }));
  }).filter(({ candidate: c, entry: i }) => dateFilterMatch(candidateDate(c, i)) && recruiterFilterMatches(i.recruiter || c.recruiter) && candidateMatch({ ...c, company: i.company || c.company, role: i.role || c.role, recruiter: i.recruiter || c.recruiter, stage: i.candidateStatus || c.stage, feedback: i.remarks || c.feedback, remarks: i.clientStatus || c.clientStatus }, interviewQuery));
  sortByDate(interviewRows);
  $('#interviewRows').innerHTML = interviewRows.map(({ candidate: c, entry: i }) => `<tr><td><input type="checkbox" data-candidate-select="${escapeHTML(c.id)}" aria-label="Select ${escapeHTML(c.name)}"></td>${td(c.name)}${td(i.recruiter || c.recruiter)}${td(formatInterviewDate(i.date || c.interviewDate))}${td(i.company || c.company)}${td(i.role || c.role)}${td(i.mode || c.interviewMode)}${td(formatInterviewTime(i.time || c.interviewTime))}<td>${stageSelect(c)}<small class="raw-status">${escapeHTML(i.candidateStatus || c.interviewStatus || c.stage || '')}</small></td>${td(i.clientStatus || c.clientStatus)}${td(interviewContact(i, c))}${td(i.remarks || c.remarks || c.feedback)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button><button class="action-button delete" type="button" data-delete-candidate="${escapeHTML(c.id)}">Delete</button></td></tr>`).join('');
  $('#interviewEmpty').hidden = interviewRows.length > 0;
  const offerQuery = trackerSearch('offers');
  const offerCandidates = candidates.filter(c => ['Shortlisted', 'Offer', 'Joining'].includes(c.stage) && dateFilterMatch(offerDate(c)) && candidateMatchesRecruiter(c) && candidateMatch(c, offerQuery));
  offerCandidates.sort((a, b) => compareDates(offerDate(a), offerDate(b)));
  $('#offerRows').innerHTML = offerCandidates.map(c => `<tr><td><input type="checkbox" data-candidate-select="${escapeHTML(c.id)}" aria-label="Select ${escapeHTML(c.name)}"></td>${td(c.recruiter)}${td(c.month || c.doj?.slice(0, 7) || c.createdAt?.slice(0, 7))}${td(c.company)}${td(c.role)}${td(c.name)}<td>${stageSelect(c)}</td>${td(c.finalCall)}${td(c.doj)}${td(c.remarks || c.interviews?.at(-1)?.remarks)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button><button class="action-button delete" type="button" data-delete-candidate="${escapeHTML(c.id)}">Delete</button></td></tr>`).join('');
  $('#offerEmpty').hidden = offerCandidates.length > 0;
  const joinedQuery = trackerSearch('joined');
  const joinedCandidates = candidates.filter(c => ['Joined', 'Joining'].includes(c.stage) && dateFilterMatch(offerDate(c)) && candidateMatchesRecruiter(c) && candidateMatch(c, joinedQuery));
  joinedCandidates.sort((a, b) => compareDates(offerDate(a), offerDate(b)));
  $('#joinedRows').innerHTML = joinedCandidates.map(c => `<tr><td><input type="checkbox" data-candidate-select="${escapeHTML(c.id)}" aria-label="Select ${escapeHTML(c.name)}"></td>${td(c.recruiter)}${td(c.month || c.doj?.slice(0, 7) || c.createdAt?.slice(0, 7))}${td(c.company)}${td(c.role)}${td(c.name)}<td>${stageSelect(c)}</td>${td(c.doj)}${td(c.remarks || c.interviews?.at(-1)?.remarks)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button><button class="action-button delete" type="button" data-delete-candidate="${escapeHTML(c.id)}">Delete</button></td></tr>`).join('');
  $('#joinedEmpty').hidden = joinedCandidates.length > 0;
  renderCvShares();
  renderImportedShareHistory();
  renderWeekly();
  renderRecruiterAnalytics();
  syncSelectionUI();
}
function renderCvShares() {
  if (!$('#cvShareRows')) return;
  const query = trackerSearch('cvshares');
  const fields = ['recruiter', 'shareStatus', 'company', 'role', 'candidateName', 'designation', 'location', 'workLocation', 'experience', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod', 'remarks', 'phone', 'email'];
  const rows = cvShares.filter(share => dateFilterMatch(cvShareDate(share)) && recruiterFilterMatches(share.recruiter) && fields.some(field => String(share[field] || '').toLowerCase().includes(query)));
  rows.sort((a, b) => compareDates(cvShareDate(a), cvShareDate(b)));
  const pageSize = 200, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  cvSharePage = Math.min(cvSharePage, pageCount - 1);
  const pageRows = rows.slice(cvSharePage * pageSize, (cvSharePage + 1) * pageSize);
  visibleCvSharePageIds = pageRows.map(share => share.id);
  const dateCounts = new Map();
  rows.forEach(share => { const date = cvShareDate(share); dateCounts.set(date, (dateCounts.get(date) || 0) + 1); });
  const cell = value => `<td>${escapeHTML(value || '”?')}</td>`;
  let lastDate = null;
  $('#cvShareRows').innerHTML = pageRows.map(share => {
    const date = cvShareDate(share), band = date !== lastDate ? `<tr class="date-band"><th colspan="19">${escapeHTML(date ? displayDate(`${date}T12:00:00`) : 'Date not set')} <span>${dateCounts.get(date)} CV shares</span></th></tr>` : '';
    lastDate = date;
    return `${band}<tr><td><input type="checkbox" data-cv-share-select="${escapeHTML(share.id)}" aria-label="Select CV share for ${escapeHTML(share.candidateName)}" ${selectedCvShareIds.has(share.id) ? 'checked' : ''}></td>${cell(share.sharedAt)}${cell(share.recruiter)}${cell(share.shareStatus)}${cell(share.company)}${cell(share.role)}${cell(share.candidateName)}${cell(share.designation)}${cell(share.location)}${cell(share.workLocation)}${cell(share.experience)}${cell(share.currentCompany)}${cell(share.currentCtc)}${cell(share.expectedCtc)}${cell(share.noticePeriod)}${cell(share.remarks)}${cell(share.phone)}${cell(share.email)}<td><button class="action-button" type="button" data-edit-cv-share="${escapeHTML(share.id)}">Edit</button><button class="action-button delete" type="button" data-delete-cv-share="${escapeHTML(share.id)}">Delete</button></td></tr>`;
  }).join('');
  $('#cvShareEmpty').hidden = rows.length > 0;
  const selectedVisible = pageRows.filter(share => selectedCvShareIds.has(share.id)).length;
  $('#selectAllCvShares').checked = pageRows.length > 0 && selectedVisible === pageRows.length;
  $('#selectAllCvShares').indeterminate = selectedVisible > 0 && selectedVisible < pageRows.length;
  $('#selectedCvShareCount').textContent = selectedCvShareIds.size;
  $('#cvShareBulkActions').hidden = selectedCvShareIds.size === 0;
  $('#selectAllCvShares').disabled = pageRows.length === 0;
  $('#cvSharePagination').hidden = rows.length <= pageSize;
  $('#cvSharePageSummary').textContent = `${rows.length ? cvSharePage * pageSize + 1 : 0}–${Math.min((cvSharePage + 1) * pageSize, rows.length)} of ${rows.length}`;
  $('#cvSharePrevPage').disabled = cvSharePage === 0;
  $('#cvShareNextPage').disabled = cvSharePage >= pageCount - 1;
}
async function loadCvShares() {
  try { cvShares = await api('/ta-cv-shares'); renderRecruiterOptions(); const ids = new Set(cvShares.map(share => share.id)); for (const id of selectedCvShareIds) if (!ids.has(id)) selectedCvShareIds.delete(id); for (const id of selectedImportedShareIds) if (!ids.has(id)) selectedImportedShareIds.delete(id); populateYearFilters(); render(); renderWeekly(); }
  catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
}
function renderImportedShareHistory() {
  const root = $('#importedShareRows');
  if (!root) return;
  const query = trackerSearch('importedshares'), fields = ['recruiter', 'company', 'role', 'candidateName', 'location', 'workLocation', 'experience', 'shareStatus', 'email', 'phone'];
  const rows = cvShares.filter(share => share.imported && dateFilterMatch(cvShareDate(share)) && recruiterFilterMatches(share.recruiter) && fields.some(field => String(share[field] || '').toLocaleLowerCase().includes(query)));
  rows.sort((a, b) => compareDates(cvShareDate(a), cvShareDate(b)));
  const pageSize = 200, pages = Math.max(1, Math.ceil(rows.length / pageSize));
  importedSharePage = Math.min(importedSharePage, pages - 1);
  const pageRows = rows.slice(importedSharePage * pageSize, (importedSharePage + 1) * pageSize);
  visibleImportedSharePageIds = pageRows.map(share => share.id);
  root.innerHTML = pageRows.map(share => `<tr><td><input type="checkbox" data-imported-share-select="${escapeHTML(share.id)}" aria-label="Select imported CV share for ${escapeHTML(share.candidateName)}" ${selectedImportedShareIds.has(share.id) ? 'checked' : ''}></td><td>${escapeHTML(share.sharedAt || '-')}</td><td>${escapeHTML(share.recruiter || '-')}</td><td>${escapeHTML(share.company || '-')}</td><td>${escapeHTML(share.role || share.designation || '-')}</td><td>${escapeHTML(share.candidateName || '-')}</td><td>${escapeHTML(share.location || share.workLocation || '-')}</td><td>${escapeHTML(share.experience || '-')}</td><td>${escapeHTML(share.shareStatus || '-')}</td><td><div class="row-actions"><button class="action-button" type="button" data-edit-imported-share="${escapeHTML(share.id)}">Edit</button><button class="action-button delete" type="button" data-delete-imported-share="${escapeHTML(share.id)}">Delete</button></div></td></tr>`).join('');
  $('#importedShareRecordCount').textContent = `${rows.length} imported CV share row${rows.length === 1 ? '' : 's'}`;
  $('#importedShareEmpty').hidden = rows.length > 0;
  const selectedVisible = pageRows.filter(share => selectedImportedShareIds.has(share.id)).length;
  $('#selectAllImportedShares').checked = pageRows.length > 0 && selectedVisible === pageRows.length;
  $('#selectAllImportedShares').indeterminate = selectedVisible > 0 && selectedVisible < pageRows.length;
  $('#selectAllImportedShares').disabled = pageRows.length === 0;
  $('#selectedImportedShareCount').textContent = selectedImportedShareIds.size;
  $('#importedShareBulkActions').hidden = selectedImportedShareIds.size === 0;
  $('#importedSharePagination').hidden = rows.length <= pageSize;
  $('#importedSharePageSummary').textContent = `${rows.length ? importedSharePage * pageSize + 1 : 0} - ${Math.min((importedSharePage + 1) * pageSize, rows.length)} of ${rows.length}`;
  $('#importedSharePrevPage').disabled = importedSharePage === 0;
  $('#importedShareNextPage').disabled = importedSharePage >= pages - 1;
}
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function mondayFor(date) { const result = new Date(date.getFullYear(), date.getMonth(), date.getDate()); result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); return result; }
function selectedWeekDays() { const [year, month, day] = $('#weekStart').value.split('-').map(Number); const monday = new Date(year, month - 1, day); return TA_DAYS.map((_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return localDateKey(d); }); }
function candidateEvents(candidate) {
  const events = (candidate.statusHistory || []).map(event => ({ ...event, recruiter: event.recruiter || candidate.recruiter }));
  // Imported tracker workbooks often keep outcomes on interview rows instead
  // of candidate statusHistory. Turn those outcomes into dated funnel events
  // so analytics reflects the source records as well.
  for (const interview of candidate.interviews || []) {
    const outcome = [interview.candidateStatus, interview.clientStatus, interview.finalCall]
      .map(value => String(value || '').trim()).filter(Boolean);
    const text = outcome.join(' ').toLocaleLowerCase();
    const stage = /reject|declin|not selected|not shortlisted|not joined/.test(text) ? 'Rejected'
      : /join|hired/.test(text) ? 'Joined'
      : /offer|offered|selected/.test(text) ? 'Offer'
      : /short.?list/.test(text) ? 'Shortlisted' : '';
    const stageDate = stage === 'Shortlisted' ? interview.shortlistedDate
      : stage === 'Offer' ? interview.offeredDate
      : stage === 'Joined' ? interview.doj
      : interview.rejectedDate;
    const date = normalizedDateKey(stageDate || interview.date);
    if (stage && date && !events.some(event => event.stage === stage && normalizedDateKey(event.at || event.date) === date)) {
      events.push({ stage, at: `${date}T12:00:00`, recruiter: interview.recruiter || candidate.recruiter });
    }
  }
  const datedStages = [
    { stage: 'Shortlisted', date: candidate.shortlistedDate },
    { stage: 'Offer', date: candidate.offeredDate },
    { stage: candidate.stage === 'Joined' ? 'Joined' : 'Joining', date: candidate.doj },
    { stage: 'Rejected', date: candidate.rejectedDate }
  ];
  for (const item of datedStages) {
    const date = normalizedDateKey(item.date);
    if (date && !events.some(event => event.stage === item.stage && normalizedDateKey(event.at || event.date) === date)) events.push({ stage: item.stage, at: `${date}T12:00:00`, recruiter: candidate.recruiter });
  }
  // Older records can have a current pipeline stage without a matching
  // statusHistory entry or stage-specific date. Count that current stage in
  // recruiter analytics using the record's last update (or creation) date.
  const currentStage = String(candidate.stage || '').trim();
  const currentStageDate = normalizedDateKey(candidate.updatedAt || candidate.createdAt);
  if (['Shortlisted', 'Offer', 'Joining', 'Joined', 'Rejected'].includes(currentStage)
      && currentStageDate
      && !events.some(event => event.stage === currentStage)) {
    events.push({ stage: currentStage, at: `${currentStageDate}T12:00:00`, recruiter: candidate.recruiter });
  }
  return events;
}
function metricCandidates(recruiter, metric, dateKey) {
  const matchesRecruiter = value => String(value || '').toLowerCase() === recruiter.toLowerCase();
  if (metric === TA_METRICS[0]) return cvShares.filter(share => matchesRecruiter(share.recruiter) && normalizedDateKey(share.sharedAt) === dateKey);
  const stages = metric === TA_METRICS[1] ? ['Shortlisted'] : metric === TA_METRICS[2] ? ['Offer'] : ['Joining', 'Joined'];
  return candidates.filter(candidate => {
    const eventMatch = candidateEvents(candidate).some(event => matchesRecruiter(event.recruiter || candidate.recruiter) && stages.includes(event.stage) && normalizedDateKey(event.at || event.date) === dateKey);
    if (eventMatch) return true;
    const datedStages = [
      { stage: 'Shortlisted', date: candidate.shortlistedDate },
      { stage: 'Offer', date: candidate.offeredDate },
      { stage: 'Joining', date: candidate.doj }
    ];
    if (matchesRecruiter(candidate.recruiter) && datedStages.some(item => stages.includes(item.stage) && normalizedDateKey(item.date) === dateKey)) return true;
    return false;
  });
}
function renderWeekly() {
  if (!$('#weeklyRows')) return;
  const recruiters = new Map();
  candidates.forEach(c => [c.recruiter, ...(c.interviews || []).map(i => i.recruiter)].filter(Boolean).forEach(name => { if (name.trim()) recruiters.set(name.toLowerCase(), name.trim()); }));
  cvShares.forEach(share => { if (share.recruiter?.trim()) recruiters.set(share.recruiter.toLowerCase(), share.recruiter.trim()); });
  weeklyReports.forEach(r => recruiters.set(r.recruiter.toLowerCase(), r.recruiter));
  recruiterDirectory.forEach(person => recruiters.set(person.name.toLocaleLowerCase(), person.name));
  const days = selectedWeekDays();
  const selected = $('#recruiterFilter')?.value || '';
  $('#weeklyRows').innerHTML = [...recruiters.values()].filter(name => !selected || name.toLocaleLowerCase() === selected.toLocaleLowerCase()).sort((a, b) => a.localeCompare(b)).map(recruiter => {
    const report = weeklyReports.find(r => r.recruiter.toLowerCase() === recruiter.toLowerCase());
    const metricRows = TA_METRICS.map(metric => `<tr><th scope="row">${escapeHTML(metric)}</th>${days.map((dayKey, index) => {
      const day = TA_DAYS[index], people = dateFilterMatch(dayKey) ? metricCandidates(recruiter, metric, dayKey) : [];
      const cell = report?.manual?.[metric]?.[day] || {};
      const target = metric === TA_METRICS[0] ? (cell.target ?? 4) : (cell.target ?? '');
      const result = metric === TA_METRICS[3] ? people.map(c => c.name).join(', ') || '”?' : String(people.length);
      const ratio = metric === TA_METRICS[0] ? `${Math.round(people.length / 4 * 100)}%` : '';
      const achievement = Number(cell.achievement) || 0;
      const met = achievement >= (Number(target) || 0);
      const achievementLabel = metric === TA_METRICS[0] ? `${achievement} of 4 · ${met ? 'Target met' : `${Math.round(achievement / 4 * 100)}% of target`}` : String(cell.achievement ?? '');
      return `<td class="week-cell"><div class="week-result${people.length ? ' has-result' : ''}" title="${metric === TA_METRICS[0] ? 'Result for the day, from CV Shared records for this recruiter and date' : 'Result for the day, from candidate records'}"><span class="result-value">${escapeHTML(result)}</span>${ratio ? `<span class="result-ratio">${escapeHTML(ratio)} of target</span>` : ''}</div><label>Achievement<input type="number" min="0" max="100000" step="1" data-recruiter="${escapeHTML(recruiter)}" data-metric="${escapeHTML(metric)}" data-day="${day}" data-field="achievement" value="${escapeHTML(cell.achievement ?? '')}"></label><small class="achievement-note${achievement ? ' met' : ''}">${escapeHTML(achievementLabel || 'Result is automatic; achievement is entered manually.')}</small></td>`;
    }).join('')}</tr>`).join('');
    return `<section class="recruiter-week"><div class="recruiter-week-heading"><h3>${escapeHTML(recruiter)}</h3><button class="primary-button" type="button" data-save-weekly-recruiter="${escapeHTML(recruiter)}">Save this recruiter</button></div><div class="table-wrap"><table class="weekly-table"><thead><tr><th>Metric</th>${TA_DAYS.map((day, i) => `<th>${day}<small>${days[i].slice(5)}</small></th>`).join('')}</tr></thead><tbody>${metricRows}</tbody></table></div></section>`;
  }).join('') || '<div class="empty-state compact"><strong>No recruiters yet</strong><p>Add a recruiter or assign candidates to a recruiter in their profile.</p></div>';
  renderRecruiterAnalytics();
}
async function loadWeekly() {
  try { weeklyReports = await api(`/ta-weekly?week=${encodeURIComponent($('#weekStart').value)}`); renderWeekly(); }
  catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; }
}
async function saveWeekly(onlyRecruiter = '') {
  const inputs = [...document.querySelectorAll('#weeklyRows input[data-field]')].filter(input => !onlyRecruiter || input.dataset.recruiter === onlyRecruiter);
  const recruiters = onlyRecruiter ? [onlyRecruiter] : [...new Set(inputs.map(input => input.dataset.recruiter))];
  try {
    for (const recruiter of recruiters) {
      const manual = Object.fromEntries(TA_METRICS.map(metric => [metric, Object.fromEntries(TA_DAYS.map(day => [day, {}]))]));
      for (const input of inputs.filter(input => input.dataset.recruiter === recruiter)) manual[input.dataset.metric][input.dataset.day][input.dataset.field] = input.value;
      const saved = await api('/ta-weekly', 'PUT', { weekStart: $('#weekStart').value, recruiter, manual });
      const index = weeklyReports.findIndex(row => row.recruiter.toLowerCase() === recruiter.toLowerCase());
      if (index < 0) weeklyReports.push(saved); else weeklyReports[index] = saved;
    }
    weeklyEntriesDirty = false; $('#weeklyMessage').textContent = onlyRecruiter ? `Weekly achievements saved for ${onlyRecruiter}.` : 'All weekly achievements saved.'; $('#weeklyMessage').hidden = false; renderWeekly();
  } catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; }
}
function addCandidate() { openDialog(); }
function exportExcel() { location.href = `/api/ta-export.xlsx?week=${encodeURIComponent($('#weekStart').value)}`; }
function openCvShareDialog(share) {
  const form = $('#cvShareForm'); form.reset(); $('#cvShareFormError').textContent = '';
  form.elements.id.value = share?.id || '';
  $('#cvShareDialogTitle').textContent = share ? 'Edit CV share' : 'Add CV share';
  $('#saveCvShare').textContent = share ? 'Save changes' : 'Save CV share';
  if (share) for (const field of ['sharedAt', 'recruiter', 'shareStatus', 'company', 'role', 'candidateName', 'designation', 'location', 'workLocation', 'experience', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod', 'remarks', 'phone', 'email']) form.elements[field].value = share[field] || '';
  else form.elements.sharedAt.value = localDateKey(new Date());
  $('#cvShareDialog').showModal();
  form.elements.candidateName.focus();
}
async function submitCvShare(event) {
  event.preventDefault();
  const form = $('#cvShareForm'), values = Object.fromEntries(new FormData(form).entries()), id = values.id;
  delete values.id;
  const button = $('#saveCvShare'); button.disabled = true;
  try {
    values.recruiter = await saveRecruiterName(values.recruiter);
    await api(id ? `/ta-cv-shares/${encodeURIComponent(id)}` : '/ta-cv-shares', id ? 'PUT' : 'POST', values);
    $('#cvShareDialog').close(); await loadCvShares();
    $('#workspaceMessage').textContent = id ? 'CV share updated.' : 'CV share saved.'; $('#workspaceMessage').hidden = false;
  } catch (error) { $('#cvShareFormError').textContent = error.message; }
  finally { button.disabled = false; }
}
function pastedShareDate(value) {
  const input = String(value || '').replace(/[\u200B\uFEFF]/g, '').trim();
  if (!input || /^[-–”?n/a]+$/i.test(input)) return '';
  if (/^\d{4,6}(?:\.\d+)?$/.test(input)) {
    const serial = Number(input);
    if (serial >= 20000 && serial <= 100000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    }
  }
  let match = input.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = input.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (match) { let [, day, month, year] = match; if (Number(day) <= 12 && Number(month) > 12) [day, month] = [month, day]; if (Number(year) < 100) year = String(Number(year) < 50 ? 2000 + Number(year) : 1900 + Number(year)); return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`; }
  match = input.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s/.-]+([a-z]{3,9})[,.\s/-]+(\d{4})$/i);
  if (match) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const month = months[match[2].slice(0, 3).toLowerCase()], day = Number(match[1]), year = Number(match[3]);
    if (month) { const date = new Date(Date.UTC(year, month - 1, day)); if (year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
  }
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? '' : localDateKey(new Date(parsed));
}
function pastedShareEmail(value) {
  const text = String(value || '').trim().replace(/^email\s*:\s*/i, '').trim();
  const address = text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i);
  return address ? address[0] : text;
}
function inferCvPasteOffset(row, dateIndex, emailIndex) {
  let bestOffset = 0, bestScore = 0;
  for (let offset = -2; offset <= 2; offset++) {
    let score = 0;
    if (pastedShareDate(row[dateIndex + offset])) score += 2;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pastedShareEmail(row[emailIndex + offset]))) score += 2;
    if (score > bestScore || (score === bestScore && score > 0 && Math.abs(offset) < Math.abs(bestOffset))) {
      bestScore = score; bestOffset = offset;
    }
  }
  return bestOffset;
}
function parsePastedCvShares(input) {
  const sourceRows = String(input || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.split('\t').map(value => value.trim()));
  const fields = ['sharedAt', 'recruiter', 'shareStatus', 'company', 'role', 'candidateName', 'designation', 'location', 'workLocation', 'experience', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod', 'remarks', 'phone', 'email'];
  const headerAliases = {
    sharedAt: ['date', 'share date', 'shared date'], recruiter: ['recruiter', 'recruiter name', 'ta name'],
    shareStatus: ['share status', 'share status time', 'status time', 'status'], company: ['company', 'client'],
    role: ['profile', 'role', 'position'], candidateName: ['candidate', 'candidate name'], designation: ['designation', 'title'],
    location: ['location'], workLocation: ['work location'], experience: ['experience', 'total experience'],
    currentCompany: ['current company'], currentCtc: ['current ctc'], expectedCtc: ['expected ctc'],
    noticePeriod: ['notice period'], remarks: ['remarks', 'remark', 'comments'], phone: ['phone', 'mobile', 'contact'], email: ['email', 'email id']
  };
  const output = []; let currentDate = '', columnMap = null;
  for (let index = 0; index < sourceRows.length; index++) {
    let row = sourceRows[index];
    if (!row.some(Boolean)) continue;
    const normalized = row.map(normalizeHeader);
    if (normalized.some(value => ['candidate', 'candidate name'].includes(value)) && normalized.some(value => headerAliases.recruiter.includes(value))) {
      columnMap = Object.fromEntries(fields.map(field => [field, normalized.findIndex(value => headerAliases[field].includes(value))]));
      const missing = fields.filter(field => columnMap[field] < 0);
      if (missing.length) return { rows: [], error: `The header row is missing these CV Shared columns: ${missing.join(', ')}.` };
      continue;
    }
    if (!columnMap && row[0] && row.slice(1).every(value => !value)) {
      const date = pastedShareDate(row[0]);
      if (date) { currentDate = date; continue; }
    }
    let leadingOffset = 0;
    // Some copied Excel ranges include one empty cell before the selected data.
    // Only discard it when the next cell is clearly the date column.
    if (!columnMap && row[0] === '' && pastedShareDate(row[1]) && row.length >= 17) leadingOffset = 1;
    if (leadingOffset) row = row.slice(leadingOffset);
    if (columnMap) {
      const dataOffset = inferCvPasteOffset(row, columnMap.sharedAt, columnMap.email);
      const record = Object.fromEntries(fields.map(field => [field, row[columnMap[field] + dataOffset] || '']));
      if (!record.candidateName) continue;
      record.sharedAt = pastedShareDate(record.sharedAt) || '';
      output.push(record);
      continue;
    }
    // Rows with a date in the first cell use all 17 expected columns. A date
    // band followed by the older 16-column layout remains supported as well.
    if (row.length > fields.length && row.slice(fields.length).every(value => !value)) row = row.slice(0, fields.length);
    if (row.length < 16 || row.length > fields.length) return { rows: [], error: `Row ${index + 1} must contain the 17 CV Shared columns in the expected order.` };
    const hasDateColumn = row.length === fields.length || Boolean(pastedShareDate(row[0]));
    while (row.length < fields.length) row.push('');
    const values = hasDateColumn ? row : [currentDate, ...row.slice(0, 16)];
    const record = Object.fromEntries(fields.map((field, fieldIndex) => [field, values[fieldIndex] || '']));
    if (!record.candidateName) continue;
    record.sharedAt = pastedShareDate(record.sharedAt) || '';
    output.push(record);
  }
  return { rows: output, error: '' };
}
async function importPastedCvShares(event) {
  event.preventDefault();
  const textarea = $('#pasteCvSharesText'), button = $('#submitPasteCvShares'), errorBox = $('#pasteCvSharesError');
  errorBox.textContent = '';
  const parsed = parsePastedCvShares(textarea.value);
  if (parsed.error) { errorBox.textContent = parsed.error; return; }
  const rows = parsed.rows;
  if (!rows.length) { errorBox.textContent = 'No CV share rows found. Copy rows in the CV Shared worksheet layout, including the Candidate column.'; return; }
  if (rows.length > 10000) { errorBox.textContent = 'Paste up to 10,000 rows at a time.'; return; }
  button.disabled = true; button.textContent = `Importing ${rows.length} rows…`;
  try {
    const result = await api('/ta-cv-shares/import', 'POST', { rows });
    $('#pasteCvSharesDialog').close(); textarea.value = '';
    await loadCvShares(); await loadRecruiters();
    $('#workspaceMessage').textContent = `Paste import complete: ${result.imported} imported, ${result.repaired || 0} corrected, ${result.removedHeaders || 0} shifted header rows removed, ${result.duplicates} duplicates skipped, ${result.blank} blank rows skipped.`;
    $('#workspaceMessage').hidden = false;
  } catch (error) { errorBox.textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Import pasted rows'; }
}
let importWorkbook = null, importFile = null, importFileBase64 = '', importSheets = [], activeImportSheet = '';
const normalizeHeader = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function worksheetType(name) {
  const value = normalizeHeader(name);
  if (value.includes('cv') && value.includes('shared')) return 'CV sharing';
  if (value.includes('interview')) return 'Interview tracker';
  if (value.includes('shortlist') || value.includes('offer')) return 'Shortlisted / offered';
  if (value.includes('weekly')) return 'Weekly summary';
  if (value.includes('fint') || value.includes('sol')) return 'Candidate sourcing';
  return 'Historical worksheet';
}
function worksheetHeader(grid, kind) {
  const aliases = kind === 'Interview tracker'
    ? [['candidate', 'candidate name', 'name'], ['recruiter', 'recruiter name', 'ta name']]
    : kind === 'Shortlisted / offered'
    ? [['ta name', 'recruiter'], ['candidate']]
    : kind === 'Candidate sourcing' ? [['candidate name', 'candidate'], ['skill', 'profile']] : [];
  let best = -1, score = 0;
  grid.slice(0, 30).forEach((row, index) => {
    const values = row.map(normalizeHeader), found = aliases.reduce((n, group) => n + Number(values.some(value => group.includes(value))), 0);
    if (found > score) { best = index; score = found; }
  });
  return best;
}
function previewInterviewRows(grid) {
  const aliases = {
    candidate: ['candidate', 'candidate name', 'name'], recruiter: ['recruiter', 'recruiter name', 'ta name'],
    date: ['interview date', 'date'], company: ['company', 'client'], profile: ['profile', 'role', 'position'],
    mode: ['mode', 'interview mode', 'interview type', 'type'], time: ['time', 'interview time'],
    candidateStatus: ['candidate status', 'candidate interview status', 'interview status', 'status'],
    clientStatus: ['client status', 'company status', 'client feedback'],
    contact: ['contact details', 'contact'], email: ['email', 'email id'], phone: ['phone', 'mobile', 'phone number'],
    remarks: ['remarks', 'remark', 'feedback', 'comments']
  };
  const headerIndex = grid.findIndex(row => {
    const values = row.map(normalizeHeader);
    return aliases.candidate.some(alias => values.includes(alias)) && aliases.recruiter.some(alias => values.includes(alias));
  });
  const find = (headers, field) => headers.findIndex(value => aliases[field].includes(value));
  const headers = headerIndex >= 0 ? grid[headerIndex].map(normalizeHeader) : [];
  const columns = headerIndex >= 0 ? {
    candidate: find(headers, 'candidate'), recruiter: find(headers, 'recruiter'), date: find(headers, 'date'),
    company: find(headers, 'company'), profile: find(headers, 'profile'), mode: find(headers, 'mode'), time: find(headers, 'time'),
    candidateStatus: find(headers, 'candidateStatus'), clientStatus: find(headers, 'clientStatus'),
    contact: find(headers, 'contact'), email: find(headers, 'email'), phone: find(headers, 'phone')
  } : { candidate: 0, recruiter: 1, date: 2, company: 3, profile: 4, mode: 5, time: 6, candidateStatus: 7, clientStatus: 8, contact: 9, email: -1, phone: -1 };
  const remarksColumns = headerIndex < 0 ? [10] : headers.map((value, index) => aliases.remarks.includes(value) ? index : -1).filter(index => index >= 0);
  const rows = [];
  (headerIndex >= 0 ? grid.slice(headerIndex + 1) : grid).forEach((source, index) => {
    const get = field => columns[field] < 0 ? '' : String(source[columns[field]] ?? '').trim();
    const candidate = get('candidate');
    if (!candidate || normalizeHeader(candidate).includes('candidate')) return;
    const date = get('date');
    const contactDetails = get('contact') || [get('email'), get('phone')].filter(Boolean).join(' · ');
    const remarks = [...new Set(remarksColumns.map(column => String(source[column] ?? '').trim()).filter(Boolean))].join('\n');
    rows.push({ excelRow: headerIndex >= 0 ? headerIndex + index + 2 : index + 1, candidate, recruiter: get('recruiter'), date: date ? pastedShareDate(date) || date : '', company: get('company'), profile: get('profile'), mode: get('mode'), time: formatInterviewTime(get('time')), candidateStatus: get('candidateStatus'), clientStatus: get('clientStatus'), contactDetails, remarks });
  });
  return { rows, headerIndex };
}
function sheetGrid(sheet) {
  const originalRef = sheet['!ref']; let minRow = Infinity, minCol = Infinity, maxRow = -1, maxCol = -1;
  for (const address of Object.keys(sheet)) {
    if (address[0] === '!' || !/^[A-Z]{1,3}\d+$/.test(address)) continue;
    const cell = sheet[address]; if (!cell || (cell.v === undefined && !cell.f)) continue;
    const point = XLSX.utils.decode_cell(address); minRow = Math.min(minRow, point.r); minCol = Math.min(minCol, point.c); maxRow = Math.max(maxRow, point.r); maxCol = Math.max(maxCol, point.c);
  }
  if (maxRow >= 0) sheet['!ref'] = XLSX.utils.encode_range({ s: { r: minRow, c: minCol }, e: { r: maxRow, c: maxCol } });
  let grid;
  try { grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true }); }
  finally { sheet['!ref'] = originalRef; }
  for (const merge of sheet['!merges'] || []) {
    const value = grid[merge.s.r]?.[merge.s.c];
    if (value === undefined || value === '') continue;
    for (let r = merge.s.r; r <= Math.min(merge.e.r, merge.s.r + 30); r++) {
      grid[r] ||= [];
      for (let c = merge.s.c; c <= Math.min(merge.e.c, merge.s.c + 30); c++) if (grid[r][c] === '' || grid[r][c] === undefined) grid[r][c] = value;
    }
  }
  return grid;
}
function previewCvSharedRows(grid) {
  const fields = ['sharedAt', 'recruiter', 'shareStatus', 'company', 'role', 'candidateName', 'designation', 'location', 'workLocation', 'experience', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod', 'remarks', 'phone', 'email'];
  const aliases = {
    sharedAt: ['date', 'share date', 'shared date'], recruiter: ['recruiter', 'recruiter name', 'ta name'],
    shareStatus: ['share status', 'share status time', 'status time', 'status'], company: ['company', 'client'],
    role: ['profile', 'role', 'position'], candidateName: ['candidate', 'candidate name'], designation: ['designation', 'title'],
    location: ['location'], workLocation: ['work location'], experience: ['experience', 'total experience'],
    currentCompany: ['current company'], currentCtc: ['current ctc'], expectedCtc: ['expected ctc'],
    noticePeriod: ['notice period'], remarks: ['remarks', 'remark', 'comments'], phone: ['phone', 'mobile', 'contact'], email: ['email', 'email id']
  };
  const headerIndex = grid.findIndex((row, index) => index < 30 && ['sharedAt', 'recruiter', 'candidateName'].every(field => row.map(normalizeHeader).some(value => aliases[field].includes(value))));
  if (headerIndex < 0) return { rows: [], error: 'Could not find a CV Shared header with Date, Recruiter, and Candidate columns.' };
  const headers = grid[headerIndex].map(normalizeHeader);
  const columns = Object.fromEntries(fields.map(field => [field, headers.findIndex(value => aliases[field].includes(value))]));
  const missing = fields.filter(field => columns[field] < 0);
  if (missing.length) return { rows: [], error: `The header row is missing: ${missing.join(', ')}.` };
  if (new Set(fields.map(field => columns[field])).size !== fields.length) return { rows: [], error: 'The header row must map each of the 17 CV Shared fields to a separate column.' };
  const rows = [];
  for (let index = headerIndex + 1; index < grid.length; index++) {
    const source = grid[index];
    if (!source.some(value => String(value ?? '').trim())) continue;
    if (['sharedAt', 'recruiter', 'candidateName'].every(field => source.map(normalizeHeader).some(value => aliases[field].includes(value)))) continue;
    const record = Object.fromEntries(fields.map(field => [field, String(source[columns[field]] ?? '').trim()]));
    if (!record.candidateName || normalizeHeader(record.candidateName) === 'candidate') continue;
    if (record.sharedAt && !pastedShareDate(record.sharedAt)) return { rows: [], error: `Excel row ${index + 1} has an invalid Date value: “${record.sharedAt}”?.` };
    record.sharedAt = pastedShareDate(record.sharedAt) || '';
    rows.push(record);
  }
  return { rows, error: '' };
}
function renderImportSheetList() {
  $('#importSheetChoices').innerHTML = importSheets.map(sheet => `<label class="import-sheet-choice"><input type="checkbox" data-import-worksheet="${escapeHTML(sheet.name)}" ${sheet.selected ? 'checked' : ''}><span>${escapeHTML(sheet.name)}${sheet.hidden ? ' ? hidden' : ''}</span><small>${escapeHTML(sheet.kind)} ? ${sheet.populatedRows} rows</small></label>`).join('');
  $('#importSheet').innerHTML = importSheets.map(sheet => `<option value="${escapeHTML(sheet.name)}" ${sheet.name === activeImportSheet ? 'selected' : ''}>${escapeHTML(sheet.name)}${sheet.hidden ? ' (hidden)' : ''}</option>`).join('');
  $('#confirmImport').disabled = !importSheets.some(sheet => sheet.selected);
  $('#confirmImportOne').disabled = !activeImportSheet;
  renderImportSheetPreview();
}
function renderImportSheetPreview() {
  const sheet = importSheets.find(item => item.name === activeImportSheet);
  if (!sheet) return;
  const nonempty = sheet.grid.map((row, index) => ({ row, index })).filter(item => item.row.some(value => String(value ?? '').trim()));
  const headerIndex = sheet.headerIndex;
  if (sheet.kind === 'Interview tracker') {
    const parsed = previewInterviewRows(sheet.grid);
    const fields = ['candidate', 'recruiter', 'date', 'company', 'profile', 'mode', 'time', 'candidateStatus', 'clientStatus', 'contactDetails', 'remarks'];
    const labels = ['Candidate', 'Recruiter', 'Interview Date', 'Company', 'Profile', 'Mode', 'Time', 'Candidate Status', 'Client Status', 'Contact Details', 'Remarks'];
    $('#importSheetDetails').textContent = `Interview tracker: mapped to the 11 tracker columns in order; ${parsed.rows.length} candidate interview rows ready.`;
    $('#importPreviewHead').innerHTML = `<tr><th>Excel row</th>${labels.map(label => `<th>${escapeHTML(label)}</th>`).join('')}</tr>`;
    $('#importPreviewRows').innerHTML = parsed.rows.slice(0, 18).map(row => `<tr><td>${row.excelRow}</td>${fields.map(field => `<td>${escapeHTML(row[field])}</td>`).join('')}</tr>`).join('');
    return;
  }
  if (sheet.kind === 'CV sharing') {
    const parsed = previewCvSharedRows(sheet.grid);
    if (parsed.error) {
      $('#importSheetDetails').textContent = parsed.error;
      $('#importPreviewHead').innerHTML = '';
      $('#importPreviewRows').innerHTML = '';
      return;
    }
    const labels = ['Date', 'Recruiter', 'Share status / time', 'Company', 'Profile', 'Candidate', 'Designation', 'Location', 'Work location', 'Experience', 'Current company', 'Current CTC', 'Expected CTC', 'Notice period', 'Remarks', 'Phone', 'Email'];
    const fields = ['sharedAt', 'recruiter', 'shareStatus', 'company', 'role', 'candidateName', 'designation', 'location', 'workLocation', 'experience', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod', 'remarks', 'phone', 'email'];
    $('#importSheetDetails').textContent = `CV Shared: header mapped across all 17 columns; ${parsed.rows.length} candidate rows ready. Preview shows mapped values before import.`;
    $('#importPreviewHead').innerHTML = `<tr><th>Excel row</th>${labels.map(label => `<th>${escapeHTML(label)}</th>`).join('')}</tr>`;
    $('#importPreviewRows').innerHTML = parsed.rows.slice(0, 18).map((row, index) => `<tr><td>${headerIndex + index + 2}</td>${fields.map(field => `<td>${escapeHTML(row[field])}</td>`).join('')}</tr>`).join('');
    return;
  }
  let mapping = 'Detected layout: ' + sheet.kind;
  if (sheet.kind === 'CV sharing') mapping += ' · date bands plus recruiter, share status/time, company, profile, candidate, designation, locations, experience, current company, CTC, notice period, remarks, phone and email';
  else if (sheet.kind === 'Interview tracker') mapping += ' · Candidate, recruiter, interview date, company, profile, mode, time, candidate status, client status, contact details and remarks mapped by heading';
  else if (sheet.kind === 'Shortlisted / offered') mapping += ` ? header row ${headerIndex + 1}; TA name, month, company, profile, candidate, status, final call, joining date and remarks mapped by heading`;
  else if (sheet.kind === 'Candidate sourcing') mapping += ` ? header row ${headerIndex + 1}; date, skill, candidate name, mobile, email and status/feedback mapped by heading`;
  else if (sheet.kind === 'Weekly summary') mapping += ' ? original cells, merged ranges, row order and blank rows retained';
  $('#importSheetDetails').textContent = `${mapping}. ${sheet.merges} merged ranges preserved.`;
  const cols = Math.max(1, Math.min(14, ...[14, ...nonempty.slice(0, 8).map(item => item.row.length)]));
  const display = nonempty.slice(0, 18);
  $('#importPreviewHead').innerHTML = `<tr><th>Excel row</th>${Array.from({ length: cols }, (_, i) => `<th>${String.fromCharCode(65 + (i % 26))}${i >= 26 ? '?' : ''}</th>`).join('')}</tr>`;
  $('#importPreviewRows').innerHTML = display.map(({ row, index }) => `<tr><td>${index + 1}</td>${Array.from({ length: cols }, (_, i) => `<td>${escapeHTML(row[i] ?? '')}</td>`).join('')}</tr>`).join('');
}
async function loadImportFile(file) {
  $('#importError').textContent = '';
  $('#importWorkbookSummary').textContent = 'Reading workbook and preparing worksheet previews…';
  if (!window.XLSX) throw new Error('The Excel reader did not load. Refresh the page and try again.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Excel workbooks are limited to 20 MB.');
  const bytes = await file.arrayBuffer();
  importWorkbook = XLSX.read(bytes, { type: 'array', cellDates: true, bookSheets: false });
  if (!importWorkbook.SheetNames.length) throw new Error('This workbook has no worksheets.');
  importFile = file;
  const reader = new FileReader();
  importFileBase64 = await new Promise((resolve, reject) => { reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error('Could not read the selected workbook.')); reader.readAsDataURL(file); });
  importSheets = importWorkbook.SheetNames.map(name => {
    const sheet = importWorkbook.Sheets[name], grid = sheetGrid(sheet), kind = worksheetType(name), hidden = Boolean(importWorkbook.Workbook?.Sheets?.find(item => item.name === name)?.Hidden);
    const headerIndex = worksheetHeader(grid, kind);
    return { name, grid, kind, hidden, headerIndex: headerIndex < 0 ? 0 : headerIndex, merges: sheet['!merges']?.length || 0, populatedRows: grid.filter(row => row.some(value => String(value ?? '').trim())).length, selected: true };
  });
  activeImportSheet = importSheets[0]?.name || '';
  $('#importWorkbookSummary').textContent = `${importSheets.length} worksheets detected, including hidden sheets. Select any combination to import.`;
  $('#importWorksheets').hidden = false;
  renderImportSheetList();
}
function preparePastedTracker() {
  $('#importError').textContent = '';
  const input = $('#trackerPasteText').value.trim();
  if (!input) { $('#importError').textContent = 'Copy cells from Excel and paste them into the box first.'; return; }
  if (!window.XLSX) { $('#importError').textContent = 'The Excel reader did not load. Refresh the page and try again.'; return; }
  const source = input.replace(/^\uFEFF/, ''), grid = [], row = []; let cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (char === '\t' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && source[i + 1] === '\n') i++; row.push(cell.trim()); grid.push(row.splice(0)); cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell.trim()); grid.push(row); }
  if (grid.length > 10000) { $('#importError').textContent = 'Paste up to 10,000 rows at a time.'; return; }
  const name = $('#trackerPasteType').value, workbook = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet(grid);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
  const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
  if (base64.length > 28_000_000) { $('#importError').textContent = 'This pasted sheet is over the 20 MB import limit. Paste fewer rows at a time.'; return; }
  importWorkbook = workbook; importFile = { name: `pasted-${name.replace(/\s+/g, '-').toLowerCase()}.xlsx` }; importFileBase64 = base64;
  const kind = worksheetType(name), headerIndex = worksheetHeader(grid, kind);
  importSheets = [{ name, grid, kind, hidden: false, headerIndex: headerIndex < 0 ? 0 : headerIndex, merges: 0, populatedRows: grid.filter(row => row.some(value => String(value ?? '').trim())).length, selected: true }];
  activeImportSheet = name;
  $('#importWorkbookSummary').textContent = `1 pasted worksheet ready to import (${importSheets[0].populatedRows} populated rows).`;
  $('#importWorksheets').hidden = false;
  renderImportSheetList();
}
async function submitHistoricalImport(names, individual = false) {
  const button = individual ? $('#confirmImportOne') : $('#confirmImport');
  button.disabled = true; button.textContent = 'Importing…'; $('#importError').textContent = '';
  try {
    for (const name of names) {
      const sheet = importSheets.find(item => item.name === name);
      if (sheet?.kind !== 'CV sharing') continue;
      const preview = previewCvSharedRows(sheet.grid);
      if (preview.error) throw new Error(`${sheet.name}: ${preview.error}`);
    }
    const result = await api('/ta-imports', 'POST', { workbookBase64: importFileBase64, sourceName: importFile?.name || 'Historical workbook', sheets: names });
    const details = result.worksheets.map(sheet => {
      if (sheet.status === 'imported') return `${sheet.name}: ${sheet.recordsImported} records processed, ${sheet.candidatesCreated} new candidates, ${sheet.interviewsAdded} interviews`;
      const previous = result.report?.worksheets?.find(item => item.name === sheet.name);
      return `${sheet.name}: already imported (${previous?.candidatesCreated || 0} candidates and ${previous?.interviewsAdded || 0} interviews were imported earlier)`;
    }).join('\n');
    $('#trackerImportDialog').close();
    await loadRecruiterAnalyticsData(); await loadImportReports();
    const alreadyImported = result.worksheets.length > 0 && result.worksheets.every(sheet => sheet.status === 'already imported');
    const matchedExisting = !alreadyImported && result.candidatesCreated === 0 && result.interviewsAdded === 0 && (result.cvSharesAdded || 0) === 0 && result.duplicatesSkipped > 0;
    $('#workspaceMessage').textContent = alreadyImported
      ? `This workbook was imported earlier. No duplicate records were added; the existing records remain in your trackers.\n${details}`
      : matchedExisting
        ? `The worksheet rows were checked against existing records. No duplicates were added; existing candidate and interview data remains in your trackers.\n${details}`
        : `Historical import report\n${details}\nNew in this run: ${result.candidatesCreated} candidates, ${result.interviewsAdded} interview rounds and ${result.cvSharesAdded || 0} CV shares; ${result.duplicatesSkipped} exact duplicates skipped. Original worksheet data was archived.`;
    $('#workspaceMessage').hidden = false;
  } catch (error) { $('#importError').textContent = error.message; }
  finally { button.textContent = individual ? 'Import this worksheet' : 'Import selected worksheets'; button.disabled = individual ? !activeImportSheet : !importSheets.some(sheet => sheet.selected); }
}
let importReports = [];
async function loadImportReports() {
  try {
    importReports = await api('/ta-imports');
    const existing = new Set(importReports.map(item => item.id));
    for (const id of selectedImportArchiveIds) if (!existing.has(id)) selectedImportArchiveIds.delete(id);
    $("#historicalImportReports").innerHTML = importReports.map(item => `<article class="historical-import-report"><label class="archive-select"><input type="checkbox" data-import-archive-select="${escapeHTML(item.id)}" ${selectedImportArchiveIds.has(item.id) ? "checked" : ""} aria-label="Select archived workbook ${escapeHTML(item.sourceName)}"></label><div class="archive-report-main"><strong>${escapeHTML(item.sourceName)}</strong><small>${escapeHTML(new Date(item.importedAt).toLocaleString())}</small><span>${(item.report?.worksheets || []).map(sheet => `${escapeHTML(sheet.name)} (${sheet.populatedRows} rows)`).join(" | ")}</span><small>${item.report?.candidatesCreated || 0} candidates | ${item.report?.interviewsAdded || 0} interview rounds | ${item.report?.cvSharesAdded || 0} CV shares | original workbook archived</small><div class="archive-report-actions"><a href="/api/ta-imports/${encodeURIComponent(item.id)}.xlsx">Download archived workbook</a><button class="action-button" type="button" data-edit-import-archive="${escapeHTML(item.id)}">Rename</button><button class="action-button delete" type="button" data-delete-import-archive="${escapeHTML(item.id)}">Delete archive</button></div></div></article>`).join("") || "<p class=\"empty-state compact\">No historical imports yet.</p>";
    $("#selectedImportArchiveCount").textContent = selectedImportArchiveIds.size;
    $("#clearImportArchiveSelection").disabled = selectedImportArchiveIds.size === 0;
    $("#deleteSelectedImportArchives").disabled = selectedImportArchiveIds.size === 0;
    $("#selectAllImportArchives").disabled = importReports.length === 0;
    const visibleIds = importReports.map(item => item.id), selectedVisible = visibleIds.filter(id => selectedImportArchiveIds.has(id)).length;
    $("#selectAllImportArchives").checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    $("#selectAllImportArchives").indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  } catch { /* Reports are optional until an import has been saved. */ }
}
$('#importTracker').addEventListener('click', () => { $('#trackerImportForm').reset(); $('#trackerImportFile').value = ''; $('#importError').textContent = ''; $('#importWorksheets').hidden = true; importWorkbook = null; importFile = null; importFileBase64 = ''; importSheets = []; activeImportSheet = ''; $('#confirmImport').disabled = true; $('#confirmImportOne').disabled = true; $('#trackerImportDialog').showModal(); });
$('#trackerImportFile').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file) return; try { await loadImportFile(file); } catch (error) { $('#importError').textContent = error.message; } });
$('#preparePastedTracker').addEventListener('click', preparePastedTracker);
$('#importSheet').addEventListener('change', () => { activeImportSheet = $('#importSheet').value; renderImportSheetPreview(); $('#confirmImportOne').disabled = !activeImportSheet; });
$('#importSheetChoices').addEventListener('change', event => { const input = event.target.closest('[data-import-worksheet]'); if (!input) return; const sheet = importSheets.find(item => item.name === input.dataset.importWorksheet); if (sheet) sheet.selected = input.checked; $('#confirmImport').disabled = !importSheets.some(item => item.selected); });
$('#confirmImportOne').addEventListener('click', () => submitHistoricalImport([activeImportSheet], true));
$('#confirmImport').addEventListener('click', () => submitHistoricalImport(importSheets.filter(sheet => sheet.selected).map(sheet => sheet.name)));
$('#trackerImportDialog').addEventListener('close', () => { const result = $('#workspaceMessage'); if (result.textContent.startsWith('Historical import report')) result.hidden = false; });
loadImportReports();
function activateTrackerTab(selected, persist = true) {
  const active = TRACKER_TABS.includes(selected) ? selected : 'interviews';
  const activeButton = document.querySelector(`[data-tab="${active}"]`);
  document.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === activeButton)));
  document.querySelectorAll('.tracker-view').forEach(view => { view.hidden = view.id !== `${active}View`; });
  if (persist) saveTalentViewState({ tab: active });
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
  activateTrackerTab(button.dataset.tab);
  loadRecruiterAnalyticsData();
  if (button.dataset.tab === 'importhistory') loadImportReports();
}));
$('#filterMonth').value = '';
$('#filterDate').value = '';
$('#filterYear').value = '';
$('#dateSort').value = savedTalentViewState.sort === 'oldest' ? 'oldest' : 'newest';
activateTrackerTab(savedTalentViewState.tab || 'interviews', false);
document.querySelectorAll('[data-add-candidate]').forEach(button => button.addEventListener('click', addCandidate));
document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', exportExcel));
document.querySelectorAll('[data-search]').forEach(input => input.addEventListener('input', debounce(() => { cvSharePage = 0; importedSharePage = 0; renderTrackers(); })));
document.querySelectorAll('#interviewRows, #offerRows, #joinedRows').forEach(body => body.addEventListener('change', async event => {
  const select = event.target.closest('select[data-candidate-stage]'); if (!select) return;
  const candidate = candidates.find(c => c.id === select.dataset.candidateStage); if (!candidate) return;
  try { await api(`/candidates/${encodeURIComponent(candidate.id)}`, 'PUT', { stage: select.value }); await loadCandidates(); }
  catch (error) { showError(error.message); select.value = candidate.stage; }
}));
document.querySelectorAll('#interviewRows, #offerRows, #joinedRows').forEach(body => body.addEventListener('click', event => {
  const button = event.target.closest('[data-edit-candidate], [data-delete-candidate]'); if (!button) return;
  const c = candidates.find(item => item.id === (button.dataset.editCandidate || button.dataset.deleteCandidate));
  if (!c) return;
  if (button.hasAttribute('data-edit-candidate')) openDialog(c); else deleteCandidate(c);
}));
$('#weekStart').value = localDateKey(mondayFor(new Date()));
$('#weekStart').addEventListener('change', () => { const date = new Date(`${$('#weekStart').value}T00:00:00`); if (!Number.isNaN(date.getTime())) { $('#weekStart').value = localDateKey(mondayFor(date)); loadWeekly(); } });
$('#recruiterMonth').value = localDateKey(new Date()).slice(0, 7);
$('#recruiterMonth').addEventListener('change', () => renderRecruiterAnalytics());
$('#addRecruiter')?.addEventListener('click', () => { $('#newRecruiterName')?.focus(); $('#newRecruiterName')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('#createRecruiter')?.addEventListener('click', () => addRecruiterFromInput('#newRecruiterName'));
$('#analyticsCreateRecruiter')?.addEventListener('click', () => addRecruiterFromInput('#analyticsNewRecruiterName'));
$('#analyticsAddRecruiter')?.addEventListener('click', () => { $('#analyticsNewRecruiterName')?.focus(); $('#analyticsNewRecruiterName')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('#saveWeekly')?.addEventListener('click', saveWeekly);
$('#recruiterWeekStart').addEventListener('change', () => {
  const value = $('#recruiterWeekStart').value;
  const date = value ? new Date(`${value}T00:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) return;
  const monday = mondayFor(date);
  $('#recruiterWeekStart').value = localDateKey(monday);
  renderRecruiterAnalytics();
});
$('#refreshRecruiterAnalytics').addEventListener('click', loadRecruiterAnalyticsData);
$('#weeklyRows').addEventListener('input', event => {
  if (event.target.matches('input[data-field]')) weeklyEntriesDirty = true;
  const target = event.target.closest('input[data-field="achievement"][data-metric="Candidate Shared"]');
  if (!target) return;
  const note = target.closest('.week-cell')?.querySelector('.achievement-note');
  if (!note) return;
  const value = Number(target.value) || 0;
  note.textContent = value >= 4 ? `${value} of 4 · Target met` : `${value} of 4 · ${Math.round(value / 4 * 100)}% of target`;
  note.classList.toggle('met', value >= 4);
});
document.querySelectorAll('[data-close-import]').forEach(button => button.addEventListener('click', () => $('#trackerImportDialog').close()));
$('#weeklyRows').addEventListener('click', async event => { const saveButton = event.target.closest('[data-save-weekly-recruiter]'); if (saveButton) { await saveWeekly(saveButton.dataset.saveWeeklyRecruiter); return; } });
const manageRecruiterDirectoryClick = async event => {
  const rename = event.target.closest('[data-rename-recruiter]'), remove = event.target.closest('[data-delete-recruiter]');
  try {
    if (rename) { const nextName = prompt('New recruiter name', rename.dataset.recruiterName); if (!nextName?.trim() || !rename.dataset.renameRecruiter) return; await api(`/ta-recruiters/${encodeURIComponent(rename.dataset.renameRecruiter)}`, 'PATCH', { name: nextName }); }
    else if (remove) { if (!remove.dataset.deleteRecruiter) return alert('This recruiter is from existing records and cannot be deleted from the directory yet.'); if (!confirm(`Delete ${remove.dataset.recruiterName} and its weekly entries? Assigned candidate, interview, and CV share records must be reassigned first.`)) return; await api(`/ta-recruiters/${encodeURIComponent(remove.dataset.deleteRecruiter)}`, 'DELETE'); }
    else return;
    await loadRecruiterAnalyticsData();
  } catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; }
};
$('#recruiterDirectory')?.addEventListener('click', manageRecruiterDirectoryClick);
$('#analyticsRecruiterDirectory')?.addEventListener('click', manageRecruiterDirectoryClick);
populateStageOptions();
loadRecruiterAnalyticsData(true);
function autoRefreshTalentWorkspace() {
  if (document.visibilityState !== 'visible' || document.querySelector('dialog[open]') || weeklyEntriesDirty || Date.now() - lastTalentUserInteractionAt < 8000) return;
  if (Date.now() - lastTalentRefreshAt >= 20000) loadRecruiterAnalyticsData();
}
['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, () => { lastTalentUserInteractionAt = Date.now(); }, true));
window.addEventListener('focus', autoRefreshTalentWorkspace);
document.addEventListener('visibilitychange', autoRefreshTalentWorkspace);
setInterval(autoRefreshTalentWorkspace, 30000);
