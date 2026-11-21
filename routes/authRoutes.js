// routes/authRoutes.js - User Authentication, Registration, and Session Management
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { validateUserAuth, sanitizeString, passwordStrengthErrors, STUDENT_EMAIL, STAFF_EMAIL, isAdminEmail } = require('../middleware/validate');
const { sendVerificationCodeEmail, sendSignInNotificationEmail, sendPasswordResetEmail } = require('../services/email');
const { readJsonArray, writeJsonArray } = require('../services/jsonStore');
const postgresStore = require('../services/postgresStore');
const supabaseStorage = require('../services/supabaseStorage');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isRateLimited, recordAttempt } = require('../middleware/rateLimit');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const CLAIMS_FILE = path.join(DATA_DIR, 'claims.json');
const BLOCKED_EMAILS_FILE = path.join(DATA_DIR, 'blockedEmails.json');
const ALLOWED_EMAILS_FILE = path.join(DATA_DIR, 'allowedEmails.json');
const STUDENT_DEPARTMENTS = new Set([
  'College of Computer Studies (CCS)',
  'College of Engineering and Architecture (CEA)',
  'College of Health Sciences (CHS)',
  'College of Tourism, Hospitality and Business Management (CTHBM)',
  'College of Technological and Developmental Education (CTDE)',
  'College of Arts and Sciences (CAS)'
]);

const VERIFICATION_RESEND_MS = 2 * 60 * 1000;
// Emailed one-time codes (sign-up confirmation and every sign-in).
// A code lasts 1 minute; "Resend code" unlocks at the same moment it expires.
const OTP_TTL_MS = 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const LOGIN_LIMIT = { max: 8, windowMs: 15 * 60 * 1000 };
const REGISTRATION_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };
const RESET_REQUEST_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);
// CSPC's @my.cspc.edu.ph / @cspc.edu.ph addresses run on Google Workspace, so a verified
// Google sign-in is proof of the same CSPC identity a password sign-in proves. Unset
// GOOGLE_CLIENT_ID disables the feature entirely rather than half-configuring it.
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;
const loginFailures = new Map();
const registrationAttempts = new Map();
const resetRequests = new Map();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issuePasswordResetToken() {
  const value = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  return {
    value,
    fields: {
      passwordResetTokenHash: hashToken(value),
      passwordResetExpiresAt: new Date(now + PASSWORD_RESET_TTL_MS).toISOString(),
      passwordResetSentAt: new Date(now).toISOString()
    }
  };
}

function clearPasswordReset(user) {
  delete user.passwordResetTokenHash;
  delete user.passwordResetExpiresAt;
  delete user.passwordResetSentAt;
}

function minimumPasswordLength(user) {
  return user.role === 'admin' ? 12 : 8;
}

async function deliverAccountEmail(send, user, token, devPath) {
  // Save and unlock the database first so a slow mail server does not hold up other requests.
  await postgresStore.commitRequest();
  try {
    await send(user, token);
    return true;
  } catch (error) {
    console.error('Account email could not be sent:', error.message);
    if (process.env.NODE_ENV !== 'production') {
      // Local development without SMTP: print the link so the flow can still be completed.
      const base = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      console.info(`Development link for ${user.email}: ${base}${devPath}${token}`);
    }
    return false;
  }
}

function deliverPasswordResetEmail(user, token) {
  return deliverAccountEmail(sendPasswordResetEmail, user, token, '/login?reset=');
}

// ── One-time codes ──────────────────────────────────────────────────────────
// A pending code lives in the visitor's (server-side) session, so it only works in
// the browser that entered the password. Only its hash is kept.
let generateOtpCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// Tests make codes predictable; this refuses to run anywhere else.
function setOtpCodeGeneratorForTests(generator) {
  if (process.env.NODE_ENV !== 'test') throw new Error('OTP code generator can only be replaced in tests.');
  generateOtpCode = generator;
}

// Changes when the password does, or when a pending sign-up (no password yet) is
// re-registered by someone else, so a stale pending code or password-creation step
// dies rather than carrying over to whoever re-registers that address next.
function accountFingerprint(user) {
  return hashToken(`${user.id}|${user.passwordHash || ''}|${user.registrationNonce || ''}`);
}

async function deliverOtpEmail(user, code, purpose) {
  // Save and unlock the database first so a slow mail server does not hold up other requests.
  await postgresStore.commitRequest();
  try {
    await sendVerificationCodeEmail(user, code, purpose, OTP_TTL_MS / 60000);
    return true;
  } catch (error) {
    console.error('Verification code email could not be sent:', error.message);
    if (process.env.NODE_ENV !== 'production') {
      // Local development without SMTP: print the code so the flow can still be completed.
      console.info(`Development ${purpose} code for ${user.email}: ${code}`);
    }
    return false;
  }
}

