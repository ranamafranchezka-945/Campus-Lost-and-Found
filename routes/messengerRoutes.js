// routes/messengerRoutes.js - Messenger account linking and the Meta webhook.
//
// Meta only allows messaging a person who has messaged the Page first, so students opt in
// by sending a one-time code (generated from their account menu) to the Back2You Facebook
// Page. The webhook below matches that code to their account and stores their Messenger
// PSID (Page-Scoped ID), which is then used to deliver possible-match and meetup-location
// alerts alongside the existing email notifications.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { readJsonArray, writeJsonArray } = require('../services/jsonStore');
const { requireAuth, requireRole } = require('../middleware/auth');
const messenger = require('../services/messenger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LINK_CODE_TTL_MS = 15 * 60 * 1000;

function getUsers() {
  return readJsonArray(USERS_FILE);
}

function saveUsers(users) {
  writeJsonArray(USERS_FILE, users);
}

function generateLinkCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// GET /api/messenger/webhook - Meta's one-time verification handshake when the webhook
// URL and verify token are first entered in the Messenger API Settings page.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.MESSENGER_VERIFY_TOKEN;

  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /api/messenger/webhook - Incoming Messenger events. The only thing a message can do
// here is complete an account-linking code; everything else gets a short help reply.
router.post('/webhook', async (req, res) => {
  if (req.body?.object !== 'page') return res.sendStatus(200);

  // Matching and saving must finish (and the database transaction must be committed) before
  // the response is sent: this app's store auto-commits on res.end, and Meta doesn't need the
  // ack sub-second, just within its retry window. The actual Messenger replies are slow network
  // calls, so those fire only after the database work is safely saved and the response is sent.
  const replies = [];
  try {
    const users = getUsers();
    let changed = false;
    const now = Date.now();

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        const psid = event?.sender?.id;
        const text = typeof event?.message?.text === 'string' ? event.message.text.trim() : '';
        if (!psid || !text) continue;

        const user = users.find(
          (candidate) =>
            candidate.messengerLinkCode === text &&
            candidate.messengerLinkCodeExpiresAt &&
            new Date(candidate.messengerLinkCodeExpiresAt).getTime() > now
        );

        if (user) {
          user.messengerPsid = psid;
          delete user.messengerLinkCode;
          delete user.messengerLinkCodeExpiresAt;
          changed = true;
          replies.push({
            psid,
            text: "You're connected! Back2You will send your possible-match and location-request alerts here from now on.",
          });
        } else {
          replies.push({
            psid,
            text: "That code wasn't recognized or has expired. Generate a new one from your Back2You account menu and send it here again.",
          });
        }
      }
    }

    if (changed) saveUsers(users);
  } catch (error) {
    console.error('Messenger webhook could not be processed:', error.message);
  }

  res.sendStatus(200);
  for (const { psid, text } of replies) {
    messenger
      .sendMessengerText(psid, text)
      .catch((error) => console.error('Messenger reply could not be sent:', error.message));
  }
});

// POST /api/messenger/link-code - A signed-in student requests a one-time code to send to
// the Back2You Facebook Page, linking their Messenger account for alerts.
router.post('/link-code', requireAuth, async (req, res) => {
  if (!(await messenger.isConfigured())) {
    return res.status(503).json({ success: false, message: 'Messenger alerts are not configured yet.' });
  }

  const users = getUsers();
  const user = users.find((candidate) => String(candidate.id) === String(req.session.user.id));
  if (!user) return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });

  const code = generateLinkCode();
  user.messengerLinkCode = code;
  user.messengerLinkCodeExpiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  saveUsers(users);

  res.json({
    success: true,
    code,
    expiresInMinutes: LINK_CODE_TTL_MS / 60000,
    pageUrl: process.env.MESSENGER_PAGE_URL || null,
  });
});

// GET /api/messenger/status - Whether the signed-in student already has Messenger linked.
router.get('/status', requireAuth, (req, res) => {
  const users = getUsers();
  const user = users.find((candidate) => String(candidate.id) === String(req.session.user.id));
  res.json({ success: true, linked: Boolean(user?.messengerPsid) });
});

