'use strict';
const crypto = require('node:crypto');

// A creation key is an internal bearer secret: knowing it permits retrieving
// the original administrator credential. Never include it in public snapshots.
function createRegistry() {
  const operations = new Map();
  return {
    async run(input, create) {
      const key = input?.creationKey;
      if (key === undefined) return create();
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
        throw Object.assign(Error('invalid_creation_key'), {status: 400});
      }
      const signature = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const prior = operations.get(key);
      if (prior) {
        if (prior.signature !== signature) throw Object.assign(Error('creation_key_conflict'), {status: 409});
        return prior.result;
      }
      // Never evict a key and silently allow it to create a second world.
      if (operations.size >= 128) throw Object.assign(Error('creation_registry_full'), {status: 429});
      const result = Promise.resolve().then(create);
      operations.set(key, {signature, result});
      return result;
    },
  };
}
module.exports = {createRegistry};