// Issues a new code for this session and emails it. purpose: 'signup' | 'login'.
async function startOtp(req, user, purpose) {
  const code = generateOtpCode();
  const now = Date.now();
  req.session.otp = {
    purpose,
    userId: user.id,
    fingerprint: accountFingerprint(user),
    codeHash: hashToken(code),
    expiresAt: now + OTP_TTL_MS,
    sentAt: now,
    attempts: 0
  };
  return deliverOtpEmail(user, code, purpose);
}

function otpResponse(user, purpose, emailSent) {
  const resendAfter = Math.ceil(OTP_RESEND_MS / 1000);
  return {
    otpRequired: true,
    purpose,
    email: user.email,
    emailSent,
    resendAfter,
    message: emailSent
      ? `We sent a 6-digit code to ${user.email}.`
      : `We could not send the code to ${user.email}. Try "Resend code" in ${resendAfter} seconds.`
  };
}

function sessionUserFor(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    department: user.department,
    studentId: user.studentId
  };
}

function authenticateSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.user = user;
      req.session.save(saveError => {
        if (saveError) return reject(saveError);
        resolve();
      });
    });
  });
}

function getUsers() {
  return readJsonArray(USERS_FILE);
}

function saveUsers(users) {
  writeJsonArray(USERS_FILE, users);
}

function getBlockedEmails() {
  return readJsonArray(BLOCKED_EMAILS_FILE);
}

function saveBlockedEmails(blockedEmails) {
  writeJsonArray(BLOCKED_EMAILS_FILE, blockedEmails);
}

function isEmailBlocked(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return getBlockedEmails().some(entry => entry.email === normalized);
}

function getAllowedEmails() {
  return readJsonArray(ALLOWED_EMAILS_FILE);
}

function saveAllowedEmails(allowedEmails) {
  writeJsonArray(ALLOWED_EMAILS_FILE, allowedEmails);
}

// An empty allowlist means no restriction is active: every properly domained email may
// register or sign in. Once it holds at least one entry, only those emails (plus any
// administrator, who must always be able to manage this list) are let through.
function isEmailAllowed(email, role) {
  if (role === 'admin') return true;
  const allowedEmails = getAllowedEmails();
  if (allowedEmails.length === 0) return true;
  const normalized = String(email || '').trim().toLowerCase();
  return allowedEmails.some(entry => entry.email === normalized);
}

function ensureDefaultAdminAccount() {
  const ensureAccount = () => {
    const users = getUsers();
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@cspc.edu.ph').trim().toLowerCase();
    if (!isAdminEmail(adminEmail)) {
      throw new Error('ADMIN_EMAIL must be a valid @cspc.edu.ph or @my.cspc.edu.ph address.');
    }

    const existingAdmin = users.find(user => user.email.toLowerCase() === adminEmail);
    if (existingAdmin) {
      if (existingAdmin.role !== 'admin') {
        throw new Error(`${adminEmail} already belongs to a student account. Run "npm run admin:set" to make it the administrator.`);
      }
      if (process.env.NODE_ENV === 'production' && process.env.ADMIN_PASSWORD_RESET === 'true') {
        const password = process.env.ADMIN_PASSWORD;
        if (!password || password.length < 12) {
          throw new Error('ADMIN_PASSWORD must be configured with at least 12 characters to reset the production admin password.');
        }

        existingAdmin.passwordHash = bcrypt.hashSync(password, 10);
        saveUsers(users);
        console.info(`Production admin password reset completed for ${adminEmail}. Set ADMIN_PASSWORD_RESET=false after verifying login.`);
      }
      return;
    }

    const password = process.env.ADMIN_PASSWORD;
    if (process.env.NODE_ENV === 'production' && (!password || password.length < 12)) {
      throw new Error('ADMIN_PASSWORD must be configured with at least 12 characters in production.');
    }

    users.push({
      id: `usr-admin-${Date.now()}`,
      email: adminEmail,
      passwordHash: bcrypt.hashSync(password || 'admin@_123bAck2u', 10),
      fullName: sanitizeString(process.env.ADMIN_NAME || 'System Admin'),
      studentId: 'N/A',
      role: 'admin',
      department: 'Administration',
      createdAt: new Date().toISOString()
    });
    saveUsers(users);
  };

  if (postgresStore.isConfigured()) return postgresStore.withTransaction(ensureAccount);
  return ensureAccount();
}

