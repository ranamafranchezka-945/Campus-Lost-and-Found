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
const { requireAuth } = require('../middleware/auth');
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
  // Acknowledge immediately: Meta retries on anything other than a fast 200.
  res.sendStatus(200);
  console.log('Messenger webhook received:', JSON.stringify(req.body));
  if (req.body?.object !== 'page') return;

  try {
    const users = getUsers();
    let changed = false;
    const now = Date.now();

    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        const psid = event?.sender?.id;
        const text = typeof event?.message?.text === 'string' ? event.message.text.trim() : '';
        if (!psid || !text) continue;

        const user = users.find(candidate =>
          candidate.messengerLinkCode === text &&
          candidate.messengerLinkCodeExpiresAt &&
          new Date(candidate.messengerLinkCodeExpiresAt).getTime() > now
        );

        if (user) {
          user.messengerPsid = psid;
          delete user.messengerLinkCode;
          delete user.messengerLinkCodeExpiresAt;
          changed = true;
          messenger.sendMessengerText(psid,
            "You're connected! Back2You will send your possible-match and location-request alerts here from now on."
          ).catch(error => console.error('Messenger confirmation could not be sent:', error.message));
        } else {
          messenger.sendMessengerText(psid,
            "That code wasn't recognized or has expired. Generate a new one from your Back2You account menu and send it here again."
          ).catch(error => console.error('Messenger help reply could not be sent:', error.message));
        }
      }
    }

    if (changed) saveUsers(users);
  } catch (error) {
    console.error('Messenger webhook could not be processed:', error.message);
  }
});

// POST /api/messenger/link-code - A signed-in student requests a one-time code to send to
// the Back2You Facebook Page, linking their Messenger account for alerts.
router.post('/link-code', requireAuth, (req, res) => {
  if (!messenger.isConfigured()) {
    return res.status(503).json({ success: false, message: 'Messenger alerts are not configured yet.' });
  }

  const users = getUsers();
  const user = users.find(candidate => String(candidate.id) === String(req.session.user.id));
  if (!user) return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });

  const code = generateLinkCode();
  user.messengerLinkCode = code;
  user.messengerLinkCodeExpiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  saveUsers(users);

  res.json({
    success: true,
    code,
    expiresInMinutes: LINK_CODE_TTL_MS / 60000,
    pageUrl: process.env.MESSENGER_PAGE_URL || null
  });
});

// GET /api/messenger/status - Whether the signed-in student already has Messenger linked.
router.get('/status', requireAuth, (req, res) => {
  const users = getUsers();
  const user = users.find(candidate => String(candidate.id) === String(req.session.user.id));
  res.json({ success: true, linked: Boolean(user?.messengerPsid) });
});

// POST /api/messenger/unlink - Disconnects Messenger alerts for the signed-in student.
router.post('/unlink', requireAuth, (req, res) => {
  const users = getUsers();
  const user = users.find(candidate => String(candidate.id) === String(req.session.user.id));
  if (user) {
    delete user.messengerPsid;
    delete user.messengerLinkCode;
    delete user.messengerLinkCodeExpiresAt;
    saveUsers(users);
  }
  res.json({ success: true });
});

module.exports = router;