// POST /api/messenger/unlink - Disconnects Messenger alerts for the signed-in student.
router.post('/unlink', requireAuth, (req, res) => {
  const users = getUsers();
  const user = users.find((candidate) => String(candidate.id) === String(req.session.user.id));
  if (user) {
    delete user.messengerPsid;
    delete user.messengerLinkCode;
    delete user.messengerLinkCodeExpiresAt;
    saveUsers(users);
  }
  res.json({ success: true });
});

// GET /api/messenger/diagnostics - Admin-only: checks the Page token and webhook
// subscription directly against Meta, so a "no reply" report can be diagnosed without
// digging through server logs.
router.get('/diagnostics', requireRole('admin'), async (req, res) => {
  const result = await messenger.diagnose();
  res.json({ success: true, ...result });
});

// ── "Connect Facebook Page" admin OAuth flow ──────────────────────────────────────────────
// Lets an admin sign in with Facebook, pick the Page to connect, and have Back2You store
// that Page's token and turn on its webhook subscription automatically - instead of an
// admin manually pasting a Page Access Token and ticking webhook checkboxes by hand.

function oauthRedirectUri() {
  const base = process.env.APP_BASE_URL;
  if (!base) throw new Error('APP_BASE_URL must be configured.');
  return new URL('/api/messenger/oauth/callback', base).toString();
}

// GET /api/messenger/oauth/start - Admin-only: redirects to the Facebook OAuth dialog.
router.get('/oauth/start', requireRole('admin'), (req, res) => {
  try {
    const state = crypto.randomUUID();
    req.session.messengerOAuthState = state;
    res.redirect(messenger.getOAuthDialogUrl(oauthRedirectUri(), state));
  } catch (error) {
    res.status(500).send(`Could not start the Facebook connection: ${error.message}`);
  }
});

// GET /api/messenger/oauth/callback - Facebook redirects here with an authorization code.
// Exchanges it for a long-lived Page token, turns on the Page's webhook subscription, and
// stores the connection so the rest of the app can start sending/receiving immediately.
router.get('/oauth/callback', requireRole('admin'), async (req, res) => {
  const { code, state, error: oauthError, error_description: oauthErrorDescription } = req.query;
  const expectedState = req.session.messengerOAuthState;
  delete req.session.messengerOAuthState;

  const fail = (message) => res.redirect(`/admin.html?connectError=${encodeURIComponent(message)}#messenger`);

  if (oauthError) return fail(oauthErrorDescription || String(oauthError));
  if (!state || !expectedState || state !== expectedState)
    return fail('This connection request expired or was tampered with. Please try again.');
  if (!code) return fail('Facebook did not return an authorization code.');

  try {
    const redirectUri = oauthRedirectUri();
    const shortLivedToken = await messenger.exchangeCodeForUserToken(code, redirectUri);
    const userToken = await messenger.exchangeForLongLivedUserToken(shortLivedToken);
    const pages = await messenger.listManagedPages(userToken);
    if (!pages.length)
      return fail(
        'No Facebook Page is available to this account. Make sure you are an admin of the Back2You Page and try again.'
      );

    const page = pages.find((entry) => entry.name === process.env.MESSENGER_PAGE_NAME) || pages[0];
    await messenger.subscribePageWebhookFields(page.id, page.access_token);
    await messenger.saveStoredConfig({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.access_token,
      connectedAt: new Date().toISOString(),
      connectedByName: req.session.user.fullName || req.session.user.email,
    });

    res.redirect(`/admin.html?connected=${encodeURIComponent(page.name)}#messenger`);
  } catch (error) {
    fail(error.message);
  }
});

// GET /api/messenger/page/connection - Admin-only: the currently connected Page, if any
// (never returns the raw token - only what the admin UI needs to display).
router.get('/page/connection', requireRole('admin'), async (req, res) => {
  const stored = await messenger.getStoredConfig();
  res.json({
    success: true,
    connected: Boolean(stored),
    page: stored
      ? {
          pageId: stored.pageId,
          pageName: stored.pageName,
          connectedAt: stored.connectedAt,
          connectedByName: stored.connectedByName,
        }
      : null,
  });
});

// POST /api/messenger/page/disconnect - Admin-only: forgets the connected Page. A manually
// configured MESSENGER_PAGE_ACCESS_TOKEN (if any) still applies afterwards.
router.post('/page/disconnect', requireRole('admin'), async (req, res) => {
  await messenger.clearStoredConfig();
  res.json({ success: true });
});

module.exports = router;
