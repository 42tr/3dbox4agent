'use strict';

const assert = require('node:assert/strict');
const E = require('../src/world-core');
const Camera = require('../server/camera-renderer');

const scene = E.getScene('industrial-park-v2');
const world = E.create(42, 'nearest', scene);
const agent = world.agents.find(item => item.camera?.enabled);
assert(agent, 'industrial park should configure at least one camera');

const frame = Camera.renderCameraFrame(world, agent);
assert.equal(frame.agentId, agent.id);
assert.equal(frame.tick, 0);
assert.equal(frame.width, 320);
assert.equal(frame.height, 180);
assert.match(frame.svg, /^<svg\b/);
assert.match(frame.svg, new RegExp(agent.id));

const rotated = Camera.renderCameraFrame(world, agent, {yaw: 45, pitch: -12});
assert.equal(rotated.yaw, 45);
assert.equal(rotated.pitch, -12);
assert.match(rotated.svg, /45° \/ -12°/);

console.log('Deterministic simulation camera frames passed');
