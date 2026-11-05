'use strict';
const assert = require('node:assert/strict');
const E = require('../src/engine');
const D = require('../src/delta');
const P = require('../server/physics');

(async () => {
  await P.initialize();
  const world = E.create(42, 'nearest', E.scene, { physicsMode: 'rapier' });
  const physics = P.createPhysics(world);
  let previous = E.snapshot(world), faulted = false, count = 0;
  try {
    while (!world.done && world.tick < 1000) {
      E.step(world, physics);
      if (!faulted && world.part.location === 'carried') {
        assert(E.fault(world));
        faulted = true;
      }
      const next = E.snapshot(world);
      assert.deepEqual(D.apply(previous, D.diff(previous, next)), next);
      previous = next;
      count++;
    }
    assert(faulted && world.done && !world.failed);
    console.log(`Rapier delta recovery tests passed (${count} frames)`);
  } finally {
    physics.free();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
