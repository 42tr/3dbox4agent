'use strict';
const assert = require('node:assert/strict');
const E = require('../src/engine');
const WorldRuntime = require('../src/world-runtime');
const Control = require('../src/control-api');
const Contracts = require('../src/control-contracts');
const Agent = require('../src/agent-runtime');

const runtime = WorldRuntime.fromEngine(E);
const control = Control.createControlApi({runtime});
const scene = E.getScene('industrial-park-v1');
const world = runtime.create(42, 'nearest', scene, {physicsMode: 'kinematic', dispatchMode: 'external'});
const actor = world.agents[0];

assert.equal(runtime.observe(world, actor.id).self.id, actor.id);
assert.deepEqual(Control.validateActionEnvelope({requestId: 'move-1', type: 'move', targetTick: 1, expiresTick: 2}), {ok: true});
assert.deepEqual(Contracts.validateObservation(runtime.observe(world, actor.id)), {ok: true});
assert.deepEqual(control.submitAction(world, actor.id, {requestId: 'bad id', type: 'move', targetTick: 1, expiresTick: 2}), {ok: false, reason: 'invalid_action'});
const action = control.submitAction(world, actor.id, {requestId: 'move-1', type: 'move', target: {x: actor.x, y: actor.y}, targetTick: 1, expiresTick: 2});
assert.equal(action.ok, true);
runtime.dispose(world);

(async()=>{
  const dispatched = [];
  const policy = Agent.createPolicy(async observation => observation.tick === 0 ? {requestId: 'a-1', type: 'scan', targetTick: 1, expiresTick: 5} : null);
  const agent = Agent.createAgentRuntime({
    observe: async()=>({tick: 0, self: {id: 'agent-1'}}),
    dispatch: async actionInput=>{dispatched.push(actionInput);return {ok: true};},
    policy,
  });
  const result = await agent.runOnce();
  assert.equal(result.actions.length, 1);
  assert.deepEqual(dispatched, [{requestId: 'a-1', type: 'scan', targetTick: 1, expiresTick: 5}]);
  console.log('Layer contracts: world runtime, semantic control API and policy runtime passed');
})().catch(error=>{console.error(error);process.exitCode=1});
