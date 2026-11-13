'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {once} = require('node:events');
const {mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {createSupervisor} = require('../../packages/world/server/world-supervisor');
const {createConsoleServer} = require('../../packages/console/server/console-server');
const {unwrapArchive} = require('../../packages/world/src/replay');

const config = {
  sceneId: 'industrial-park-v2', seed: 42, physics: 'rapier',
  coordinators: 1, fault: 'none', maxTicks: 1000, timeoutSeconds: 45, strategy: 'planner'
};
const caps = {scenes: [config.sceneId], physics: ['rapier'], faults: ['none'], strategies: ['planner'],
  maxCoordinators: 1, concurrency: 1};

async function until(probe, timeout = 30000) {
  const end = Date.now() + timeout;
  do {
    const value = await probe();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < end);
  throw Error('Runner integration timed out');
}

async function listen(server) {
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function close(server) {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
}

async function processAt(executable, args, env, pattern) {
  const child = spawn(executable, args, {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'inherit']});
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-8192); });
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  async function stop() {
    child.kill();
    await exited;
  }
  try {
    const address = await until(() => {
      const match = pattern.exec(output);
      if (match) return match[1];
      if (child.exitCode !== null) throw Error(executable + ' exited: ' + output);
    }, 10000);
    return {base: 'http://' + address, stop};
  } catch (error) {
    await stop();
    throw error;
  }
}

