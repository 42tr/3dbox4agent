'use strict';

const fs = require('node:fs');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function repositoryUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      return value.replace(/\/$/, '');
    }
  } catch {}
  return 'https://github.com/42tr/3dbox4agent';
}

function loadDeploymentInfo(filePath) {
  const info = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!info || typeof info !== 'object' || !Array.isArray(info.commits)) {
    throw new Error('Deployment info must contain a commits array');
  }
  return {...info, commits: info.commits.slice(0, 3)};
}

function renderDeploymentPage(info) {
  const repository = repositoryUrl(info.repository);
  const commits = info.commits.map((commit, index) => {
    const sha = String(commit.sha || '');
    const url = `${repository}/commit/${encodeURIComponent(sha)}`;
    const body = commit.body ? `<pre>${escapeHtml(commit.body)}</pre>` : '';
    return `<li class="commit">
      <div class="number">${index + 1}</div>
      <div class="details">
        <h3>${escapeHtml(commit.subject)}</h3>
        ${body}
        <p>${escapeHtml(commit.author)} · <time datetime="${escapeHtml(commit.authoredAt)}">${escapeHtml(commit.authoredAt)}</time></p>
        <p><code>${escapeHtml(commit.shortSha || sha.slice(0, 12))}</code> · <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">在 GitHub 查看提交 ↗</a></p>
      </div>
    </li>`;
  }).join('\n');
  const currentUrl = info.commit ? `${repository}/commit/${encodeURIComponent(info.commit)}` : repository;
  return Buffer.from(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>3dbox4agent · 当前部署版本</title>
  <style>
    :root{color-scheme:dark;--bg:#0b1020;--panel:#121a2d;--line:#283651;--text:#edf2ff;--muted:#9caac5;--accent:#72a7ff}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#0b1020,#111a30);color:var(--text);font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
    main{width:min(860px,calc(100% - 32px));margin:64px auto}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
    h1{font-size:30px;margin:0 0 8px}h2{font-size:20px;margin:36px 0 16px}.muted,p{color:var(--muted)}
    .current{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 24px;margin-top:24px}.current span{display:block;color:var(--muted);font-size:13px;margin-bottom:5px}.current code{font-size:19px;color:var(--text);overflow-wrap:anywhere}
    ol{list-style:none;padding:0;margin:0}.commit{display:flex;gap:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:12px 0}.number{flex:0 0 32px;height:32px;border-radius:50%;display:grid;place-items:center;background:#203456;color:#b9d2ff;font-weight:700}.details{min-width:0}h3{font-size:17px;line-height:1.4;margin:2px 0 10px;overflow-wrap:anywhere}.commit p{font-size:13px;margin:5px 0}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#c6d1e5;background:#0b1222;border-radius:8px;padding:12px;font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.empty{padding:28px 0;color:var(--muted)}
    @media(max-width:600px){main{margin:32px auto}.commit{padding:18px 16px;gap:12px}.current{padding:18px}.current code{font-size:15px}}
  </style>
</head>
<body><main>
  <h1>当前部署版本</h1>
  <p><a href="${escapeHtml(repository)}" target="_blank" rel="noopener noreferrer">42tr/3dbox4agent</a> · ${escapeHtml(info.branch || 'main')} 分支</p>
  <section class="current"><span>部署提交 SHA</span><a href="${escapeHtml(currentUrl)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(info.commit || '未提供')}</code></a></section>
  <h2>最近 3 次提交</h2>
  ${commits ? `<ol>${commits}</ol>` : '<p class="empty">此构建未包含提交记录。</p>'}
  <p>此页面随部署镜像生成，显示的是当前运行版本，而不是 GitHub 上的实时最新版本。<br><a href="/deployment.json">查看 JSON 数据</a> · <a href="/control/world/health">健康检查</a></p>
</main></body></html>`, 'utf8');
}

module.exports = {loadDeploymentInfo, renderDeploymentPage};
