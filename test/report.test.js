const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport } = require('../lib/tools');

test('reports include legacy clients with missing stage and call status in default totals', () => {
  const report = buildReport({
    STAGES: ['new', 'contacted', 'replied', 'onboarded', 'rejected'],
    CALLS: ['not_called', 'connected', 'no_answer', 'busy', 'callback']
  }, {
    clients: [
      { id: 'legacy', createdAt: new Date().toISOString() },
      { id: 'invalid', stage: 'unknown-stage', callStatus: 'unknown-call' },
      { id: 'replied', stage: 'replied', callStatus: 'connected' },
      { id: 'onboarded', stage: 'onboarded', callStatus: 'not_called' }
    ],
    activities: [],
    campaigns: [],
    deals: [],
    tasks: []
  });

  assert.equal(report.clients.total, 4);
  assert.equal(report.clients.stages.new, 2);
  assert.equal(report.clients.stages.replied, 1);
  assert.equal(report.clients.stages.onboarded, 1);
  assert.equal(report.clients.conversionRate, 0.25);
  assert.equal(Object.values(report.clients.stages).reduce((sum, count) => sum + count, 0), 4);
  assert.equal(report.clients.calls.not_called, 3);
  assert.equal(report.clients.calls.connected, 1);
  assert.equal(Object.values(report.clients.calls).reduce((sum, count) => sum + count, 0), 4);
  assert.equal(report.clients.contacted, 2);
  assert.equal(report.clients.responded, 2);
});
