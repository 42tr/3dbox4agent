'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createConsoleServer} = require('../server/console-server');

test('deployment page and JSON expose three safely rendered commits', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-deployment-'));
  const htmlPath = path.join(directory, 'index.html');
  const infoPath = path.join(directory, 'deployment-info.json');
  fs.writeFileSync(htmlPath, 'console');
  const info = {
    repository: 'https://github.com/42tr/3dbox4agent',
    branch: 'main',
    commit: 'a'.repeat(40),
    commits: [1, 2, 3].map(number => ({
      sha: String(number).repeat(40), shortSha: String(number).repeat(7),
      author: 'Test <Author>', authoredAt: '2026-11-15T00:00:00Z',
      subject: number === 1 ? 'Escape <script> & quotes' : `Commit ${number}`,
      body: ''
    }))
  };
  fs.writeFileSync(infoPath, JSON.stringify(info));
  const server = createConsoleServer({controlUrl: 'http://127.0.0.1:1', htmlPath, deploymentInfoPath: infoPath});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const jsonResponse = await fetch(`${origin}/deployment.json`);
  assert.equal(jsonResponse.status, 200);
  assert.equal((await jsonResponse.json()).commits.length, 3);
  const html = await (await fetch(`${origin}/deployment`)).text();
  assert.match(html, /当前部署版本/);
  assert.match(html, /Escape &lt;script&gt; &amp; quotes/);
  assert.doesNotMatch(html, /Escape <script>/);
  assert.match(html, new RegExp(info.commit));
  const head = await fetch(`${origin}/deployment`, {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
