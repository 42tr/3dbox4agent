'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/engine');
const Init = require('../server/rust-world-initialization');

const sceneIds = [
  'industrial-park-v1', 'industrial-park-v2', 'industrial-park-parallel-v1',
  'industrial-park-fixed-sensor-v1', 'industrial-park-risk-detour-v1',
  'industrial-park-risk-v1', 'industrial-park-priority-v1',
  'lunar-base-v1', 'lunar-terrain-v1', 'lunar-sampling-v1', 'lunar-relay-v1',
  'lunar-rescue-v1', 'lunar-power-v1', 'lunar-construction-v1',
  'lunar-materials-v1', 'lunar-thermal-v1', 'lunar-heightfield-v1',
  'lunar-outpost-v1', 'shore-coordination-v1', 'shore-rescue-v1',
  'shore-echelons-v1', 'shore-sea-state-v1', 'shore-surface-v1',
];

function check(scene, label) {
  const native = Init.create(42, 'nearest', scene);
  const javascript = E.create(42, 'nearest', scene);
  try {
    assert.equal(native.sceneId, scene.id, label);
    assert.deepEqual(
      native.agents.map(agent => agent.camera ?? null),
      javascript.agents.map(agent => agent.camera ?? null),
      label + ': camera configuration must survive both initializers',
    );
  } finally {
    E.disposeWorld(native);
    E.disposeWorld(javascript);
  }
}

for (const id of sceneIds) check(E.getScene(id), id);

const sceneDirectory = path.resolve('packages/world/scenes');
for (const name of fs.readdirSync(sceneDirectory).filter(name => name.endsWith('.json')).sort()) {
  const raw = JSON.parse(fs.readFileSync(path.join(sceneDirectory, name), 'utf8'));
  if (!raw.id || !Array.isArray(raw.agents)) continue;
  check(E.normalizeScene(raw), name);
}

const invalid = E.getScene('industrial-park-v2');
invalid.agents[0].camera.updateTicks = 0;
assert.throws(() => E.create(42, 'nearest', invalid));
assert.throws(() => Init.create(42, 'nearest', invalid));

console.log(`JS/Rust scene contract passed for ${sceneIds.length} built-in scenes and all scene JSON files`);
