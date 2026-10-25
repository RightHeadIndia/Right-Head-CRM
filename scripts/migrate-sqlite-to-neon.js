
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing from .env');
  }

  const source = new DatabaseSync('./data/crm.sqlite', {
    readOnly: true,
  });

  const target = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const records = source
      .prepare('SELECT collection, id, version, data FROM records')
      .all();

    const metadata = source
      .prepare('SELECT k, v FROM meta')
      .all();

    console.log('Local records:', records.length);
    console.log('Local metadata entries:', metadata.length);

    await target.connect();

    await target.query('BEGIN');

    const existingRecords = await target.query(
      'SELECT COUNT(*)::int AS total FROM public.records'
    );
    const existingMeta = await target.query(
      'SELECT COUNT(*)::int AS total FROM public.meta'
    );

    if (
      existingRecords.rows[0].total !== 0 ||
      existingMeta.rows[0].total !== 0
    ) {
      throw new Error(
        'Neon tables are not empty. Migration stopped to protect existing data.'
      );
    }

    for (const record of records) {
      await target.query(
        `INSERT INTO public.records
          (collection, id, version, data)
         VALUES ($1, $2, $3, $4)`,
        [
          record.collection,
          record.id,
          record.version,
          record.data,
        ]
      );
    }

    for (const item of metadata) {
      await target.query(
        'INSERT INTO public.meta (k, v) VALUES ($1, $2)',
        [item.k, item.v]
      );
    }

    const verifyRecords = await target.query(
      'SELECT collection, COUNT(*)::int AS total ' +
      'FROM public.records GROUP BY collection ORDER BY collection'
    );

    const verifyMeta = await target.query(
      'SELECT COUNT(*)::int AS total FROM public.meta'
    );

    console.log('Neon record counts:', verifyRecords.rows);
    console.log('Neon metadata entries:', verifyMeta.rows[0].total);

    await target.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (error) {
    try {
      await target.query('ROLLBACK');
    } catch {}

    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    source.close();
    await target.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