// POST /api/auth/register - Step 1: collect only the email (and name/type); the OTP
// below proves the inbox belongs to whoever is registering before a password is ever
// asked for. POST /api/auth/complete-registration is step 2, once that code is verified.
router.post('/register', validateUserAuth, async (req, res) => {
  try {
    const { email, fullName } = req.body;
    const role = req.body.accountType === 'employee' ? 'employee' : 'student';
    const emailPattern = role === 'employee' ? STAFF_EMAIL : STUDENT_EMAIL;
    if (!emailPattern.test(email)) {
      return res.status(400).json({
        success: false,
        message: role === 'employee'
          ? 'Employee registration requires an @cspc.edu.ph email address.'
          : 'Student registration requires an @my.cspc.edu.ph email address.'
      });
    }
    if (isEmailBlocked(email)) {
      return res.status(403).json({
        success: false,
        message: 'This email address is not allowed to register.'
      });
    }
    if (!isEmailAllowed(email, role)) {
      return res.status(403).json({
        success: false,
        message: 'Registration is currently restricted. Contact the administrator for access.'
      });
    }
    if (isRateLimited(registrationAttempts, req.ip, REGISTRATION_LIMIT)) {
      return res.status(429).json({
        success: false,
        message: 'Too many registrations from this network. Please try again later.'
      });
    }
    const users = getUsers();

    // An unconfirmed registration can be replaced: only whoever owns the inbox can
    // enter the emailed code, so squatting on someone's address achieves nothing.
    const existingIndex = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());
    if (existingIndex !== -1 && users[existingIndex].emailVerified !== false) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email address already exists.'
      });
    }

    const newUser = {
      id: existingIndex === -1 ? 'usr-' + Date.now() : users[existingIndex].id,
      email,
      fullName: sanitizeString(fullName) || (role === 'employee' ? 'CSPC Employee' : 'CSPC Student'),
      // Self-registration no longer asks for a student ID or department.
      studentId: 'N/A',
      role,
      department: '',
      emailVerified: false,
      // No passwordHash yet - that's collected only after the OTP below confirms the
      // inbox. Regenerated on every (re-)registration so a stale pending session from
      // an earlier registration attempt (by someone else) can never be used to set it.
      registrationNonce: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString()
    };

    if (existingIndex === -1) users.push(newUser);
    else users[existingIndex] = newUser;
    saveUsers(users);
    recordAttempt(registrationAttempts, req.ip, REGISTRATION_LIMIT);

    const emailSent = await startOtp(req, newUser, 'signup');
    res.status(201).json({
      success: true,
      verificationRequired: true,
      ...otpResponse(newUser, 'signup', emailSent)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Internal server error during registration.'
    });
  }
});

