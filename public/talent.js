const STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];
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
  $('#activeCount').textContent = candidates.filter(item => ['Screening', 'Interview', 'Offer'].includes(item.stage)).length;
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
    for (const field of ['name', 'role', 'stage', 'email', 'phone', 'source', 'notes']) {
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
populateStageOptions();
loadCandidates();
