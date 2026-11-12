'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createInterface} = require('node:readline');
const {WebSocket} = require('ws');
const {createServer} = require('../packages/world/server/world-server');
const {createSupervisor} = require('../packages/world/server/world-supervisor');
const {createHttpAgentClient} = require('../packages/control/src/agent-control-client');
const {createClientAgentRuntime} = require('../packages/agent/src/agent-runtime');

async function startControl(worldUrl) {
  const executable = process.platform === 'win32' ? 'threebox-control-server.exe' : 'threebox-control-server';
  const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, '../packages/control-server/target');
  const env = {...process.env, WORLD_URL: worldUrl, CONTROL_BIND: '127.0.0.1:0', RUST_LOG: 'threebox_control_server=info'};
  delete env.CONTROL_AGENT_TOKEN;
  const child = spawn(path.resolve(target, 'debug', executable), [], {env, stdio: ['ignore', 'pipe', 'inherit']});
  const lines = createInterface({input: child.stdout});
  const exited = new Promise(resolve => child.once('close', resolve));
  async function close() {
    child.kill();
    await exited;
  }
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Control startup timed out')), 10000);
      lines.on('line', line => {
        const match = /\baddress=(127\.0\.0\.1:\d+)\b/.exec(line);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); reject(Error('Control exited during startup: ' + code)); });
    });
    return {base: 'http://' + address, close};
  } catch (error) {
    await close();
    throw error;
  }
}

async function http(base, route, {method = 'GET', body, token, status = 200, headers = {}} = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {...(token ? {authorization: 'Bearer ' + token} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, status, method + ' ' + route);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  return response.json();
}

function mcpClient(base, token) {
  let session, version, nextId = 1;
  async function rpc(method, params, {credential = token, notification = false, status = notification ? 202 : 200} = {}) {
    const id = notification ? undefined : nextId++;
    const response = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(credential ? {authorization: 'Bearer ' + credential} : {}),
        ...(session ? {'mcp-session-id': session, 'mcp-protocol-version': version} : {})
      },
      body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
      signal: AbortSignal.timeout(10000)
    });
    assert.equal(response.status, status, method);
    session = response.headers.get('mcp-session-id') ?? session;
    const body = await response.text();
    if (notification) return;
    if (status !== 200) return JSON.parse(body);
    const frames = response.headers.get('content-type').includes('text/event-stream')
      ? body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean)
      : [body];
    const message = frames.map(frame => JSON.parse(frame)).find(frame => frame.id === id);
    assert(message?.result, 'MCP ' + method + ' did not return a result');
    return message.result;
  }
  return {
    async initialize(options) {
      const result = await rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: '3dbox-integration', version: '1'}}, options);
      if (options?.status) return result;
      version = result.protocolVersion;
      assert(session && version);
      await rpc('notifications/initialized', undefined, {notification: true});
    },
    list: () => rpc('tools/list', {}),
    async call(name, args, options) {
      const result = await rpc('tools/call', {name, arguments: args}, options);
      return {isError: result.isError, value: JSON.parse(result.content[0].text)};
    }
  };
}

