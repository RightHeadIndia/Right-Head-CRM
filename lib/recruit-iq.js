'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const runFile = promisify(execFile);
const PDFParse = require('pdf-parse').PDFParse;
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');

const STATUSES = ['Shortlisted', 'Hold', 'Rejected', 'Interview Scheduled', 'Interviewed', 'Selected', 'Offered', 'Joined'];
const SHORTLIST_STATUSES = ['Shortlisted', 'Interview Scheduled', 'Interviewed', 'Selected', 'Offered', 'Joined'];
const DIMENSIONS = ['Skills', 'Relevant experience', 'Industry experience', 'Role and responsibilities', 'Education', 'Tools and certifications'];
const DEFAULT_WEIGHTS = { Skills: 30, 'Relevant experience': 20, 'Industry experience': 15, 'Role and responsibilities': 15, Education: 10, 'Tools and certifications': 10 };
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 25;

const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value, maxItems = 40, maxText = 300) => Array.isArray(value) ? [...new Set(value.map(item => text(item, maxText)).filter(Boolean))].slice(0, maxItems) : [];
const nowIso = () => new Date().toISOString();
const validBase64 = value => typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
const privateEmail = value => {
  const email = text(value, 254).toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
};
const normalizePhone = value => text(value, 50).replace(/\D/g, '').slice(-15);

function cleanRequirements(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const weightsIn = value.weights && typeof value.weights === 'object' && !Array.isArray(value.weights) ? value.weights : {};
  const weights = {};
  let total = 0;
  for (const name of DIMENSIONS) {
    const raw = weightsIn[name] === undefined ? DEFAULT_WEIGHTS[name] : Number(weightsIn[name]);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) throw Object.assign(new Error(`Weight for ${name} must be between 0 and 100.`), { status: 400 });
    weights[name] = raw;
    total += raw;
  }
  if (total !== 100) throw Object.assign(new Error('Matching weights must add up to 100%.'), { status: 400 });
  return {
    weights,
    minExperience: text(value.minExperience, 100),
    education: list(value.education, 20, 200),
    skills: list(value.skills, 80, 120),
    industries: list(value.industries, 30, 120),
    responsibilities: list(value.responsibilities, 40, 300),
    tools: list(value.tools, 40, 120),
    certifications: list(value.certifications, 40, 150),
    mandatory: list(value.mandatory, 40, 300)
  };
}

function scoreCategory(total) {
  if (total >= 85) return 'Excellent Match';
  if (total >= 70) return 'Good Match';
  if (total >= 55) return 'Moderate Match';
  return 'Low Match';
}

