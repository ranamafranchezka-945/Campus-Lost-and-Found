// scripts/manage-admin.js - Make an account the administrator and set its password.
//
//   npm run admin:set -- <email> <password> [--allow-weak]
//   npm run admin:set                     (uses ADMIN_EMAIL and ADMIN_PASSWORD from .env)
//
// If the email already has an account (for example a student's), that account is kept
// and becomes an administrator; otherwise a new one is created. Works on whichever
// store the app is configured for: Supabase PostgreSQL when DATABASE_URL is set,
// the JSON files in DATA_DIR otherwise.
// Like server.js, .env is only read for local development.
if (!['test', 'production'].includes(process.env.NODE_ENV)) require('dotenv').config();

const path = require('path');
const bcrypt = require('bcryptjs');
const postgresStore = require('../services/postgresStore');
const { readJsonArray, writeJsonArray } = require('../services/jsonStore');
const { isAdminEmail, passwordStrengthErrors, sanitizeString } = require('../middleware/validate');

const USERS_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'users.json');
const ADMIN_MIN_PASSWORD_LENGTH = 12;

function setAdmin(email, passwordHash) {
  const users = readJsonArray(USERS_FILE);
  const now = new Date().toISOString();
  const existing = users.find(user => String(user.email).toLowerCase() === email);
  let outcome;
  if (existing) {
    outcome = existing.role === 'admin' ? 'updated' : 'promoted';
    existing.role = 'admin';
    existing.department = 'Administration';
    existing.passwordHash = passwordHash;
    existing.passwordChangedAt = now;
    // The person running this vouches for the address; sign-in still emails a code to it.
    if (existing.emailVerified === false) {
      existing.emailVerified = true;
      existing.emailVerifiedAt = now;
    }
    ['verificationTokenHash', 'verificationExpiresAt', 'verificationSentAt',
      'passwordResetTokenHash', 'passwordResetExpiresAt', 'passwordResetSentAt'].forEach(key => delete existing[key]);
  } else {
    outcome = 'created';
    users.push({
      id: `usr-admin-${Date.now()}`,
      email,
      passwordHash,
      fullName: sanitizeString(process.env.ADMIN_NAME || 'CSPC Administrator'),
      studentId: 'N/A',
      role: 'admin',
      department: 'Administration',
      createdAt: now
    });
  }
  writeJsonArray(USERS_FILE, users);
  return { outcome, admins: users.filter(user => user.role === 'admin').map(user => user.email) };
}

async function main() {
  const args = process.argv.slice(2);
  const allowWeak = args.includes('--allow-weak');
  const [emailArg, passwordArg] = args.filter(arg => arg !== '--allow-weak');
  const email = String(emailArg || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = passwordArg || process.env.ADMIN_PASSWORD || '';

  if (!isAdminEmail(email)) {
    throw new Error('Give a CSPC email address ending in @cspc.edu.ph or @my.cspc.edu.ph.');
  }
  if (!password) throw new Error('Give a password, or set ADMIN_PASSWORD in .env.');
  const weaknesses = passwordStrengthErrors(password, ADMIN_MIN_PASSWORD_LENGTH);
  if (weaknesses.length && !allowWeak) {
    throw new Error(`That password does not meet the administrator password rules:\n  - ${weaknesses.join('\n  - ')}\n`
      + 'Choose a stronger one, or add --allow-weak to use it anyway.');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let result;
  if (postgresStore.isConfigured()) {
    await postgresStore.initialize();
    result = await postgresStore.withTransaction(() => setAdmin(email, passwordHash));
  } else {
    result = setAdmin(email, passwordHash);
  }

  const where = postgresStore.isConfigured() ? 'the Supabase database' : USERS_FILE;
  const what = { created: 'New administrator account created', promoted: 'Existing account made an administrator', updated: 'Administrator password updated' }[result.outcome];
  console.log(`${what}: ${email} (in ${where}).`);
  if (weaknesses.length) console.log('Warning: the password is weaker than the administrator password rules.');
  console.log(`Administrator accounts now: ${result.admins.join(', ')}`);
}

main()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => postgresStore.close());
