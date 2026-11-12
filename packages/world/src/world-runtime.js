'use strict';

/**
 * Layer 1: the headless world runtime port.
 *
 * This adapter deliberately contains no HTTP, DOM, Three.js or policy code.
 * JavaScript/WASM and Rust-backed worlds implement the same small surface so
 * the control and Agent layers do not need to know which backend is active.
 */
class WorldRuntime {
  constructor({engine, createWorld, disposeWorld} = {}) {
    if (!engine || typeof engine !== 'object') throw new TypeError('world runtime requires an engine');
    const required = ['snapshot', 'observe', 'step', 'submitAction', 'cancelAction', 'sendMessage', 'assign'];
    for (const name of required) {
      if (typeof engine[name] !== 'function') throw new TypeError(`world runtime engine is missing ${name}`);
    }
    this.engine = engine;
    this._createWorld = createWorld || engine.create;
    this._disposeWorld = disposeWorld || engine.disposeWorld;
    if (typeof this._createWorld !== 'function') throw new TypeError('world runtime requires create');
    if (typeof this._disposeWorld !== 'function') throw new TypeError('world runtime requires dispose');
    for (const name of ['create', 'snapshot', 'observe', 'step', 'submitAction', 'cancelAction', 'sendMessage', 'assign', 'submitEvidence', 'submitSampleReport', 'call', 'dispose']) this[name] = this[name].bind(this);
    Object.freeze(this);
  }

  create(seed, policy, scene, options = {}, factory = this._createWorld) {
    if (typeof factory !== 'function') throw new TypeError('world runtime factory is invalid');
    return factory(seed, policy, scene, options);
  }

  snapshot(world) { return this.engine.snapshot(world); }
  observe(world, agentId) { return this.engine.observe(world, agentId); }
  step(world, physics) { return this.engine.step(world, physics); }
  submitAction(world, agentId, input) { return this.engine.submitAction(world, agentId, input); }
  cancelAction(world, agentId, requestId) { return this.engine.cancelAction(world, agentId, requestId); }
  sendMessage(world, from, to, text, via, requestId) { return this.engine.sendMessage(world, from, to, text, via, requestId); }
  assign(world, taskId, agentId) { return this.engine.assign(world, taskId, agentId); }
  call(capability, world, ...args) {
    const operation = this.engine[capability];
    return typeof operation === 'function' ? operation(world, ...args) : {ok: false, reason: 'capability_unavailable'};
  }
  submitEvidence(world, agentId, input) {
    return typeof this.engine.submitEvidence === 'function' ? this.engine.submitEvidence(world, agentId, input) : {ok: false, reason: 'capability_unavailable'};
  }
  submitSampleReport(world, agentId, input) {
    return typeof this.engine.submitSampleReport === 'function' ? this.engine.submitSampleReport(world, agentId, input) : {ok: false, reason: 'capability_unavailable'};
  }
  dispose(world) { return this._disposeWorld(world); }
}

function fromEngine(engine, options = {}) {
  return new WorldRuntime({engine, ...options});
}

module.exports = {WorldRuntime, fromEngine};
