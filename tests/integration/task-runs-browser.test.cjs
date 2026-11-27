'use strict';

// Browser smoke test. Install Chromium with `npx playwright install chromium`.
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

async function waitForCenteredAgent(page, agentId, name) {
  await page.waitForFunction(id => {
    const marker = document.querySelector('.mc-stage-agent');
    if (marker?.dataset.stageAgent !== id || getComputedStyle(marker).visibility !== 'visible') return false;
    const agent = marker.getBoundingClientRect();
    const map = document.querySelector('#map3d').getBoundingClientRect();
    return Math.abs(agent.left - map.left - map.width / 2) < 35 &&
      Math.abs(agent.top - map.top - map.height / 2) < 95;
  }, agentId);
  assert.equal(await page.locator('.mc-stage-agent').textContent(), name);
}

async function verifyCompletedReplay(page) {
  const replay = page.getByRole('button', {name: '回放', exact: true});
  const pause = page.getByRole('button', {name: '暂停回放', exact: true});
  const timeline = page.getByRole('slider', {name: '回放时间'});
  await replay.waitFor({timeout: 45000});
  const finalFrame = Number(await timeline.inputValue());
  assert(finalFrame > 2);
  await replay.click();
  await pause.click();
  const pausedFrame = Number(await timeline.inputValue());
  assert(pausedFrame < finalFrame, 'replay starts before the finished frame');
  await page.waitForTimeout(350);
  assert.equal(Number(await timeline.inputValue()), pausedFrame);

  await timeline.fill(String(finalFrame - 1));
  await replay.click();
  await page.waitForFunction(() => {
    const slider = document.getElementById('timeline');
    return slider.value === slider.max;
  });
  assert(await replay.isEnabled(), 'replay remains available after playback ends');

  await replay.click();
  await pause.waitFor();
  await page.getByRole('button', {name: '返回实时', exact: true}).click();
  await replay.waitFor();
  assert.equal(Number(await timeline.inputValue()), finalFrame);
}

