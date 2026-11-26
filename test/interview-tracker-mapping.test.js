const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { extractWorkbook, parseSheet } = require('../lib/talent-history-import');

function interviewSheet(rows, name = 'Interview Tracker') {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
  const parsedWorkbook = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: false });
  const extracted = extractWorkbook(XLSX.write(parsedWorkbook, { type: 'buffer', bookType: 'xlsx' }));
  return extracted.sheets.find(item => item.name === name);
}

test('maps the ordered eleven Interview Tracker columns and converts Excel date and time values', () => {
  const rows = [[
    'Candidate', 'Recruiter', 'Interview Date', 'Company', 'Profile', 'Mode', 'Time',
    'Candidate Status', 'Client Status', 'Contact Details', 'Remarks'
  ], ['Sam Taylor', 'Jordan Lee', 45568, 'Northwind', 'Data Analyst', 'Video', 0.5, 'Shortlisted', 'Feedback pending', 'sam@example.test · 9876543210', 'Keep this remark']];
  const sheet = interviewSheet(rows);
  const dateCell = sheet.rows.find(row => row.some(cell => cell[0] === 2)).find(cell => cell[0] === 2);
  dateCell[5] = 'dd/mm/yyyy';
  const timeCell = sheet.rows.find(row => row.some(cell => cell[0] === 6)).find(cell => cell[0] === 6);
  timeCell[5] = '0.00';

  const candidate = parseSheet(sheet)[0];
  assert.equal(candidate.name, 'Sam Taylor');
  assert.equal(candidate.recruiter, 'Jordan Lee');
  assert.equal(candidate.interview.date, '2024-10-03');
  assert.equal(candidate.company, 'Northwind');
  assert.equal(candidate.role, 'Data Analyst');
  assert.equal(candidate.interview.mode, 'Video');
  assert.equal(candidate.interview.time, '12:00');
  assert.equal(candidate.interview.candidateStatus, 'Shortlisted');
  assert.equal(candidate.interview.clientStatus, 'Feedback pending');
  assert.equal(candidate.interview.contactDetails, 'sam@example.test · 9876543210');
  assert.equal(candidate.interview.remarks, 'Keep this remark');
});

test('keeps the previous headed Interview Tracker workbook mapping readable', () => {
  const sheet = interviewSheet([
    ['Recruiter', 'Company', 'Profile', 'Candidate', 'Mode', 'Time', 'Remarks', 'Feedback', 'Email'],
    ['Alex Kim', 'Acme', 'Engineer', 'Taylor Morgan', 'Video', 0.375, 'Round notes', 'Client feedback', 'taylor@example.test'],
    ['03-10-2024']
  ]);
  const candidate = parseSheet(sheet)[0];
  assert.equal(candidate.name, 'Taylor Morgan');
  assert.equal(candidate.recruiter, 'Alex Kim');
  assert.equal(candidate.interview.date, '2024-10-03');
  assert.equal(candidate.company, 'Acme');
  assert.equal(candidate.role, 'Engineer');
  assert.equal(candidate.interview.time, '09:00');
  assert.equal(candidate.interview.email, 'taylor@example.test');
  assert.equal(candidate.interview.remarks, 'Round notes\nClient feedback');
});
