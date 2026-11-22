const GRAPH_API_VERSION = 'v21.0';

function isConfigured() {
  return Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN);
}

function formatGraphError(data, status) {
  const apiError = data?.error;
  return apiError
    ? `${apiError.message} (type=${apiError.type || 'unknown'}, code=${apiError.code ?? 'n/a'}, subcode=${apiError.error_subcode ?? 'n/a'}, fbtrace_id=${apiError.fbtrace_id || 'n/a'})`
    : `Graph API request failed with status ${status}`;
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
  if (!response.ok) throw new Error(formatGraphError(data, response.status));
  return data;
}

// Checks the configured Page token and webhook subscription directly against Meta, so a
// silent "no reply" issue can be diagnosed (expired token vs. missing webhook subscription)
// without needing access to server logs.
async function diagnose() {
  const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
  if (!token) return { configured: false, tokenValid: false, error: 'MESSENGER_PAGE_ACCESS_TOKEN is not set.' };

  const result = { configured: true, tokenValid: false };
  try {
    const pageResponse = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    const pageData = await pageResponse.json().catch(() => ({}));
    if (!pageResponse.ok) {
      result.error = formatGraphError(pageData, pageResponse.status);
      return result;
    }
    result.tokenValid = true;
    result.pageId = pageData.id;
    result.pageName = pageData.name;
  } catch (error) {
    result.error = `Could not reach the Graph API: ${error.message}`;
    return result;
  }

  try {
    const subsResponse = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/subscribed_apps?access_token=${encodeURIComponent(token)}`);
    const subsData = await subsResponse.json().catch(() => ({}));
    if (!subsResponse.ok) {
      result.subscriptionError = formatGraphError(subsData, subsResponse.status);
    } else {
      result.subscribedFields = subsData?.data?.[0]?.subscribed_fields || [];
      result.receivesMessages = result.subscribedFields.includes('messages');
    }
  } catch (error) {
    result.subscriptionError = `Could not reach the Graph API: ${error.message}`;
  }

  return result;
}

module.exports = { isConfigured, sendMessengerText, diagnose };
