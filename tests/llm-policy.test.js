'use strict';
const assert = require('node:assert/strict');
const {ACTION_SCHEMA, createLlmPolicy, parseModelOutput} = require('../src/llm-policy');

assert.equal(ACTION_SCHEMA.properties.actions.maxItems, 4);
assert.deepEqual(parseModelOutput({actions: []}, 4), []);
assert.deepEqual(parseModelOutput(JSON.stringify({actions: [{requestId: 'scan-1', type: 'scan', targetTick: 1, expiresTick: 5}]}), 4), [{requestId: 'scan-1', type: 'scan', targetTick: 1, expiresTick: 5}]);
assert.throws(() => parseModelOutput({actions: [{requestId: 'bad', type: 'scan'}]}, 4), /invalid action/i);
assert.throws(() => parseModelOutput({actions: new Array(5).fill({requestId: 'x', type: 'scan', targetTick: 1, expiresTick: 2})}, 4), /action_limit/);

(async()=>{
  const policy = createLlmPolicy({timeoutMs: 100, complete: async input => {
    assert.equal(input.observation.self.id, 'agent-1');
    assert.equal(input.responseSchema.required[0], 'actions');
    return {actions: [{requestId: 'move-1', type: 'move', target: {x: 4, y: 5}, targetTick: 2, expiresTick: 8}]};
  }});
  assert.deepEqual(await policy.decide({tick: 1, self: {id: 'agent-1'}}), [{requestId: 'move-1', type: 'move', target: {x: 4, y: 5}, targetTick: 2, expiresTick: 8}]);
  const timeout = createLlmPolicy({timeoutMs: 5, complete: () => new Promise(()=>{})});
  await assert.rejects(timeout.decide({tick: 1, self: {id: 'agent-1'}}), /llm_timeout/);
  console.log('LLM policy: strict JSON actions, bounded output, action limit and timeout passed');
})().catch(error=>{console.error(error);process.exitCode=1});
