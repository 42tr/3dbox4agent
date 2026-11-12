'use strict';
const assert = require('node:assert/strict');
const {createServer} = require('../server/world-server');
const {createHttpAgentClient} = require('../src/agent-control-client');
const {createPolicy, createClientAgentRuntime} = require('../src/agent-runtime');

(async()=>{
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function admin(path, method = 'GET', body, token) {
    const response = await fetch(base + path, {method, headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json();
    assert(response.ok, JSON.stringify({path, status: response.status, value}));
    return value;
  }
  try {
    const session = await (async()=>{const response = await fetch(base + '/sessions', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sceneId: 'industrial-park-v1', physicsMode: 'kinematic', dispatchMode: 'external'})});return response.json()})();
    const agentId = session.world.agents.find(agent => agent.role === 'drone').id;
    const credentials = await admin(`/sessions/${session.sessionId}/agents/${agentId}/credentials`, 'POST', {}, session.adminToken);
    const client = createHttpAgentClient({baseUrl: base, sessionId: session.sessionId, agentId, token: credentials.agentToken});
    let submitted = false;
    const policy = createPolicy(observation => {
      if (submitted || observation.actions.some(action => action.requestId === 'http-scan-1')) return null;
      submitted = true;
      return {requestId: 'http-scan-1', type: 'scan', targetTick: observation.tick + 1, expiresTick: observation.tick + 5};
    });
    const runtime = createClientAgentRuntime({client, policy});
    const first = await runtime.runOnce();
    assert.equal(first.observation.self.id, agentId);
    assert.equal(first.actions[0].requestId, 'http-scan-1');
    assert.equal(first.results[0].action.status, 'pending');
    assert(!Object.hasOwn(first.observation, 'agents'), 'Agent observation must remain scoped');
    const advanced = await admin(`/sessions/${session.sessionId}/step`, 'POST', {count: 2}, session.adminToken);
    assert(advanced.world.tick >= 2);
    const second = await runtime.runOnce();
    assert.equal(second.actions.length, 0);
    assert(second.observation.actions.some(action => action.requestId === 'http-scan-1' && ['accepted', 'completed'].includes(action.status)));
    await admin(`/sessions/${session.sessionId}`, 'DELETE', undefined, session.adminToken);
    console.log('Agent HTTP vertical slice: scoped observation, rule decision, server action commit and follow-up observation passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
