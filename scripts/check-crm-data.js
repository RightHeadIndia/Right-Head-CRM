
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('./data/crm.sqlite');

const collections = db.prepare(`
  SELECT collection, COUNT(*) AS total
  FROM records
  GROUP BY collection
`).all();

const metaKeys = db.prepare(`
  SELECT k FROM meta
`).all().map(row => row.k);

console.log('Record counts:', collections);
console.log('Metadata keys:', metaKeys);

db.close();