(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'box-task-browser-'));
  const world = createServer({catalogPath: path.join(dir, 'catalog.sqlite3'),
    journalDir: path.join(dir, 'journal'), replayJournal: true});
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
    let rpcId = 0;
    async function mcpTool(name, args, error) {
      const protocol = '2026-07-28';
      const id = ++rpcId;
      const response = await fetch(base + '/mcp/control', {
        method: 'POST',
        headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
          'mcp-method': 'tools/call', 'mcp-name': name},
        body: JSON.stringify({jsonrpc: '2.0', id, method: 'tools/call', params: {
          name, arguments: args, _meta: {'io.modelcontextprotocol/protocolVersion': protocol,
            'io.modelcontextprotocol/clientInfo': {name: 'observer-browser-test', version: '1'},
            'io.modelcontextprotocol/clientCapabilities': {}},
        }}),
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const message = response.headers.get('content-type').includes('text/event-stream')
        ? body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(message => message.id === id)
        : JSON.parse(body);
      assert(message?.result, body);
      const result = message.result;
      if (error) {
        assert.equal(result.isError, true, body);
        assert.equal(result.structuredContent.code, error);
      } else {
        assert(!result.isError, body);
      }
      return result.structuredContent;
    }
    const run = await api('/tools/box_create_run', token, {
      request_id: 'browser-demo', scene_id: 'industrial-park-v2',
      objective: {type: 'scene_completed', instruction: '完成园区巡检、备件运输、维修和复核'},
      config: {speed: 1},
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
    await liveSource.waitFor();
    await page.locator('#map3d').waitFor();
    assert.equal(await page.getByLabel('实验与世界设置', {exact: true}).evaluate(dialog => dialog.open), false);
    assert.equal(await page.getByLabel('管理令牌').count(),0);
    await page.reload();
    await liveSource.waitFor({state:'attached'});
    assert.equal(page.url(),observationUrl);
    assert.equal(await page.evaluate(()=>document.cookie.includes('threebox_console_session')),false);
    await page.locator('.mc-feed').getByText(note, {exact: true}).waitFor();
    const camera = page.locator(cameraSelector);
    await page.locator(`${cameraSelector}[data-rendered-tick="0"]`).waitFor();
    assert.equal(await page.locator('.mc-scene-camera span').textContent(), '无人机 1');
    const observerControls = page.locator('.mc-inline-device-actions');
    await observerControls.getByText('当前为只读观察，不能发送设备意图。').waitFor();
    assert.equal(await observerControls.count(), 1);
    assert(await observerControls.getByRole('button', {name:'扫描周边',exact:true}).isDisabled());
    await page.getByRole('region', {name:'观测数据',exact:true}).waitFor();
    const stageView = page.locator('.mc-view-toggle');
    await stageView.getByText('全局观察', {exact: true}).waitFor();

    const feed = page.locator('.mc-feed');
    const view = await mcpTool('box_observe', {run_id: run.run_id, view: 'coordinator'});
    await feed.getByText('协调器视图', {exact: true}).first().waitFor();
    const task = view.observation.tasks.find(task => task.candidates.length);
    const agent = task.candidates[0];
    const agentName = '无人机 ' + agent.id.split('-').at(-1);
    await mcpTool('box_assign_task', {...args, request_id: 'assign',
      expected_revision: view.world_revision, task_id: task.id, agent_id: agent.id});
    const firstFollow = stageView.getByText('跟随 ' + agentName, {exact: true});
    await firstFollow.waitFor();
    await waitForCenteredAgent(page, agent.id, agentName);
    const action = await api('/tools/box_submit_action', token, {...args, agent_id: agent.id,
      action: {requestId: 'execute', type: 'execute_task', taskId: task.id,
        targetTick: view.observation.tick + 1, expiresTick: view.observation.tick + 40}});
    const advancing = mcpTool('box_advance', {...args, request_id: 'advance',
      expected_revision: action.world_revision, max_ticks: 25, until: []});
    const progress = feed.getByRole('progressbar');
    await progress.waitFor();
    await page.waitForFunction(() => document.querySelector('.mc-feed progress')?.value > 0);
    const advance = await advancing;
    await progress.waitFor({state: 'detached'});
    await feed.getByText(new RegExp(`^已推进 ${advance.executed} 步`)).waitFor();
    assert.doesNotMatch(await feed.locator('.mc-agent-run-heading').innerText(), /世界正在推进/);
    assert.match(await feed.locator('.mc-agent-events li').first().innerText(), /推进世界/);
    await page.waitForFunction(() => document.querySelector('.mc-feed .mc-agent-meta')?.textContent.includes('1/5'));
    await page.locator('.mc-feed').getByText('World 变化', {exact: true}).first().waitFor();
    const latestCamera = `${cameraSelector}[data-rendered-tick="${advance.end_tick}"]`;
    await page.waitForFunction(selector => {
      const card = document.querySelector(selector);
      const inset = document.querySelector('.mc-scene-camera canvas');
      return card && card.dataset.renderedTick === inset?.dataset.renderedTick && card.toDataURL() === inset.toDataURL();
    }, latestCamera);
    await waitForCenteredAgent(page, agent.id, agentName);
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
    await stageView.getByText('全局观察', {exact: true}).waitFor();
    await page.getByRole('button', {name: '返回实时'}).click();
    await page.locator(latestCamera).waitFor();
    await firstFollow.waitFor();

    const otherAgentId = 'vehicle-1';
    await mcpTool('box_observe', {run_id: run.run_id, view: 'agent', agent_id: otherAgentId});
    await mcpTool('box_cancel_action', {...args, agent_id: otherAgentId,
      request_id: 'cancel-missing', action_request_id: 'missing'}, 'action_not_found');
    await feed.getByText(`${otherAgentId} · 找不到设备动作`, {exact: true}).waitFor();
    assert.equal(await firstFollow.count(), 1);
    await mcpTool('box_submit_action', {...args, agent_id: otherAgentId,
      action: {requestId: 'follow-scan', type: 'scan', targetTick: advance.end_tick + 1, expiresTick: advance.end_tick + 4}});
    const otherAgentName = '运输车 1';
    const secondFollow = stageView.getByText('跟随 ' + otherAgentName, {exact: true});
    await secondFollow.waitFor();
    await waitForCenteredAgent(page, otherAgentId, otherAgentName);
    assert.equal(await page.getByRole('button', {name: '返回全局观察'}).count(), 0);

    const map = page.locator('#map3d');
    await stageView.click();
    const followToggle = page.getByRole('button', {name: '自动跟随 Agent', exact: true});
    assert.equal(await followToggle.getAttribute('aria-pressed'), 'true');
    const followingImage = await map.screenshot();
    await followToggle.click();
    await stageView.getByText('全局观察', {exact: true}).waitFor();
    assert.equal(await followToggle.getAttribute('aria-pressed'), 'false');
    assert.notDeepEqual(await map.screenshot(), followingImage);
    await followToggle.click();
    await secondFollow.waitFor();
    await page.setViewportSize({width: 390, height: 844});
    const toggleBox = await followToggle.boundingBox();
    assert(toggleBox && toggleBox.x >= 0 && toggleBox.x + toggleBox.width <= 390);
    assert(await feed.evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.setViewportSize({width: 1440, height: 1000});
    await stageView.click();

    const other = await api('/tools/box_create_run', token, {
      request_id: 'browser-other-run', scene_id: 'industrial-park-v2',
      objective: {type: 'scene_completed', instruction: '查看另一轮园区运行'},
    });
    await page.goto(new URL(new URL(other.console_url).hash, url).href);
    await page.locator('.mc-feed').getByText(other.objective.instruction,{exact:true}).waitFor();
    await page.locator(`${cameraSelector}[data-rendered-tick="0"]`).waitFor();
    await stageView.getByText('全局观察', {exact: true}).waitFor();
    await page.goto(observationUrl);
    await page.locator(latestCamera).waitFor();
    await secondFollow.waitFor();
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
    const fallbackImage = fallback.getByRole('img', {name: '无人机 1 仿真摄像头画面', exact: true});
    await fallbackImage.waitFor();
    assert.match(await fallbackImage.getAttribute('src'), /^data:image\/svg\+xml/);
    assert.equal(await fallback.locator('.mc-camera > span').count(), 0);
    const rotation = fallback.waitForResponse(response => new URL(response.url()).pathname.endsWith('/drone-1/camera'));
    await dragCamera(fallback, fallbackImage);
    assert((await rotation).ok());
    await fallback.locator('.mc-camera img[alt="无人机 1 仿真摄像头画面"][src^="blob:"]').waitFor();
    await fallback.getByRole('slider', {name: '回放时间'}).fill('0');
    await fallback.locator('.mc-camera img[alt="无人机 1 仿真摄像头画面"][src^="data:"]').waitFor();
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
    assert.equal(await replayPage.getByLabel('实验与世界设置', {exact: true}).evaluate(dialog => dialog.open), false);
    await replayPage.locator('.mc-feed').getByText(note,{exact:true}).waitFor();
    await replayPage.setViewportSize({width:390,height:844});
    await replayPage.locator(cameraSelector).scrollIntoViewIfNeeded();
    await replayPage.locator(`${cameraSelector}[data-ready]`).waitFor();
    const replayFallback = await context.newPage();
    await replayFallback.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...options) {
        return type === 'webgl2' ? null : getContext.call(this, type, ...options);
      };
    });
    await replayFallback.goto(observationUrl);
    const replayImage = replayFallback.getByRole('img', {name:'无人机 1 仿真摄像头画面', exact: true});
    await replayImage.waitFor();
    assert.match(await replayImage.getAttribute('src'), /^data:image\/svg\+xml/);
    await replayFallback.close();
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
    await replayPage.getByRole('button', {name: '场景', exact: true}).click();
    const settings = replayPage.getByRole('dialog', {name: '场景与世界设置'});
    await settings.getByLabel('随机种子').fill('77');
    const created = replayPage.waitForResponse(response => response.request().method()==='POST' &&
      new URL(response.url()).pathname==='/control/sessions');
    await settings.getByRole('button', {name: '连接世界服务', exact: true}).click();
    const receipt = await created;
    assert.equal(receipt.status(), 201);
    const editableSession = await receipt.json();
    assert.equal(receipt.request().postDataJSON().seed, 77);
    await settings.getByText('当前运行', {exact: true}).waitFor();
    await settings.getByRole('button', {name: '切换浏览器预览', exact: true}).waitFor();
    assert.match(await settings.locator('.mc-settings-current').innerText(), /种子\s+77/);
    await settings.getByRole('button', {name: '关闭实验工具'}).click();
    await replayPage.locator('.mc-header .mc-source').getByText('世界服务', {exact: true}).waitFor();
    await replayPage.reload();
    await replayPage.locator('.mc-header .mc-source').getByText('世界服务', {exact: true}).waitFor();
    await replayPage.setViewportSize({width:1536,height:1028});

    const roster = replayPage.getByRole('list', {name:'设备列表',exact:true});
    const droneRow=roster.getByRole('button',{name:/^无人机 1\b/});
    await replayPage.getByText('无人机 1 · 仿真相机',{exact:true}).waitFor();
    assert.equal(await droneRow.getAttribute('aria-pressed'),'true');
    assert.equal(await droneRow.getByText('无人机 1',{exact:true}).getAttribute('title'),'drone-1');
    const operations = replayPage.getByRole('region', {name:'设备操作',exact:true});
    const observations = replayPage.getByRole('region', {name:'观测数据',exact:true});
    await operations.getByRole('button', {name:'定向移动',exact:true}).click();
    await operations.getByLabel('方位角（°）').waitFor();
    await operations.getByRole('button', {name:'飞行控制',exact:true}).click();
    await operations.getByLabel('飞行操作').waitFor();
    await operations.getByRole('button', {name:'移动目标',exact:true}).click();
    await operations.getByLabel('移动目标 X').waitFor();
    const scan = operations.getByRole('button', {name:'扫描周边',exact:true});
    const submitted = replayPage.waitForResponse(response => response.request().method()==='POST' &&
      new URL(response.url()).pathname.endsWith(`/sessions/${editableSession.sessionId}/agents/drone-1/actions`));
    await scan.click();
    const submittedResponse = await submitted;
    assert(submittedResponse.ok());
    const {action:scanAction}=await submittedResponse.json();
    assert.equal(scanAction.type,'scan');
    await operations.getByText('扫描周边 · 已完成',{exact:true}).waitFor();
    await replayPage.getByRole('button',{name:'开始运行',exact:true}).waitFor();
    const sessionRoute=`${worldUrl}/sessions/${editableSession.sessionId}`;
    const worldHeaders={authorization:`Bearer ${editableSession.adminToken}`,'content-type':'application/json'};
    const read=await fetch(sessionRoute+'/observations/drone-1?include=device',{headers:worldHeaders});
    assert(read.ok);
    const latestScan=(await read.json()).device.actions.find(action=>action.requestId===scanAction.requestId);
    assert.equal(latestScan.status,'completed');
    const sessionState=await (await fetch(sessionRoute,{headers:worldHeaders})).json();
    assert.equal(sessionState.running,false);
    assert.equal(sessionState.world.tick,latestScan.result.observedTick);
    const activeTask=sessionState.world.tasks.find(task=>task.status==='active');
    const executingAgent=sessionState.world.agents.find(device=>device.id===activeTask?.assignee);
    assert(executingAgent && executingAgent.id!=='drone-1');
    const executingRow=roster.getByRole('button').filter({has:replayPage.getByText(executingAgent.name,{exact:true})});
    await executingRow.waitFor({state:'attached'});
    assert.equal(await executingRow.getAttribute('aria-pressed'),'false');
    assert.equal(await droneRow.getAttribute('aria-pressed'),'true');
    assert(await scan.isEnabled());
    const scanRow=observations.getByRole('row').filter({hasText:'主动扫描'});
    await scanRow.getByText(`T+${latestScan.result.observedTick}`,{exact:true}).waitFor();
    assert.match(await scanRow.innerText(),new RegExp(({anomaly:'发现异常',normal:'状态正常',not_detected:'未探测到目标'})[latestScan.result.kind]));
    assert(await observations.getByRole('button',{name:'查看全部'}).isVisible());
    const previewCount=await observations.getByRole('row').count();
    await observations.getByRole('button',{name:'查看全部'}).click();
    assert((await observations.getByRole('row').count())>previewCount);
    await observations.getByRole('button',{name:'收起记录'}).click();
    if(process.env.BOX_BROWSER_SCREENSHOT){
      await replayPage.locator('.mc-device-content').evaluate(element=>element.scrollTop=0);
      await replayPage.screenshot({path:process.env.BOX_BROWSER_SCREENSHOT.replace(/\.png$/,'-editable.png'),fullPage:true});
    }
    await replayPage.getByRole('slider',{name:'回放时间'}).fill('0');
    await scanRow.waitFor({state:'detached'});
    assert(await scan.isDisabled());
    await replayPage.getByRole('button',{name:'返回实时',exact:true}).click();
    await scanRow.waitFor();
    await roster.getByRole('button',{name:/^运输车 1\b/}).click();
    await scanRow.waitFor({state:'detached'});
    assert.equal(await operations.getByRole('button',{name:'飞行控制',exact:true}).count(),0);
    await replayPage.setViewportSize({width:390,height:844});
    await observations.scrollIntoViewIfNeeded();
    assert(await observations.evaluate(element=>element.scrollWidth<=element.clientWidth));

    const completedResponse=await fetch(sessionRoute+'/step',{method:'POST',headers:worldHeaders,body:JSON.stringify({count:600})});
    assert(completedResponse.ok);
    const completedSession=await completedResponse.json();
    assert(completedSession.world.done&&!completedSession.world.failed);
    const replayWrites=[];
    replayPage.on('request',request=>{
      if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith(`/control/sessions/${editableSession.sessionId}/`)) replayWrites.push(request.url());
    });
    await verifyCompletedReplay(replayPage);
    const afterPlayback=await (await fetch(sessionRoute,{headers:worldHeaders})).json();
    assert.equal(afterPlayback.revision,completedSession.revision);
    assert.equal(afterPlayback.running,false);
    assert.deepEqual(replayWrites,[]);

    const local=await browser.newPage({viewport:{width:1440,height:1000}});
    local.on('pageerror',error=>errors.push(error.message));
    await local.goto(url+'/');
    const localDrone=local.getByRole('list',{name:'设备列表'}).getByRole('button',{name:/^无人机 1\b/});
    await local.getByRole('region',{name:'无人机 1 详情',exact:true}).waitFor();
    assert.equal(await localDrone.getAttribute('aria-pressed'),'true');
    const localControls=local.getByRole('region',{name:'设备操作',exact:true});
    await localControls.getByRole('button',{name:'扫描周边',exact:true}).click();
    await localControls.getByText('扫描周边 · 已完成',{exact:true}).waitFor();
    await local.getByRole('region',{name:'观测数据',exact:true}).getByText('主动扫描',{exact:true}).waitFor();
    await localControls.getByRole('button',{name:'定向移动',exact:true}).click();
    await localControls.getByLabel('距离（m）').fill('1');
    await localControls.getByRole('button',{name:'提交定向移动',exact:true}).click();
    await localControls.getByText('定向移动 · 已完成',{exact:true}).waitFor();
    assert.equal(await localDrone.getAttribute('aria-pressed'),'true');
    await localControls.locator('.mc-inline-action-history summary').click();
    await localControls.getByText(/已移动 1\.0 \/ 1 m/).waitFor();
    await localControls.locator('.mc-inline-action-history summary').click();
    await localControls.getByRole('button',{name:'飞行控制',exact:true}).click();
    await localControls.getByLabel('飞行操作').selectOption('hover');
    await localControls.getByLabel('悬停时长（步）').fill('30');
    await localControls.getByRole('button',{name:'提交悬停',exact:true}).click();
    await local.getByRole('button',{name:'暂停操作',exact:true}).click();
    await localControls.getByText('手动操作已暂停。开始运行可继续执行。',{exact:true}).waitFor();
    const pausedTick=await local.locator('.mc-tick').innerText();
    await localControls.locator('.mc-inline-action-history summary').click();
    await localControls.getByRole('button',{name:/取消动作 panel-/}).click();
    await localControls.getByText('悬停 · 已取消',{exact:true}).waitFor();
    assert.equal(await local.locator('.mc-tick').innerText(),pausedTick);
    await local.evaluate(()=>{
      const speed=document.getElementById('speed');
      speed.value='5';
      speed.dispatchEvent(new Event('change'));
    });
    await local.getByRole('button',{name:'开始运行',exact:true}).click();
    await verifyCompletedReplay(local);
    await local.close();
    assert.deepEqual(errors, []);
    console.log('Task browser: login, MCP camera follow, readonly observer, direct device execution in both worlds, pause, replay and scoped observations passed.');
  } finally {
    if (browser) await browser.close();
    if (control) {control.kill(); await controlExit;}
    if (consoleServer) {consoleServer.closeAllConnections(); await new Promise(resolve => consoleServer.close(resolve));}
    await new Promise(resolve => world.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
