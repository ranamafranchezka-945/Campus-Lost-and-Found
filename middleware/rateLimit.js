// middleware/rateLimit.js - In-memory fixed-window counters; enough for a single app instance.
// A limit is { max, windowMs }; a store is a Map kept by the caller, one per kind of action.

function isRateLimited(store, key, limit) {
  const entry = store.get(key);
  if (!entry) return false;
  if (Date.now() - entry.start > limit.windowMs) {
    store.delete(key);
    return false;
  }
  return entry.count >= limit.max;
}

function recordAttempt(store, key, limit) {
  const entry = store.get(key);
  if (!entry || Date.now() - entry.start > limit.windowMs) {
    if (store.size > 10000) store.clear();
    store.set(key, { start: Date.now(), count: 1 });
  } else {
    entry.count += 1;
  }
}

module.exports = { isRateLimited, recordAttempt };
