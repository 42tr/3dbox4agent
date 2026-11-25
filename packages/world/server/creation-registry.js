'use strict';
const crypto = require('node:crypto');
const MAX_OPERATIONS = 128;
const MAX_RETRY_WINDOW_MS = 60 * 60 * 1000;

// A creation key is an internal bearer secret: knowing it permits retrieving
// the original administrator credential. Never include it in public snapshots.
function createRegistry() {
  const operations = new Map();
  const temporary = new Map();
  const closedLegacy = new Map();
  const retired = new Map();
  return {
    closeSession(sessionId) {
      for (const registry of [operations, temporary]) {
        for (const [key, receipt] of registry) {
          if (receipt.sessionId !== sessionId) continue;
          registry.delete(key);
          // Keep the key fenced without retaining the snapshot or credential.
          if (receipt.expiresAt === undefined) closedLegacy.set(key, {signature: receipt.signature});
          else retired.set(key, {signature: receipt.signature, expiresAt: receipt.expiresAt});
        }
      }
    },
    async run(input, create) {
      const key = input?.creationKey;
      const expiresAt = input?.creationExpiresAt;
      if (key === undefined && expiresAt === undefined) return create();
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
        throw Object.assign(Error('invalid_creation_key'), {status: 400});
      }
      const now = Date.now();
      if (expiresAt !== undefined) {
        if (!Number.isSafeInteger(expiresAt) || expiresAt > now + MAX_RETRY_WINDOW_MS) {
          throw Object.assign(Error('invalid_creation_expiry'), {status: 400});
        }
        // An expired request is rejected even after its receipt has been pruned.
        if (expiresAt <= now) throw Object.assign(Error('creation_key_expired'), {status: 409});
      }
      for (const [id, entry] of temporary) {
        if (entry.expiresAt <= now) temporary.delete(id);
      }
      for (const [id, entry] of retired) {
        if (entry.expiresAt <= now) retired.delete(id);
      }
      const signature = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const prior = operations.get(key) ?? temporary.get(key) ?? retired.get(key) ?? closedLegacy.get(key);
      if (prior) {
        if (prior.signature !== signature) throw Object.assign(Error('creation_key_conflict'), {status: 409});
        if (!prior.result) throw Object.assign(Error('session_not_found'), {status: 404});
        return prior.result;
      }
      // Never evict a key and silently allow it to create a second world.
      const registry = expiresAt === undefined ? operations : temporary;
      if (registry.size >= MAX_OPERATIONS) throw Object.assign(Error('creation_registry_full'), {status: 429});
      const result = Promise.resolve().then(create);
      const entry = {signature, result, expiresAt};
      registry.set(key, entry);
      const discardFailure = () => {
        if (registry.get(key) === entry) registry.delete(key);
      };
      // The supervisor retires its worker before returning a failed creation.
      result.then(value => {
        if (value?.status >= 400) discardFailure();
        else entry.sessionId = value?.sessionId;
      }, discardFailure);
      return result;
    },
  };
}
module.exports = {createRegistry};
