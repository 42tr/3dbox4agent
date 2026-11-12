'use strict';
const assert = require('node:assert/strict');
const Engine = require('../src/engine');
const Core = require('../src/world-core');

for (const name of ['create', 'step', 'snapshot', 'observe', 'submitAction', 'cancelAction', 'sendMessage', 'assign']) {
  assert.equal(Engine[name], Core[name], `engine compatibility export ${name}`);
}
const world = Core.create(42, 'nearest', Core.getScene('industrial-park-v1'), {physicsMode: 'kinematic'});
assert.equal(Engine.snapshot(world).tick, 0);
Core.disposeWorld(world);
console.log('World core: engine compatibility entry point and shared headless implementation passed');