function verifyMatch(aiResult, requirements, cvText, jobDescription = '') {
  const normalize = value => String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedCv = normalize(cvText);
  const normalizedJob = normalize(jobDescription);
  const inCv = value => Boolean(value && normalizedCv.includes(normalize(value)));
  const inJob = value => Boolean(value && normalizedJob.includes(normalize(value)));
  const incoming = Array.isArray(aiResult.matching?.dimensions) ? aiResult.matching.dimensions : [];
  const dimensions = DIMENSIONS.map(name => {
    const item = incoming.find(row => row.name.toLowerCase() === name.toLowerCase());
    const rawScore = Number(item?.score);
    if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > 100) {
      throw Object.assign(new Error(`The AI response did not contain a valid ${name} score. Retry the assessment.`), { status: 502 });
    }
    const evidence = text(item.evidence, 600);
    return { name, weight: requirements.weights[name], score: Math.round(rawScore), evidence: evidence && (inCv(evidence) || inJob(evidence)) ? evidence : 'No directly verifiable source excerpt returned.' };
  });
  const total = Math.round(dimensions.reduce((sum, item) => sum + item.weight * item.score, 0) / 100);
  const profile = aiResult.profile;
  const match = aiResult.matching;
  const sourced = (value, max = 300) => {
    const clean = text(value, max);
    return clean && inCv(clean) ? clean : 'Not Mentioned';
  };
  const sourcedList = (value, maxItems = 40, maxText = 300) => list(value, maxItems, maxText).filter(inCv);
  const mandatoryFromJob = requirements.mandatory.map(requirement => {
    const source = (match.mandatoryRequirements || []).find(item => item.requirement.toLowerCase() === requirement.toLowerCase());
    const quote = text(source?.evidence, 500);
    const evidenced = inCv(quote);
    return { requirement, met: Boolean(source?.met && evidenced), evidence: evidenced ? quote : 'Not evidenced in CV' };
  });
  const mandatoryMet = mandatoryFromJob.every(item => item.met);
  const rawEmail = privateEmail(profile.email);
  const email = rawEmail && inCv(rawEmail) ? rawEmail : 'Not Mentioned';
  const rawPhone = text(profile.phone, 50);
  const phone = rawPhone && normalizePhone(rawPhone) && normalize(cvText).replace(/\D/g, '').includes(normalizePhone(rawPhone)) ? rawPhone : 'Not Mentioned';
  const history = Array.isArray(profile.employmentHistory) ? profile.employmentHistory.slice(0, 30).map(item => ({
    company: sourced(item.company, 200),
    designation: sourced(item.designation, 200),
    duration: sourced(item.duration, 120),
    responsibilities: sourcedList(item.responsibilities, 10)
  })) : [];
  return {
    profile: {
      ...profile,
      name: sourced(profile.name, 200),
      phone,
      email,
      location: sourced(profile.location, 200),
      currentCompany: sourced(profile.currentCompany, 200),
      designation: sourced(profile.designation, 200),
      totalExperience: sourced(profile.totalExperience, 100),
      relevantExperience: sourced(profile.relevantExperience, 100),
      noticePeriod: sourced(profile.noticePeriod, 100),
      currentCtc: sourced(profile.currentCtc, 100),
      expectedCtc: sourced(profile.expectedCtc, 100),
      skills: sourcedList(profile.skills),
      industries: sourcedList(profile.industries),
      education: sourcedList(profile.education),
      employmentHistory: history,
      certifications: sourcedList(profile.certifications),
      tools: sourcedList(profile.tools),
      responsibilities: sourcedList(profile.responsibilities),
      achievements: sourcedList(profile.achievements),
      evidence: Array.isArray(profile.evidence) ? profile.evidence.slice(0, 60).map(item => ({ field: text(item.field, 100), quote: text(item.quote, 500) })).filter(item => item.quote && inCv(item.quote)) : []
    },
    matching: {
      total,
      category: scoreCategory(total),
      mandatoryMet,
      dimensions,
      matchedSkills: list(match.matchedSkills).filter(skill => inCv(skill) && (requirements.skills.length ? requirements.skills.some(required => normalize(required) === normalize(skill)) : inJob(skill))),
      missingSkills: requirements.skills.length ? requirements.skills.filter(skill => !inCv(skill)) : list(match.missingSkills).filter(skill => inJob(skill) && !inCv(skill)),
      relevantExperience: inCv(match.relevantExperience) ? text(match.relevantExperience, 500) : 'Not Mentioned',
      experienceGap: inCv(match.experienceGap) || inJob(match.experienceGap) ? text(match.experienceGap, 500) : 'Not Mentioned',
      educationMatch: inCv(match.educationMatch) || inJob(match.educationMatch) ? text(match.educationMatch, 500) : 'Not Mentioned',
      industryMatch: inCv(match.industryMatch) || inJob(match.industryMatch) ? text(match.industryMatch, 500) : 'Not Mentioned',
      mandatoryRequirements: mandatoryFromJob,
      strengths: sourcedList(match.strengths, 12),
      weaknesses: list(match.weaknesses, 12).filter(item => inCv(item) || inJob(item)),
      verifyInInterview: list(match.verifyInInterview, 12),
      recommendation: text(match.recommendation, 1000) || 'Review the cited evidence with the candidate.',
      assessedAt: nowIso()
    }
  };
}

async function extractFile(file) {
  const name = path.basename(text(file.name, 240));
  const extension = path.extname(name).toLowerCase();
  const allowed = ['.pdf', '.doc', '.docx', '.txt', '.md', '.html'];
  if (!allowed.includes(extension)) throw new Error('Unsupported file type. Upload PDF, DOC, DOCX, TXT, MD or HTML.');
  if (!validBase64(file.data)) throw new Error('The uploaded file data is invalid.');
  const buffer = Buffer.from(file.data, 'base64');
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('Each file must be between 1 byte and 10 MB.');
  if (file.data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) throw new Error('Each file must be 10 MB or smaller.');

  if (extension === '.pdf') {
    const parser = new PDFParse({ data: buffer });
    let result;
    try { result = await parser.getText(); }
    finally { await parser.destroy(); }
    let extracted = text(result?.text, 50000);
    if (extracted.replace(/\s/g, '').length < 20) extracted = await runPdfOcr(buffer);
    if (!extracted.trim()) throw new Error('No readable text was found. This may be a scanned PDF; configure pdftoppm and tesseract for OCR or upload an OCR-processed copy.');
    return extracted;
  }
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return text(result.value, 50000);
  }
  if (extension === '.doc') {
    const extractor = new WordExtractor();
    const document = await extractor.extract(buffer);
    return text(document.getBody(), 50000);
  }
  let result = buffer.toString('utf8');
  if (extension === '.html') result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return text(result, 50000);
}

