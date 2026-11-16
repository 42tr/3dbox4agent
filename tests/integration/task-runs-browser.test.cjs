'use strict';

// Optional browser smoke test. Provide Playwright and, if needed, a Chrome executable.
const {chromium} = require(process.env.BOX_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createInterface} = require('node:readline');
const {createServer} = require('../../packages/world/server/world-server');
const {createConsoleServer} = require('../../packages/console/server/console-server');

const root = path.resolve(__dirname, '../..');
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'packages/control-server/target');
const operator = 'browser-test-operator';

(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'box-task-browser-'));
  const world = createServer({catalogPath: path.join(dir, 'catalog.sqlite3')});
  await once(world.listen(0, '127.0.0.1'), 'listening');
  const worldUrl = 'http://127.0.0.1:' + world.address().port;
  let control, controlExit, browser, consoleServer;
  try {
    control = spawn(path.join(target, 'debug/threebox-control-server'), [], {
      cwd: root,
      env: {...process.env, WORLD_URL: worldUrl, CONTROL_BIND: '127.0.0.1:0',
        BOX_CONTROL_DATA_DIR: dir, BOX_RUNNER_DATA_DIR: dir,
        BOX_RUNNER_OPERATOR_TOKEN: operator, RUST_LOG: 'info'},
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    controlExit = once(control, 'close');
    const lines = createInterface({input: control.stdout});
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Control startup timed out')), 15000);
      control.once('close', () => {clearTimeout(timer); reject(Error('Control exited'));});
      lines.on('line', line => {
        const match = /address=(127\.0\.0\.1:\d+)/.exec(line);
        if (match) {clearTimeout(timer); resolve('http://' + match[1]);}
      });
    });
    consoleServer = createConsoleServer({controlUrl: base, worldUrl});
    await once(consoleServer.listen(0, '127.0.0.1'), 'listening');
    const url = 'http://127.0.0.1:' + consoleServer.address().port;
    async function api(route, token, body) {
      const response = await fetch(base + '/runs/v1' + route, {
        method: body ? 'POST' : 'GET',
        headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      const value = await response.json();
      assert(response.ok, JSON.stringify(value));
      return value;
    }
    const {token} = await api('/integrations', operator, {label: '园区运维 Agent'});
    const run = await api('/tools/box_create_run', token, {
      request_id: 'browser-demo', scene_id: 'industrial-park-v2',
      objective: {type: 'scene_completed', instruction: '完成园区巡检、备件运输、维修和复核'},
    });
    const args = {run_id: run.run_id, control_epoch: run.control_epoch};
    const note = '先由无人机巡检北侧设备区，再安排备件运输和维修，最后复核设备状态。';
    await api('/tools/box_record_note', token, {...args, request_id: 'plan', kind: 'plan', text: note});

    browser = await chromium.launch({
      executablePath: process.env.BOX_CHROME_EXECUTABLE || undefined,
      headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url + '/#run=' + run.run_id);
    const panel = page.locator('.mc-agent-panel');
    await panel.getByLabel('管理令牌').fill(operator);
    await panel.getByRole('button', {name: '连接', exact: true}).click();
    await panel.getByRole('button', {name: '打开三维观察与执行记录'}).click();
    await page.waitForFunction(() => !document.querySelector('.mc-tool-dialog').open);
    await page.locator('.mc-feed').getByText(note, {exact: true}).waitFor();

    const view = await api('/tools/box_observe', token, {run_id: run.run_id, view: 'coordinator'});
    const task = view.observation.tasks.find(task => task.candidates.length);
    const agent = task.candidates[0];
    await api('/tools/box_assign_task', token, {...args, request_id: 'assign',
      expected_revision: view.world_revision, task_id: task.id, agent_id: agent.id});
    const action = await api('/tools/box_submit_action', token, {...args, agent_id: agent.id,
      action: {requestId: 'execute', type: 'execute_task', taskId: task.id,
        targetTick: view.observation.tick + 1, expiresTick: view.observation.tick + 40}});
    await api('/tools/box_advance', token, {...args, request_id: 'advance',
      expected_revision: action.world_revision, max_ticks: 20});
    await page.waitForFunction(() => document.querySelector('.mc-feed .mc-agent-meta')?.textContent.includes('1/5'));
    await page.locator('.mc-feed').getByText('World 变化', {exact: true}).first().waitFor();
    if (process.env.BOX_BROWSER_SCREENSHOT) {
      await page.screenshot({path: process.env.BOX_BROWSER_SCREENSHOT, fullPage: true});
    }
    assert.deepEqual(errors, []);
    await api('/tools/box_cancel_run', token, {...args, request_id: 'cleanup'});
    console.log('Task browser: deep link, login, observer join, live notes and World progress passed.');
  } finally {
    if (browser) await browser.close();
    if (control) {control.kill(); await controlExit;}
    if (consoleServer) {consoleServer.closeAllConnections(); await new Promise(resolve => consoleServer.close(resolve));}
    await new Promise(resolve => world.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
