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
const {hashPassword} = require('../../packages/console/server/console-auth');

const root = path.resolve(__dirname, '../..');
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'packages/control-server/target');
const operator = 'browser-test-operator';
const cameraSelector = '.mc-device-content canvas[data-device-camera="drone-1"]';

async function dragCamera(page, camera) {
  const {x, y, width, height} = await camera.boundingBox();
  await page.mouse.move(x + width / 3, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width * 2 / 3, y + height / 3, {steps: 5});
  await page.mouse.up();
}

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
    consoleServer = createConsoleServer({controlUrl: base, worldUrl, auth: {
      username:'admin',passwordHash:await hashPassword('browser-test-password'),operatorToken:operator,
      dataDir:path.join(dir,'console'),secure:false,
    }});
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
    const observationLink = new URL(run.console_url);
    const observationPath = '/#run=' + run.run_id;
    assert.equal(observationLink.pathname + observationLink.search + observationLink.hash, observationPath);
    const observationUrl = new URL(observationPath, url).href;
    const args = {run_id: run.run_id, control_epoch: run.control_epoch};
    const note = '先由无人机巡检北侧设备区，再安排备件运输和维修，最后复核设备状态。';
    await api('/tools/box_record_note', token, {...args, request_id: 'plan', kind: 'plan', text: note});

    browser = await chromium.launch({
      executablePath: process.env.BOX_CHROME_EXECUTABLE || undefined,
      headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const page = await context.newPage();
    const errors = [];
    const browserRequests = [];
    page.on('request',request=>{if(request.url().includes('/console-api/'))browserRequests.push(request);});
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(observationUrl);
    await page.waitForURL('**/login?**');
    assert.equal(new URL(page.url()).searchParams.get('returnTo'),observationPath);
    await page.getByLabel('账号',{exact:true}).fill('admin');
    await page.getByLabel('密码',{exact:true}).fill('wrong-password');
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('alert').getByText('账号或密码不正确。').waitFor();
    await page.getByLabel('密码',{exact:true}).fill('browser-test-password');
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.waitForURL(observationUrl);
    const liveSource = page.locator('.mc-source').filter({hasText: /^只读世界服务$/});
    await liveSource.waitFor({state:'attached'});
    await page.locator('#map3d').waitFor();
    assert.equal(await page.locator('.mc-tool-dialog').evaluate(dialog => dialog.open), false);
    assert.equal(await page.getByLabel('管理令牌').count(),0);
    await page.reload();
    await liveSource.waitFor({state:'attached'});
    assert.equal(page.url(),observationUrl);
    assert.equal(await page.evaluate(()=>document.cookie.includes('threebox_console_session')),false);
    await page.locator('.mc-feed').getByText(note, {exact: true}).waitFor();
    const camera = page.locator(cameraSelector);
    await page.locator(`${cameraSelector}[data-rendered-tick="0"]`).waitFor();

    const view = await api('/tools/box_observe', token, {run_id: run.run_id, view: 'coordinator'});
    const task = view.observation.tasks.find(task => task.candidates.length);
    const agent = task.candidates[0];
    await api('/tools/box_assign_task', token, {...args, request_id: 'assign',
      expected_revision: view.world_revision, task_id: task.id, agent_id: agent.id});
    const action = await api('/tools/box_submit_action', token, {...args, agent_id: agent.id,
      action: {requestId: 'execute', type: 'execute_task', taskId: task.id,
        targetTick: view.observation.tick + 1, expiresTick: view.observation.tick + 40}});
    const advance = await api('/tools/box_advance', token, {...args, request_id: 'advance',
      expected_revision: action.world_revision, max_ticks: 20});
    await page.waitForFunction(() => document.querySelector('.mc-feed .mc-agent-meta')?.textContent.includes('1/5'));
    await page.locator('.mc-feed').getByText('World 变化', {exact: true}).first().waitFor();
    const latestCamera = `${cameraSelector}[data-rendered-tick="${advance.end_tick}"]`;
    await page.waitForFunction(selector => {
      const card = document.querySelector(selector);
      const inset = document.querySelector('.mc-scene-camera canvas');
      return card && card.dataset.renderedTick === inset?.dataset.renderedTick && card.toDataURL() === inset.toDataURL();
    }, latestCamera);
    if (process.env.BOX_BROWSER_SCREENSHOT) {
      await page.screenshot({path: process.env.BOX_BROWSER_SCREENSHOT, fullPage: true});
    }
    const defaultImage = await camera.evaluate(canvas => canvas.toDataURL());
    const cameraRequests = [];
    page.on('request', request => {if (new URL(request.url()).pathname.endsWith('/camera')) cameraRequests.push(request);});
    await dragCamera(page, camera);
    await page.waitForFunction(({selector, before}) => {
      const canvas = document.querySelector(selector);
      return canvas?.dataset.cameraYaw && canvas.toDataURL() !== before;
    }, {selector: latestCamera, before: defaultImage});
    assert.equal(cameraRequests.length, 0);
    await page.getByRole('slider', {name: '回放时间'}).fill('0');
    await page.locator(`${cameraSelector}[data-rendered-tick="0"]`).waitFor();
    await page.getByRole('button', {name: '返回实时'}).click();
    await page.locator(latestCamera).waitFor();

    const other = await api('/tools/box_create_run', token, {
      request_id: 'browser-other-run', scene_id: 'industrial-park-v2',
      objective: {type: 'scene_completed', instruction: '查看另一轮园区运行'},
    });
    await page.goto(new URL(new URL(other.console_url).hash, url).href);
    await page.locator('.mc-feed').getByText(other.objective.instruction,{exact:true}).waitFor();
    await page.locator(`${cameraSelector}[data-rendered-tick="0"]`).waitFor();
    await page.goto(observationUrl);
    await page.locator(latestCamera).waitFor();
    await api('/tools/box_cancel_run', token, {
      run_id: other.run_id, control_epoch: other.control_epoch, request_id: 'cleanup-other',
    });

    const fallback = await context.newPage();
    fallback.on('pageerror', error => errors.push(error.message));
    await fallback.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...options) {
        return type === 'webgl2' ? null : getContext.call(this, type, ...options);
      };
    });
    await fallback.goto(observationUrl);
    const fallbackImage = fallback.getByRole('img', {name: 'drone-1 仿真摄像头画面', exact: true});
    await fallbackImage.waitFor();
    assert.match(await fallbackImage.getAttribute('src'), /^data:image\/svg\+xml/);
    assert.equal(await fallback.locator('.mc-camera > span').count(), 0);
    const rotation = fallback.waitForResponse(response => new URL(response.url()).pathname.endsWith('/drone-1/camera'));
    await dragCamera(fallback, fallbackImage);
    assert((await rotation).ok());
    await fallback.locator('.mc-camera img[alt="drone-1 仿真摄像头画面"][src^="blob:"]').waitFor();
    await fallback.getByRole('slider', {name: '回放时间'}).fill('0');
    await fallback.locator('.mc-camera img[alt="drone-1 仿真摄像头画面"][src^="data:"]').waitFor();
    await fallback.close();

    await api('/tools/box_cancel_run', token, {...args, request_id: 'cleanup'});
    for(let i=0;i<40;i++){
      const saved=await api('/runs/'+run.run_id,operator);
      if(saved.archive_status==='ready')break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    // The same observation link opens the archived 3D replay in a signed-in tab.
    const replayPage=await page.context().newPage();
    replayPage.on('pageerror',error=>errors.push(error.message));
    await replayPage.goto(observationUrl);
    await replayPage.locator('.mc-source').filter({hasText: /^导入回放$/}).waitFor({state:'attached'});
    await replayPage.locator('#map3d').waitFor();
    assert.equal(await replayPage.locator('.mc-tool-dialog').evaluate(dialog => dialog.open), false);
    await replayPage.locator('.mc-feed').getByText(note,{exact:true}).waitFor();
    await replayPage.setViewportSize({width:390,height:844});
    await replayPage.locator(cameraSelector).scrollIntoViewIfNeeded();
    await replayPage.locator(`${cameraSelector}[data-ready]`).waitFor();
    const cookies=await page.context().cookies();
    const sessionCookie=cookies.find(cookie=>cookie.name==='threebox_console_session');
    assert(sessionCookie.httpOnly&&sessionCookie.sameSite==='Lax');
    assert(browserRequests.length>0);
    for(const request of browserRequests)assert.equal(request.headers().authorization,undefined);
    await replayPage.getByRole('button',{name:'admin · 退出登录',exact:true}).click();
    await replayPage.waitForURL('**/login?**');
    // The original tab detects revocation while polling, and returns to login too.
    await page.waitForURL('**/login?**');
    const denied=await fetch(url+'/console-api/runs/v1/runs/'+run.run_id+'/report',{
      headers:{cookie:'threebox_console_session='+sessionCookie.value},
    });
    assert.equal(denied.status,401);
    // Login cannot redirect to a remote site, even with a crafted returnTo.
    await replayPage.goto(url+'/login?returnTo='+encodeURIComponent('//attacker.example/'));
    await replayPage.getByLabel('账号',{exact:true}).fill('admin');
    await replayPage.getByLabel('密码',{exact:true}).fill('browser-test-password');
    await replayPage.getByRole('button',{name:'登录',exact:true}).click();
    await replayPage.waitForURL(url+'/');
    assert.deepEqual(errors, []);
    console.log('Task browser: login, observer, SSE, live and replay cameras, SVG fallback, logout and safe redirects passed.');
  } finally {
    if (browser) await browser.close();
    if (control) {control.kill(); await controlExit;}
    if (consoleServer) {consoleServer.closeAllConnections(); await new Promise(resolve => consoleServer.close(resolve));}
    await new Promise(resolve => world.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