// GET /api/auth/google-client-id - Lets the login page decide whether to show the Google
// button, without baking the client ID into static HTML (this app has no templating).
router.get('/google-client-id', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

// POST /api/auth/google - Sign in (or self-register) with a verified Google Workspace
// account. Skips the emailed code a password sign-in needs, since Google already proved
// the inbox; student vs employee is the same @my.cspc.edu.ph / @cspc.edu.ph split as
// manual registration, read from Google's own verified email instead of a form field.
router.post('/google', async (req, res) => {
  if (!googleClient) {
    return res.status(503).json({ success: false, message: 'Google sign-in is not configured on this server.' });
  }
  const credential = typeof req.body.credential === 'string' ? req.body.credential : '';
  if (!credential) {
    return res.status(400).json({ success: false, message: 'Missing Google credential.' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Could not verify your Google sign-in. Please try again.' });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!payload.email_verified || (!STUDENT_EMAIL.test(email) && !STAFF_EMAIL.test(email))) {
    return res.status(403).json({
      success: false,
      message: 'Sign in with your CSPC Google account (@my.cspc.edu.ph or @cspc.edu.ph).'
    });
  }
  if (isEmailBlocked(email)) {
    return res.status(403).json({ success: false, message: 'This account has been blocked. Contact the administrator.' });
  }

  const role = STUDENT_EMAIL.test(email) ? 'student' : 'employee';
  const users = getUsers();
  let user = users.find(u => u.email.toLowerCase() === email);

  if (!isEmailAllowed(email, user ? user.role : role)) {
    return res.status(403).json({ success: false, message: 'Sign-in is currently restricted. Contact the administrator for access.' });
  }

  if (!user) {
    user = {
      id: 'usr-' + Date.now(),
      email,
      // No password is ever checked for a Google-created account; a long random hash
      // means nothing a user could type at the sign-in form will ever match it.
      passwordHash: bcrypt.hashSync(crypto.randomBytes(48).toString('hex'), 10),
      fullName: sanitizeString(payload.name) || (role === 'employee' ? 'CSPC Employee' : 'CSPC Student'),
      studentId: 'N/A',
      role,
      department: '',
      emailVerified: true,
      authProvider: 'google',
      createdAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers(users);
  }

  const sessionUser = sessionUserFor(user);
  await authenticateSession(req, sessionUser);
  res.json({ success: true, message: 'Login successful.', user: sessionUser });
});

// GET /api/auth/verify-email?token=... - Confirmation links emailed before sign-up
// switched to codes. New accounts get a code instead; this keeps older links working.
router.get('/verify-email', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!/^[a-f0-9]{64}$/.test(token)) return res.redirect(302, '/login?verified=invalid');

  const users = getUsers();
  const tokenHash = hashToken(token);
  const user = users.find(u => u.emailVerified === false && u.verificationTokenHash === tokenHash);
  if (!user) return res.redirect(302, '/login?verified=invalid');
  if (Date.parse(user.verificationExpiresAt) < Date.now()) return res.redirect(302, '/login?verified=expired');

  user.emailVerified = true;
  user.emailVerifiedAt = new Date().toISOString();
  delete user.verificationTokenHash;
  delete user.verificationExpiresAt;
  delete user.verificationSentAt;
  saveUsers(users);
  res.redirect(302, '/login?verified=success');
});

// POST /api/auth/login
router.post('/login', validateUserAuth, async (req, res) => {
  try {
    const { email, password } = req.body;
    const attemptKey = `${req.ip}|${email}`;
    if (isRateLimited(loginFailures, attemptKey, LOGIN_LIMIT)) {
      return res.status(429).json({
        success: false,
        message: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.'
      });
    }

    const users = getUsers();
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

    // Students use @my.cspc.edu.ph, employees use @cspc.edu.ph; an admin account may be on either domain.
    // A pending sign-up (OTP confirmed or not) has no passwordHash yet, so there is no
    // password it could ever match - treat it the same as "no such account".
    const domainAllowed = Boolean(user) && Boolean(user.passwordHash) && (
      user.role === 'admin' ? isAdminEmail(email)
        : user.role === 'employee' ? STAFF_EMAIL.test(email)
          : STUDENT_EMAIL.test(email)
    );
    // Always run bcrypt so response time does not reveal whether the account exists.
    const isMatch = await bcrypt.compare(password, domainAllowed ? user.passwordHash : DUMMY_PASSWORD_HASH);
    if (!domainAllowed || !isMatch) {
      recordAttempt(loginFailures, attemptKey, LOGIN_LIMIT);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }
    loginFailures.delete(attemptKey);

    if (isEmailBlocked(email)) {
      return res.status(403).json({
        success: false,
        message: 'This account has been blocked. Contact the administrator.'
      });
    }
    if (!isEmailAllowed(email, user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Sign-in is currently restricted. Contact the administrator for access.'
      });
    }

    // A verified account signs in with the password alone, no emailed code; only an
    // unconfirmed sign-up still needs one, to prove the inbox is really theirs.
    // (Wrong passwords above still count toward the sign-in lockout.)
    if (user.emailVerified !== false) {
      const sessionUser = sessionUserFor(user);
      await authenticateSession(req, sessionUser);
      // Fire-and-forget: a slow mail server should never hold up the sign-in response.
      sendSignInNotificationEmail(sessionUser).catch(error =>
        console.error('Sign-in notification email could not be sent:', error.message));
      return res.json({ success: true, message: 'Login successful.', user: sessionUser });
    }

    // Correct password on an unconfirmed account: resend (or reuse) the sign-up code.
    // A code sent to this browser in the last minute is reused instead of re-sent.
    const pending = req.session.otp;
    const reusable = pending && pending.userId === user.id && pending.purpose === 'signup' &&
      pending.fingerprint === accountFingerprint(user) &&
      Date.now() - pending.sentAt < OTP_RESEND_MS && pending.attempts < OTP_MAX_ATTEMPTS;
    const emailSent = reusable ? true : await startOtp(req, user, 'signup');
    const body = otpResponse(user, 'signup', emailSent);
    res.status(403).json({ success: false, code: 'EMAIL_NOT_VERIFIED', ...body,
      message: `Please confirm your email first. ${body.message}` });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Internal server error during login.'
    });
  }
});

// POST /api/auth/verify-code - Second step: the 6-digit code emailed by /register or /login.
router.post('/verify-code', async (req, res) => {
  try {
    const pending = req.session.otp;
    if (!pending) {
      return res.status(400).json({ success: false, code: 'OTP_MISSING',
        message: 'This code is no longer valid. Go back and sign in again to get a new one.' });
    }
    if (Date.now() > pending.expiresAt || pending.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(400).json({ success: false, code: 'OTP_EXPIRED',
        message: 'This code has expired. Tap "Resend code" to get a new one.' });
    }
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, code: 'OTP_FORMAT', message: 'Enter the 6-digit code from the email.' });
    }

    const users = getUsers();
    const user = users.find(u => u.id === pending.userId);
    if (!user || accountFingerprint(user) !== pending.fingerprint) {
      delete req.session.otp;
      return res.status(400).json({ success: false, code: 'OTP_MISSING',
        message: 'This code is no longer valid. Go back and sign in again to get a new one.' });
    }

    pending.attempts += 1;
    const matches = crypto.timingSafeEqual(Buffer.from(hashToken(code), 'hex'), Buffer.from(pending.codeHash, 'hex'));
    if (!matches) {
      const attemptsLeft = OTP_MAX_ATTEMPTS - pending.attempts;
      return res.status(400).json({
        success: false,
        code: attemptsLeft > 0 ? 'OTP_INVALID' : 'OTP_EXPIRED',
        attemptsLeft,
        message: attemptsLeft > 0
          ? `That code is not right. ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`
          : 'Too many wrong codes. Tap "Resend code" to get a new one.'
      });
    }

    // A brand-new sign-up has no password yet: the inbox is confirmed, but registration
    // only finishes once /complete-registration sets one. Nothing is saved to the user
    // record here, so a password is never asked for before the OTP that gates it.
    if (pending.purpose === 'signup' && !user.passwordHash) {
      req.session.pendingPassword = { userId: user.id, fingerprint: accountFingerprint(user) };
      delete req.session.otp;
      return res.json({
        success: true,
        passwordRequired: true,
        email: user.email,
        message: 'Your CSPC email is verified. Create a password to finish setting up your account.'
      });
    }

    // An older account that already had a password before this step existed (created
    // before this flow shipped): confirm it the same way sign-up used to.
    if (pending.purpose === 'signup' && user.emailVerified === false) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date().toISOString();
      delete user.verificationTokenHash;
      delete user.verificationExpiresAt;
      delete user.verificationSentAt;
      saveUsers(users);
    }

    // A new session id for the signed-in session; the pending code goes with the old one.
    const sessionUser = sessionUserFor(user);
    await authenticateSession(req, sessionUser);
    res.json({
      success: true,
      message: pending.purpose === 'signup' ? 'Your email is confirmed. Welcome to Back2You!' : 'Login successful.',
      user: sessionUser
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Internal server error during verification.' });
  }
});

