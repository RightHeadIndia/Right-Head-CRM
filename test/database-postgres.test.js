const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

class FakePool {
  static records = new Map();
  static metadata = new Map();

  constructor() {}
  on() {}
  async end() {}
  async query(sql, values = []) {
    const query = sql.trim().replace(/\s+/g, ' ');
    if (query === 'SELECT 1' || query.startsWith('CREATE TABLE')) return { rows: [], rowCount: 0 };
    if (query === 'SELECT v FROM public.meta WHERE k = $1') {
      const value = FakePool.metadata.get(values[0]);
      return { rows: value === undefined ? [] : [{ v: value }], rowCount: value === undefined ? 0 : 1 };
    }
    if (query.startsWith('INSERT INTO public.meta')) {
      if (!FakePool.metadata.has(values[0])) FakePool.metadata.set(values[0], values[1]);
      return { rows: [], rowCount: 1 };
    }
    if (query.startsWith('SELECT collection, id, version, data FROM public.records')) {
      return { rows: [...FakePool.records.values()].map(row => ({ ...row })), rowCount: FakePool.records.size };
    }
    throw new Error(`Unexpected fake pool query: ${query}`);
  }
  async connect() {
    return new FakeClient();
  }
}

class FakeClient {
  async query(sql, values = []) {
    const query = sql.trim().replace(/\s+/g, ' ');
    if (query === 'BEGIN') {
      this.records = new Map([...FakePool.records].map(([key, value]) => [key, { ...value }]));
      return { rows: [], rowCount: 0 };
    }
    if (query === 'COMMIT') {
      FakePool.records = this.records;
      this.records = null;
      return { rows: [], rowCount: 0 };
    }
    if (query === 'ROLLBACK') {
      this.records = null;
      return { rows: [], rowCount: 0 };
    }
    if (query.startsWith('INSERT INTO public.records')) {
      const [collection, id, version, data] = values;
      const key = `${collection}/${id}`;
      if (this.records.has(key)) {
        const error = new Error('duplicate key');
        error.code = '23505';
        throw error;
      }
      this.records.set(key, { collection, id, version, data });
      return { rows: [], rowCount: 1 };
    }
    if (query.startsWith('UPDATE public.records')) {
      const [version, data, collection, id, expectedVersion] = values;
      const key = `${collection}/${id}`;
      const current = this.records.get(key);
      if (!current || current.version !== expectedVersion) return { rows: [], rowCount: 0 };
      this.records.set(key, { collection, id, version, data });
      return { rows: [], rowCount: 1 };
    }
    if (query.startsWith('DELETE FROM public.records')) {
      const [collection, id, expectedVersion] = values;
      const key = `${collection}/${id}`;
      const current = this.records.get(key);
      if (!current || current.version !== expectedVersion) return { rows: [], rowCount: 0 };
      this.records.delete(key);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected fake client query: ${query}`);
  }
  release() {}
}

const pg = require('pg');
pg.Pool = FakePool;
process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
process.env.CRM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { openDatabase, readDatabase, writeDatabase, flush, closeDatabase, postgresConnectionOptions } = require('../lib/database-postgres');

test('PostgreSQL SSL settings respect connection-string modes without the pg config conflict', () => {
  const current = postgresConnectionOptions('postgresql://user:pass@db.example.test/app?sslmode=require&channel_binding=require', '');
  assert.equal(new URL(current.connectionString).searchParams.get('sslmode'), 'verify-full');
  assert.equal(Object.hasOwn(current, 'ssl'), false);
  const compatible = postgresConnectionOptions('postgresql://user:pass@db.example.test/app?sslmode=require&uselibpqcompat=true', '');
  assert.equal(new URL(compatible.connectionString).searchParams.get('sslmode'), 'require');
  assert.equal(Object.hasOwn(compatible, 'ssl'), false);
  assert.equal(postgresConnectionOptions('postgresql://user:pass@db.example.test/app', 'disable').ssl, false);
  assert.deepEqual(postgresConnectionOptions('postgresql://user:pass@db.example.test/app').ssl, { rejectUnauthorized: false });
});

test('PostgreSQL adapter refreshes after a conflict and accepts a later write', async () => {
  FakePool.records = new Map();
  FakePool.metadata = new Map();
  const first = await openDatabase();
  let stale;
  let verification;
  try {
    const initial = readDatabase(first);
    initial.clients.push({ id: 'shared-client', name: 'Initial' });
    writeDatabase(first, initial);
    await flush(first);

    stale = await openDatabase();
    const firstEdit = readDatabase(first);
    firstEdit.clients[0].name = 'Updated elsewhere';
    writeDatabase(first, firstEdit);
    await flush(first);

    const staleEdit = readDatabase(stale);
    staleEdit.clients[0].company = 'Stale company';
    writeDatabase(stale, staleEdit);
    const queuedEdit = readDatabase(stale);
    queuedEdit.clients.push({ id: 'queued-client', name: 'Must not overwrite after conflict' });
    writeDatabase(stale, queuedEdit);
    await assert.rejects(flush(stale), error => error.code === 'CRM_CONCURRENT_UPDATE');
    assert.equal(readDatabase(stale).clients[0].name, 'Updated elsewhere');
    assert.equal(readDatabase(stale).clients[0].company, undefined);
    assert.ok(!readDatabase(stale).clients.some(client => client.id === 'queued-client'));
    assert.ok(!FakePool.records.has('clients/queued-client'));
    await flush(stale);

    const retry = readDatabase(stale);
    retry.clients[0].company = 'Updated company';
    writeDatabase(stale, retry);
    await flush(stale);

    verification = await openDatabase();
    assert.deepEqual(readDatabase(verification).clients[0], {
      id: 'shared-client',
      name: 'Updated elsewhere',
      company: 'Updated company'
    });
  } finally {
    if (verification) await closeDatabase(verification);
    if (stale) await closeDatabase(stale);
    await closeDatabase(first);
  }
});
