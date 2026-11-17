// tests/report-assistant.test.js - The natural-language report intake.
//
// Covers the deterministic rules engine (which is what runs when no AI key is configured),
// the guards applied to an AI reply, and the HTTP endpoint including its live match preview.
// Needs no database, no SMTP server and no Anthropic key.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const assistant = require('../services/reportAssistant');

let dataDir;
let appServer;
let baseUrl;

// A fixed "now" so relative phrases like "this morning" assert the same way every run.
// Tuesday 17 November 2026, 14:30 in the server's local zone.
const NOW = new Date(2026, 10, 17, 14, 30, 0, 0);

function parse(message) {
  return assistant.parseWithRules(message, NOW);
}

function ask(message) {
  return fetch(`${baseUrl}/api/items/assistant/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cspc-assistant-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-only-session-secret';
  // The endpoint must behave identically with no AI key, which is the demo configuration.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.SUPABASE_DB_URL;

  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify([
    {
      id: 'found-tumbler',
      refCode: 'CSPC-LF-2026-AAAAA',
      title: 'Black AquaFlask Tumbler',
      category: 'Water Bottles/Tumblers',
      type: 'found',
      location: 'Learning Resources and Development (Library)',
      desc: 'Found a black AquaFlask tumbler left on a reading table.',
      contact: 'private-finder@example.edu',
      verification: 'Private sticker clue',
      reportedBy: 'finder-test',
      status: 'active',
      claimed: false,
      createdAt: new Date().toISOString()
    },
    {
      id: 'registered-private',
      refCode: 'CSPC-REG-QR-0001',
      title: 'Black AquaFlask Tumbler',
      category: 'Water Bottles/Tumblers',
      type: 'registered',
      location: 'Learning Resources and Development (Library)',
      desc: 'A privately registered belonging that must never surface publicly.',
      reportedBy: 'owner-test',
      status: 'active',
      claimed: false
    },
    {
      id: 'found-archived',
      refCode: 'CSPC-LF-2026-BBBBB',
      title: 'Black AquaFlask Tumbler',
      category: 'Water Bottles/Tumblers',
      type: 'found',
      location: 'Learning Resources and Development (Library)',
      desc: 'An archived report that should not be offered as a match.',
      reportedBy: 'finder-test',
      status: 'archived',
      claimed: false
    }
  ]));
  fs.writeFileSync(path.join(dataDir, 'claims.json'), JSON.stringify([]));

  const { createApp } = require('../server');
  appServer = createApp().listen(0);
  await new Promise(resolve => appServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  if (appServer) {
    await new Promise((resolve, reject) => appServer.close(error => (error ? reject(error) : resolve())));
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ── The rules engine ─────────────────────────────────────────────────────── */

test('extracts a full report from one English sentence', () => {
  const { draft, engine } = parse('I lost my black AquaFlask near the library this morning');
  assert.equal(engine, 'rules');
  assert.equal(draft.type, 'lost');
  assert.equal(draft.title, 'Black AquaFlask');
  assert.equal(draft.category, 'Water Bottles/Tumblers');
  assert.equal(draft.location, 'Learning Resources and Development (Library)');
  // "this morning" is 8am on the day of the message, not the time it was typed.
  assert.equal(new Date(draft.when).getHours(), 8);
  assert.equal(new Date(draft.when).getDate(), 17);
  assert.equal(assistant.reviewDraft(parse('I lost my black AquaFlask near the library this morning')).ready, true);
});

test('extracts a found report and keeps the finder wording as the description', () => {
  const { draft } = parse('I found a blue JanSport backpack at the canteen around lunch');
  assert.equal(draft.type, 'found');
  assert.equal(draft.title, 'Blue JanSport Backpack');
  assert.equal(draft.category, 'Bags & Wallets');
  assert.equal(draft.location, 'Production and Auxiliary Services (Canteen / Commercial)');
  assert.equal(new Date(draft.when).getHours(), 12);
  assert.match(draft.desc, /^I found a blue JanSport backpack/);
});

test('reads a Filipino sentence', () => {
  const { draft } = parse('nawala yung school id ko sa CCS building kahapon ng hapon');
  assert.equal(draft.type, 'lost');
  assert.equal(draft.category, 'ID / Cards');
  assert.equal(draft.location, 'College of Computer Studies (CCS)');
  // "kahapon ng hapon" - yesterday afternoon.
  assert.equal(new Date(draft.when).getDate(), 16);
  assert.equal(new Date(draft.when).getHours(), 14);
});

test('keeps known acronyms in capitals in the item name', () => {
  assert.equal(parse('I lost my school ID at the library').draft.title, 'School ID');
});

test('puts a room number in the specific-spot field, not the location', () => {
  const { draft } = parse('I left my scientific calculator in Room 204 at the engineering building 2 hours ago');
  assert.equal(draft.location, 'College of Engineering and Architecture (CEA)');
  assert.equal(draft.locationDetails, 'Room 204');
  assert.equal(draft.category, 'Electronics');
  assert.equal(new Date(draft.when).getHours(), 12, '2 hours before 14:30');
});

test('prefers the more specific keyword when several match', () => {
  // "apple watch" (Electronics) must beat the bare "watch" (Jewelry).
  assert.equal(parse('I lost my apple watch at the gym').draft.category, 'Electronics');
  assert.equal(parse('I lost my wristwatch at the gym').draft.category, 'Jewelry');
  // "water bottle" must beat "bottle".
  assert.equal(parse('I found a water bottle').draft.category, 'Water Bottles/Tumblers');
});

test('matches whole words only', () => {
  const internals = assistant.__internals;
  assert.equal(internals.containsPhrase('i lost my id', 'id'), true);
  assert.equal(internals.containsPhrase('please identify this', 'id'), false);
  assert.equal(internals.containsPhrase('at the gym', 'gym'), true);
  assert.equal(internals.containsPhrase('she is a gymnast', 'gym'), false);
});

test('asks for the one missing field instead of guessing it', () => {
  const review = assistant.reviewDraft(parse('lost my keys'));
  assert.equal(review.ready, false);
  assert.deepEqual(review.missing, ['location']);
  assert.match(review.question, /CSPC office or campus area/);
});

test('leaves the type empty when the message says neither lost nor found', () => {
  const result = parse('black aquaflask tumbler at the library');
  assert.equal(result.draft.type, '');
  assert.equal(result.confidence.type, 0);
  assert.equal(assistant.reviewDraft(result).missing.includes('type'), true);
});

test('never dates a report in the future', () => {
  // A December date read in November means last December, not next month.
  const when = parse('I lost my wallet at the library on December 20').draft.when;
  assert.ok(Date.parse(when) <= NOW.getTime(), `${when} must not be in the future`);
  // "this morning" asked before 8am resolves to the moment of asking.
  const earlyMorning = new Date(2026, 10, 17, 6, 15, 0, 0);
  const early = assistant.parseWithRules('I lost my pen this morning', earlyMorning).draft.when;
  assert.ok(Date.parse(early) <= earlyMorning.getTime(), `${early} must not be in the future`);
});

test('resolves a weekday to the most recent one', () => {
  // NOW is a Tuesday; "last friday" is the previous Friday, the 13th.
  const when = parse('I found an iPhone charger near the gym last friday').draft.when;
  assert.equal(new Date(when).getDate(), 13);
});

test('handles an empty or junk message without throwing', () => {
  for (const message of ['', '   ', '!!!', null, undefined]) {
    const result = assistant.parseWithRules(message, NOW);
    assert.equal(result.draft.type, '');
    assert.equal(result.draft.category, '');
    assert.equal(assistant.reviewDraft(result).ready, false);
  }
});

test('truncates an overlong message rather than storing all of it', () => {
  const result = parse(`I lost my wallet at the library ${'x'.repeat(2000)}`);
  assert.ok(result.draft.desc.length <= 1000);
  assert.ok(result.draft.title.length <= 100);
});

/* ── Guards on an AI reply ────────────────────────────────────────────────── */

test('an AI reply cannot introduce a category or office the form would reject', () => {
  const base = parse('I lost something at the library');
  const merged = assistant.__internals.mergeModelResult(base, {
    type: 'lost',
    title: 'Black Tumbler',
    category: 'Invented Category',
    location: 'Hogwarts Castle',
    when: ''
  }, NOW);

  assert.equal(merged.draft.title, 'Black Tumbler', 'a plain title is accepted');
  assert.equal(merged.draft.category, base.draft.category, 'the invented category is dropped');
  assert.notEqual(merged.draft.location, 'Hogwarts Castle');
  assert.equal(merged.draft.location, 'Learning Resources and Development (Library)');
});

test('an AI reply cannot backdate a report into the future', () => {
  const base = parse('I lost my wallet at the library');
  const future = new Date(NOW.getTime() + 7 * 86400000).toISOString();
  const merged = assistant.__internals.mergeModelResult(base, { when: future }, NOW);
  assert.notEqual(merged.draft.when, future);

  const valid = new Date(NOW.getTime() - 3600000).toISOString();
  assert.equal(assistant.__internals.mergeModelResult(base, { when: valid }, NOW).draft.when, valid);
});

test('an AI reply with a junk title or type leaves the rules result standing', () => {
  const base = parse('I lost my black AquaFlask near the library this morning');
  const merged = assistant.__internals.mergeModelResult(base, {
    type: 'maybe', title: 'x', category: '', location: ''
  }, NOW);
  assert.equal(merged.draft.type, 'lost');
  assert.equal(merged.draft.title, 'Black AquaFlask');
});

/* ── The HTTP endpoint ────────────────────────────────────────────────────── */

test('the endpoint fills a draft and previews a matching report for a guest', async () => {
  const response = await ask('I lost my black AquaFlask near the library this morning');
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.success, true);
  assert.equal(body.engine, 'rules', 'with no API key the deterministic engine answers');
  assert.equal(body.ready, true);
  assert.equal(body.draft.category, 'Water Bottles/Tumblers');

  assert.equal(body.matches.length, 1, 'the active found report is offered');
  assert.equal(body.matches[0].id, 'found-tumbler');
  assert.equal(body.matches[0].refCode, 'CSPC-LF-2026-AAAAA');
});

test('the match preview leaks no private field', async () => {
  const body = await (await ask('I lost my black AquaFlask near the library this morning')).json();
  const match = body.matches[0];
  for (const field of ['contact', 'verification', 'claimantProof', 'reportedBy', 'notifications']) {
    assert.equal(field in match, false, `${field} must not reach a guest`);
  }
});

test('the match preview excludes registered belongings and archived reports', async () => {
  const body = await (await ask('I lost my black AquaFlask near the library this morning')).json();
  const ids = body.matches.map(match => match.id);
  assert.equal(ids.includes('registered-private'), false, 'a private belonging must stay private');
  assert.equal(ids.includes('found-archived'), false, 'an archived report is not a live match');
});

test('the endpoint rejects a message that is too short or too long', async () => {
  const short = await ask('hi');
  assert.equal(short.status, 400);
  assert.equal((await short.json()).success, false);

  const long = await ask('x'.repeat(1001));
  assert.equal(long.status, 400);
});

test('the endpoint saves nothing', async () => {
  const before = fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8');
  await ask('I lost my black AquaFlask near the library this morning');
  await ask('I found a wallet at the canteen');
  assert.equal(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8'), before,
    'the assistant is read-only; the student still submits the form');
});

test('the endpoint strips angle brackets from the message it echoes back', async () => {
  const body = await (await ask('I lost my <script>alert(1)</script> wallet at the library')).json();
  assert.equal(body.success, true);
  assert.equal(body.draft.desc.includes('<'), false);
  assert.equal(body.draft.desc.includes('>'), false);
});