// POST /api/auth/complete-registration - Step 2 of sign-up: create the password, now that
// /verify-code has proven this session's owner controls the inbox. Reachable only with the
// session marker verify-code sets, which dies if the account is re-registered meanwhile.
router.post('/complete-registration', async (req, res) => {
  try {
    const pending = req.session.pendingPassword;
    if (!pending) {
      return res.status(400).json({ success: false, code: 'PENDING_MISSING',
        message: 'Your verification has expired. Please register again.' });
    }

    const users = getUsers();
    const user = users.find(u => u.id === pending.userId);
    if (!user || user.passwordHash || accountFingerprint(user) !== pending.fingerprint) {
      delete req.session.pendingPassword;
      return res.status(400).json({ success: false, code: 'PENDING_MISSING',
        message: 'Your verification has expired. Please register again.' });
    }

    const errors = passwordStrengthErrors(req.body.password, minimumPasswordLength(user));
    if (errors.length) return res.status(400).json({ success: false, message: errors.join(' '), errors });

    user.passwordHash = await bcrypt.hash(req.body.password, 10);
    user.emailVerified = true;
    user.emailVerifiedAt = new Date().toISOString();
    delete user.registrationNonce;
    saveUsers(users);
    delete req.session.pendingPassword;

    const sessionUser = sessionUserFor(user);
    await authenticateSession(req, sessionUser);
    res.json({ success: true, message: 'Your account is ready. Welcome to Back2You!', user: sessionUser });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Internal server error while creating your password.' });
  }
});

// POST /api/auth/resend-code - New code for the sign-up or sign-in waiting in this session.
router.post('/resend-code', async (req, res) => {
  try {
    const pending = req.session.otp;
    if (!pending) {
      return res.status(400).json({ success: false, code: 'OTP_MISSING',
        message: 'Go back and sign in again to get a new code.' });
    }
    const waitMs = OTP_RESEND_MS - (Date.now() - pending.sentAt);
    if (waitMs > 0) {
      const retryAfter = Math.ceil(waitMs / 1000);
      return res.status(429).json({ success: false, retryAfter,
        message: `Please wait ${retryAfter} seconds before requesting another code.` });
    }
    const user = getUsers().find(u => u.id === pending.userId);
    if (!user || accountFingerprint(user) !== pending.fingerprint) {
      delete req.session.otp;
      return res.status(400).json({ success: false, code: 'OTP_MISSING',
        message: 'Go back and sign in again to get a new code.' });
    }
    const emailSent = await startOtp(req, user, pending.purpose);
    res.json({ success: true, ...otpResponse(user, pending.purpose, emailSent),
      message: emailSent ? `We sent a new code to ${user.email}.` : 'We could not send a new code. Please try again in a minute.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Internal server error while sending the code.' });
  }
});

// POST /api/auth/forgot-password - Email a one-hour reset link.
// The reply is identical whether or not the account exists.
router.post('/forgot-password', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!STUDENT_EMAIL.test(email) && !STAFF_EMAIL.test(email)) {
    return res.status(400).json({ success: false, message: 'Use your CSPC email address ending in @my.cspc.edu.ph.' });
  }
  if (isRateLimited(resetRequests, req.ip, RESET_REQUEST_LIMIT)) {
    return res.status(429).json({ success: false, message: 'Too many reset requests. Please try again later.' });
  }
  recordAttempt(resetRequests, req.ip, RESET_REQUEST_LIMIT);

  try {
    const users = getUsers();
    const user = users.find(u => u.email.toLowerCase() === email);
    const lastSent = Date.parse(user?.passwordResetSentAt) || 0;
    if (user && Date.now() - lastSent > VERIFICATION_RESEND_MS) {
      const token = issuePasswordResetToken();
      Object.assign(user, token.fields);
      saveUsers(users);
      await deliverPasswordResetEmail(user, token.value);
    }
    res.json({
      success: true,
      message: `If an account exists for ${email}, a password reset link has been sent. The link expires in 1 hour.`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not process the reset request.' });
  }
});

