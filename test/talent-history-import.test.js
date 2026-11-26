'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { extractWorkbook, importWorkbook, rebuildWorkbook } = require('../lib/talent-history-import');

function fixtureWorkbook() {
  const workbook = XLSX.utils.book_new();
  const interview = XLSX.utils.aoa_to_sheet([
    ['Recruiter', 'Company', 'Profile', 'Candidate', 'Mode', 'Time', 'Remarks', 'Feedback', 'Email'],
    ['Alex', 'Acme', 'Engineer', 'Jordan Lee', 'PI', '10:00 AM', 'Round one feedback', '', 'jordan@example.test'],
    ['Alex', 'Acme', 'Engineer', 'Jordan Lee', 'Technical', '11:00 AM', 'Round two feedback', '', 'jordan@example.test'],
    ['Alex', 'Acme', 'Engineer', 'Jordan Lee', 'Technical', '11:00 AM', 'Round two feedback', '', 'jordan@example.test'],
    ['03-10-2024']
  ]);
  interview['!merges'] = [XLSX.utils.decode_range('A5:A6')];
  XLSX.utils.book_append_sheet(workbook, interview, 'Interview Tracker');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Shortlisted / Offer Awaited'], ['TA Name', 'Month', 'Company', 'Profile', 'Candidate', 'Status', 'Final Call', 'DOJ', 'Remarks'],
    ['Alex', 'May', 'Acme', 'Engineer', 'Jordan Lee', 'Offered', 'Accepted', '', 'Offer notes']
  ]), 'Shortlisted Offered');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Week 1', 'Week Date: 1st May - 7th May'], ['Recruiter', 'Metric', 'Monday', 'Tuesday'], ['Alex', 'Candidate Shared', 2, 1], [], ['Target', 5, 4]
  ]), 'Weekly Tracker');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'Skill', 'Candidate Name', 'Mobile', 'Email', 'Status / Feedback'], ['1st May 2024', 'Engineer', 'Sam Patel', '9876543210', 'sam@example.test', 'Available soon']
  ]), 'Fint Sol');
  workbook.Workbook = { Sheets: workbook.SheetNames.map((name, index) => ({ name, Hidden: index === 3 ? 1 : 0 })) };
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('detects visible and hidden sheets and retains their sparse workbook structure', () => {
  const info = extractWorkbook(fixtureWorkbook());
  assert.deepEqual(info.detected.map(sheet => sheet.name), ['Interview Tracker', 'Shortlisted Offered', 'Weekly Tracker', 'Fint Sol']);
  assert.equal(info.detected[3].hidden, true);
  assert.equal(info.detected[0].merges, 1);
  assert.equal(info.sheets.find(sheet => sheet.name === 'Weekly Tracker').rows[3].length, 0, 'blank row position is retained');
});

test('imports candidate and weekly sheets with exact duplicate safety and distinct interview rounds', () => {
  const buffer = fixtureWorkbook(), db = { candidates: [], taHistoricalImports: [] };
  const selected = extractWorkbook(buffer).detected.map(sheet => sheet.name);
  const report = importWorkbook(db, buffer, selected, 'fixture.xlsx');
  const jordan = db.candidates.find(candidate => candidate.name === 'Jordan Lee');
  assert.equal(jordan.interviews.length, 2, 'separate interview rounds remain separate; an exact repeated row is skipped');
  assert.equal(jordan.interviews[0].date, '2024-10-03', 'a date separator applies to the rows immediately above it');
  assert.ok(db.candidates.some(candidate => candidate.name === 'Sam Patel'), 'hidden sourcing sheet is imported');
  assert.equal(report.duplicatesSkipped, 1);
  assert.equal(report.worksheets.find(sheet => sheet.type === 'weekly').archived, true);
  assert.equal(db.taHistoricalImports[0].sheets.length, 4);
  assert.equal(db.taHistoricalImports[0].sheets.find(sheet => sheet.type === 'weekly').rows[3].length, 0);
  const archived = XLSX.read(XLSX.write(rebuildWorkbook(db.taHistoricalImports[0]), { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  assert.equal(archived.Sheets['Weekly Tracker']['D3'].v, 1);
  assert.equal(archived.Sheets['Interview Tracker']['!merges'].length, 1);
  assert.equal(archived.Workbook.Sheets.find(sheet => sheet.name === 'Fint Sol').Hidden, 1);
});

test('reimporting an already imported workbook checks its rows without duplicating archive or candidate rows', () => {
  const buffer = fixtureWorkbook(), db = { candidates: [], taHistoricalImports: [] }, names = extractWorkbook(buffer).detected.map(sheet => sheet.name);
  importWorkbook(db, buffer, names, 'fixture.xlsx');
  const before = db.candidates.length;
  const again = importWorkbook(db, buffer, names, 'fixture.xlsx');
  assert.equal(db.candidates.length, before);
  assert.equal(db.taHistoricalImports.length, 1);
  assert.ok(again.worksheets.every(sheet => sheet.status === 'imported'));
  assert.ok(again.duplicatesSkipped >= 2, 'existing interviews are recognized and skipped');
});

test('reprocesses an archived worksheet whose previous import report recorded zero rows', () => {
  const buffer = fixtureWorkbook(), db = { candidates: [], taHistoricalImports: [] }, names = extractWorkbook(buffer).detected.map(sheet => sheet.name);
  importWorkbook(db, buffer, names, 'fixture.xlsx');
  db.candidates = [];
  db.taHistoricalImports[0].report.worksheets = db.taHistoricalImports[0].report.worksheets.map(sheet => ({ ...sheet, recordsImported: 0, candidatesCreated: 0, interviewsAdded: 0, cvSharesAdded: 0 }));
  const retried = importWorkbook(db, buffer, names, 'fixture.xlsx');
  assert.ok(db.candidates.some(candidate => candidate.name === 'Jordan Lee'));
  assert.ok(retried.candidatesCreated > 0);
  assert.ok(retried.worksheets.every(sheet => sheet.status === 'imported'));
});