async function runPdfOcr(buffer) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitiq-ocr-'));
  try {
    const input = path.join(directory, 'upload.pdf');
    const prefix = path.join(directory, 'page');
    await fs.writeFile(input, buffer, { mode: 0o600 });
    await runFile(process.env.PDFTOPPM_CMD || 'pdftoppm', ['-f', '1', '-l', '10', '-r', '160', '-png', input, prefix], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const pages = (await fs.readdir(directory)).filter(name => /^page-\d+\.png$/i.test(name)).sort().slice(0, 10);
    const outputs = [];
    for (const page of pages) {
      const { stdout } = await runFile(process.env.TESSERACT_CMD || 'tesseract', [path.join(directory, page), 'stdout', '-l', process.env.OCR_LANG || 'eng'], { timeout: 30000, maxBuffer: 1024 * 1024 });
      outputs.push(stdout);
    }
    return outputs.join('\n').slice(0, 50000);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error('OCR could not read this scanned PDF. Check the pdftoppm/tesseract installation and try again.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function mount(app, ctx) {
  const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(error => {
    if (!res.headersSent && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    return next(error);
  });
  const uploadQueue = [];
  let activeWorkers = 0;
  const runUploadQueue = () => {
    while (activeWorkers < 2 && uploadQueue.length) {
      const id = uploadQueue.shift();
      activeWorkers++;
      processUpload(id).catch(error => console.error(`RecruitIQ upload worker failed (${id}):`, error.message)).finally(() => {
        activeWorkers--;
        runUploadQueue();
      });
    }
  };
  const enqueueUpload = id => { uploadQueue.push(id); runUploadQueue(); };
  const byId = (rows, id) => rows.find(item => item.id === id);
  const sanitizeCandidate = candidate => {
    const { cvText, ...publicRecord } = candidate;
    return { ...publicRecord, hasCv: Boolean(cvText) };
  };
  const jobMatch = (db, jobId, candidateId) => db.recruitIqMatches.find(item => item.jobId === jobId && item.candidateId === candidateId);
  const dashboard = db => {
    const matches = db.recruitIqMatches;
    const candidates = db.recruitIqCandidates;
    const processing = db.recruitIqProcessingJobs;
    const activeJobs = db.recruitIqJobs.filter(job => job.status === 'Active');
    const statusCount = status => candidates.filter(candidate => candidate.status === status).length;
    const matchCategories = matches.reduce((out, match) => { out[match.category] = (out[match.category] || 0) + 1; return out; }, {});
    const byJob = db.recruitIqJobs.map(job => ({
      id: job.id, title: job.title,
      candidates: matches.filter(match => match.jobId === job.id).length,
      excellent: matches.filter(match => match.jobId === job.id && match.category === 'Excellent Match').length,
      shortlisted: matches.filter(match => match.jobId === job.id && ['Shortlisted', 'Interview Scheduled', 'Interviewed', 'Selected', 'Offered', 'Joined'].includes(byId(candidates, match.candidateId)?.status)).length
    }));
    return {
      totalJobs: db.recruitIqJobs.length, activeJobs: activeJobs.length,
      totalCVs: processing.length, processedCVs: processing.filter(item => item.status === 'processed').length,
      failedProcessing: processing.filter(item => item.status === 'failed').length,
      excellentMatches: matches.filter(match => match.category === 'Excellent Match').length,
      goodMatches: matches.filter(match => match.category === 'Good Match').length,
      shortlisted: candidates.filter(candidate => SHORTLIST_STATUSES.includes(candidate.status)).length,
      interviewsScheduled: statusCount('Interview Scheduled'),
      selected: statusCount('Selected'),
      distribution: matchCategories, jobs: byJob,
      funnel: STATUSES.map(status => ({ status, count: statusCount(status) }))
    };
  };

  async function createAssessment(cvText, job, candidateName = '') {
    const analysis = await ctx.analyze(ctx.aiContext, { cvText, jobDescription: job.description, requirements: job.requirements });
    const verified = verifyMatch(analysis, job.requirements, cvText, job.description);
    const p = verified.profile;
    if (candidateName && p.name === 'Not Mentioned') p.name = candidateName;
    const hash = crypto.createHash('sha256').update(cvText.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
    const db = ctx.load();
    const email = p.email !== 'Not Mentioned' ? privateEmail(p.email) : '';
    const phone = p.phone !== 'Not Mentioned' ? normalizePhone(p.phone) : '';
    const linkedTalentCandidate = email ? db.candidates.find(item => String(item.email || '').trim().toLowerCase() === email) : null;
    let candidate = db.recruitIqCandidates.find(item => (email && item.email === email) || (phone && normalizePhone(item.phone) === phone) || (item.cvHashes || []).includes(hash));
    const timestamp = ctx.now();
    if (candidate) {
      candidate.cvHashes = [...new Set([...(candidate.cvHashes || []), hash])];
      candidate.cvText = cvText;
      candidate.profile = { ...candidate.profile, ...p };
      if (linkedTalentCandidate) candidate.talentCandidateId = linkedTalentCandidate.id;
      candidate.updatedAt = timestamp;
      candidate.history = [...(candidate.history || []), { type: 'CV updated', at: timestamp, jobId: job.id }].slice(-100);
    } else {
      candidate = {
        id: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp, status: 'Hold',
        profile: p, name: p.name !== 'Not Mentioned' ? p.name : candidateName || 'Not Mentioned',
        talentCandidateId: linkedTalentCandidate?.id || '',
        email, phone, cvText, cvHashes: [hash], recruiter: '', comments: '', interviewNotes: '', rejectionReason: '', followUpDate: '', history: []
      };
      db.recruitIqCandidates.push(candidate);
    }
    let match = jobMatch(db, job.id, candidate.id);
    const matchData = {
      jobId: job.id, candidateId: candidate.id, total: verified.matching.total,
      category: verified.matching.category, mandatoryMet: verified.matching.mandatoryMet,
      matchedSkills: verified.matching.matchedSkills, missingSkills: verified.matching.missingSkills,
      dimensions: verified.matching.dimensions, relevantExperience: verified.matching.relevantExperience,
      experienceGap: verified.matching.experienceGap, educationMatch: verified.matching.educationMatch,
      industryMatch: verified.matching.industryMatch, mandatoryRequirements: verified.matching.mandatoryRequirements,
      strengths: verified.matching.strengths, weaknesses: verified.matching.weaknesses,
      verifyInInterview: verified.matching.verifyInInterview, recommendation: verified.matching.recommendation,
      updatedAt: timestamp
    };
    if (match) Object.assign(match, matchData);
    else { match = { id: crypto.randomUUID(), createdAt: timestamp, ...matchData }; db.recruitIqMatches.push(match); }
    candidate.history = [...candidate.history, { type: `Matched to ${job.title}`, at: timestamp, jobId: job.id, matchId: match.id }].slice(-100);
    ctx.save(db);
    await ctx.flush();
    return { candidate: sanitizeCandidate(candidate), match };
  }

  async function processUpload(processingId) {
    const db = ctx.load();
    const record = byId(db.recruitIqProcessingJobs, processingId);
    if (!record || record.status !== 'queued') return;
    record.status = 'processing';
    record.updatedAt = ctx.now();
    ctx.save(db);
    await ctx.flush();
    try {
      const current = ctx.load();
      const currentRecord = byId(current.recruitIqProcessingJobs, processingId);
      const job = byId(current.recruitIqJobs, currentRecord.jobId);
      if (!job || job.status !== 'Active') throw new Error('The selected job is no longer active.');
      const cvText = await extractFile({ name: currentRecord.fileName, data: currentRecord.fileData });
      currentRecord.fileData = '';
      if (cvText.trim().length < 80) throw new Error('Not enough readable CV text was extracted (at least 80 characters are required).');
      const result = await createAssessment(cvText, job, '');
      const latest = ctx.load(), latestRecord = byId(latest.recruitIqProcessingJobs, processingId);
      latestRecord.status = 'processed';
      latestRecord.candidateId = result.candidate.id;
      latestRecord.matchId = result.match.id;
      latestRecord.updatedAt = ctx.now();
      latestRecord.error = '';
      latestRecord.fileData = '';
      ctx.save(latest);
      await ctx.flush();
    } catch (error) {
      const latest = ctx.load(), latestRecord = byId(latest.recruitIqProcessingJobs, processingId);
      if (!latestRecord) throw error;
      latestRecord.status = 'failed';
      latestRecord.error = text(error.message, 500) || 'Processing failed.';
      latestRecord.updatedAt = ctx.now();
      ctx.save(latest);
      await ctx.flush();
      console.error(`RecruitIQ CV processing failed (${processingId}):`, error.message);
    }
  }

  const pendingUploads = ctx.load();
  let resumedUploads = false;
  for (const record of pendingUploads.recruitIqProcessingJobs) {
    if (record.status === 'processing') {
      record.status = 'queued';
      record.error = 'Processing resumed after a server restart.';
      record.updatedAt = ctx.now();
      resumedUploads = true;
    }
  }
  if (resumedUploads) ctx.save(pendingUploads);
  for (const record of pendingUploads.recruitIqProcessingJobs) {
    if (record.status === 'queued' && record.fileData) enqueueUpload(record.id);
  }

  app.get('/api/recruit-iq', (req, res) => {
    const db = ctx.load();
    const view = String(req.query.view || 'all');
    const jobs = () => db.recruitIqJobs.map(job => ({ ...job, candidates: db.recruitIqMatches.filter(match => match.jobId === job.id).length })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (view === 'dashboard') return res.json({ dashboard: dashboard(db) });
    if (view === 'jobs') return res.json({ jobs: jobs() });
    if (view === 'uploads') return res.json({ jobs: jobs(), processing: db.recruitIqProcessingJobs.map(({ fileData, ...record }) => record).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    if (view === 'reports') return res.json({ jobs: jobs(), candidates: db.recruitIqCandidates.map(sanitizeCandidate) });
    if (['candidates', 'matches', 'shortlisted'].includes(view)) return res.json({
      jobs: jobs(), candidates: db.recruitIqCandidates.map(sanitizeCandidate),
      matches: db.recruitIqMatches.slice().sort((a, b) => b.total - a.total)
    });
    res.json({
      dashboard: dashboard(db), jobs: jobs(), candidates: db.recruitIqCandidates.map(sanitizeCandidate),
      matches: db.recruitIqMatches.slice().sort((a, b) => b.total - a.total),
      processing: db.recruitIqProcessingJobs.map(({ fileData, ...record }) => record).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    });
  });

  app.get('/api/recruit-iq/ai-status', (req, res) => {
    const settings = ctx.load().settings.ai || {};
    const requested = process.env.AI_PROVIDER || settings.provider || 'gemini';
    const provider = requested === 'groq' ? 'gemini' : (requested === 'gemini' || requested === 'openai-compatible' ? requested : 'gemini');
    const envKey = provider === 'gemini' ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) : process.env.AI_API_KEY;
    const configured = Boolean(envKey || settings.apiKey);
    res.json({ configured, provider, model: process.env.AI_MODEL || settings.model || (provider === 'gemini' ? 'gemini-3.5-flash' : '') });
  });
  app.get('/api/recruit-iq/jobs', (req, res) => {
    const db = ctx.load();
    res.json(db.recruitIqJobs.map(job => ({ ...job, candidates: db.recruitIqMatches.filter(match => match.jobId === job.id).length })));
  });
  app.post('/api/recruit-iq/jobs/extract', wrap(async (req, res) => {
    const description = text(req.body?.description, 20000);
    if (description.length < 50) return res.status(400).json({ error: 'Enter at least 50 characters of job description.' });
    const extracted = await ctx.extractJob(ctx.aiContext, description);
    res.json(extracted);
  }));
  app.post('/api/recruit-iq/jobs/read-document', wrap(async (req, res) => {
    const description = await extractFile({ name: req.body?.name, data: req.body?.data });
    if (description.trim().length < 50) return res.status(400).json({ error: 'At least 50 characters of readable job-description text are required.' });
    res.json({ description });
  }));
  app.post('/api/recruit-iq/jobs', (req, res) => {
    const title = text(req.body?.title, 200);
    const description = text(req.body?.description, 20000);
    if (!title || description.length < 50) return res.status(400).json({ error: 'Job title and at least 50 characters of job description are required.' });
    const db = ctx.load();
    let requirements;
    try { requirements = cleanRequirements(req.body?.requirements); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
    const timestamp = ctx.now();
    const job = {
      id: crypto.randomUUID(), title, description, requirements,
      status: req.body?.status === 'Closed' ? 'Closed' : 'Active',
      createdAt: timestamp, updatedAt: timestamp
    };
    db.recruitIqJobs.push(job);
    ctx.save(db);
    res.json(job);
  });
  app.put('/api/recruit-iq/jobs/:id', (req, res) => {
    const db = ctx.load(), job = byId(db.recruitIqJobs, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (req.body?.title !== undefined) job.title = text(req.body.title, 200);
    if (req.body?.description !== undefined) job.description = text(req.body.description, 20000);
    if (!job.title || job.description.length < 50) return res.status(400).json({ error: 'Job title and at least 50 characters of job description are required.' });
    if (req.body?.requirements !== undefined) {
      try { job.requirements = cleanRequirements(req.body.requirements); }
      catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
    }
    if (req.body?.status !== undefined && !['Active', 'Closed'].includes(req.body.status)) return res.status(400).json({ error: 'Job status must be Active or Closed.' });
    if (req.body?.status) job.status = req.body.status;
    job.updatedAt = ctx.now();
    ctx.save(db);
    res.json(job);
  });
  app.post('/api/recruit-iq/jobs/bulk-delete', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string')) return res.status(400).json({ error: 'Select between 1 and 1,000 job openings.' });
    const selected = new Set(ids), db = ctx.load(), before = db.recruitIqJobs.length;
    db.recruitIqJobs = db.recruitIqJobs.filter(job => !selected.has(job.id));
    const deleted = before - db.recruitIqJobs.length;
    if (deleted) ctx.save(db);
    res.json({ deleted });
  });
  app.post('/api/recruit-iq/jobs/:id/match/:candidateId', wrap(async (req, res) => {
    const db = ctx.load(), job = byId(db.recruitIqJobs, req.params.id), candidate = byId(db.recruitIqCandidates, req.params.candidateId);
    if (!job || !candidate) return res.status(404).json({ error: 'Job or candidate not found.' });
    if (req.body?.cvText && typeof req.body.cvText === 'string') {
      const cleanCv = req.body.cvText.slice(0, 50000).trim();
      if (cleanCv) {
        candidate.cvText = cleanCv;
        const hash = crypto.createHash('sha256').update(cleanCv.replace(/\s+/g, ' ').toLowerCase()).digest('hex');
        candidate.cvHashes = [...new Set([...(candidate.cvHashes || []), hash])];
      }
    }
    if (!candidate.cvText) return res.status(400).json({ error: 'This candidate does not have CV text available to assess. Provide or paste their resume text to run AI matching.' });
    const result = await createAssessment(candidate.cvText, job, candidate.name);
    res.json(result);
  }));

  app.get('/api/recruit-iq/uploads', (req, res) => {
    const db = ctx.load();
    res.json(db.recruitIqProcessingJobs.map(({ fileData, ...record }) => record).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
  app.post('/api/recruit-iq/uploads', (req, res) => {
    const files = req.body?.files, jobId = text(req.body?.jobId, 100);
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) return res.status(400).json({ error: `Upload between 1 and ${MAX_FILES} CV files at a time.` });
    const totalBytes = files.reduce((total, file) => total + (typeof file?.data === 'string' ? Buffer.byteLength(file.data, 'base64') : 0), 0);
    if (totalBytes > MAX_BATCH_BYTES) return res.status(413).json({ error: 'Keep each upload batch at or below 20 MB total. Split larger batches into smaller uploads.' });
    const db = ctx.load(), job = byId(db.recruitIqJobs, jobId);
    if (!job || job.status !== 'Active') return res.status(400).json({ error: 'Select an active job before uploading CVs.' });
    const created = [];
    for (const file of files) {
      const name = path.basename(text(file?.name, 240));
      const extension = path.extname(name).toLowerCase();
      const allowed = ['.pdf', '.doc', '.docx', '.txt', '.md', '.html'];
      const data = typeof file?.data === 'string' ? file.data : '';
      const size = Buffer.byteLength(data, 'base64');
      const invalid = !name || !allowed.includes(extension) || !validBase64(data) || size > MAX_FILE_BYTES;
      const record = {
        id: crypto.randomUUID(), jobId, fileName: name || 'unnamed file',
        fileData: invalid ? '' : data, fileHash: data ? crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex') : '',
        status: invalid ? 'failed' : 'queued', error: invalid ? 'Choose PDF, DOC, DOCX, TXT, MD or HTML files up to 10 MB.' : '',
        candidateId: '', matchId: '', createdAt: ctx.now(), updatedAt: ctx.now()
      };
      db.recruitIqProcessingJobs.push(record);
      created.push(record);
    }
    ctx.save(db);
    for (const item of created) if (item.status === 'queued') enqueueUpload(item.id);
    res.status(202).json(created.map(({ fileData, ...record }) => record));
  });
  app.post('/api/recruit-iq/uploads/:id/retry', (req, res) => {
    const db = ctx.load(), record = byId(db.recruitIqProcessingJobs, req.params.id);
    if (!record) return res.status(404).json({ error: 'Upload record not found.' });
    if (record.status !== 'failed') return res.status(409).json({ error: 'Only failed uploads can be retried.' });
    if (!record.fileData) return res.status(409).json({ error: 'The original file is not available. Upload the CV again.' });
    record.status = 'queued';
    record.error = '';
    record.updatedAt = ctx.now();
    ctx.save(db);
    enqueueUpload(record.id);
    const { fileData, ...safeRecord } = record;
    res.status(202).json(safeRecord);
  });

  app.post('/api/recruit-iq/candidates', (req, res) => {
    const name = text(req.body?.name, 200);
    if (!name) return res.status(400).json({ error: 'Candidate name is required.' });
    const email = privateEmail(req.body?.email), phone = normalizePhone(req.body?.phone);
    if (req.body?.email && !email) return res.status(400).json({ error: 'Candidate email is not valid.' });
    const db = ctx.load();
    const existing = db.recruitIqCandidates.find(item => (email && item.email === email) || (phone && normalizePhone(item.phone) === phone));
    if (existing) return res.status(409).json({ error: 'A candidate with this email or phone already exists.', candidate: sanitizeCandidate(existing) });
    const timestamp = ctx.now();
    const cvText = typeof req.body?.cvText === 'string' ? req.body.cvText.slice(0, 50000).trim() : '';
    const hash = cvText ? crypto.createHash('sha256').update(cvText.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex') : '';
    const candidate = {
      id: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp, name, email, phone,
      talentCandidateId: email ? db.candidates.find(item => String(item.email || '').trim().toLowerCase() === email)?.id || '' : '',
      profile: { name, email: email || 'Not Mentioned', phone: phone || 'Not Mentioned' },
      status: 'Hold', recruiter: text(req.body?.recruiter, 200), comments: '', interviewNotes: '', rejectionReason: '', followUpDate: '',
      history: [{ type: 'Candidate added manually', at: timestamp }], cvText, cvHashes: hash ? [hash] : []
    };
    db.recruitIqCandidates.push(candidate);
    ctx.save(db);
    res.json(sanitizeCandidate(candidate));
  });
  app.put('/api/recruit-iq/candidates/:id', (req, res) => {
    const db = ctx.load(), candidate = byId(db.recruitIqCandidates, req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
    const b = req.body || {};
    if (b.status !== undefined && !STATUSES.includes(b.status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
    if (b.cvText !== undefined && typeof b.cvText === 'string') {
      const cleanCv = b.cvText.slice(0, 50000).trim();
      candidate.cvText = cleanCv;
      if (cleanCv) {
        const hash = crypto.createHash('sha256').update(cleanCv.replace(/\s+/g, ' ').toLowerCase()).digest('hex');
        candidate.cvHashes = [...new Set([...(candidate.cvHashes || []), hash])];
      }
    }
    for (const [field, max] of Object.entries({ recruiter: 200, comments: 5000, interviewNotes: 5000, rejectionReason: 2000, followUpDate: 10 })) {
      if (b[field] === undefined) continue;
      if (typeof b[field] !== 'string') return res.status(400).json({ error: `${field} must be text.` });
      candidate[field] = text(b[field], max);
    }
    if (candidate.followUpDate && (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.followUpDate) || Number.isNaN(Date.parse(`${candidate.followUpDate}T00:00:00Z`)) || new Date(`${candidate.followUpDate}T00:00:00Z`).toISOString().slice(0, 10) !== candidate.followUpDate)) return res.status(400).json({ error: 'Follow-up date must be a valid YYYY-MM-DD date.' });
    const changes = [];
    if (b.status && candidate.status !== b.status) {
      candidate.status = b.status;
      changes.push(`Status changed to ${b.status}`);
    }
    for (const field of ['recruiter', 'comments', 'interviewNotes', 'rejectionReason', 'followUpDate']) {
      if (b[field] !== undefined) changes.push(`${field} updated`);
    }
    if (changes.length) candidate.history = [...(candidate.history || []), { type: changes.join('; '), at: ctx.now() }].slice(-100);
    candidate.updatedAt = ctx.now();
    ctx.save(db);
    res.json(sanitizeCandidate(candidate));
  });
  app.post('/api/recruit-iq/candidates/bulk-delete', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string')) return res.status(400).json({ error: 'Select between 1 and 10,000 candidates.' });
    const selected = new Set(ids), db = ctx.load(), before = db.recruitIqCandidates.length;
    db.recruitIqCandidates = db.recruitIqCandidates.filter(candidate => !selected.has(candidate.id));
    const deleted = before - db.recruitIqCandidates.length;
    if (deleted) {
      db.recruitIqMatches = db.recruitIqMatches.filter(match => !selected.has(match.candidateId));
      db.recruitIqProcessingJobs = db.recruitIqProcessingJobs.filter(upload => !selected.has(upload.candidateId));
      ctx.save(db);
    }
    res.json({ deleted });
  });
  app.post('/api/recruit-iq/matches/bulk-delete', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string')) return res.status(400).json({ error: 'Select between 1 and 10,000 match reports.' });
    const selected = new Set(ids), db = ctx.load(), before = db.recruitIqMatches.length;
    db.recruitIqMatches = db.recruitIqMatches.filter(match => !selected.has(match.id));
    const deleted = before - db.recruitIqMatches.length;
    if (deleted) {
      db.recruitIqProcessingJobs.forEach(upload => { if (selected.has(upload.matchId)) upload.matchId = ''; });
      ctx.save(db);
    }
    res.json({ deleted });
  });
  app.get('/api/recruit-iq/candidates/:id', (req, res) => {
    const db = ctx.load(), candidate = byId(db.recruitIqCandidates, req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
    res.json({
      candidate: sanitizeCandidate(candidate),
      cvText: candidate.cvText || '',
      matches: db.recruitIqMatches.filter(match => match.candidateId === candidate.id).map(match => ({ ...match, jobTitle: byId(db.recruitIqJobs, match.jobId)?.title || 'Archived job' }))
    });
  });

  app.get('/api/recruit-iq/export.xlsx', (req, res) => {
    const db = ctx.load();
    const jobId = text(req.query.jobId, 100);
    const candidateId = text(req.query.candidateId, 100);
    const matches = db.recruitIqMatches.filter(match => (!jobId || match.jobId === jobId) && (!candidateId || match.candidateId === candidateId))
      .sort((a, b) => b.total - a.total)
      .map(match => {
        const candidate = byId(db.recruitIqCandidates, match.candidateId) || {};
        const job = byId(db.recruitIqJobs, match.jobId) || {};
        return {
          'Candidate': candidate.name || 'Not Mentioned', 'Email': candidate.email || 'Not Mentioned', 'Phone': candidate.phone || 'Not Mentioned',
          'Job': job.title || 'Archived job', 'Match %': match.total, 'Category': match.category, 'Mandatory requirements met': match.mandatoryMet ? 'Yes' : 'No',
          'Status': candidate.status || 'Hold', 'Skills matched': match.matchedSkills.join(', '), 'Skills missing': match.missingSkills.join(', '),
          'Experience': match.relevantExperience, 'Recommendation': match.recommendation
        };
      });
    const XLSX = require('xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(matches), 'Screening report');
      const reportCandidateIds = new Set(db.recruitIqMatches.filter(match => (!jobId || match.jobId === jobId) && (!candidateId || match.candidateId === candidateId)).map(match => match.candidateId));
      const candidates = db.recruitIqCandidates.filter(candidate => (!jobId || reportCandidateIds.has(candidate.id)) && (!candidateId || candidate.id === candidateId)).map(candidate => ({
      Name: candidate.name, Email: candidate.email || 'Not Mentioned', Phone: candidate.phone || 'Not Mentioned',
      Location: candidate.profile?.location || 'Not Mentioned', Designation: candidate.profile?.designation || 'Not Mentioned',
      'Current company': candidate.profile?.currentCompany || 'Not Mentioned',
      Experience: candidate.profile?.totalExperience || 'Not Mentioned', Education: (candidate.profile?.education || []).join(', ') || 'Not Mentioned',
      Skills: (candidate.profile?.skills || []).join(', ') || 'Not Mentioned', Recruiter: candidate.recruiter || 'Not assigned',
      'Relevant experience': candidate.profile?.relevantExperience || 'Not Mentioned',
      Industries: (candidate.profile?.industries || []).join(', ') || 'Not Mentioned',
      Certifications: (candidate.profile?.certifications || []).join(', ') || 'Not Mentioned',
      Tools: (candidate.profile?.tools || []).join(', ') || 'Not Mentioned',
      'Notice period': candidate.profile?.noticePeriod || 'Not Mentioned',
      'Current CTC': candidate.profile?.currentCtc || 'Not Mentioned',
      'Expected CTC': candidate.profile?.expectedCtc || 'Not Mentioned',
      Status: candidate.status, Comments: candidate.comments || '', InterviewNotes: candidate.interviewNotes || '',
      RejectionReason: candidate.rejectionReason || '', FollowUp: candidate.followUpDate || ''
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(candidates), 'Candidates');
    const shortlist = candidates.filter(candidate => ['Shortlisted', 'Interview Scheduled', 'Interviewed', 'Selected', 'Offered', 'Joined'].includes(candidate.Status));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(shortlist), 'Shortlisted');
    const evidence = db.recruitIqMatches.filter(match => (!jobId || match.jobId === jobId) && (!candidateId || match.candidateId === candidateId)).flatMap(match => {
      const candidate = byId(db.recruitIqCandidates, match.candidateId) || {};
      const job = byId(db.recruitIqJobs, match.jobId) || {};
      return [
        ...match.dimensions.map(item => ({ Candidate: candidate.name || 'Not Mentioned', Job: job.title || 'Archived job', Type: 'Score', Requirement: item.name, Result: `${item.score}% (${item.weight}%)`, Evidence: item.evidence })),
        ...match.mandatoryRequirements.map(item => ({ Candidate: candidate.name || 'Not Mentioned', Job: job.title || 'Archived job', Type: 'Mandatory requirement', Requirement: item.requirement, Result: item.met ? 'Met' : 'Missing', Evidence: item.evidence })),
        ...match.matchedSkills.map(skill => ({ Candidate: candidate.name || 'Not Mentioned', Job: job.title || 'Archived job', Type: 'Matched skill', Requirement: skill, Result: 'Matched', Evidence: '' })),
        ...match.missingSkills.map(skill => ({ Candidate: candidate.name || 'Not Mentioned', Job: job.title || 'Archived job', Type: 'Missing skill', Requirement: skill, Result: 'Missing', Evidence: '' }))
      ];
    });
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(evidence), 'Evidence');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="recruitiq-screening-report.xlsx"' });
    res.send(buffer);
  });
}

module.exports = { mount, cleanRequirements, verifyMatch, scoreCategory, extractFile, STATUSES, DEFAULT_WEIGHTS };
