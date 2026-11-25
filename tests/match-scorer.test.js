// tests/match-scorer.test.js - Background semantic re-scoring for a lost/found pair.
//
// Covers the cache (hit, miss, staleness on edit), the queue (dedupe, bounded concurrency,
// a cooldown after failure), and the same fail-open spirit as the other AI-backed services:
// nothing here should ever throw out of a request path. Needs no network and no real
// Anthropic key - global.fetch is replaced for each test. Every test uses its own item ids
// so the module's shared in-memory cache never leaks between tests.

const assert = require('node:assert/strict');
const test = require('node:test');

const matchScorer = require('../services/matchScorer');

const originalFetch = global.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;
let nextId = 1;
function id() {
  return `test-${nextId++}`;
}

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

function lostItem(overrides = {}) {
  return {
    id: id(),
    type: 'lost',
    title: 'Blue Jansport Bag',
    category: 'Bags & Wallets',
    desc: 'A blue backpack',
    location: 'Library',
    ...overrides,
  };
}
function foundItem(overrides = {}) {
  return {
    id: id(),
    type: 'found',
    title: 'Navy Backpack',
    category: 'Bags & Wallets',
    desc: 'Found near the gym',
    location: 'Gymnasium',
    ...overrides,
  };
}

function claudeReply(text) {
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('getCachedScore returns null when nothing has been scored yet', () => {
  const result = matchScorer.getCachedScore(lostItem(), foundItem());
  assert.equal(result, null);
});

test('queueScoring does nothing when no API key is configured', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let called = false;
  global.fetch = async () => {
    called = true;
    return claudeReply('{"score": 0.9, "reason": "same bag"}');
  };

  const lost = lostItem();
  const found = foundItem();
  matchScorer.queueScoring(lost, found);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(called, false);
  assert.equal(matchScorer.getCachedScore(lost, found), null);
});

test('a queued pair becomes available through getCachedScore once scored', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('{"score": 0.82, "reason": "same bag, different lighting"}');

  const lost = lostItem();
  const found = foundItem();
  assert.equal(matchScorer.getCachedScore(lost, found), null);

  matchScorer.queueScoring(lost, found);
  await waitUntil(() => matchScorer.getCachedScore(lost, found) !== null);

  const cached = matchScorer.getCachedScore(lost, found);
  assert.equal(cached.score, 0.82);
  assert.equal(cached.reason, 'same bag, different lighting');
});

test('works whichever side (lost or found) is passed first', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('{"score": 0.7, "reason": "plausible"}');

  const lost = lostItem();
  const found = foundItem();
  matchScorer.queueScoring(found, lost);
  await waitUntil(() => matchScorer.getCachedScore(lost, found) !== null);

  assert.equal(matchScorer.getCachedScore(found, lost).score, 0.7);
});

test('editing either report invalidates its cached score', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('{"score": 0.75, "reason": "match"}');

  const lost = lostItem();
  const found = foundItem();
  matchScorer.queueScoring(lost, found);
  await waitUntil(() => matchScorer.getCachedScore(lost, found) !== null);

  const editedLost = { ...lost, desc: 'Completely different description now' };
  assert.equal(matchScorer.getCachedScore(editedLost, found), null);
  // The original, unedited pair is still untouched in the cache.
  assert.notEqual(matchScorer.getCachedScore(lost, found), null);
});

test('does not call the API twice for the same pair while the first call is in flight', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let calls = 0;
  let resolveFetch;
  global.fetch = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveFetch = () => resolve(claudeReply('{"score": 0.5, "reason": "maybe"}'));
    });
  };

  const lost = lostItem();
  const found = foundItem();
  matchScorer.queueScoring(lost, found);
  matchScorer.queueScoring(lost, found);
  matchScorer.queueScoring(lost, found);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls, 1);
  resolveFetch();
  await waitUntil(() => matchScorer.getCachedScore(lost, found) !== null);
});

test('fails open (no cached score, but no throw) when Claude replies with a bad shape', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.fetch = async () => claudeReply('not json at all');

  const lost = lostItem();
  const found = foundItem();
  matchScorer.queueScoring(lost, found);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(matchScorer.getCachedScore(lost, found), null);
});

test('does not retry a pair again immediately after a failure (cooldown)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('network down');
  };

  const lost = lostItem();
  const found = foundItem();
  matchScorer.queueScoring(lost, found);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);

  matchScorer.queueScoring(lost, found);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'a second attempt right after a failure should be skipped by the cooldown');
});

test('MATCH_THRESHOLD is a sane 0-1 bound used by the caller to decide a match', () => {
  assert.ok(matchScorer.MATCH_THRESHOLD > 0 && matchScorer.MATCH_THRESHOLD < 1);
});
