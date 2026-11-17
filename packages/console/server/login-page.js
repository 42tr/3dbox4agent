'use strict';

const {createHash} = require('node:crypto');
const script = `
const form = document.querySelector('form'), message = document.querySelector('[role="alert"]'), button = form.querySelector('button');
function destination() {
  const value = new URLSearchParams(location.search).get('returnTo') || '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\\\\x00-\\x20]/.test(value)) return '/';
  try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname === '/' ? url.pathname + url.search + url.hash : '/'; } catch { return '/'; }
}
const errors = {invalid_credentials:'账号或密码不正确。',login_rate_limited:'登录尝试过于频繁，请五分钟后重试。',console_login_not_configured:'管理员尚未配置 Console 登录账号。',invalid_origin:'登录请求已失效，请刷新页面后重试。'};
fetch('/auth/session',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(s=>{if(s.authenticated)location.replace(destination());else if(!s.configured){message.textContent=errors.console_login_not_configured;button.disabled=true;}}).catch(()=>{message.textContent='无法连接登录服务，请刷新重试。';});
form.addEventListener('submit',async event=>{
  event.preventDefault();button.disabled=true;message.textContent='';
  try {
    const response=await fetch('/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:form.elements.username.value,password:form.elements.password.value})});
    const result=await response.json();
    if(!response.ok)throw Error(errors[result.error]||'登录失败，请稍后重试。');
    form.elements.password.value='';location.replace(destination());
  } catch(error){message.textContent=error.message;button.disabled=false;}
});`;
const style = `*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#171b20;color:#d9dce2;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;padding:24px}main{width:min(420px,100%);padding:36px;border:1px solid #353e4c;border-radius:16px;background:#202630;box-shadow:0 24px 80px #0003}.brand{font-size:12px;letter-spacing:2px;color:#9aa4ff}h1{font-size:26px;margin:12px 0 8px}p{color:#a9b2c0;font-size:14px}label{display:block;margin-top:20px}input{display:block;width:100%;margin-top:6px;padding:11px 12px;border:1px solid #4b586b;border-radius:7px;background:#171e29;color:#fff;font:inherit}input:focus-visible,button:focus-visible{outline:2px solid #a6aeff;outline-offset:3px}button{width:100%;margin-top:26px;padding:11px;border:0;border-radius:7px;background:#818cf8;color:#12182a;font:600 15px inherit;cursor:pointer}button:disabled{opacity:.55;cursor:wait}[role=alert]{color:#ffb7aa;min-height:1.6em;margin-bottom:0}small{display:block;color:#939eaf;margin-top:18px}`;
const hash = value => createHash('sha256').update(value).digest('base64');
const html = Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录 · 3DBox Console</title><style>${style}</style></head><body><main><div class="brand">3DBOX / CONSOLE</div><h1>登录控制台</h1><p>登录后查看任务执行记录、三维观察与回放。</p><form><label for="username">账号</label><input id="username" name="username" autocomplete="username" required maxlength="100" autofocus><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">登录</button><p role="alert" aria-live="polite"></p></form><small>此浏览器保持登录 7 天，可随时退出。</small></main><script>${script}</script></body></html>`);

function serveLogin(req, res) {
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-length': html.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`});
  res.end(req.method === 'HEAD' ? undefined : html);
}
module.exports = {serveLogin};
