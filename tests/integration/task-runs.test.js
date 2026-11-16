'use strict';
const assert = require('node:assert/strict');
const httpServer = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createInterface} = require('node:readline');
const {createSupervisor} = require('../../packages/world/server/world-supervisor');
const {createConsoleServer} = require('../../packages/console/server/console-server');
const {unwrapArchive} = require('../../packages/world/src/replay');
const root = path.resolve(__dirname, '../..');
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'packages/control-server/target');
const operator = 'task-run-test-operator';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(world, dir) {
  const child = spawn(path.join(target, 'debug/threebox-control-server'), [], {env: {...process.env,
    WORLD_URL: world, CONTROL_BIND: '127.0.0.1:0', BOX_CONTROL_DATA_DIR: dir,
    BOX_RUNNER_DATA_DIR: dir, BOX_RUNNER_OPERATOR_TOKEN: operator, BOX_CONSOLE_URL: 'http://127.0.0.1:8780', RUST_LOG: 'info'}, stdio: ['ignore', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout}); let errors = '';
  child.stderr.on('data', b => errors += b);
  const exited = once(child, 'close');
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout: ' + errors)), 15000);
    child.once('close', () => { clearTimeout(timer); reject(Error('Control exited: ' + errors)); });
    lines.on('line', line => { const m = /address=(127\.0\.0\.1:\d+)/.exec(line); if (m) { clearTimeout(timer); resolve('http://' + m[1]); } });
  });
  return {base, async close() { child.kill(); await exited; }};
}
async function http(base, route, token, body, expected = 200, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + route, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {})}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)});
  const value = await res.json(); assert.equal(res.status, expected, `${method} ${route}: ${JSON.stringify(value)}`); return value;
}
function mcp(base, token, modern = false) {
  let session, sequence = 0;
  async function rpc(method, params = {}, notification = false) {
    const id = ++sequence;
    if (modern) params._meta = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': {name: 'task-test', version: '1'}, 'io.modelcontextprotocol/clientCapabilities': {}};
    const response = await fetch(base + '/mcp/control', {method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(session ? {'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25'} : {}),
      ...(modern ? {'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(params.name ? {'mcp-name': params.name} : {})} : {})
    }, body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, params}), signal: AbortSignal.timeout(20000)});
    session = response.headers.get('mcp-session-id') || session;
    const body = await response.text(); assert.equal(response.status, notification ? 202 : 200, body);
    if (notification) return;
    const frames = response.headers.get('content-type').includes('text/event-stream') ? body.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trim()).filter(Boolean).map(s => JSON.parse(s)) : [JSON.parse(body)];
    const msg = frames.find(m => m.id === id); assert(msg?.result, JSON.stringify(msg)); return msg.result;
  }
  return {rpc, async initialize() { if (modern) return rpc('server/discover'); await rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'task-test', version: '1'}}); await rpc('notifications/initialized', {}, true); },
    async call(name, args, error) { const r = await rpc('tools/call', {name: 'box_' + name, arguments: args}); const v = r.structuredContent || JSON.parse(r.content[0].text); if (error) { assert.equal(r.isError, true); assert.equal(v.code, error); } else assert(!r.isError, JSON.stringify(v)); return v; }};
}
async function stdio(base, token) {
  const child = spawn(path.join(target, 'debug/threebox-mcp-stdio'), [], {env: {...process.env, BOX_CONTROL_URL: base, BOX_CONTROL_TOKEN: token}, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout}); const pending = new Map(); let seq = 0, errors = '';
  child.stderr.on('data', b => errors += b);
  lines.on('line', line => { const v = JSON.parse(line); if (v.id) pending.get(v.id)?.(v); });
  async function rpc(method, params) { const id = ++seq; const response = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('stdio timeout: ' + errors)), 10000); pending.set(id, v => { clearTimeout(timer); pending.delete(id); resolve(v); }); }); child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n'); const r = await response; assert(r.result, JSON.stringify(r)); return r.result; }
  await rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'stdio-test', version: '1'}});
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  return {rpc, async close() { const exit = once(child, 'close'); child.stdin.end(); await exit; }};
}

