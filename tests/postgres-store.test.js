// The PostgreSQL request transaction, exercised against a stand-in for the `pg` pool
// (no database needed). Runs in its own process, so the stub does not affect other tests.
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const queries = [];
const connection = {
  async query(sql) {
    const statement = sql.trim().replace(/\s+/g, ' ');
    queries.push(statement.split(' ').slice(0, 3).join(' '));
    if (statement.startsWith('SELECT lock_id')) return { rowCount: 1, rows: [{ lock_id: 1 }] };
    return { rowCount: 0, rows: [] };
  },
  release() {
    queries.push('RELEASE');
  }
};
require.cache[require.resolve('pg')] = {
  id: require.resolve('pg'),
  filename: require.resolve('pg'),
  loaded: true,
  exports: { Pool: class { async connect() { return connection; } async end() {} } }
};
process.env.DATABASE_URL = 'postgresql://stub/stub';
const store = require('../services/postgresStore');

let server;
let baseUrl;
let seenAfterCommit;

test.before(async () => {
  const app = express();
  app.use(store.requestMiddleware());
  app.post('/plain', (req, res) => {
    store.writeCollection('items.json', [{ id: 1 }]);
    res.json({ ok: true });
  });
  app.post('/early', async (req, res) => {
    store.writeCollection('items.json', [{ id: 1 }]);
    await store.commitRequest();
    seenAfterCommit = [...queries];
    let lateWriteRefused = false;
    try {
      store.writeCollection('items.json', [{ id: 2 }]);
    } catch {
      lateWriteRefused = true;
    }
    res.json({ items: store.readCollection('items.json'), lateWriteRefused });
  });
  app.post('/failing', (req, res) => {
    store.writeCollection('items.json', [{ id: 1 }]);
    res.status(500).json({ ok: false });
  });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.DATABASE_URL;
});

test.beforeEach(() => {
  queries.length = 0;
});

const count = statement => queries.filter(entry => entry === statement).length;

test('a request saves its changes and commits once when the response ends', async () => {
  const response = await fetch(`${baseUrl}/plain`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(count('INSERT INTO app_items'), 1);
  assert.equal(count('COMMIT'), 1);
  assert.equal(count('RELEASE'), 1);
});

test('commitRequest saves and unlocks before the handler carries on', async () => {
  const response = await fetch(`${baseUrl}/early`, { method: 'POST' });
  assert.equal(response.status, 200);

  // By the time the handler resumed, the data was saved and the connection given back.
  assert.ok(seenAfterCommit.includes('INSERT INTO app_items'));
  assert.deepEqual(seenAfterCommit.slice(-2), ['COMMIT', 'RELEASE']);

  // Earlier data can still be read; a later save is refused instead of silently lost.
  assert.deepEqual(await response.json(), { items: [{ id: 1 }], lateWriteRefused: true });

  // Ending the response does not commit or release a second time.
  assert.equal(count('COMMIT'), 1);
  assert.equal(count('RELEASE'), 1);
  assert.equal(count('ROLLBACK'), 0);
});

test('a failed request is rolled back', async () => {
  const response = await fetch(`${baseUrl}/failing`, { method: 'POST' });
  assert.equal(response.status, 500);
  assert.equal(count('INSERT INTO app_items'), 0);
  assert.equal(count('COMMIT'), 0);
  assert.equal(count('ROLLBACK'), 1);
  assert.equal(count('RELEASE'), 1);
});
