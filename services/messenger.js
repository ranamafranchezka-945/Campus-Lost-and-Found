const fs = require('fs');
const path = require('path');
const postgresStore = require('./postgresStore');

const GRAPH_API_VERSION = 'v21.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const MESSENGER_CONFIG_FILE = path.join(DATA_DIR, 'messengerConfig.json');

// Permissions requested by the "Connect Facebook Page" admin flow. Bundled together because
// Meta's Messenger use-case review expects all of them exercised by the same OAuth flow:
// pages_show_list to list the admin's Pages, pages_read_engagement to read the chosen Page's
// name, pages_manage_metadata to turn on its webhook subscription, and pages_messaging for
// the actual send/receive. business_management covers Pages owned by a Business Portfolio.
const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_messaging',
  'business_management',
  'public_profile',
];

function formatGraphError(data, status) {
  const apiError = data?.error;
  return apiError
    ? `${apiError.message} (type=${apiError.type || 'unknown'}, code=${apiError.code ?? 'n/a'}, subcode=${apiError.error_subcode ?? 'n/a'}, fbtrace_id=${apiError.fbtrace_id || 'n/a'})`
    : `Graph API request failed with status ${status}`;
}

// ── Connected Page storage ──────────────────────────────────────────────────────────────
// Read/written directly (not through the per-request transaction context used elsewhere in
// this app): Messenger sends fire after a request's own transaction has already committed
// and closed, so by the time the token is needed there is no transaction left to read from.
async function fetchStoredConfig() {
  if (postgresStore.isConfigured()) return postgresStore.getMessengerConfigDirect();
  try {
    return JSON.parse(fs.readFileSync(MESSENGER_CONFIG_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// isConfigured()/getActiveToken() are called on routes that are themselves already inside a
// per-request database transaction (see postgresStore's requestMiddleware). Hitting Supabase
// again on every single call stacks another round-trip - and on a connection blip, another
// retrying one - onto a request that's already waiting on one, risking the whole request
// outliving its transaction. A short cache keeps the common case fully in memory.
const CONFIG_CACHE_TTL_MS = 30_000;
let cachedConfig = { value: null, expiresAt: 0 };

async function getStoredConfig() {
  if (cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  const value = await fetchStoredConfig();
  cachedConfig = { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  return value;
}

async function saveStoredConfig(config) {
  if (postgresStore.isConfigured()) await postgresStore.saveMessengerConfigDirect(config);
  else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MESSENGER_CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
  cachedConfig = { value: config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
}

async function clearStoredConfig() {
  if (postgresStore.isConfigured()) await postgresStore.deleteMessengerConfigDirect();
  else {
    try {
      fs.unlinkSync(MESSENGER_CONFIG_FILE);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  cachedConfig = { value: null, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
}

// The Page token actually in effect: one connected through the admin OAuth flow, falling
// back to a manually-configured MESSENGER_PAGE_ACCESS_TOKEN for a single-Page setup that
// never went through that flow.
async function getActiveToken() {
  const stored = await getStoredConfig();
  return stored?.pageAccessToken || process.env.MESSENGER_PAGE_ACCESS_TOKEN || null;
}

async function isConfigured() {
  return Boolean(await getActiveToken());
}

// Sends a plain-text Messenger message to a PSID (Page-Scoped ID) obtained through the
// account-linking webhook flow. Throws if Messenger isn't configured or Meta rejects the
// call; callers treat this the same way they treat a failed email send (log and move on).
async function sendMessengerText(psid, text) {
  const token = await getActiveToken();
  if (!token) throw new Error('No Messenger Page is connected (connect one from the admin dashboard).');

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatGraphError(data, response.status));
  return data;
}

// Checks the active Page token and webhook subscription directly against Meta, so a silent
// "no reply" issue can be diagnosed without needing access to server logs.
//
// Token validity comes from /debug_token, which introspects the token itself (type, scopes,
// expiry) and needs no extra permission - unlike /me?fields=name or /me/subscribed_apps,
// which both need page-reading permissions (pages_read_engagement / pages_manage_metadata)
// that a token scoped only for pages_messaging may never have been granted. Reading those as
// "token invalid" was the earlier bug here; the actual scopes list below is what tells us
// whether pages_messaging is present.
async function diagnose() {
  const stored = await getStoredConfig();
  const token = stored?.pageAccessToken || process.env.MESSENGER_PAGE_ACCESS_TOKEN;
  if (!token) return { configured: false, tokenValid: false, error: 'No Messenger Page is connected.' };

  const result = {
    configured: true,
    connectedPage: stored
      ? {
          pageId: stored.pageId,
          pageName: stored.pageName,
          connectedAt: stored.connectedAt,
          connectedByName: stored.connectedByName,
        }
      : null,
    usingManualToken: !stored,
  };

  try {
    const debugResponse = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
    );
    const debugData = await debugResponse.json().catch(() => ({}));
    const info = debugData?.data;
    if (!debugResponse.ok || !info) {
      result.tokenValid = false;
      result.error = formatGraphError(debugData, debugResponse.status);
      return result;
    }
    result.tokenValid = Boolean(info.is_valid);
    result.tokenType = info.type || 'unknown';
    result.scopes = info.scopes || [];
    result.hasMessagingScope = result.scopes.includes('pages_messaging');
    if (!info.is_valid) result.error = info.error?.message || 'Meta reports this token as no longer valid.';
  } catch (error) {
    result.tokenValid = false;
    result.error = `Could not reach the Graph API: ${error.message}`;
    return result;
  }

  try {
    const subsResponse = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/me/subscribed_apps?access_token=${encodeURIComponent(token)}`
    );
    const subsData = await subsResponse.json().catch(() => ({}));
    if (!subsResponse.ok) {
      result.subscriptionNote = `Could not read webhook subscriptions (separate permission from messaging): ${formatGraphError(subsData, subsResponse.status)}`;
    } else {
      result.subscribedFields = subsData?.data?.[0]?.subscribed_fields || [];
      result.receivesMessages = result.subscribedFields.includes('messages');
    }
  } catch (error) {
    result.subscriptionNote = `Could not reach the Graph API: ${error.message}`;
  }

  return result;
}

// ── "Connect Facebook Page" OAuth flow (driven by routes/messengerRoutes.js) ────────────

function getOAuthDialogUrl(redirectUri, state) {
  const appId = process.env.MESSENGER_APP_ID;
  if (!appId) throw new Error('MESSENGER_APP_ID must be configured.');
  const url = new URL(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPES.join(','));
  return url.toString();
}

async function exchangeCodeForUserToken(code, redirectUri) {
  const appId = process.env.MESSENGER_APP_ID;
  const appSecret = process.env.MESSENGER_APP_SECRET;
  if (!appId || !appSecret) throw new Error('MESSENGER_APP_ID and MESSENGER_APP_SECRET must be configured.');

  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatGraphError(data, response.status));
  return data.access_token;
}

// Short-lived user tokens expire in ~1-2 hours; exchanging for a long-lived one (~60 days)
// means the Page tokens derived from it (see listManagedPages) effectively never expire.
async function exchangeForLongLivedUserToken(shortLivedToken) {
  const appId = process.env.MESSENGER_APP_ID;
  const appSecret = process.env.MESSENGER_APP_SECRET;
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', shortLivedToken);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatGraphError(data, response.status));
  return data.access_token;
}

// Pages the signed-in admin manages (pages_show_list), each already carrying its own
// never-expiring Page Access Token (pages_read_engagement is what lets us read each Page's
// name here too).
async function listManagedPages(userToken) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userToken)}`
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatGraphError(data, response.status));
  return data.data || [];
}

// Turns on the webhook fields this app needs for the connected Page (pages_manage_metadata),
// so connecting a Page here is enough - nobody has to also tick checkboxes by hand in the
// Meta dashboard's Webhooks settings.
async function subscribePageWebhookFields(pageId, pageAccessToken) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${encodeURIComponent(pageAccessToken)}`,
    { method: 'POST' }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatGraphError(data, response.status));
  return data;
}

module.exports = {
  OAUTH_SCOPES,
  isConfigured,
  sendMessengerText,
  diagnose,
  getStoredConfig,
  saveStoredConfig,
  clearStoredConfig,
  getOAuthDialogUrl,
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  listManagedPages,
  subscribePageWebhookFields,
};
