const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  console.error('.env already exists. Setup will not overwrite your company password or encryption key.');
  process.exit(1);
}

const password = crypto.randomBytes(24).toString('base64url');
const encryptionKey = crypto.randomBytes(32).toString('base64');
const contents = `APP_PASSWORD=${password}\nCRM_ENCRYPTION_KEY=${encryptionKey}\n`;
try {
  fs.writeFileSync(envFile, contents, { flag: 'wx', mode: 0o600 });
} catch (error) {
  console.error(`Could not create .env: ${error.message}`);
  process.exit(1);
}

console.log('Created .env with a new shared login password and database encryption key.');
console.log(`Company login password: ${password}`);
console.log(`Database encryption key: ${encryptionKey}`);
console.log('Save both values in your company password manager. Never replace the encryption key after CRM data is saved.');
