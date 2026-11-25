const STAGES = ['Screening', 'Interview', 'Shortlisted', 'Offer', 'Joining', 'Joined', 'Rejected', 'Blacklisted', 'Withdrawn'];
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let candidates = [];
let cvShares = [];
const selectedCandidateIds = new Set();
const selectedCvShareIds = new Set();
let cvSharePage = 0;
let visibleCvSharePageIds = [];
let busy = false;
const TALENT_VIEW_STATE_KEY = 'right-head-talent-view-state';
const TRACKER_TABS = ['interviews', 'offers', 'joined', 'weekly', 'cvshares', 'pipeline'];
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
function normalizedDateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : localDateKey(value);
  // Excel sheets and older tracker imports can expose dates as serial numbers.
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 100000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  const text = String(value).trim();
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
  const eventDates = [candidate.interviewDate, candidate.sharedDate, candidate.doj, candidate.offeredDate, candidate.shortlistedDate,
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
function sortByDate(rows) {
  return rows.sort((a, b) => compareDates(candidateDate(a.candidate || a, a.entry), candidateDate(b.candidate || b, b.entry)));
}
function populateYearFilters() {
  const current = $('#filterYear').value;
  const dates = candidates.flatMap(candidate => [
    candidate.interviewDate, candidate.sharedDate, candidate.doj, candidate.offeredDate,
    candidate.shortlistedDate, candidate.createdAt,
    candidate.month,
    ...(candidate.interviews || []).flatMap(item => [item.date, item.sharedDate]),
    ...(candidate.statusHistory || []).map(item => item.at || item.date)
  ]).concat(cvShares.map(cvShareDate));
  const years = [...new Set(dates.map(value => candidateMonthKey(value)).map(key => key.slice(0, 4)).filter(year => /^\d{4}$/.test(year)))].sort((a, b) => b.localeCompare(a));
  $('#filterYear').innerHTML = `<option value="">All years</option>${years.map(year => `<option value="${year}">${year}</option>`).join('')}`;
  const selected = current || savedTalentViewState.year || '';
  $('#filterYear').value = years.includes(selected) ? selected : '';
}
function updateMetrics() {
  const filtered = candidates.filter(candidateMatchesDateFilter);
  $('#totalCount').textContent = filtered.length;
  $('#activeCount').textContent = filtered.filter(item => ['Screening', 'Interview', 'Shortlisted', 'Offer'].includes(item.stage)).length;
  $('#interviewCount').textContent = filtered.filter(item => item.stage === 'Interview').length;
  $('#hiredCount').textContent = filtered.filter(item => item.stage === 'Joining').length;
}
function render() {
  updateMetrics();
  const query = $('#search').value.trim().toLowerCase();
  const stage = $('#stageFilter').value;
  const visible = candidates.filter(item => !['Joined', 'Joining'].includes(item.stage) && [item.name, item.role, item.email, item.phone, item.source, item.company, item.recruiter].some(value => String(value || '').toLowerCase().includes(query)) && (!stage || item.stage === stage) && candidateMatchesDateFilter(item))
    .sort((a, b) => compareDates(candidateDate(a), candidateDate(b)));
  $('#candidateRows').innerHTML = visible.map(item => `<tr data-id="${escapeHTML(item.id)}">
    <td><input type="checkbox" data-candidate-select="${escapeHTML(item.id)}" aria-label="Select ${escapeHTML(item.name)}"></td>
    <td><span class="candidate-name">${escapeHTML(item.name)}</span>${item.email ? `<span class="candidate-email">${escapeHTML(item.email)}</span>` : ''}</td>
    <td>${escapeHTML(item.role)}</td>
    <td>${escapeHTML(item.company || '—')}</td>
    <td>${escapeHTML(item.recruiter || '—')}</td>
    <td>${item.sharedDate ? displayDate(item.sharedDate) : '—'}</td>
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
    populateYearFilters();
    const existingIds = new Set(candidates.map(candidate => candidate.id));
    for (const id of selectedCandidateIds) if (!existingIds.has(id)) selectedCandidateIds.delete(id);
    render();
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
      for (const field of ['name', 'role', 'stage', 'email', 'phone', 'source', 'notes', 'company', 'recruiter', 'month', 'interviewDate', 'sharedDate', 'finalCall', 'doj', 'feedback', 'remarks']) {
      form.elements[field].value = candidate[field] || (field === 'stage' ? 'Screening' : '');
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
$('#search').addEventListener('input', render);
$('#stageFilter').addEventListener('change', render);
function persistDateFilters() {
  saveTalentViewState({ month: $('#filterMonth').value, date: $('#filterDate').value, year: $('#filterYear').value, sort: $('#dateSort').value });
}
['filterMonth', 'filterDate', 'filterYear', 'dateSort'].forEach(id => $(`#${id}`).addEventListener('change', () => { cvSharePage = 0; persistDateFilters(); render(); }));
$('#clearDateFilters').addEventListener('click', () => { $('#filterMonth').value = ''; $('#filterDate').value = ''; $('#filterYear').value = ''; $('#dateSort').value = 'newest'; cvSharePage = 0; persistDateFilters(); render(); });
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
  }).filter(({ candidate: c, entry: i }) => dateFilterMatch(candidateDate(c, i)) && candidateMatch({ ...c, company: i.company || c.company, role: i.role || c.role, recruiter: i.recruiter || c.recruiter, stage: i.candidateStatus || c.stage, feedback: i.remarks || c.feedback, remarks: i.clientStatus || c.clientStatus }, interviewQuery));
  sortByDate(interviewRows);
  $('#interviewRows').innerHTML = interviewRows.map(({ candidate: c, entry: i }) => `<tr><td><input type="checkbox" data-candidate-select="${escapeHTML(c.id)}" aria-label="Select ${escapeHTML(c.name)}"></td>${td(c.name)}${td(i.recruiter || c.recruiter)}${td(i.date || c.interviewDate)}${td(i.company || c.company)}${td(i.role || c.role)}${td(i.mode || c.interviewMode)}${td(i.time || c.interviewTime)}<td>${stageSelect(c)}<small class="raw-status">${escapeHTML(i.candidateStatus || '')}</small></td>${td(i.clientStatus || c.clientStatus)}${td(i.contactDetails || [i.email || c.email, i.phone || c.phone].filter(Boolean).join(' · '))}${td(i.remarks || c.remarks || c.feedback)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button><button class="action-button delete" type="button" data-delete-candidate="${escapeHTML(c.id)}">Delete</button></td></tr>`).join('');
  $('#interviewEmpty').hidden = interviewRows.length > 0;
  const offerQuery = trackerSearch('offers');
  const offerCandidates = candidates.filter(c => ['Shortlisted', 'Offer', 'Joining'].includes(c.stage) && dateFilterMatch(offerDate(c)) && candidateMatch(c, offerQuery));
  offerCandidates.sort((a, b) => compareDates(offerDate(a), offerDate(b)));
  $('#offerRows').innerHTML = offerCandidates.map(c => `<tr><td><input type="checkbox" data-candidate-select="${escapeHTML(c.id)}" aria-label="Select ${escapeHTML(c.name)}"></td>${td(c.recruiter)}${td(c.month || c.doj?.slice(0, 7) || c.createdAt?.slice(0, 7))}${td(c.company)}${td(c.role)}${td(c.name)}<td>${stageSelect(c)}</td>${td(c.finalCall)}${td(c.doj)}${td(c.remarks || c.interviews?.at(-1)?.remarks)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button><button class="action-button delete" type="button" data-delete-candidate="${escapeHTML(c.id)}">Delete</button></td></tr>`).join('');
  $('#offerEmpty').hidden = offerCandidates.length > 0;
  const joinedQuery = trackerSearch('joined');
  const joinedCandidates = candidates.filter(c => ['Joined', 'Joining'].includes(c.stage) && dateFilterMatch(offerDate(c)) && candidateMatch(c, joinedQuery));
  joinedCandidates.sort((a, b) => compareDates(offerDate(a), offerDate(b)));
  $('#joinedRows').innerHTML = joinedCandidates.map(c => `<tr><td><input type="checkbox" data-candidate-select="${escapeHTML(c.id)}" aria-label="Select ${escapeHTML(c.name)}"></td>${td(c.recruiter)}${td(c.month || c.doj?.slice(0, 7) || c.createdAt?.slice(0, 7))}${td(c.company)}${td(c.role)}${td(c.name)}<td>${stageSelect(c)}</td>${td(c.doj)}${td(c.remarks || c.interviews?.at(-1)?.remarks)}<td><button class="action-button" type="button" data-edit-candidate="${escapeHTML(c.id)}">Edit</button><button class="action-button delete" type="button" data-delete-candidate="${escapeHTML(c.id)}">Delete</button></td></tr>`).join('');
  $('#joinedEmpty').hidden = joinedCandidates.length > 0;
  renderCvShares();
  renderWeekly();
  syncSelectionUI();
}
function renderCvShares() {
  if (!$('#cvShareRows')) return;
  const query = trackerSearch('cvshares');
  const fields = ['recruiter', 'shareStatus', 'company', 'role', 'candidateName', 'designation', 'location', 'workLocation', 'experience', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod', 'remarks', 'phone', 'email'];
  const rows = cvShares.filter(share => dateFilterMatch(cvShareDate(share)) && fields.some(field => String(share[field] || '').toLowerCase().includes(query)));
  rows.sort((a, b) => compareDates(cvShareDate(a), cvShareDate(b)));
  const pageSize = 200, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  cvSharePage = Math.min(cvSharePage, pageCount - 1);
  const pageRows = rows.slice(cvSharePage * pageSize, (cvSharePage + 1) * pageSize);
  visibleCvSharePageIds = pageRows.map(share => share.id);
  const dateCounts = new Map();
  rows.forEach(share => { const date = cvShareDate(share); dateCounts.set(date, (dateCounts.get(date) || 0) + 1); });
  const cell = value => `<td>${escapeHTML(value || '—')}</td>`;
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
  try { cvShares = await api('/ta-cv-shares'); const ids = new Set(cvShares.map(share => share.id)); for (const id of selectedCvShareIds) if (!ids.has(id)) selectedCvShareIds.delete(id); populateYearFilters(); render(); }
  catch (error) { $('#workspaceMessage').textContent = error.message; $('#workspaceMessage').hidden = false; }
}
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function mondayFor(date) { const result = new Date(date.getFullYear(), date.getMonth(), date.getDate()); result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); return result; }
function selectedWeekDays() { const [year, month, day] = $('#weekStart').value.split('-').map(Number); const monday = new Date(year, month - 1, day); return TA_DAYS.map((_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return localDateKey(d); }); }
function candidateEvents(candidate) {
  return candidate.statusHistory || [];
}
function metricCandidates(recruiter, metric, dateKey) {
  const matchesRecruiter = value => String(value || '').toLowerCase() === recruiter.toLowerCase();
  if (metric === TA_METRICS[0]) return cvShares.filter(share => matchesRecruiter(share.recruiter) && normalizedDateKey(share.sharedAt) === dateKey);
  const stage = metric === TA_METRICS[1] ? 'Shortlisted' : metric === TA_METRICS[2] ? 'Offer' : 'Joining';
  return candidates.filter(c => candidateEvents(c).some(e => matchesRecruiter(e.recruiter || c.recruiter) && e.stage === stage && normalizedDateKey(e.at || e.date) === dateKey));
}
function renderWeekly() {
  if (!$('#weeklyRows')) return;
  const recruiters = new Map();
  candidates.forEach(c => [c.recruiter, ...(c.interviews || []).map(i => i.recruiter)].filter(Boolean).forEach(name => { if (name.trim()) recruiters.set(name.toLowerCase(), name.trim()); }));
  cvShares.forEach(share => { if (share.recruiter?.trim()) recruiters.set(share.recruiter.toLowerCase(), share.recruiter.trim()); });
  weeklyReports.forEach(r => recruiters.set(r.recruiter.toLowerCase(), r.recruiter));
  const days = selectedWeekDays();
  $('#weeklyRows').innerHTML = [...recruiters.values()].sort((a, b) => a.localeCompare(b)).map(recruiter => {
    const report = weeklyReports.find(r => r.recruiter.toLowerCase() === recruiter.toLowerCase());
    const metricRows = TA_METRICS.map(metric => `<tr><th scope="row">${escapeHTML(metric)}</th>${days.map((dayKey, index) => {
      const day = TA_DAYS[index], people = dateFilterMatch(dayKey) ? metricCandidates(recruiter, metric, dayKey) : [];
      const cell = report?.manual?.[metric]?.[day] || {};
      const target = metric === TA_METRICS[0] ? 4 : Number(cell.target) || '';
      const result = metric === TA_METRICS[3] ? people.map(c => c.name).join(', ') || '—' : String(people.length);
      const ratio = metric === TA_METRICS[0] ? `${Math.round(people.length / 4 * 100)}%` : '';
      const achievement = Number(cell.achievement) || 0;
      const met = achievement >= (Number(target) || 0);
      const achievementLabel = metric === TA_METRICS[0] ? `${achievement} of 4 · ${met ? 'Target met' : `${Math.round(achievement / 4 * 100)}% of target`}` : String(cell.achievement ?? '');
      return `<td class="week-cell"><div class="week-result${people.length ? ' has-result' : ''}" title="${metric === TA_METRICS[0] ? 'Result for the day, from CV Shared records for this recruiter and date' : 'Result for the day, from candidate records'}"><span class="result-value">${escapeHTML(result)}</span>${ratio ? `<span class="result-ratio">${escapeHTML(ratio)} of target</span>` : ''}</div><label>Achievement<input type="number" min="0" max="100000" step="1" data-recruiter="${escapeHTML(recruiter)}" data-metric="${escapeHTML(metric)}" data-day="${day}" data-field="achievement" value="${escapeHTML(cell.achievement ?? '')}"></label><small class="achievement-note${achievement ? ' met' : ''}">${escapeHTML(achievementLabel || 'Result is automatic; achievement is entered manually.')}</small></td>`;
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
    $('#weeklyMessage').textContent = 'Weekly achievements saved.'; $('#weeklyMessage').hidden = false; renderWeekly();
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
    await api(id ? `/ta-cv-shares/${encodeURIComponent(id)}` : '/ta-cv-shares', id ? 'PUT' : 'POST', values);
    $('#cvShareDialog').close(); await loadCvShares();
    $('#workspaceMessage').textContent = id ? 'CV share updated.' : 'CV share saved.'; $('#workspaceMessage').hidden = false;
  } catch (error) { $('#cvShareFormError').textContent = error.message; }
  finally { button.disabled = false; }
}
function pastedShareDate(value) {
  const input = String(value || '').replace(/[\u200B\uFEFF]/g, '').trim();
  if (!input || /^[-–—n/a]+$/i.test(input)) return '';
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
    await loadCvShares();
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
  const aliases = kind === 'Shortlisted / offered'
    ? [['ta name', 'recruiter'], ['candidate']]
    : kind === 'Candidate sourcing' ? [['candidate name', 'candidate'], ['skill', 'profile']] : [];
  let best = -1, score = 0;
  grid.slice(0, 30).forEach((row, index) => {
    const values = row.map(normalizeHeader), found = aliases.reduce((n, group) => n + Number(values.some(value => group.includes(value))), 0);
    if (found > score) { best = index; score = found; }
  });
  return best;
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
    if (record.sharedAt && !pastedShareDate(record.sharedAt)) return { rows: [], error: `Excel row ${index + 1} has an invalid Date value: “${record.sharedAt}”.` };
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
  else if (sheet.kind === 'Interview tracker') mapping += ' · A recruiter, B company, C profile, D candidate, E interview type, F time, G/H remarks or feedback, I/J contact details';
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
    const details = result.worksheets.map(sheet => `${sheet.name}: ${sheet.status === 'imported' ? `${sheet.recordsImported} records, ${sheet.candidatesCreated} new candidates, ${sheet.interviewsAdded} interviews` : sheet.status}`).join('\n');
    $('#trackerImportDialog').close();
    await loadCandidates(); await loadImportReports();
    $('#workspaceMessage').textContent = `Historical import report\n${details}\nTotal: ${result.candidatesCreated} candidates, ${result.interviewsAdded} interview rounds and ${result.cvSharesAdded || 0} CV shares imported; ${result.duplicatesSkipped} exact duplicates skipped. Original worksheet data was archived.`;
    $('#workspaceMessage').hidden = false;
  } catch (error) { $('#importError').textContent = error.message; }
  finally { button.textContent = individual ? 'Import this worksheet' : 'Import selected worksheets'; button.disabled = individual ? !activeImportSheet : !importSheets.some(sheet => sheet.selected); }
}
let importReports = [];
async function loadImportReports() {
  try {
    importReports = await api('/ta-imports');
    $('#historicalImportReports').innerHTML = importReports.map(item => `<article class="historical-import-report"><strong>${escapeHTML(item.sourceName)}</strong><small>${escapeHTML(new Date(item.importedAt).toLocaleString())}</small><span>${(item.report?.worksheets || []).map(sheet => `${escapeHTML(sheet.name)} (${sheet.populatedRows} rows)`).join(' · ')}</span><small>${item.report?.candidatesCreated || 0} candidates · ${item.report?.interviewsAdded || 0} interview rounds · ${item.report?.cvSharesAdded || 0} CV shares · original row/merge structure archived</small><a href="/api/ta-imports/${encodeURIComponent(item.id)}.xlsx">Download archived worksheets</a></article>`).join('') || '<p class="empty-state compact">No historical imports yet.</p>';
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
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => activateTrackerTab(button.dataset.tab)));
$('#filterMonth').value = /^(0[1-9]|1[0-2])$/.test(savedTalentViewState.month || '') ? savedTalentViewState.month : '';
$('#filterDate').value = /^\d{4}-\d{2}-\d{2}$/.test(savedTalentViewState.date || '') ? savedTalentViewState.date : '';
$('#dateSort').value = savedTalentViewState.sort === 'oldest' ? 'oldest' : 'newest';
activateTrackerTab(savedTalentViewState.tab || 'interviews', false);
document.querySelectorAll('[data-add-candidate]').forEach(button => button.addEventListener('click', addCandidate));
document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', exportExcel));
document.querySelectorAll('[data-search]').forEach(input => input.addEventListener('input', () => { cvSharePage = 0; renderTrackers(); }));
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
$('#addRecruiter').addEventListener('click', () => { const name = prompt('Recruiter / TA name'); if (!name?.trim()) return; const key = name.trim().toLowerCase(); if (!weeklyReports.some(r => r.recruiter.toLowerCase() === key) && !candidates.some(c => c.recruiter?.toLowerCase() === key)) weeklyReports.push({ id: `draft-${Date.now()}`, weekStart: $('#weekStart').value, recruiter: name.trim(), manual: {} }); renderWeekly(); });
$('#saveWeekly').addEventListener('click', saveWeekly);
$('#weeklyRows').addEventListener('input', event => {
  const target = event.target.closest('input[data-field="achievement"][data-metric="Candidate Shared"]');
  if (!target) return;
  const note = target.closest('.week-cell')?.querySelector('.achievement-note');
  if (!note) return;
  const value = Number(target.value) || 0;
  note.textContent = value >= 4 ? `${value} of 4 · Target met` : `${value} of 4 · ${Math.round(value / 4 * 100)}% of target`;
  note.classList.toggle('met', value >= 4);
});
document.querySelectorAll('[data-close-import]').forEach(button => button.addEventListener('click', () => $('#trackerImportDialog').close()));
$('#weeklyRows').addEventListener('click', async event => { const button = event.target.closest('[data-remove-recruiter]'); if (!button) return; const name = button.dataset.removeRecruiter; if (candidates.some(c => c.recruiter?.toLowerCase() === name.toLowerCase())) return alert('This recruiter is assigned to candidate records. Change those candidate profiles first.'); const record = weeklyReports.find(r => r.recruiter.toLowerCase() === name.toLowerCase()); try { if (record && !String(record.id).startsWith('draft-')) await api(`/ta-weekly/${encodeURIComponent(record.id)}`, 'DELETE'); weeklyReports = weeklyReports.filter(r => r.recruiter.toLowerCase() !== name.toLowerCase()); renderWeekly(); } catch (error) { $('#weeklyMessage').textContent = error.message; $('#weeklyMessage').hidden = false; } });
populateStageOptions();
loadCandidates();
loadWeekly();
loadCvShares();
