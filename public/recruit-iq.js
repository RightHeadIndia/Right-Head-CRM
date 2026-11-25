'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const STATUSES = ['Shortlisted', 'Hold', 'Rejected', 'Interview Scheduled', 'Interviewed', 'Selected', 'Offered', 'Joined'];
const DIMENSIONS = ['Skills', 'Relevant experience', 'Industry experience', 'Role and responsibilities', 'Education', 'Tools and certifications'];
const DEFAULT_WEIGHTS = [30, 20, 15, 15, 10, 10];
let state = { dashboard: {}, jobs: [], candidates: [], matches: [], processing: [] };
let editingJobId = '';
const selectedForCompare = new Set();
async function api(path = '', options = {}) {
  const response = await fetch(`/api/recruit-iq${path}`, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options
  });
  if (response.status === 401) { location.replace('/login.html?product=talent&next=%2Frecruit-iq.html'); throw new Error('Sign in to Talent Acquisition to continue.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function setMessage(selector, message, error = false) {
  const node = $(selector);
  node.textContent = message || '';
  node.style.color = error ? 'var(--danger)' : 'var(--muted)';
}
function splitLines(value) { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
function setLines(selector, value) { $(selector).value = Array.isArray(value) ? value.join('\n') : ''; }
function fillWeights(weights = {}) {
  $('#weightFields').innerHTML = DIMENSIONS.map((name, index) => `<label>${escapeHtml(name)} <input type="number" min="0" max="100" step="1" data-weight="${escapeHtml(name)}" value="${Number(weights[name] ?? DEFAULT_WEIGHTS[index])}"></label>`).join('');
}
function currentRequirements() {
  return {
    weights: Object.fromEntries($$('[data-weight]').map(input => [input.dataset.weight, Number(input.value)])),
    minExperience: $('#minExperience').value.trim(), skills: splitLines($('#jobSkills').value),
    mandatory: splitLines($('#jobMandatory').value), education: splitLines($('#jobEducation').value),
    industries: splitLines($('#jobIndustries').value), responsibilities: splitLines($('#jobResponsibilities').value),
    tools: splitLines($('#jobTools').value), certifications: []
  };
}
function renderMetrics(dashboard) {
  const values = [
    ['Total Jobs', dashboard.totalJobs], ['Active Jobs', dashboard.activeJobs],
    ['Total CVs Uploaded', dashboard.totalCVs], ['Successfully Processed CVs', dashboard.processedCVs],
    ['Failed Processing', dashboard.failedProcessing], ['Excellent Matches', dashboard.excellentMatches],
    ['Good Matches', dashboard.goodMatches], ['Shortlisted Candidates', dashboard.shortlisted],
    ['Interviews Scheduled', dashboard.interviewsScheduled], ['Selected Candidates', dashboard.selected]
  ];
  $('#metrics').innerHTML = values.map(([label, count]) => `<article class="riq-metric"><span>${escapeHtml(label)}</span><strong>${Number(count || 0)}</strong></article>`).join('');
  const distribution = [['Excellent Match', '#1f8d62'], ['Good Match', '#1f61b3'], ['Moderate Match', '#c17a16'], ['Low Match', '#a33d36']];
  const max = Math.max(1, ...distribution.map(([name]) => dashboard.distribution?.[name] || 0));
  $('#distribution').innerHTML = distribution.map(([name, color]) => {
    const count = dashboard.distribution?.[name] || 0;
    return `<div class="riq-chart-row"><span>${escapeHtml(name)}</span><div class="riq-bar"><i style="width:${Math.round(count / max * 100)}%;background:${color}"></i></div><b>${count}</b></div>`;
  }).join('') || '<p class="riq-empty">No match reports saved yet.</p>';
  $('#jobStats').innerHTML = dashboard.jobs?.length ? `<table class="riq-table"><thead><tr><th>Job opening</th><th>Candidates</th><th>Excellent matches</th><th>Shortlisted</th></tr></thead><tbody>${dashboard.jobs.map(job => `<tr><td>${escapeHtml(job.title)}</td><td>${job.candidates}</td><td>${job.excellent}</td><td>${job.shortlisted}</td></tr>`).join('')}</tbody></table>` : '<p class="riq-empty">Create a job opening to see job-wise screening statistics.</p>';
  const maxFunnel = Math.max(1, ...(dashboard.funnel || []).map(item => item.count));
  $('#funnel').innerHTML = (dashboard.funnel || []).map(item => `<div class="riq-chart-row"><span>${escapeHtml(item.status)}</span><div class="riq-bar"><i style="width:${Math.round(item.count / maxFunnel * 100)}%"></i></div><b>${item.count}</b></div>`).join('') || '<p class="riq-empty">No candidates in the funnel yet.</p>';
}
function renderJobs() {
  const rows = state.jobs.map(job => `<div class="riq-job-row"><strong>${escapeHtml(job.title)}</strong><span>${Number(job.candidates || 0)} candidates · ${job.requirements?.skills?.length || 0} skills</span><span class="riq-badge">${escapeHtml(job.status)}</span><span class="riq-actions"><button class="action-button" type="button" data-edit-job="${escapeHtml(job.id)}">Edit</button><button class="action-button" type="button" data-toggle-job="${escapeHtml(job.id)}">${job.status === 'Active' ? 'Close' : 'Reopen'}</button></span></div>`).join('');
  $('#jobList').innerHTML = rows || '<p class="riq-empty">No job openings saved yet.</p>';
  const options = state.jobs.map(job => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}${job.status === 'Active' ? '' : ' (Closed)'}</option>`).join('');
  const activeOptions = state.jobs.filter(job => job.status === 'Active').map(job => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}</option>`).join('');
  $('#uploadJob').innerHTML = activeOptions || '<option value="">Create an active job first</option>';
  $('#matchJobFilter').innerHTML = `<option value="">All job openings</option>${options}`;
  $('#exportJob').innerHTML = `<option value="">All job openings</option>${options}`;
  $('#exportCandidate').innerHTML = `<option value="">All candidates</option>${state.candidates.map(candidate => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</option>`).join('')}`;
}
function candidateFor(id) { return state.candidates.find(candidate => candidate.id === id); }
function jobFor(id) { return state.jobs.find(job => job.id === id); }
function uploadResult(item) {
  if (item.status !== 'processed' || !item.matchId) return '';
  const match = state.matches.find(row => row.id === item.matchId);
  const candidate = match && candidateFor(match.candidateId);
  const job = jobFor(item.jobId);
  if (!match || !candidate) return '';
  const profile = candidate.profile || {};
  const dimension = name => match.dimensions?.find(row => row.name.toLowerCase() === name.toLowerCase())?.score;
  const educationScore = dimension('Education');
  const fitScore = dimension('Relevant experience');
  const summaryFact = (label, value) => `<div class="riq-result-fact"><span>${label}</span><strong>${safeText(value)}</strong></div>`;
  const scoreBars = (match.dimensions || []).map((row, index) => `<div class="riq-result-score riq-result-score-${index % 6}"><span>${escapeHtml(row.name)}</span><div class="riq-bar"><i style="width:${Math.max(0, Math.min(100, Number(row.score) || 0))}%"></i></div><strong>${Number(row.score) || 0}%</strong></div>`).join('');
  const listItems = (values, empty) => values?.length ? `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : `<p>${empty}</p>`;
  const score = Math.max(0, Math.min(100, Number(match.total) || 0));
  return `<section class="riq-upload-result" aria-label="${escapeHtml(candidate.name)} screening result"><div class="riq-result-banner"><div class="riq-result-donut" style="--score:${score}" role="img" aria-label="${score}% overall job match"><span>${score}%</span></div><div class="riq-result-title"><span class="riq-result-kicker">SCREENING COMPLETE · ${escapeHtml(match.category)}</span><h3>${escapeHtml(candidate.name)}</h3><p>${escapeHtml(job?.title || 'Job opening')} · ${match.mandatoryMet ? 'Mandatory requirements met' : 'Mandatory requirement gaps to review'}</p></div><button type="button" class="secondary-button" data-match-detail="${escapeHtml(match.id)}">View full report</button></div><div class="riq-result-facts">${summaryFact('Location', profile.location)}${summaryFact('Total experience', profile.totalExperience)}${summaryFact('Relevant experience', match.relevantExperience || profile.relevantExperience)}${summaryFact('Domain experience fit', fitScore === undefined ? 'Not Mentioned' : `${fitScore}%`)}${summaryFact('Education', (profile.education || []).join(', '))}${summaryFact('Education match', educationScore === undefined ? 'Not Mentioned' : `${educationScore}%`)}</div><div class="riq-result-detail-grid"><div class="riq-result-scorecard"><h4>JD pointer match <span>Score by requirement area</span></h4>${scoreBars}<div class="riq-result-skill-block"><strong>Matched skills</strong><div class="riq-skill-chips">${(match.matchedSkills || []).map(value => `<span class="matched">${escapeHtml(value)}</span>`).join("") || "<span>None identified</span>"}</div></div><div class="riq-result-skill-block"><strong>Skills to verify</strong><div class="riq-skill-chips">${(match.missingSkills || []).map(value => `<span class="missing">${escapeHtml(value)}</span>`).join("") || "<span>None identified</span>"}</div></div></div><div class="riq-result-insights"><article><h4>Strengths</h4>${listItems(match.strengths, 'No strengths identified in the evidence.')}</article><article><h4>Gaps to review</h4>${listItems(match.weaknesses, 'No gaps identified in the evidence.')}<p><strong>Missing skills:</strong> ${escapeHtml((match.missingSkills || []).join(', ') || 'None identified')}</p></article></div></div><p class="riq-result-recommendation"><strong>Recruiter summary:</strong> ${escapeHtml(match.recommendation || 'Review the cited evidence with the candidate.')}</p></section>`;
}
function renderProcessing() {
  $('#uploadList').innerHTML = state.processing.length ? state.processing.map(item => `<article class="riq-upload-card"><div class="riq-upload-row"><strong>${escapeHtml(item.fileName)}</strong><span class="riq-badge ${item.status === 'failed' ? 'alert' : ''}">${escapeHtml(item.status)}</span><span>${escapeHtml(item.error || (item.matchId ? `Saved report for ${jobFor(item.jobId)?.title || 'job'}` : ''))}</span><span>${item.status === 'failed' ? `<button class="action-button" type="button" data-retry="${escapeHtml(item.id)}">Retry</button>` : escapeHtml(new Date(item.createdAt).toLocaleString())}</span></div>${uploadResult(item)}</article>`).join('') : '<p class="riq-empty">No CV files uploaded yet.</p>';
}
function candidateRows(candidates, matchesByCandidate = null) {
  return candidates.map(candidate => {
    const profile = candidate.profile || {};
    const loc = profile.location && profile.location !== 'Not Mentioned' ? profile.location : 'Not Mentioned';
    const skills = (profile.skills || []).slice(0, 5).join(', ') || 'Not Mentioned';
    const candidateMatches = matchesByCandidate ? matchesByCandidate.get(candidate.id) || [] : [];
    const best = candidateMatches.slice().sort((a, b) => b.total - a.total)[0];
    return { candidate, profile, loc, skills, best, candidateMatches };
  });
}

