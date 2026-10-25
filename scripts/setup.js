// Creates .env with a generated shared password and encryption key. Never overwrites an existing .env.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)) {
  console.log('.env already exists, so nothing was changed.');
  process.exit(0);
}
const password = crypto.randomBytes(18).toString('base64url');
const key = crypto.randomBytes(32).toString('base64');
fs.writeFileSync(file, `DATABASE_URL=\nAPP_PASSWORD=${password}\nCRM_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
console.log(`Created .env

  Login password : ${password}
  Encryption key : ${key}

Save BOTH in your company password manager.
Backups can only be opened with the same encryption key. If you lose it, the data cannot be recovered.
Add your Neon DATABASE_URL to .env before starting. If connecting to an existing encrypted database, replace the generated key with its original key. Never change the key for an existing database.\nNext: npm start   then open http://localhost:3000`);
