'use strict';
const { Client } = require('pg');
(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Copy the Neon connection string into your environment.');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const ping = await client.query('SELECT current_database() AS database_name, current_user AS database_user');
    const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('records','meta') ORDER BY table_name");
    console.log('Connected to PostgreSQL successfully.');
    console.log(`Database: ${ping.rows[0].database_name}`);
    console.log(`Required tables found: ${tables.rows.map(r => r.table_name).join(', ') || 'none yet'}`);
    if (tables.rows.length !== 2) console.log('Next: run database/schema.sql in Neon SQL Editor.');
    else {
      const counts = await client.query('SELECT collection, COUNT(*)::int AS total FROM public.records GROUP BY collection ORDER BY collection');
      console.log('Record counts:');
      for (const r of counts.rows) console.log(`  ${r.collection}: ${r.total}`);
    }
  } finally { await client.end(); }
})().catch(err => { console.error('Neon check failed:', err.message); process.exitCode = 1; });
