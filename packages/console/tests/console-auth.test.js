'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createConsoleServer} = require('../server/console-server');
const {hashPassword} = require('../server/console-auth');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
const close = server => new Promise(resolve => {server.closeAllConnections();server.close(resolve);});

test('Console sessions protect records and replay, persist and revoke without exposing operator credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-login-'));
  const htmlPath = path.join(directory, 'index.html');
  fs.writeFileSync(htmlPath, 'console');
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({path:req.url, authorization:req.headers.authorization, cookie:req.headers.cookie});
    if (req.url.endsWith('/events/stream')) {
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.write('event: run\ndata: {"seq":1}\n\n');
    } else {
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({runs:[],frames:[{done:true}]}));
    }
  });
  const controlUrl = await listen(upstream);
  let clock = Date.now();
  const auth = {username:'admin',passwordHash:await hashPassword('correct-password'),operatorToken:'private-operator',dataDir:directory,sessionSeconds:60,now:()=>clock};
  let server = createConsoleServer({controlUrl,htmlPath,auth});
  let base = await listen(server);
  t.after(async()=>{await close(server);await close(upstream);fs.rmSync(directory,{recursive:true,force:true});});
  const request = (route, {cookie, body, method='GET', headers={}}={}) => fetch(base+route, {
    method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{origin:base,'content-type':'application/json'}:{}),...headers},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000),
  });
  const login = (password='correct-password',extra={}) => request('/auth/login',{method:'POST',body:{username:'admin',password},...extra});
  assert.equal((await request('/console-api/runs/v1/runs')).status,401);
  assert.deepEqual(await (await request('/auth/session')).json(),{configured:true,authenticated:false});
  assert.equal((await login('wrong')).status,401);
  assert.equal((await login('correct-password',{headers:{origin:'https://attacker.example'}})).status,403);
  assert.equal((await request('/auth/login',{method:'POST',headers:{'content-type':'text/plain'}})).status,403);
  assert.equal((await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  const response = await login();
  assert.equal(response.status,200);
  const setCookie = response.headers.get('set-cookie'), cookie=setCookie.split(';')[0];
  assert.match(setCookie,/HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(JSON.stringify(await response.json()),/private-operator|correct-password/);
  assert.equal((await (await request('/auth/session',{cookie})).json()).username,'admin');
  const stored = fs.readFileSync(path.join(directory,'sessions.json'),'utf8');
  assert(!stored.includes(cookie.split('=')[1]));
  assert.equal(fs.statSync(path.join(directory,'sessions.json')).mode & 0o777,0o600);
  for (const route of ['/runs/v1/runs','/runs/v1/runs/run-1/report','/runners/v1/runs']) {
    assert.equal((await request('/console-api'+route,{cookie})).status,200);
    assert.equal(received.at(-1).authorization,'Bearer private-operator');
    assert.equal(received.at(-1).cookie,undefined);
  }
  assert.equal((await request('/console-api/runs/v1/tools/box_create_run',{cookie})).status,404);
  assert.equal((await request('/console-api/mcp/control',{cookie})).status,404);
  assert.equal((await request('/console-api/runs/v1/runs',{cookie,headers:{'sec-fetch-site':'cross-site'}})).status,401);
  assert.equal((await request('/console-api/runs/v1/runs/run-1/observer',{cookie,method:'POST',body:{}})).status,200);
  assert.equal((await request('/console-api/runs/v1/runs/run-1/observer',{cookie,method:'POST',body:{},headers:{origin:'https://attacker.example'}})).status,403);
  await request('/control/mcp/control',{cookie,headers:{authorization:'Bearer external-agent'}});
  assert.equal(received.at(-1).authorization,'Bearer external-agent');
  await request('/control/runs/v1/runs',{cookie});
  assert.equal(received.at(-1).authorization,undefined);
  await close(server);
  server=createConsoleServer({controlUrl,htmlPath,auth});base=await listen(server);
  assert.equal((await request('/console-api/runs/v1/runs',{cookie})).status,200,'session survives server restart');
  const stream=await request('/console-api/runs/v1/runs/run-1/events/stream',{cookie});
  const reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: run/);
  const logout=await request('/auth/logout',{cookie,method:'POST',body:{}});
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  await assert.rejects(reader.read());
  assert.equal((await request('/console-api/runs/v1/runs',{cookie})).status,401);
  await close(server);server=createConsoleServer({controlUrl,htmlPath,auth});base=await listen(server);
  assert.equal((await request('/console-api/runs/v1/runs',{cookie})).status,401,'logout remains revoked after restart');
  const expiring=(await login()).headers.get('set-cookie').split(';')[0];
  clock+=61000;
  assert.equal((await request('/console-api/runs/v1/runs',{cookie:expiring})).status,401);
  const rotated=(await login()).headers.get('set-cookie').split(';')[0];
  await close(server);server=createConsoleServer({controlUrl,htmlPath,auth:{...auth,passwordHash:await hashPassword('changed-password'),secure:true}});base=await listen(server);
  assert.equal((await request('/console-api/runs/v1/runs',{cookie:rotated})).status,401,'password rotation invalidates old sessions');
  assert.match((await login('changed-password')).headers.get('set-cookie'),/; Secure/);
  for(let i=0;i<10;i++)assert.equal((await login('wrong')).status,401);
  assert.equal((await login('wrong')).status,429);
  const page=await request('/login');
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.doesNotMatch(await page.text(),/private-operator/);
});