// POST /api/auth/reset-password - Set a new password using the emailed link.
router.post('/reset-password', async (req, res) => {
  const token = typeof req.body.token === 'string' ? req.body.token : '';
  const invalid = () => res.status(400).json({
    success: false,
    code: 'RESET_LINK_INVALID',
    message: 'This reset link is invalid or has expired. Please request a new one.'
  });
  if (!/^[a-f0-9]{64}$/.test(token)) return invalid();

  try {
    const users = getUsers();
    const tokenHash = hashToken(token);
    const user = users.find(u => u.passwordResetTokenHash === tokenHash);
    if (!user || Date.parse(user.passwordResetExpiresAt) < Date.now()) return invalid();

    const errors = passwordStrengthErrors(req.body.password, minimumPasswordLength(user));
    if (errors.length) return res.status(400).json({ success: false, message: errors.join(' '), errors });

    user.passwordHash = await bcrypt.hash(req.body.password, 10);
    user.passwordChangedAt = new Date().toISOString();
    clearPasswordReset(user);
    // Opening the emailed link proves the student owns the inbox.
    if (user.emailVerified === false) {
      user.emailVerified = true;
      user.emailVerifiedAt = user.passwordChangedAt;
      delete user.verificationTokenHash;
      delete user.verificationExpiresAt;
      delete user.verificationSentAt;
    }
    saveUsers(users);
    loginFailures.forEach((entry, key) => {
      if (key.endsWith(`|${user.email}`)) loginFailures.delete(key);
    });
    res.json({ success: true, message: 'Your password has been changed. You can now sign in.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not reset the password.' });
  }
});

// POST /api/auth/change-password - Signed-in users change their own password.
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const attemptKey = `${req.ip}|${req.session.user.email}`;
  if (isRateLimited(loginFailures, attemptKey, LOGIN_LIMIT)) {
    return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please wait 15 minutes and try again.' });
  }

  try {
    const users = getUsers();
    const user = users.find(u => String(u.id) === String(req.session.user.id));
    if (!user) return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });

    const currentMatches = typeof currentPassword === 'string'
      && await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentMatches) {
      recordAttempt(loginFailures, attemptKey, LOGIN_LIMIT);
      return res.status(400).json({ success: false, message: 'Your current password is incorrect.' });
    }

    const errors = passwordStrengthErrors(newPassword, minimumPasswordLength(user));
    if (newPassword === currentPassword) errors.push('Choose a password different from your current one.');
    if (errors.length) return res.status(400).json({ success: false, message: errors.join(' '), errors });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordChangedAt = new Date().toISOString();
    clearPasswordReset(user);
    saveUsers(users);
    loginFailures.delete(attemptKey);
    // New session ID so a previously captured session cookie stops working.
    await authenticateSession(req, req.session.user);
    res.json({ success: true, message: 'Your password has been changed.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not change the password.' });
  }
});

// Accounts deleted since the server started. Their sessions are refused (server.js),
// including one the session store re-saves from a request that was still finishing.
const removedAccountIds = new Set();
function isAccountRemoved(userId) {
  return removedAccountIds.has(String(userId));
}

// Removes a student's data when they delete their account.
//   Deleted:    their registered belongings, their lost reports, their pending claims,
//               their inbox notifications, shared meetup locations, and those items' photos.
//   Anonymised: found reports they posted (the owner must still be able to claim the
//               item) and claims that were already decided (the school's record).
// Returns the photos to remove from storage.
function eraseStudentData(user) {
  const userId = String(user.id);
  const items = readJsonArray(ITEMS_FILE);
  const removedItemIds = new Set();
  const photos = [];
  const keptItems = items.filter(item => {
    const isTheirs = String(item.reportedBy) === userId;
    if (isTheirs && (item.type === 'registered' || item.type === 'lost')) {
      removedItemIds.add(String(item.id));
      if (item.photo) photos.push(item.photo);
      return false;
    }
    return true;
  });
  keptItems.forEach(item => {
    if (String(item.reportedBy) !== userId) return;
    item.reportedBy = 'guest';
    item.contact = 'Reporter account deleted. Please contact the Back2You admin.';
    delete item.reporterName;
    delete item.reporterEmail;
    delete item.ownerName;
    delete item.ownerEmail;
    delete item.notifications;
  });
  writeJsonArray(ITEMS_FILE, keptItems);

  const anonymisedItemIds = new Set(keptItems.filter(item => item.reportedBy === 'guest').map(item => String(item.id)));
  const claims = readJsonArray(CLAIMS_FILE).filter(claim => {
    const isClaimant = String(claim.claimantId) === userId;
    // Undecided claims by them, and claims tied to a lost report that no longer exists.
    if (isClaimant && claim.status === 'pending') return false;
    if (claim.status === 'pending' && removedItemIds.has(String(claim.lostItemId))) return false;
    return true;
  });
  claims.forEach(claim => {
    const isClaimant = String(claim.claimantId) === userId;
    if (isClaimant) {
      claim.claimantId = 'deleted-account';
      claim.claimantName = 'Deleted account';
      claim.claimantEmail = '';
      claim.claimantContact = '';
      claim.claimantStudentId = '';
      claim.claimantCourseYear = '';
      claim.claimantDepartment = '';
      claim.proof = 'Removed with the account.';
      delete claim.notification;
    }
    // No more handover meetup with a person who has left.
    if (isClaimant || anonymisedItemIds.has(String(claim.itemId))) delete claim.meetup;
  });
  writeJsonArray(CLAIMS_FILE, claims);
  return photos;
}