(async () => {
  const data = mkdtempSync(path.join(tmpdir(), '3dbox-control-'));
  const world = createServer({catalogPath: path.join(data, 'catalog.sqlite3')});
  await once(world.listen(0, '127.0.0.1'), 'listening');
  const worldUrl = 'http://127.0.0.1:' + world.address().port;
  let control, consoleHost;
  try {
    control = await startControl(worldUrl);
    const {base} = control;
    assert.equal((await http(base, '/health')).service, 'control');
    assert.equal((await http(base, '/world/health')).protocol, (await http(worldUrl, '/health')).protocol);
    consoleHost = createSupervisor({controlUrl: base});
    await once(consoleHost.listen(0, '127.0.0.1'), 'listening');
    const consoleUrl = 'http://127.0.0.1:' + consoleHost.address().port;
    assert.equal((await http(consoleUrl, '/control/world/health')).protocol, 3);
    const session = await http(base, '/sessions', {
      method: 'POST', status: 201, body: {sceneId: 'industrial-park-v1', physicsMode: 'kinematic', dispatchMode: 'external'}
    });
    const {sessionId, adminToken} = session, root = '/sessions/' + sessionId;
    const agent = session.world.agents.find(item => item.role === 'drone').id;
    const other = session.world.agents.find(item => item.id !== agent).id;
    const {agentToken: token} = await http(base, root + '/agents/' + agent + '/credentials', {method: 'POST', token: adminToken, body: {}, status: 201});
    const observation = root + '/observations/' + agent;
    const actionRoute = root + '/agents/' + agent + '/actions';
    const observed = await http(base, observation, {token});
    assert.equal(observed.self.id, agent);
    assert(!Object.hasOwn(observed, 'agents'));
    assert.deepEqual(observed, await http(worldUrl, observation, {token}));
    assert.deepEqual(observed, await http(consoleUrl, '/control' + observation, {token, headers: {origin: consoleUrl}}));
    assert.deepEqual(await http(base, observation, {status: 401}), {error: 'unauthorized'});
    assert.deepEqual(await http(base, root + '/observations/' + other, {token, status: 403}), {error: 'forbidden'});
    assert.deepEqual(await http(base, observation, {token, status: 403, headers: {origin: 'https://other.invalid'}}), {error: 'invalid_origin'});
    assert.deepEqual(await http(base, root + '/step', {method: 'POST', token, body: {count: 1}, status: 403}), {error: 'forbidden'});
    const importError = await http(consoleUrl, '/control' + root + '/catalog/import?label=invalid', {
      method: 'POST', token: adminToken, body: {padding: 'x'.repeat(3 * 1024 * 1024)}, status: 400
    });
    assert.equal(importError.error, 'invalid_catalog_report');

    const action = {requestId: 'control-scan', type: 'scan', targetTick: 1, expiresTick: 5};
    assert.deepEqual(await http(base, root + '/agents/' + other + '/actions', {
      method: 'POST', token, body: action, status: 403
    }), {error: 'forbidden'});
    const client = createHttpAgentClient({sessionId, agentId: agent, token, fetchImpl(url, options) {
      const destination = new URL(url);
      assert.equal(destination.origin, 'http://127.0.0.1:8789');
      return fetch(base + destination.pathname, {...options, signal: AbortSignal.timeout(10000)});
    }});
    const runtime = createClientAgentRuntime({client, policy: {decide: () => action}});
    const {results: [submitted]} = await runtime.runOnce();
    assert.equal(submitted.action.status, 'pending');
    const invalid = await http(base, actionRoute, {method: 'POST', token, body: {...action, requestId: 'invalid action'}, status: 409});
    assert.equal(invalid.error, 'invalid_action');

    assert.deepEqual(await mcpClient(base).initialize({status: 401}), {error: 'missing_agent_token'});
    const mcp = mcpClient(base, token);
    await mcp.initialize();
    assert.deepEqual((await mcp.list()).tools.map(tool => tool.name).sort(), ['cancel_action', 'observe_agent', 'send_agent_message', 'submit_action']);
    const target = {session_id: sessionId, agent_id: agent};
    const mcpObservation = await mcp.call('observe_agent', target);
    assert.equal(mcpObservation.isError, false);
    assert.deepEqual(mcpObservation.value, await http(base, observation, {token}));
    const duplicate = await mcp.call('submit_action', {...target, action});
    assert.equal(duplicate.isError, false);
    assert.equal(duplicate.value.duplicate, true);
    assert.deepEqual(duplicate.value.action, submitted.action);
    assert.deepEqual(await mcp.call('observe_agent', {...target, agent_id: other}), {isError: true, value: {error: 'forbidden', status: 403}});
    assert.deepEqual(await mcp.call('submit_action', {...target, agent_id: other, action}), {isError: true, value: {error: 'forbidden', status: 403}});
    assert.deepEqual(await mcp.call('observe_agent', target, {credential: 'invalid'}), {isError: true, value: {error: 'unauthorized', status: 401}});
    assert.deepEqual(await mcp.call('submit_action', {...target, action: {...action, requestId: 'invalid action'}}), {isError: true, value: {...invalid, status: 409}});

    const laterAction = {...action, requestId: 'control-mcp-scan', targetTick: 5, expiresTick: 10};
    const mcpSubmitted = await mcp.call('submit_action', {...target, action: laterAction});
    assert.equal(mcpSubmitted.isError, false);
    assert.equal(mcpSubmitted.value.action.status, 'pending');
    const advanced = await http(base, root + '/step', {method: 'POST', token: adminToken, body: {count: 9}});
    assert.equal(advanced.world.tick, 9);
    const after = await http(base, observation, {token});
    for (const requestId of [action.requestId, laterAction.requestId]) {
      assert.equal(after.actions.find(item => item.requestId === requestId)?.status, 'completed');
    }
    const history = await http(base, root + '/history?after=0', {token: adminToken});
    assert(history.frames.length > 0 && history.frames.every(frame => frame.revision > 0));
    const stream = new WebSocket(worldUrl.replace(/^http:/, 'ws:') + '/stream', {origin: worldUrl, handshakeTimeout: 5000});
    try {
      await once(stream, 'open', {signal: AbortSignal.timeout(5000)});
      const ready = once(stream, 'message', {signal: AbortSignal.timeout(5000)});
      stream.send(JSON.stringify({type: 'subscribe', sessionId, token, afterRevision: -1}));
      const [frame] = await ready;
      assert.equal(JSON.parse(frame).role, 'agent');
    } finally {
      stream.terminate();
    }
    await http(base, root, {method: 'DELETE', token: adminToken});
    assert.deepEqual(await http(base, observation, {token, status: 404}), {error: 'session_not_found'});
    assert.deepEqual(await mcp.call('observe_agent', target), {isError: true, value: {error: 'session_not_found', status: 404}});

    await new Promise(resolve => world.close(resolve));
    assert.deepEqual(await http(base, '/world/health', {status: 502}), {error: 'world_unreachable'});
    assert.deepEqual(await mcp.call('observe_agent', target), {isError: true, value: {error: 'world_unreachable', status: 502}});
    await control.close();
    control = null;
    assert.deepEqual(await http(consoleUrl, '/control/world/health', {status: 502}), {error: 'control_unreachable'});
    console.log('Control HTTP and MCP: scoped observations, action submission and retries, role checks, World errors and unavailable upstream passed');
  } finally {
    if (consoleHost?.listening) await new Promise(resolve => consoleHost.close(resolve));
    await control?.close();
    if (world.listening) await new Promise(resolve => world.close(resolve));
    rmSync(data, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