async function api(base, route, {method = 'GET', token, data, status = 200} = {}) {
  const response = await fetch(base + route, {
    method, headers: {...(token && {Authorization: 'Bearer ' + token}),
      ...(data !== undefined && {'Content-Type': 'application/json'})},
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  assert.equal(response.status, status, method + ' ' + route + ' ' + (result.error || ''));
  return result;
}

(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), '3dbox-runner-test-'));
  const world = createSupervisor({worldOptions: {catalogPath: path.join(dir, 'catalog.sqlite3')}});
  const worldUrl = await listen(world);
  const operator = randomUUID();
  const bootstrapFile = path.join(dir, 'builtin.token');
  const controlTarget = process.env.CARGO_TARGET_DIR || path.resolve('packages/control-server/target');
  const binary = path.join(controlTarget, 'debug', 'threebox-control-server');
  const controlEnv = {
    WORLD_URL: worldUrl, CONTROL_BIND: '127.0.0.1:0', NO_COLOR: '1', RUST_LOG: 'threebox_control_server=info',
    BOX_RUNNER_DATA_DIR: path.join(dir, 'runs'), BOX_RUNNER_BOOTSTRAP_FILE: bootstrapFile,
    BOX_RUNNER_OPERATOR_TOKEN: operator,
  };
  let control, runner, externalRunner, consoleHost;
  const startControl = () => processAt(binary, [], controlEnv, /address=(127\.0\.0\.1:\d+)/);
  try {
    control = await startControl();
    runner = await processAt('python3', ['packages/agent/python/runner_web.py'], {
      BOX_CONTROL_URL: control.base, BOX_RUNNER_TOKEN_FILE: bootstrapFile, BOX_RUNNER_PORT: '0',
      BOX_RUNNER_TOKEN: '', BOX_RUNNER_ID: 'builtin',
    }, /Runner listening on (127\.0\.0\.1:\d+)/);
    consoleHost = createConsoleServer({controlUrl: control.base, worldUrl});
    const consoleUrl = await listen(consoleHost);
    const prefix = '/runners/v1';
    const op = (route, options) => api(consoleUrl, '/control' + prefix + route, {token: operator, ...options});
    await api(consoleUrl, '/control' + prefix + '/runs', {status: 401});
    const registry = await until(async () => {
      const {runners} = await op('/runners');
      return runners.find(item => item.runnerId === 'builtin' && item.online);
    });
    assert(registry.capabilities.scenes.includes(config.sceneId));
    assert.equal((await api(runner.base, '/health')).registered, true);

    const draft = {requestId: randomUUID(), runnerId: 'builtin', config};
    const run = await op('/runs', {method: 'POST', data: draft, status: 202});
    assert.equal((await op('/runs', {method: 'POST', data: draft})).runId, run.runId);
    await op('/runs', {method: 'POST', data: {...draft, config: {...config, seed: 1}}, status: 409});
    const root = '/runs/' + run.runId;
    const finished = await until(async () => {
      const result = await op(root);
      assert.notEqual(result.status, 'failed', JSON.stringify(result));
      return result.status === 'completed' && result;
    });
    assert(finished.hasReplay);
    assert.equal(finished.progress.completedTasks, finished.progress.totalTasks);
    const completed = await op(root + '/report');
    const completedFrames = unwrapArchive(completed).archive.frames;
    assert(completedFrames.at(-1).done);
    assert.equal(completedFrames.at(-1).worldSize, 224);
    assert(completedFrames.some(frame => frame.agents.some(agent => agent.role === "vehicle" && agent.x > 100)));
    assert.equal(completed.config.seed, 42);
    assert.equal(completed.config.sceneId, config.sceneId);
    assert.equal(world.inspectWorkers().filter(worker => worker.state === 'active').length, 0);

    const external = await op('/runners', {method: 'POST', data: {label: 'Independent runner'}, status: 201});
    const externalRoot = prefix + '/runners/' + external.runnerId;
    const worker = (route, options) => api(control.base, prefix + route,
      {method: 'POST', token: external.runnerToken, ...options});
    await api(control.base, externalRoot + '/register', {method: 'POST', data: {protocolVersion: 1, capabilities: caps}, status: 401});
    await worker('/runners/' + external.runnerId + '/register', {data: {protocolVersion: 2, capabilities: caps}, status: 409});
    await worker('/runners/' + external.runnerId + '/register', {data: {protocolVersion: 1, capabilities: caps}});
    await op('/runs', {method: 'POST', data: {requestId: randomUUID(), runnerId: external.runnerId,
      config: {...config, physics: 'kinematic'}}, status: 400});
    const queued = await op('/runs', {method: 'POST', data: {requestId: randomUUID(),
      runnerId: external.runnerId, config: {...config, seed: 77}}, status: 202});
    const {job} = await worker('/runners/' + external.runnerId + '/claim');
    assert.equal(job.runId, queued.runId);
    const jobRoot = '/runs/' + job.runId;
    const leased = (route, options) => worker(jobRoot + route, {token: job.leaseToken, ...options});
    const session = await leased('/session');
    assert.equal(session.adminToken, undefined);
    assert.equal(session.observerToken, undefined);
    assert.equal((await leased('/session')).sessionId, session.sessionId);
    const view = await op(jobRoot + '/observer', {method: 'POST'});
    assert.equal(view.sessionId, session.sessionId);
    await api(control.base, '/sessions/' + view.sessionId + '/step',
      {method: 'POST', token: view.observerToken, data: {count: 1}, status: 403});
    const route = '/world/sessions/' + session.sessionId;
    await leased('/world/sessions/' + randomUUID() + '/step', {data: {count: 1}, status: 403});
    await leased(route + '/step', {data: {count: 1001}, status: 400});
    const agent = session.world.agents[0].id;
    const {agentToken} = await leased(route + '/agents/' + agent + '/credentials', {data: {}, status: 201});
    await leased(route + '/observations/' + agent, {method: 'GET', token: agentToken});
    await leased(route + '/observations/' + session.world.agents[1].id,
      {method: 'GET', token: agentToken, status: 403});
    await api(control.base, '/sessions/' + session.sessionId + '/observations/' + agent, {token: agentToken, status: 401});
    await leased(route + '/step', {data: {count: 1}});
    const cancelled = await op(jobRoot + '/cancel', {method: 'POST'});
    assert.equal(cancelled.status, 'stopping');
    await leased(route + '/step', {data: {count: 1}, status: 409});
    await leased(route + '/observations/' + agent, {method: 'GET', token: agentToken, status: 409});
    await leased('/heartbeat', {status: 409});
    await until(async () => (await op(jobRoot)).status === 'cancelled');
    const partial = await op(jobRoot + '/report');
    assert.equal(unwrapArchive(partial).archive.frames.at(-1).tick, 1);
    assert.equal(partial.coverage.end, 'unfinished');

    const expire = await op('/runs', {method: 'POST', data: {requestId: randomUUID(),
      runnerId: external.runnerId, config: {...config, timeoutSeconds: 2}}, status: 202});
    const {job: stalled} = await worker('/runners/' + external.runnerId + '/claim');
    assert.equal(stalled.runId, expire.runId);
    const stalledRoot = '/runs/' + stalled.runId;
    await worker(stalledRoot + '/session', {token: stalled.leaseToken});
    const expired = await until(async () => {
      const result = await op(stalledRoot);
      return result.status === 'failed' && result;
    }, 22000);
    assert.equal(expired.reason, 'runner_lease_expired');
    assert(expired.hasReplay);
    await worker(stalledRoot + '/heartbeat', {token: stalled.leaseToken, status: 409});
    externalRunner = await processAt('python3', ['packages/agent/python/runner_web.py'], {
      BOX_CONTROL_URL: control.base, BOX_RUNNER_ID: external.runnerId, BOX_RUNNER_TOKEN: external.runnerToken,
      BOX_RUNNER_TOKEN_FILE: '', BOX_RUNNER_PORT: '0',
    }, /Runner listening on (127\.0\.0\.1:\d+)/);
    await until(async () => {
      const response = await fetch(externalRunner.base + '/health', {signal: AbortSignal.timeout(5000)});
      return response.ok;
    });
    const remoteRun = await op('/runs', {method: 'POST', data: {requestId: randomUUID(),
      runnerId: external.runnerId, config: {...config, seed: 79}}, status: 202});
    const remoteRoot = '/runs/' + remoteRun.runId;
    await until(async () => {
      const result = await op(remoteRoot);
      assert.notEqual(result.status, 'failed', JSON.stringify(result));
      return result.status === 'completed';
    });
    assert.equal(unwrapArchive(await op(remoteRoot + '/report')).archive.config.seed, 79);
    await externalRunner.stop();
    externalRunner = null;
    await op('/runners/' + external.runnerId, {method: 'DELETE'});
    await worker('/runners/' + external.runnerId + '/claim', {status: 401});

    await runner.stop();
    runner = null;
    await close(consoleHost);
    await control.stop();
    control = await startControl();
    assert.equal((await api(control.base, prefix + root, {token: operator})).status, 'completed');
    assert.deepEqual(await api(control.base, prefix + root + '/report', {token: operator}), completed);
    assert(!readFileSync(path.join(dir, 'runs', 'runner-state.json'), 'utf8').includes(external.runnerToken));
    console.log('Runner Web service, Console API, shared protocol, leased World requests, cancellation, replay and restart passed');
  } finally {
    await externalRunner?.stop();
    await runner?.stop();
    await close(consoleHost);
    await control?.stop();
    await close(world);
    rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