async function removeStoredPhotos(photos) {
  for (const photo of photos) {
    try {
      if (typeof photo === 'string' && photo.startsWith('/uploads/')) {
        fs.rmSync(path.join(DATA_DIR, 'uploads', path.basename(photo)), { force: true });
      }
      if (supabaseStorage.objectKey(photo)) await supabaseStorage.deleteImage(photo);
    } catch (error) {
      console.error('A photo could not be removed with the deleted account:', error.message);
    }
  }
}

// POST /api/auth/delete-account - A student permanently deletes their own account.
router.post('/delete-account', requireAuth, async (req, res) => {
  const attemptKey = `${req.ip}|${req.session.user.email}`;
  if (isRateLimited(loginFailures, attemptKey, LOGIN_LIMIT)) {
    return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please wait 15 minutes and try again.' });
  }

  try {
    const users = getUsers();
    const index = users.findIndex(u => String(u.id) === String(req.session.user.id));
    if (index === -1) return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    const user = users[index];
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, message: 'Admin accounts are removed by another administrator from the admin page.' });
    }
    if (req.body.confirm !== 'DELETE') {
      return res.status(400).json({ success: false, message: 'Type DELETE to confirm that you want to delete your account.' });
    }
    const passwordMatches = typeof req.body.password === 'string'
      && await bcrypt.compare(req.body.password, user.passwordHash);
    if (!passwordMatches) {
      recordAttempt(loginFailures, attemptKey, LOGIN_LIMIT);
      return res.status(400).json({ success: false, message: 'Your password is incorrect.' });
    }

    const photos = eraseStudentData(user);
    users.splice(index, 1);
    saveUsers(users);
    removedAccountIds.add(String(user.id));
    loginFailures.delete(attemptKey);
    await postgresStore.commitRequest();
    await removeStoredPhotos(photos);

    req.session.destroy(() => {
      res.clearCookie('cspc.sid');
      res.json({ success: true, message: 'Your account and personal data have been deleted.' });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not delete the account. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Could not log out.' });
    }
    res.clearCookie('cspc.sid');
    res.json({ success: true, message: 'Logged out successfully.' });
  });
});

// GET /api/auth/me (Current Session Check)
router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({
      authenticated: true,
      user: req.session.user
    });
  }
  res.json({
    authenticated: false,
    user: null
  });
});

// GET /api/auth/users - Admin-only user directory (never expose password hashes).
router.get('/users', requireRole('admin'), (req, res) => {
  const users = getUsers()
    // A pending sign-up (no password yet - the OTP was never entered) never finished
    // registering, so it shouldn't appear as an account the admin can manage.
    .filter(user => Boolean(user.passwordHash))
    .map(({
      passwordHash, verificationTokenHash, verificationExpiresAt, verificationSentAt,
      passwordResetTokenHash, passwordResetExpiresAt, passwordResetSentAt, ...user
    }) => user);
  res.json({ success: true, users });
});

