import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
try {
  await client.connect();
  const res = await client.query('SELECT version()');
  console.log('DB OK:', res.rows[0].version.split(' ').slice(0, 2).join(' '));
} catch (e) {
  console.error('DB FAIL:', e.code || '', e.message);
} finally {
  await client.end();
}
