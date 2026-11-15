const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForPostgresWrites } = require('../lib/postgres-response-barrier');

function fakeResponse() {
  return {
    statusCode: 200,
    headersSent: false,
    json(body) { return this.send(JSON.stringify(body)); },
    send(body) { this.body = body; this.headersSent = true; return this; }
  };
}

test('a PostgreSQL write conflict returns one 409 response without recursively flushing', async () => {
  let flushCalls = 0;
  const flushWithConflict = () => {
    flushCalls++;
    const error = new Error('This record was changed by someone else a moment ago.');
    error.code = 'CRM_CONCURRENT_UPDATE';
    return Promise.reject(error);
  };
  const jsonResponse = fakeResponse();
  const textResponse = fakeResponse();
  waitForPostgresWrites(jsonResponse, flushWithConflict);
  waitForPostgresWrites(textResponse, flushWithConflict);

  jsonResponse.json({ ok: true });
  textResponse.send('ok');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(jsonResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(jsonResponse.body), { error: 'This record was changed by someone else a moment ago.' });
  assert.equal(textResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(textResponse.body), { error: 'This record was changed by someone else a moment ago.' });
  assert.equal(flushCalls, 2);
});