(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'box-task-runs-'));
  const world = createSupervisor({maxWorkers: 4, worldOptions: {catalogPath: path.join(dir, 'catalog.sqlite3')}});
  world.listen(0, '127.0.0.1'); await once(world, 'listening'); const worldUrl = 'http://127.0.0.1:' + world.address().port;
  let dropNextStep = false, dropNextCreation = false, rejectNextCreation = false;
  const proxy = httpServer.createServer((req, res) => {
    if (rejectNextCreation && req.method === 'POST' && req.url === '/sessions') {
      rejectNextCreation = false; req.resume();
      res.writeHead(429, {'content-type':'application/json'}); res.end(JSON.stringify({error:'session_limit'})); return;
    }
    const upstream = httpServer.request(worldUrl + req.url, {method: req.method, headers: {...req.headers, host: new URL(worldUrl).host}}, response => {
      if (dropNextStep && req.url.endsWith('/step')) {dropNextStep = false; response.resume(); response.on('end', () => res.destroy());}
      else if (dropNextCreation && req.method === 'POST' && req.url === '/sessions') {dropNextCreation = false; response.resume(); response.on('end', () => res.destroy());}
      else {res.writeHead(response.statusCode, response.headers); response.pipe(res);}
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const proxyUrl='http://127.0.0.1:'+proxy.address().port;
  let control, consoleServer, bridge;
  try {
    // The supervisor and worker both retain idempotency across response loss.
    const creation = {creationKey: 'c'.repeat(64), sceneId: 'industrial-park-v2'};
    const [a, b] = await Promise.all([http(worldUrl, '/sessions', null, creation, 201), http(worldUrl, '/sessions', null, creation, 201)]);
    assert.equal(a.sessionId, b.sessionId); assert.equal(a.adminToken, b.adminToken);
    const step = {count: 1, requestId: 'single-step', expectedRevision: 0};
    const first = await http(worldUrl, `/sessions/${a.sessionId}/step`, a.adminToken, step);
    const retry = await http(worldUrl, `/sessions/${a.sessionId}/step`, a.adminToken, step);
    assert.equal(first.world.tick, retry.world.tick); assert.equal(retry.duplicate, true);
    await http(worldUrl, `/sessions/${a.sessionId}/step`, a.adminToken, {...step, expectedRevision: 1}, 409);
    await http(worldUrl, `/sessions/${a.sessionId}`, a.adminToken, undefined, 200, 'DELETE');

    const legacyState = {runners: {'legacy-runner': {label: 'Migrated runner', token_hash: '0'.repeat(64), capabilities: null, last_seen: 0}}, runs: {}};
    mkdirSync(path.join(dir, 'control'));
    writeFileSync(path.join(dir, 'control/runner-state.json'), JSON.stringify(legacyState));
    control = await start(proxyUrl, path.join(dir, 'control'));
    assert(!existsSync(path.join(dir, 'control/runner-state.json')));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'control/runner-state.json.migrated'))), legacyState);
    assert((await http(control.base, '/runners/v1/runners', operator)).runners.some(r => r.runnerId === 'legacy-runner'));
    consoleServer = createConsoleServer({worldUrl, controlUrl: control.base}); consoleServer.listen(0, '127.0.0.1'); await once(consoleServer, 'listening');
    const base = 'http://127.0.0.1:' + consoleServer.address().port + '/control';
    await http(base, '/runs/v1/runs', null, undefined, 401);
    const invalidOrigin = await fetch(control.base+'/runs/v1/runs', {headers:{authorization:'Bearer '+operator,origin:'https://evil.example'}});assert.equal(invalidOrigin.status,403);
    const invalidHost = await new Promise((resolve,reject)=>{httpServer.get(control.base+'/runs/v1/runs',{headers:{authorization:'Bearer '+operator,host:'evil.example'}},r=>{r.resume();resolve(r.statusCode)}).on('error',reject)});assert.equal(invalidHost,403);
    const enrollment = await http(base, '/runs/v1/integrations', operator, {label: 'Integration test'});
    await http(base, '/runs/v1/integrations', operator, {label: 'Invalid limit', max_concurrency: '2'}, 409);
    const token = enrollment.token;
    const legacy = mcp(base, token); await legacy.initialize();
    assert((await legacy.rpc('tools/list')).tools.some(t => t.name === 'box_advance'));
    const modern = mcp(base, token, true); await modern.initialize();
    assert((await modern.call('get_capabilities', {})).scenes[0].tasks.length === 5);
    bridge = await stdio(base, token);
    assert((await bridge.rpc('tools/list', {})).tools.some(t => t.name === 'box_create_run'));
    const caps = await bridge.rpc('tools/call', {name: 'box_get_capabilities', arguments: {}}); assert.equal(caps.isError, false);

    const input = {request_id: 'park-001', scene_id: 'industrial-park-v2', objective: {instruction: '完成园区五任务链', type: 'scene_completed'}, config: {speed: 5}};
    rejectNextCreation = true;
    const rejectedInput = {...input,request_id:'rejected-creation'};
    await legacy.call('create_run', rejectedInput, 'session_limit');
    assert(['stopping','failed'].includes((await legacy.call('create_run',rejectedInput)).status));
    await delay(1200);
    dropNextCreation = true;
    const lostCreationInput = {...input,request_id:'lost-creation'};
    await legacy.call('create_run',lostCreationInput,'outcome_unknown');
    const createdOnce = world.inspectWorkers().filter(w=>!w.exited).length;
    const createdRetry = await legacy.call('create_run',lostCreationInput);
    assert.equal(world.inspectWorkers().filter(w=>!w.exited).length,createdOnce);
    await legacy.call('cancel_run',{run_id:createdRetry.run_id,control_epoch:1,request_id:'creation-cleanup'});
    await delay(1200);
    let run = await legacy.call('create_run', input); const id = run.run_id;
    assert.equal((await modern.call('create_run', input)).run_id, id);
    await legacy.call('create_run', {...input, config: {seed: 23}}, 'request_id_conflict');
    const other = await http(base, '/runs/v1/integrations', operator, {label: 'Other'});
    await http(base, '/runs/v1/runs/' + id, other.token, undefined, 403);
    const access = await http(base, `/runs/v1/runs/${id}/observer`, operator, {}); assert(access.observerToken);
    await http(base, `/runs/v1/runs/${id}/observer`, token, {}, 403);
    const rootArgs = {run_id: id, control_epoch: run.control_epoch};
    await legacy.call('record_note', {...rootArgs, request_id: 'plan-1', kind: 'plan', text: '按任务依赖分配合适设备，逐段推进并核验结果。'});
    await legacy.call('record_note', {...rootArgs, request_id: 'claim-complete', kind: 'progress', text: '已完成'});
    assert.equal((await legacy.call('get_run', {run_id: id})).status, 'running');
    let n = 0;
    while (run.status === 'running' && n++ < 60) {
      const view = await legacy.call('observe', {run_id: id, view: 'coordinator'});
      for (const task of view.observation.tasks) {
        if (!task.candidates.length) continue;
        const candidate = task.candidates[0];
        const latest = await legacy.call('get_run', {run_id: id});
        await legacy.call('assign_task', {...rootArgs, request_id: 'assign-' + task.id, expected_revision: latest.world_revision, task_id: task.id, agent_id: candidate.id});
        const action = {...rootArgs, agent_id: candidate.id, action: {requestId: 'action-' + task.id, type: 'execute_task', taskId: task.id, targetTick: view.observation.tick + 1, expiresTick: view.observation.tick + 40}};
        const submitted = await legacy.call('submit_action', action);
        assert.deepEqual(await modern.call('submit_action', action), submitted);
      }
      run = await legacy.call('get_run', {run_id: id});
      const args = {...rootArgs, request_id: 'advance-' + n, expected_revision: run.world_revision, max_ticks: 100, until: ['task_finished', 'failure']};
      const result = await legacy.call('advance', args);
      assert.deepEqual(await modern.call('advance', args), result);
      run = result.run;
    }
    assert.equal(run.status, 'stopping', JSON.stringify(run));
    for (let i = 0; i < 20 && run.status === 'stopping'; i++) { await delay(250); run = await legacy.call('get_run', {run_id: id}); }
    assert.equal(run.status, 'completed'); assert.equal(run.result.success, true); assert.equal(run.conditions.filter(c => c.done).length, 5);
    assert.equal(run.archive_status, 'ready', JSON.stringify(run));
    await http(base, `/runs/v1/runs/${id}/report`, token, undefined, 403);
    const report = await http(base, `/runs/v1/runs/${id}/report`, operator); assert.equal(unwrapArchive(report).archive.frames.at(-1).done, true);
    const events = await legacy.call('get_events', {run_id: id, limit: 200});
    assert(events.events.some(e => e.kind === 'agent.note')); assert(events.events.some(e => e.kind === 'tool.started'));
    assert(events.events.filter(e=>e.kind==='world.updated').every(e=>e.payload.scope==='console_only'));
    const streaming = new AbortController();
    const streamResponse = await fetch(base+`/runs/v1/runs/${id}/events/stream?after=0`,{headers:{authorization:'Bearer '+operator},signal:streaming.signal});
    assert.equal(streamResponse.headers.get('x-accel-buffering'),'no');
    const streamReader=streamResponse.body.getReader();const chunk=await streamReader.read();assert(new TextDecoder().decode(chunk.value).includes('event: run'));await streamReader.cancel();streaming.abort();
    const cursor = events.next_cursor; const rest = await legacy.call('get_events', {run_id: id, after_seq: cursor, limit: 200}); assert(rest.events.every(e => e.seq > cursor));
    assert(!JSON.stringify(events).includes(token)); assert(!JSON.stringify(run).includes(access.observerToken));

    // Pause fences old writes; cancellation doesn't wait for an advance lock.
    let cancelled = await legacy.call('create_run', {...input, request_id: 'cancel-001'});
    const paused = await legacy.call('pause_run', {run_id: cancelled.run_id, control_epoch: 1, request_id: 'pause-1'});
    assert.equal(paused.phase, 'paused');
    cancelled = await legacy.call('resume_run', {run_id: cancelled.run_id, control_epoch: paused.control_epoch, request_id: 'resume-1'});
    await legacy.call('record_note', {run_id: cancelled.run_id, control_epoch: 1, request_id: 'stale', kind: 'progress', text: 'stale'}, 'control_epoch_conflict');
    const inFlight = legacy.call('advance', {run_id: cancelled.run_id, control_epoch: cancelled.control_epoch, request_id: 'in-flight', expected_revision: 0, max_ticks: 100, until: []});
    await delay(150);
    const stop = await http(base, `/runs/v1/runs/${cancelled.run_id}/commands/cancel_run`, operator, {control_epoch: cancelled.control_epoch, request_id: 'cancel-1'}); assert.equal(stop.status, 'stopping');
    const interrupted = await inFlight;
    assert(['interrupted','terminal'].includes(interrupted.stop_reason)); assert(interrupted.executed < 100); assert.equal(interrupted.run.status, 'stopping');
    const audit = await http(base, `/runs/v1/runs/${cancelled.run_id}/events`, operator);
    assert(audit.events.some(e => e.kind === 'run.interrupted' && e.actor_id === 'operator'));
    // A lost World response must freeze new mutations; retry the same ID after restart.
    await delay(1200);
    const recovering = await legacy.call('create_run', {...input,request_id:'recovery-001'});
    const recoveringArgs={run_id:recovering.run_id,control_epoch:1,request_id:'lost-step',expected_revision:0,max_ticks:3};
    dropNextStep=true;
    await legacy.call('advance',recoveringArgs,'outcome_unknown');
    assert.equal((await legacy.call('get_run',{run_id:recovering.run_id})).phase,'reconciling');
    await legacy.call('record_note',{run_id:recovering.run_id,control_epoch:1,request_id:'blocked',kind:'progress',text:'must not pass'},'run_reconciling');
    const recoveryPaused = await legacy.call('pause_run',{run_id:recovering.run_id,control_epoch:1,request_id:'recovery-pause'});
    assert.equal(recoveryPaused.phase, 'paused');
    await bridge.close(); bridge = null;
    await new Promise(resolve => consoleServer.close(resolve)); consoleServer = null;
    await control.close(); control = await start(proxyUrl, path.join(dir, 'control'));
    const resumed = mcp(control.base,token);await resumed.initialize();
    const recoveryResumed = await resumed.call('resume_run',{run_id:recovering.run_id,control_epoch:recoveryPaused.control_epoch,request_id:'recovery-resume'});
    assert.equal(recoveryResumed.phase,'reconciling');
    const recovered = await resumed.call('advance',recoveringArgs);
    assert.equal(recovered.end_tick,1);assert.equal(recovered.executed,1);assert.equal(recovered.stop_reason,'reconciled');
    assert.equal(recovered.run.phase,'waiting_for_agent');
    await resumed.call('record_note',{run_id:recovering.run_id,control_epoch:recoveryResumed.control_epoch,request_id:'recovered',kind:'progress',text:'Recovered without a duplicate step'});
    await resumed.call('cancel_run',{run_id:recovering.run_id,control_epoch:recoveryResumed.control_epoch,request_id:'cleanup'});
    await delay(1200);
    const lost = await resumed.call('create_run', {...input,request_id:'world-crash'});
    const lostAccess = await http(control.base, `/runs/v1/runs/${lost.run_id}/observer`, operator, {});
    const worker = world.inspectWorkers().find(w=>w.sessionId===lostAccess.sessionId);
    process.kill(worker.pid,'SIGKILL');
    let failed;
    for(let i=0;i<80;i++){await delay(100);failed=await resumed.call('get_run',{run_id:lost.run_id});if(failed.status==='failed')break;}
    assert.equal(failed.status,'failed');assert.equal(failed.reason,'world_session_lost');
    assert.equal(failed.archive_status,'failed');
    const persisted = await http(control.base, '/runs/v1/runs/' + id, token); assert.equal(persisted.status, 'completed');
    await http(control.base, '/runs/v1/integrations/' + enrollment.integration.id, operator, undefined, 200, 'DELETE');
    await http(control.base, '/runs/v1/runs/' + id, token, undefined, 401);
    console.log('Task runs: HTTP MCP (2025/2026), stdio, full objective, deduplication, scope, pause, archive and restart passed.');
  } finally {
    if (bridge) await bridge.close();
    if (consoleServer) { consoleServer.closeAllConnections(); await new Promise(resolve => consoleServer.close(resolve)); }
    if (control) await control.close();
    proxy.closeAllConnections();await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => world.close(resolve)); rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
