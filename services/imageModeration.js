// services/imageModeration.js - Safety check on photos attached to a public report.
//
// Anyone on campus, including guests, can attach a photo to a found-item report and it goes
// straight onto the public feed. Without a check here, that photo is whatever the uploader
// chose to send. When ANTHROPIC_API_KEY is set, this asks Claude's vision model to flag
// sexual content, graphic violence/gore, or hate symbols before the file is ever saved to
// disk or Supabase Storage.
//
// Same fail-open contract as services/reportAssistant.js: no key, a timeout, a malformed
// reply, or any other error all resolve to "allowed", so a flaky or unconfigured AI call
// never blocks someone from reporting a found item. This is a safety net, not a lock.

const MODERATION_MODEL = process.env.ANTHROPIC_VISION_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MODERATION_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const PROMPT = [
  'You are a safety filter for a college campus lost-and-found website. A student is about',
  'to publish the attached photo alongside a public "found item" report that anyone on',
  'campus, including strangers, can view.',
  '',
  'Flag the photo only if it contains any of:',
  '  - nudity or sexual content',
  '  - graphic violence, gore, or a weapon shown in a threatening way',
  '  - hate symbols or extremist imagery',
  '',
  'An ordinary photo of a lost or found object (bag, phone, ID, bottle, clothing, etc.), even',
  'a blurry or low-quality one, is NOT a violation. When in doubt, do not flag it.',
  '',
  'Reply with ONLY a JSON object, no prose and no code fence:',
  '  {"appropriate": true or false, "reason": "short reason if false, else \\"\\""}'
].join('\n');

async function callClaude(file) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODERATION_MODEL,
        max_tokens: 200,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') } },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });
    if (!response.ok) throw new Error(`Claude API responded ${response.status}`);
    const payload = await response.json();
    const text = (payload.content || [])
      .filter(block => block && block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();
    const json = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks one uploaded photo before it is saved. Always resolves - never throws - so a
 * caller can treat the result as the final word.
 * Returns { allowed, reason, checked }. `checked` is false whenever no AI call was made
 * (unconfigured, oversized, or the call itself failed), so callers and logs can tell a
 * real pass from a skipped one.
 */
async function moderateImage(file) {
  if (!file || !file.buffer || !file.buffer.length) return { allowed: true, reason: '', checked: false };
  if (!isConfigured()) return { allowed: true, reason: '', checked: false };
  if (file.buffer.length > MAX_IMAGE_BYTES) return { allowed: true, reason: '', checked: false };

  try {
    const result = await callClaude(file);
    if (!result || typeof result !== 'object' || typeof result.appropriate !== 'boolean') {
      return { allowed: true, reason: '', checked: false };
    }
    return {
      allowed: result.appropriate,
      reason: result.appropriate ? '' : String(result.reason || '').slice(0, 200),
      checked: true
    };
  } catch (error) {
    console.warn('Image moderation check failed; allowing the upload:', error.message);
    return { allowed: true, reason: '', checked: false };
  }
}

module.exports = { moderateImage, isConfigured };