function updateRecruiterFilterOptions() {
  const recruiters = new Set();
  (state.candidates || []).forEach(c => {
    if (c.recruiter && c.recruiter.trim()) recruiters.add(c.recruiter.trim());
  });
  const sorted = [...recruiters].sort((a, b) => a.localeCompare(b));
  
  const populate = (id, label) => {
    const el = $(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = `<option value="">${label}</option>${sorted.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}`;
    if (sorted.includes(current)) el.value = current;
  };

  populate('#candidateRecruiterFilter', 'All recruiters');
  populate('#matchRecruiterFilter', 'All recruiters');
  populate('#shortlistRecruiterFilter', 'All recruiters');
}

function renderCandidates() {
  const query = $('#candidateSearch').value.trim().toLowerCase();
  const location = $('#candidateLocation').value.trim().toLowerCase();
  const experience = $('#candidateExperience').value.trim().toLowerCase();
  const designation = $('#candidateDesignation').value.trim().toLowerCase();
  const skill = $('#candidateSkill').value.trim().toLowerCase();
  const education = $('#candidateEducation').value.trim().toLowerCase();
  const minimum = Number($('#candidateMinimum').value || 0);
  const maximum = $('#candidateMaximum').value === '' ? 100 : Number($('#candidateMaximum').value);
  const status = $('#candidateStatusFilter').value;
  const recruiter = $('#candidateRecruiterFilter') ? $('#candidateRecruiterFilter').value.trim().toLowerCase() : '';
  const matchMap = new Map();
  for (const match of state.matches) matchMap.set(match.candidateId, [...(matchMap.get(match.candidateId) || []), match]);
  const rows = candidateRows(state.candidates, matchMap).filter(({ candidate, profile, loc, skills }) => {
    const contactText = `${candidate.name} ${candidate.email} ${candidate.phone}`.toLowerCase();
    const candidateMatches = matchMap.get(candidate.id) || [];
    const score = Math.max(0, ...candidateMatches.map(match => match.total));
    const candRecruiter = String(candidate.recruiter || '').trim().toLowerCase();
    return (!query || contactText.includes(query)) && (!location || loc.toLowerCase().includes(location)) &&
      (!experience || String(profile.totalExperience || '').toLowerCase().includes(experience)) &&
      (!designation || String(profile.designation || '').toLowerCase().includes(designation)) &&
      (!education || (profile.education || []).join(' ').toLowerCase().includes(education)) &&
      (!skill || `${skills} ${(profile.skills || []).join(' ')}`.toLowerCase().includes(skill)) &&
      score >= minimum && score <= maximum && (!status || candidate.status === status) &&
      (!recruiter || candRecruiter === recruiter);
  });
  $('#candidateList').innerHTML = rows.length ? `<table class="riq-table"><thead><tr><th>Candidate</th><th>Experience / location</th><th>Skills</th><th>Best match</th><th>Recruiter status</th><th>Actions</th></tr></thead><tbody>${rows.map(({ candidate, profile, loc, skills, best }) => `<tr><td><strong>${escapeHtml(candidate.name)}</strong><span class="candidate-email">${escapeHtml(candidate.email || 'Not Mentioned')} · ${escapeHtml(candidate.phone || 'Not Mentioned')}</span></td><td>${escapeHtml(profile.totalExperience || 'Not Mentioned')}<span class="candidate-email">${escapeHtml(loc)}</span></td><td>${escapeHtml(skills)}</td><td>${best ? `${best.total}% · ${escapeHtml(best.category)}${best.mandatoryMet ? '' : ' · Mandatory gap'}` : 'Not matched'}</td><td><select class="riq-status" data-status-id="${escapeHtml(candidate.id)}">${statusOptions(candidate.status)}</select></td><td><button class="action-button" type="button" data-profile-candidate="${escapeHtml(candidate.id)}">Profile</button><button class="action-button" type="button" data-edit-candidate="${escapeHtml(candidate.id)}">Notes / history</button><button class="action-button" type="button" data-export-candidate="${escapeHtml(candidate.id)}">Export</button><button class="action-button primary-match-btn" type="button" data-open-match="${escapeHtml(candidate.id)}" style="background:var(--brand-soft);color:var(--brand);border-color:var(--brand);font-weight:700">⚡ AI Match</button><div class="riq-inline" style="margin-top:4px"><select class="riq-status" aria-label="Select job for ${escapeHtml(candidate.name)}" data-rematch-job="${escapeHtml(candidate.id)}">${state.jobs.filter(job => job.status === 'Active').map(job => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}</option>`).join('') || '<option value="">No active jobs</option>'}</select><button class="action-button" type="button" data-rematch-candidate="${escapeHtml(candidate.id)}" ${state.jobs.some(job => job.status === 'Active') ? '' : 'disabled'}>Quick match</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="riq-empty">No candidate records match these filters.</p>';
}
function statusOptions(selected) { return STATUSES.map(status => `<option ${status === selected ? 'selected' : ''}>${escapeHtml(status)}</option>`).join(''); }
function renderMatches() {
  const jobId = $('#matchJobFilter').value, q = $('#matchSearch').value.trim().toLowerCase(), min = Number($('#matchMinimum').value || 0);
  const recruiter = $('#matchRecruiterFilter') ? $('#matchRecruiterFilter').value.trim().toLowerCase() : '';
  const rows = state.matches.filter(match => !jobId || match.jobId === jobId)
    .map(match => ({ match, candidate: candidateFor(match.candidateId), job: jobFor(match.jobId) }))
    .filter(({ match, candidate }) => {
      if (!candidate || match.total < min) return false;
      if (q && !`${candidate.name} ${candidate.email} ${candidate.phone}`.toLowerCase().includes(q)) return false;
      if (recruiter && String(candidate.recruiter || '').trim().toLowerCase() !== recruiter) return false;
      return true;
    })
    .sort((a, b) => b.match.total - a.match.total);
  $('#matchList').innerHTML = rows.length ? `<table class="riq-table"><thead><tr><th>Compare</th><th>Candidate</th><th>Job</th><th>Score</th><th>Relevant experience</th><th>Skills</th><th>Recommendation</th><th></th></tr></thead><tbody>${rows.map(({ match, candidate, job }, index) => `<tr><td><input aria-label="Select ${escapeHtml(candidate.name)} to compare" type="checkbox" data-compare="${escapeHtml(match.id)}" ${selectedForCompare.has(match.id) ? 'checked' : ''}></td><td><strong>${index + 1}. ${escapeHtml(candidate.name)}</strong><span class="candidate-email">${escapeHtml(candidate.email || 'Not Mentioned')}</span></td><td>${escapeHtml(job?.title || 'Archived job')}</td><td><span class="riq-badge">${match.total}% · ${escapeHtml(match.category)}</span>${match.mandatoryMet ? '' : '<span class="riq-badge alert" style="margin-left:4px">Mandatory gap</span>'}</td><td>${escapeHtml(match.relevantExperience || 'Not Mentioned')}</td><td><strong>Matched:</strong> ${escapeHtml((match.matchedSkills || []).join(', ') || 'None')}<br><strong>Missing:</strong> ${escapeHtml((match.missingSkills || []).join(', ') || 'None')}</td><td>${escapeHtml(match.recommendation || '')}</td><td><button class="action-button" type="button" data-match-detail="${escapeHtml(match.id)}">Evidence</button></td></tr>`).join('')}</tbody></table>` : '<p class="riq-empty">No saved matching results for this filter.</p>';
}
function renderShortlist() {
  const statuses = ['Shortlisted', 'Interview Scheduled', 'Interviewed', 'Selected', 'Offered', 'Joined'];
  const q = $('#shortlistSearch') ? $('#shortlistSearch').value.trim().toLowerCase() : '';
  const recruiter = $('#shortlistRecruiterFilter') ? $('#shortlistRecruiterFilter').value.trim().toLowerCase() : '';
  const statusFilter = $('#shortlistStatusFilter') ? $('#shortlistStatusFilter').value : '';
  const candidates = state.candidates.filter(candidate => {
    if (!statuses.includes(candidate.status)) return false;
    if (statusFilter && candidate.status !== statusFilter) return false;
    if (recruiter && String(candidate.recruiter || '').trim().toLowerCase() !== recruiter) return false;
    if (q && !`${candidate.name} ${candidate.email} ${candidate.phone}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const matchMap = new Map();
  for (const match of state.matches) matchMap.set(match.candidateId, [...(matchMap.get(match.candidateId) || []), match]);
  const rows = candidateRows(candidates, matchMap);
  $('#shortlistList').innerHTML = rows.length ? `<table class="riq-table"><thead><tr><th>Candidate</th><th>Job match</th><th>Status</th><th>Recruiter</th><th>Follow-up</th><th>Actions</th></tr></thead><tbody>${rows.map(({ candidate, best }) => `<tr><td><strong>${escapeHtml(candidate.name)}</strong><span class="candidate-email">${escapeHtml(candidate.email || '')} · ${escapeHtml(candidate.phone || '')}</span></td><td>${best ? `${best.total}% · ${escapeHtml(jobFor(best.jobId)?.title || 'Archived job')}` : 'Not matched'}</td><td>${escapeHtml(candidate.status)}</td><td>${escapeHtml(candidate.recruiter || 'Not assigned')}</td><td>${escapeHtml(candidate.followUpDate || '—')}</td><td><button class="action-button" type="button" data-edit-candidate="${escapeHtml(candidate.id)}">Update</button></td></tr>`).join('')}</tbody></table>` : '<p class="riq-empty">No candidates have recruiter statuses in the shortlist funnel.</p>';
}
function renderAll() {
  updateRecruiterFilterOptions();
  renderMetrics(state.dashboard || {});
  renderJobs();
  renderProcessing();
  renderCandidates();
  renderMatches();
  renderShortlist();
}
async function refresh() {
  const next = await api('');
  state = next;
  renderAll();
}
function choosePage(page) {
  $$('.riq-tabs [role=tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.page === page)));
  $$('[data-view]').forEach(view => { view.hidden = view.dataset.view !== page; });
  if (page === 'candidates') renderCandidates();
  if (page === 'matches') renderMatches();
}
function loadJobIntoForm(job) {
  editingJobId = job?.id || '';
  $('#jobTitle').value = job?.title || '';
  $('#jobDescription').value = job?.description || '';
  const req = job?.requirements || {};
  $('#minExperience').value = req.minExperience || '';
  setLines('#jobSkills', req.skills);
  setLines('#jobMandatory', req.mandatory);
  setLines('#jobEducation', req.education);
  setLines('#jobIndustries', req.industries);
  setLines('#jobResponsibilities', req.responsibilities);
  setLines('#jobTools', [...(req.tools || []), ...(req.certifications || [])]);
  fillWeights(req.weights);
  $('#jobForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openCandidateDialog(id) {
  const candidate = candidateFor(id);
  if (!candidate) return;
  $('#candidateDialogTitle').textContent = candidate.name;
  $('#dialogCandidateId').value = id;
  $('#dialogStatus').innerHTML = statusOptions(candidate.status);
  $('#dialogRecruiter').value = candidate.recruiter || '';
  $('#dialogFollowUp').value = candidate.followUpDate || '';
  $('#dialogComments').value = candidate.comments || '';
  $('#dialogInterviewNotes').value = candidate.interviewNotes || '';
  $('#dialogRejectionReason').value = candidate.rejectionReason || '';
  $('#dialogMessage').textContent = '';
  $('#candidateDialog').showModal();
}
function safeText(value) { return escapeHtml(value || 'Not Mentioned'); }
function renderCompare() {
  const selected = [...selectedForCompare].slice(0, 2).map(id => state.matches.find(match => match.id === id)).filter(Boolean);
  if (selected.length !== 2) { $('#compareResult').innerHTML = selected.length ? '<p class="riq-empty">Select one more result to compare side by side.</p>' : ''; return; }
  $('#compareResult').innerHTML = `<div class="riq-compare">${selected.map(match => {
    const candidate = candidateFor(match.candidateId), job = jobFor(match.jobId);
    return `<article><h3>${safeText(candidate?.name)} · ${match.total}%</h3><p>${safeText(job?.title)} · ${safeText(match.category)}</p><p><strong>Relevant experience:</strong> ${safeText(match.relevantExperience)}</p><p><strong>Education:</strong> ${safeText(match.educationMatch)}</p><p><strong>Industry:</strong> ${safeText(match.industryMatch)}</p><p><strong>Matched skills:</strong> ${safeText((match.matchedSkills || []).join(', '))}</p><p><strong>Missing skills:</strong> ${safeText((match.missingSkills || []).join(', '))}</p><p><strong>Mandatory:</strong> ${match.mandatoryMet ? 'Met' : 'Gap to review'}</p></article>`;
  }).join('')}</div>`;
}
function showMatchDetail(id) {
  const match = state.matches.find(item => item.id === id);
  if (!match) return;
  const candidate = candidateFor(match.candidateId), job = jobFor(match.jobId);
  const profile = candidate?.profile || {};
  $('#candidateDialogTitle').textContent = `${candidate?.name || 'Candidate'} · ${match.total}% match`;
  $('#dialogCandidateId').value = candidate?.id || '';
  $('#dialogStatus').innerHTML = statusOptions(candidate?.status || 'Hold');
  $('#dialogRecruiter').value = candidate?.recruiter || '';
  $('#dialogFollowUp').value = candidate?.followUpDate || '';
  $('#dialogComments').value = candidate?.comments || '';
  $('#dialogInterviewNotes').value = candidate?.interviewNotes || '';
  $('#dialogRejectionReason').value = candidate?.rejectionReason || '';
  const previous = $('#dialogMessage');
  const fact = (label, value) => `<div class="riq-fact"><small>${label}</small><strong>${safeText(value)}</strong></div>`;
  const dimensions = (match.dimensions || []).map(item => `<div class="riq-report-dim"><span>${escapeHtml(item.name)} <small>${Number(item.weight) || 0}% weight</small></span><div class="riq-bar"><i style="width:${Math.max(0, Math.min(100, Number(item.score) || 0))}%"></i></div><strong>${Number(item.score) || 0}%</strong></div>`).join('');
  const mandatory = (match.mandatoryRequirements || []).map(item => `<p><strong>${item.met ? '✓ Met' : 'Review'}:</strong> ${escapeHtml(item.requirement)} <span class="riq-report-evidence">${escapeHtml(item.evidence)}</span></p>`).join('') || '<p>No mandatory requirements listed.</p>';
  const bullets = items => items?.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>Not mentioned in the CV/JD evidence.</p>';
  previous.innerHTML = `<section class="riq-report"><div><strong>${escapeHtml(job?.title || 'Archived job')}</strong><div class="riq-report-evidence">${escapeHtml(match.category)} · AI supported screening for recruiter review</div></div><div class="riq-report-head"><div class="riq-donut" style="--score:${Math.max(0, Math.min(100, Number(match.total) || 0))}"><span>${Number(match.total) || 0}%</span></div><div><strong>Overall JD match</strong><p>${escapeHtml(match.recommendation || 'Review the source evidence with the candidate.')}</p></div></div><div class="riq-facts">${fact('Candidate location', profile.location)}${fact('Total experience', profile.totalExperience)}${fact('JD relevant experience', match.relevantExperience || profile.relevantExperience)}${fact('Education', (profile.education || []).join(', '))}${fact('Education match', match.educationMatch)}${fact('Industry match', match.industryMatch)}</div><div><h3>Match by JD area</h3>${dimensions}</div><div class="riq-report-cols"><article class="riq-report-box"><h3>Strengths</h3>${bullets(match.strengths)}</article><article class="riq-report-box"><h3>Gaps / weaknesses</h3>${bullets(match.weaknesses)}<p><strong>Missing skills:</strong> ${escapeHtml((match.missingSkills || []).join(', ') || 'None identified')}</p></article></div><article class="riq-report-box"><h3>Mandatory JD requirements</h3>${mandatory}</article><article class="riq-report-box"><h3>Evidence by scoring area</h3>${(match.dimensions || []).map(item => `<p><strong>${escapeHtml(item.name)} (${Number(item.score) || 0}%):</strong> <span class="riq-report-evidence">${escapeHtml(item.evidence)}</span></p>`).join('')}</article><article class="riq-report-box"><h3>Suggested interview verification</h3>${bullets(match.verifyInInterview)}</article></section>`;
  $('#candidateDialog').showModal();
}
function showCandidateProfile(id) {
  const candidate = candidateFor(id);
  if (!candidate) return;
  const profile = candidate.profile || {};
  $('#candidateDialogTitle').textContent = `${candidate.name} · CV profile`;
  $('#dialogCandidateId').value = id;
  $('#dialogStatus').innerHTML = statusOptions(candidate.status);
  $('#dialogRecruiter').value = candidate.recruiter || '';
  $('#dialogFollowUp').value = candidate.followUpDate || '';
  $('#dialogComments').value = candidate.comments || '';
  $('#dialogInterviewNotes').value = candidate.interviewNotes || '';
  $('#dialogRejectionReason').value = candidate.rejectionReason || '';
  $('#dialogMessage').innerHTML = `<strong>Talent Acquisition record</strong>: ${candidate.talentCandidateId ? 'Linked' : 'No existing record linked'}<br><strong>Contact</strong>: ${safeText(profile.phone)} · ${safeText(profile.email)}<br><strong>Location</strong>: ${safeText(profile.location)}<br><strong>Current role / company</strong>: ${safeText(profile.designation)} · ${safeText(profile.currentCompany)}<br><strong>Total / relevant experience</strong>: ${safeText(profile.totalExperience)} · ${safeText(profile.relevantExperience)}<br><strong>Education</strong>: ${safeText((profile.education || []).join(', '))}<br><strong>Skills</strong>: ${safeText((profile.skills || []).join(', '))}<br><strong>Industries</strong>: ${safeText((profile.industries || []).join(', '))}<br><strong>Certifications / tools</strong>: ${safeText([...(profile.certifications || []), ...(profile.tools || [])].join(', '))}<br><strong>Notice period / CTC</strong>: ${safeText(profile.noticePeriod)} · ${safeText(profile.currentCtc)} · ${safeText(profile.expectedCtc)}<br><strong>Responsibilities</strong>: ${safeText((profile.responsibilities || []).join('; '))}<br><strong>Achievements</strong>: ${safeText((profile.achievements || []).join('; '))}<br><strong>Evidence from CV</strong>: ${(profile.evidence || []).map(item => `${escapeHtml(item.field)}: “${escapeHtml(item.quote)}”`).join('; ') || 'Not Mentioned'}<br><strong>History</strong>: ${(candidate.history || []).map(item => `${escapeHtml(item.at)} ${escapeHtml(item.type)}`).join('; ') || 'No history'}`;
  $('#candidateDialog').showModal();
}
async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function printReport() {
  const jobId = $('#exportJob').value;
  const candidateId = $('#exportCandidate').value;
  const rows = state.matches.filter(match => (!jobId || match.jobId === jobId) && (!candidateId || match.candidateId === candidateId)).slice().sort((a, b) => b.total - a.total).map(match => {
    const candidate = candidateFor(match.candidateId) || {}, job = jobFor(match.jobId) || {};
    return `<tr><td>${escapeHtml(candidate.name || 'Not Mentioned')}<br>${escapeHtml(candidate.email || '')}<br>${escapeHtml(candidate.phone || '')}</td><td>${escapeHtml(job.title || 'Archived job')}</td><td>${match.total}% · ${escapeHtml(match.category)}<br>${match.mandatoryMet ? 'Mandatory met' : 'Mandatory gap'}</td><td>${escapeHtml((match.matchedSkills || []).join(', ') || 'None')}</td><td>${escapeHtml((match.missingSkills || []).join(', ') || 'None')}</td><td>${escapeHtml(match.relevantExperience || 'Not Mentioned')}<br>${escapeHtml(match.recommendation || '')}</td></tr>`;
  }).join('');
  const report = window.open('', '_blank');
  if (!report) return alert('Allow pop-ups to print the RecruitIQ report.');
  report.document.write(`<!doctype html><html><head><title>RecruitIQ screening report</title><style>body{font:12px Arial,sans-serif;color:#172d3c;padding:24px}h1{font-size:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccd7de;padding:8px;text-align:left;vertical-align:top}th{background:#eef4f7}small{color:#60717a}@media print{body{padding:0}}</style></head><body><h1>RecruitIQ screening report</h1><p>${candidateId ? escapeHtml(candidateFor(candidateId)?.name || 'Selected candidate') : jobId ? escapeHtml(jobFor(jobId)?.title || 'Selected job') : 'All job openings'} · Generated ${escapeHtml(new Date().toLocaleString())}</p><table><thead><tr><th>Candidate contact</th><th>Job</th><th>Match</th><th>Matched skills</th><th>Missing skills</th><th>Experience / recommendation</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No saved match reports.</td></tr>'}</tbody></table><script>window.onload=()=>window.print();<` + `/script></body></html>`);
  report.document.close();
}
async function openMatchModal(candidateId) {
  const candidate = candidateFor(candidateId);
  if (!candidate) return;
  const activeJobs = state.jobs.filter(j => j.status === 'Active');
  if (!activeJobs.length) {
    alert('There are no active job openings available. Create an active job first.');
    return;
  }
  $('#matchCandidateId').value = candidateId;
  $('#matchDialogTitle').textContent = `AI Match · ${candidate.name}`;
  $('#matchDialogSubtitle').textContent = `Match ${candidate.name} against an active job opening to evaluate ATS score, required skills, and mandatory criteria.`;
  $('#matchSelectJob').innerHTML = activeJobs.map(j => `<option value="${escapeHtml(j.id)}">${escapeHtml(j.title)}</option>`).join('');
  $('#matchCandidateMessage').textContent = '';
  $('#matchCandidateCv').value = '';
  try {
    const detail = await api(`/candidates/${encodeURIComponent(candidateId)}`);
    if (detail?.cvText) {
      $('#matchCandidateCv').value = detail.cvText;
    }
  } catch (_) {}
  $('#matchCandidateDialog').showModal();
}

function init() {
  fillWeights();
  $('#candidateStatusFilter').innerHTML = `<option value="">All statuses</option>${STATUSES.map(status => `<option>${escapeHtml(status)}</option>`).join('')}`;
  $('#dialogStatus').innerHTML = statusOptions('Hold');
  $$('.riq-tabs [role=tab]').forEach(button => button.addEventListener('click', () => choosePage(button.dataset.page)));
  $('#refreshButton').addEventListener('click', () => refresh().catch(error => alert(error.message)));
  $('#jobForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter || event.target.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const body = { title: $('#jobTitle').value.trim(), description: $('#jobDescription').value.trim(), requirements: currentRequirements() };
      await api(editingJobId ? `/jobs/${encodeURIComponent(editingJobId)}` : '/jobs', { method: editingJobId ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setMessage('#jobMessage', editingJobId ? 'Job updated.' : 'Job saved.');
      editingJobId = '';
      event.target.reset();
      fillWeights();
      await refresh();
    } catch (error) { setMessage('#jobMessage', error.message, true); }
    finally { button.disabled = false; }
  });
  $('#extractJobButton').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; setMessage('#jobMessage', 'Extracting requirements…');
    try {
      const extracted = await api('/jobs/extract', { method: 'POST', body: JSON.stringify({ description: $('#jobDescription').value }) });
      if (extracted.title) $('#jobTitle').value = extracted.title;
      const req = extracted.requirements || {};
      $('#minExperience').value = req.minExperience || '';
      setLines('#jobSkills', req.skills); setLines('#jobMandatory', req.mandatory); setLines('#jobEducation', req.education);
      setLines('#jobIndustries', req.industries); setLines('#jobResponsibilities', req.responsibilities);
      setLines('#jobTools', [...(req.tools || []), ...(req.certifications || [])]); fillWeights(req.weights);
      setMessage('#jobMessage', 'Review and edit extracted requirements before saving.');
    } catch (error) { setMessage('#jobMessage', error.message, true); }
    finally { button.disabled = false; }
  });
  $('#jobFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setMessage('#jobMessage', 'Job-description file must be 10 MB or smaller.', true); event.target.value = ''; return; }
    setMessage('#jobMessage', 'Reading job description…');
    try {
      const description = await api('/jobs/read-document', { method: 'POST', body: JSON.stringify({ name: file.name, data: await encodeFile(file) }) });
      $('#jobDescription').value = description.description;
      setMessage('#jobMessage', `Loaded ${file.name}. Review the text and use AI extraction if desired.`);
    } catch (error) { setMessage('#jobMessage', error.message, true); }
  });
  $('#jobList').addEventListener('click', async event => {
    const edit = event.target.closest('[data-edit-job]'), toggle = event.target.closest('[data-toggle-job]');
    try {
      if (edit) loadJobIntoForm(jobFor(edit.dataset.editJob));
      if (toggle) {
        const job = jobFor(toggle.dataset.toggleJob);
        await api(`/jobs/${encodeURIComponent(job.id)}`, { method: 'PUT', body: JSON.stringify({ status: job.status === 'Active' ? 'Closed' : 'Active' }) });
        await refresh();
      }
    } catch (error) { alert(error.message); }
  });
  $('#uploadForm').addEventListener('submit', async event => {
    event.preventDefault();
    const files = [...$('#cvFiles').files], jobId = $('#uploadJob').value;
    if (!files.length) return setMessage('#uploadMessage', 'Choose at least one CV file.', true);
    if (files.length > 25) return setMessage('#uploadMessage', 'Upload no more than 25 files at a time.', true);
    if (files.some(file => file.size > 10 * 1024 * 1024)) return setMessage('#uploadMessage', 'Each file must be 10 MB or smaller.', true);
    if (files.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) return setMessage('#uploadMessage', 'Keep each batch at or below 20 MB total; split larger batches into smaller uploads.', true);
    const button = $('#uploadButton'); button.disabled = true; setMessage('#uploadMessage', 'Preparing files…');
    try {
      const encoded = await Promise.all(files.map(async file => ({ name: file.name, data: await encodeFile(file) })));
      const rows = await api('/uploads', { method: 'POST', body: JSON.stringify({ jobId, files: encoded }) });
      setMessage('#uploadMessage', `Queued ${rows.length} file(s). Processing status will update automatically.`);
      event.target.reset();
      await refresh();
    } catch (error) { setMessage('#uploadMessage', error.message, true); }
    finally { button.disabled = false; }
  });
  $('#uploadList').addEventListener('click', async event => {
    const reportButton = event.target.closest('[data-match-detail]');
    if (reportButton) { showMatchDetail(reportButton.dataset.matchDetail); return; }
    const button = event.target.closest('[data-retry]');
    if (!button) return;
    button.disabled = true;
    try { await api(`/uploads/${encodeURIComponent(button.dataset.retry)}/retry`, { method: 'POST', body: '{}' }); await refresh(); }
    catch (error) { alert(error.message); }
  });
  if ($('#shortlistStatusFilter')) {
    $('#shortlistStatusFilter').innerHTML = `<option value="">All shortlist statuses</option>${['Shortlisted', 'Interview Scheduled', 'Interviewed', 'Selected', 'Offered', 'Joined'].map(s => `<option value="${s}">${s}</option>`).join('')}`;
  }
  ['#candidateSearch', '#candidateLocation', '#candidateExperience', '#candidateDesignation', '#candidateSkill', '#candidateEducation', '#candidateMinimum', '#candidateMaximum', '#candidateStatusFilter', '#candidateRecruiterFilter'].forEach(selector => {
    const el = $(selector);
    if (el) {
      el.addEventListener('input', renderCandidates);
      el.addEventListener('change', renderCandidates);
    }
  });
  ['#shortlistSearch', '#shortlistRecruiterFilter', '#shortlistStatusFilter'].forEach(selector => {
    const el = $(selector);
    if (el) {
      el.addEventListener('input', renderShortlist);
      el.addEventListener('change', renderShortlist);
    }
  });
  $('#candidateList').addEventListener('change', async event => {
    const select = event.target.closest('[data-status-id]');
    if (!select) return;
    try { await api(`/candidates/${encodeURIComponent(select.dataset.statusId)}`, { method: 'PUT', body: JSON.stringify({ status: select.value }) }); await refresh(); }
    catch (error) { alert(error.message); await refresh(); }
  });
  $('#candidateList').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-candidate]'), profile = event.target.closest('[data-profile-candidate]'), exportCandidate = event.target.closest('[data-export-candidate]'), rematch = event.target.closest('[data-rematch-candidate]'), openMatch = event.target.closest('[data-open-match]');
    if (openMatch) openMatchModal(openMatch.dataset.openMatch);
    if (edit) openCandidateDialog(edit.dataset.editCandidate);
    if (profile) showCandidateProfile(profile.dataset.profileCandidate);
    if (exportCandidate) location.href = `/api/recruit-iq/export.xlsx?candidateId=${encodeURIComponent(exportCandidate.dataset.exportCandidate)}`;
    if (rematch) {
      const jobId = rematch.closest('tr').querySelector('[data-rematch-job]').value;
      if (!jobId) return alert('Select an active job opening.');
      rematch.disabled = true;
      api(`/jobs/${encodeURIComponent(jobId)}/match/${encodeURIComponent(rematch.dataset.rematchCandidate)}`, { method: 'POST', body: '{}' })
        .then(async () => { await refresh(); choosePage('matches'); $('#matchJobFilter').value = jobId; renderMatches(); })
        .catch(error => {
          if (error.message.includes('CV text')) {
            openMatchModal(rematch.dataset.rematchCandidate);
          } else {
            alert(error.message);
          }
        })
        .finally(() => { rematch.disabled = false; });
    }
  });
  $('#addCandidateButton').addEventListener('click', () => { $('#addCandidateMessage').textContent = ''; $('#addCandidateDialog').showModal(); });
  $('#addCandidateForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      await api('/candidates', { method: 'POST', body: JSON.stringify({
        name: $('#newName').value, email: $('#newEmail').value, phone: $('#newPhone').value,
        recruiter: $('#newRecruiter').value, cvText: $('#newCvText') ? $('#newCvText').value : ''
      }) });
      $('#addCandidateDialog').close(); event.target.reset(); await refresh();
    } catch (error) { $('#addCandidateMessage').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#matchCandidateForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#runMatchButton');
    const msg = $('#matchCandidateMessage');
    const candidateId = $('#matchCandidateId').value;
    const jobId = $('#matchSelectJob').value;
    const cvText = $('#matchCandidateCv').value.trim();
    if (!jobId) { msg.textContent = 'Please select a job opening.'; return; }
    button.disabled = true;
    msg.textContent = 'Analyzing and running AI match assessment…';
    try {
      await api(`/jobs/${encodeURIComponent(jobId)}/match/${encodeURIComponent(candidateId)}`, {
        method: 'POST',
        body: JSON.stringify({ cvText })
      });
      $('#matchCandidateDialog').close();
      await refresh();
      choosePage('matches');
      $('#matchJobFilter').value = jobId;
      renderMatches();
    } catch (error) {
      msg.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('#candidateForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      await api(`/candidates/${encodeURIComponent($('#dialogCandidateId').value)}`, { method: 'PUT', body: JSON.stringify({
        status: $('#dialogStatus').value, recruiter: $('#dialogRecruiter').value, followUpDate: $('#dialogFollowUp').value,
        comments: $('#dialogComments').value, interviewNotes: $('#dialogInterviewNotes').value, rejectionReason: $('#dialogRejectionReason').value
      }) });
      $('#candidateDialog').close(); await refresh();
    } catch (error) { $('#dialogMessage').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#matchJobFilter').addEventListener('change', renderMatches);
  if ($('#matchRecruiterFilter')) $('#matchRecruiterFilter').addEventListener('change', renderMatches);
  $('#matchSearch').addEventListener('input', renderMatches);
  $('#matchMinimum').addEventListener('input', renderMatches);
  $('#matchList').addEventListener('change', event => {
    const checkbox = event.target.closest('[data-compare]'); if (!checkbox) return;
    if (checkbox.checked && selectedForCompare.size >= 2) { checkbox.checked = false; return alert('Select no more than two results.'); }
    if (checkbox.checked) selectedForCompare.add(checkbox.dataset.compare); else selectedForCompare.delete(checkbox.dataset.compare);
  });
  $('#compareButton').addEventListener('click', renderCompare);
  $('#matchList').addEventListener('click', event => { const button = event.target.closest('[data-match-detail]'); if (button) showMatchDetail(button.dataset.matchDetail); });
  $('#shortlistList').addEventListener('click', event => { const button = event.target.closest('[data-edit-candidate]'); if (button) openCandidateDialog(button.dataset.editCandidate); });
  $('#exportButton').addEventListener('click', () => {
    const jobId = $('#exportJob').value;
    const candidateId = $('#exportCandidate').value;
    const params = new URLSearchParams();
    if (jobId) params.set('jobId', jobId);
    if (candidateId) params.set('candidateId', candidateId);
    const query = params.toString();
    location.href = `/api/recruit-iq/export.xlsx${query ? `?${query}` : ''}`;
  });
  $('#printButton').addEventListener('click', printReport);
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.replace('/'); });
  refresh().catch(error => { $('#metrics').innerHTML = `<p class="status-message">${escapeHtml(error.message)}</p>`; });
  setInterval(() => {
    if (!document.hidden && state.processing.some(item => ['queued', 'processing'].includes(item.status))) refresh().catch(() => {});
  }, 2500);
  api('/ai-status').then(data => { $('#aiConfig').textContent = data.configured ? `AI provider available: ${data.provider}${data.model ? ` · ${data.model}` : ''}.` : 'AI provider is not configured. Set GEMINI_API_KEY / AI_API_KEY server-side or configure the provider in encrypted Settings.'; }).catch(() => {});
}
init();
