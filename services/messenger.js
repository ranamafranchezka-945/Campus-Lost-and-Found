const GRAPH_API_VERSION = 'v21.0';

function isConfigured() {
  return Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN);
}

// Sends a plain-text Messenger message to a PSID (Page-Scoped ID) obtained through the
// account-linking webhook flow. Throws if Messenger isn't configured or Meta rejects the
// call; callers treat this the same way they treat a failed email send (log and move on).
async function sendMessengerText(psid, text) {
  const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('MESSENGER_PAGE_ACCESS_TOKEN must be configured.');

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text },
        messaging_type: 'RESPONSE'
      })
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiError = data?.error;
    const detail = apiError
      ? `${apiError.message} (type=${apiError.type || 'unknown'}, code=${apiError.code ?? 'n/a'}, subcode=${apiError.error_subcode ?? 'n/a'}, fbtrace_id=${apiError.fbtrace_id || 'n/a'})`
      : `Messenger API request failed with status ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

module.exports = { isConfigured, sendMessengerText };
