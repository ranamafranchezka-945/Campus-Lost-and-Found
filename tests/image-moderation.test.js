// tests/image-moderation.test.js - Safety check on photos attached to a public report.
//
// Covers the fail-open contract: no key, a bad reply, or a failed call must all still let
// the upload through, exactly like services/reportAssistant.js does for text. Needs no
// network and no real Anthropic key - global.fetch is replaced for each test.

const assert = require('node:assert/strict');
const test = require('node:test');

const moderation = require('../services/imageModeration');

const originalFetch = global.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

function fakeFile(overrides = {}) {
  return {
    mimetype: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...overrides,
  };
}

function claudeReply(text) {
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) };
}

test('skips the check and allows the upload when no API key is configured', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let called = false;
  global.fetch = async () => {
    called = true;
    return claudeReply('{"appropriate": false}');
  };

  const result = await moderation.moderateImage(fakeFile());
  assert.equal(result.allowed, true);
  assert.equal(result.checked, false);
  assert.equal(called, false);
});

test('allows the upload when Claude approves the photo', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('{"appropriate": true, "reason": ""}');

  const result = await moderation.moderateImage(fakeFile());
  assert.equal(result.allowed, true);
  assert.equal(result.checked, true);
});

test('blocks the upload when Claude flags the photo, and keeps the reason', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('{"appropriate": false, "reason": "Contains graphic violence"}');

  const result = await moderation.moderateImage(fakeFile());
  assert.equal(result.allowed, false);
  assert.equal(result.checked, true);
  assert.equal(result.reason, 'Contains graphic violence');
});

test('strips a code fence around the JSON reply', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('```json\n{"appropriate": false, "reason": "Nudity"}\n```');

  const result = await moderation.moderateImage(fakeFile());
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'Nudity');
});

test('fails open when the API call rejects', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => {
    throw new Error('network down');
  };

  const result = await moderation.moderateImage(fakeFile());
  assert.equal(result.allowed, true);
  assert.equal(result.checked, false);
});

test('fails open when Claude replies with something other than the expected JSON shape', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('Sure, here is my answer: it looks fine!');

  const result = await moderation.moderateImage(fakeFile());
  assert.equal(result.allowed, true);
  assert.equal(result.checked, false);
});

test('fails open when the HTTP response itself is not ok', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  const result = await moderation.moderateImage(fakeFile());
  assert.equal(result.allowed, true);
  assert.equal(result.checked, false);
});

test('skips files with no buffer without calling the API', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let called = false;
  global.fetch = async () => {
    called = true;
    return claudeReply('{"appropriate": false}');
  };

  const result = await moderation.moderateImage(null);
  assert.equal(result.allowed, true);
  assert.equal(result.checked, false);
  assert.equal(called, false);
});