// POST /api/auth/users - Admin-only user creation.
router.post('/users', requireRole('admin'), async (req, res) => {
  try {
    const fullName = sanitizeString(req.body.fullName);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const role = ['admin', 'employee'].includes(req.body.role) ? req.body.role : 'student';
    const studentId = sanitizeString(req.body.studentId) || 'N/A';
    const department = sanitizeString(req.body.department) || (role === 'admin' ? 'Administration' : '');
    const errors = [];

    if (!fullName || fullName.length < 2 || fullName.length > 100) errors.push('Full name must be between 2 and 100 characters.');
    if (role === 'student' && !STUDENT_EMAIL.test(email)) errors.push('Student accounts must use an @my.cspc.edu.ph email.');
    if (role === 'employee' && !STAFF_EMAIL.test(email)) errors.push('Employee accounts must use an @cspc.edu.ph email.');
    if (role === 'admin' && !isAdminEmail(email)) errors.push('Admin accounts must use an @cspc.edu.ph or @my.cspc.edu.ph email.');
    if (passwordStrengthErrors(password, role === 'admin' ? 12 : 8).length) {
      errors.push(`Password must be at least ${role === 'admin' ? 12 : 8} characters and include uppercase, lowercase, number, and special character.`);
    }
    if (role === 'student' && !STUDENT_DEPARTMENTS.has(department)) errors.push('Select a valid college department.');
    if (role === 'admin' && department !== 'Administration') errors.push('Admin accounts must use the Administration department.');

    const users = getUsers();
    if (users.some(user => user.email.toLowerCase() === email)) errors.push('An account with this email address already exists.');
    if (errors.length) return res.status(400).json({ success: false, message: 'User validation failed.', errors });

    const newUser = {
      id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      fullName,
      studentId,
      role,
      department,
      createdAt: new Date().toISOString()
    };
    users.push(newUser);
    saveUsers(users);

    // An admin creating this account directly is itself the access decision: make sure
    // an active allowlist does not then turn around and lock the new account out.
    if (role !== 'admin') {
      const allowedEmails = getAllowedEmails();
      if (!allowedEmails.some(entry => entry.email === email)) {
        allowedEmails.push({ id: email, email, addedAt: new Date().toISOString(), addedBy: req.session.user.email });
        saveAllowedEmails(allowedEmails);
      }
    }

    const { passwordHash, ...safeUser } = newUser;
    res.status(201).json({ success: true, message: 'User created successfully.', user: safeUser });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not create user.' });
  }
});

// DELETE /api/auth/users/:id - Admin-only user deletion.
router.delete('/users/:id', requireRole('admin'), (req, res) => {
  const users = getUsers();
  const index = users.findIndex(user => String(user.id) === String(req.params.id));
  if (index === -1) return res.status(404).json({ success: false, message: 'User not found.' });

  const target = users[index];
  if (target.id === req.session.user.id) return res.status(400).json({ success: false, message: 'You cannot delete the account currently in use.' });
  if (target.role === 'admin' && users.filter(user => user.role === 'admin').length <= 1) {
    return res.status(400).json({ success: false, message: 'The last administrator account cannot be deleted.' });
  }

  users.splice(index, 1);
  saveUsers(users);
  removedAccountIds.add(String(target.id));
  res.json({ success: true, message: 'User deleted successfully.' });
});

// GET /api/auth/blocked-emails - Admin-only blocklist directory.
router.get('/blocked-emails', requireRole('admin'), (req, res) => {
  res.json({ success: true, blockedEmails: getBlockedEmails() });
});

// POST /api/auth/blocked-emails - Admin-only: block an email from registering or signing in.
router.post('/blocked-emails', requireRole('admin'), (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }

  const blockedEmails = getBlockedEmails();
  if (!blockedEmails.some(entry => entry.email === email)) {
    blockedEmails.push({
      id: email,
      email,
      blockedAt: new Date().toISOString(),
      blockedBy: req.session.user.email
    });
    saveBlockedEmails(blockedEmails);
  }
  res.status(201).json({ success: true, message: 'Email blocked.', blockedEmails });
});

// DELETE /api/auth/blocked-emails/:email - Admin-only: unblock an email.
router.delete('/blocked-emails/:email', requireRole('admin'), (req, res) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  const blockedEmails = getBlockedEmails().filter(entry => entry.email !== email);
  saveBlockedEmails(blockedEmails);
  res.json({ success: true, message: 'Email unblocked.', blockedEmails });
});

// GET /api/auth/allowed-emails - Admin-only allowlist directory.
router.get('/allowed-emails', requireRole('admin'), (req, res) => {
  res.json({ success: true, allowedEmails: getAllowedEmails() });
});

// POST /api/auth/allowed-emails - Admin-only: add an email to the allowlist. Once the
// list holds at least one entry, only those emails (plus admins) may register or sign in.
router.post('/allowed-emails', requireRole('admin'), (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }

  const allowedEmails = getAllowedEmails();
  if (!allowedEmails.some(entry => entry.email === email)) {
    allowedEmails.push({
      id: email,
      email,
      addedAt: new Date().toISOString(),
      addedBy: req.session.user.email
    });
    saveAllowedEmails(allowedEmails);
  }
  res.status(201).json({ success: true, message: 'Email allowed.', allowedEmails });
});

// DELETE /api/auth/allowed-emails/:email - Admin-only: remove an email from the allowlist.
router.delete('/allowed-emails/:email', requireRole('admin'), (req, res) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  const allowedEmails = getAllowedEmails().filter(entry => entry.email !== email);
  saveAllowedEmails(allowedEmails);
  res.json({ success: true, message: 'Email removed from the allowlist.', allowedEmails });
});

router.ensureDefaultAdminAccount = ensureDefaultAdminAccount;
router.setOtpCodeGeneratorForTests = setOtpCodeGeneratorForTests;
router.isAccountRemoved = isAccountRemoved;
router.isEmailBlocked = isEmailBlocked;

module.exports = router;
