'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const Assets=require('../src/experiment-assets'),{serve}=require('../server/public-experiment-assets');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-public-experiment-')),name='policy-acceptance-codex-test.json',bytes=Buffer.from('{"test":[1,2]}'),sha256=crypto.createHash('sha256').update(bytes).digest('hex'),ref={file:name,bytes:bytes.length,sha256};
 const manifest=()=>fs.writeFileSync(path.join(root,'policy-acceptance-public-codex.json'),JSON.stringify({files:{[name]:{bytes:ref.bytes,sha256}}}));
 fs.writeFileSync(path.join(root,name),bytes);manifest();
 const server=http.createServer((req,res)=>{if(!serve(req,res,new URL(req.url,'http://localhost'),root)){res.writeHead(404);res.end()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/progress.html`,nativeFetch=global.fetch;let calls=0;
 try{
  for(const file of ['../private.json','policy-acceptance-codex-test.json?token=x','other.json','/policy-acceptance-codex-test.json'])assert.throws(()=>Assets.validate({...ref,file}));
  await assert.rejects(Assets.fetchAsset(ref,'file:///tmp/progress.html'),/HTTP/);
  await assert.rejects(Assets.fetchAsset(ref,'http://user:pass@localhost/progress.html'),/HTTP/);
  global.fetch=async(url,options)=>{calls++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return nativeFetch(url,options)};
  const first=await Assets.fetchAsset(ref,base);first.test.push(3);assert.deepEqual(await Assets.fetchAsset(ref,base),{test:[1,2]});assert.equal(calls,1);
  await assert.rejects(Assets.fetchAsset({...ref,sha256:'0'.repeat(64)},base),/校验和/);
  await assert.rejects(Assets.fetchAsset({...ref,bytes:bytes.length-1},base),/大小/);
  await assert.rejects(Assets.fetchAsset({...ref,bytes:bytes.length+1},base),/大小/);
  let response=await nativeFetch(new URL(name,base),{method:'HEAD'});assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(await response.text(),'');
  assert.equal((await nativeFetch(new URL('policy-acceptance-codex-unknown.json',base))).status,404);
  assert.equal((await nativeFetch(new URL('policy-acceptance-public-codex.json',base))).status,404);
  fs.writeFileSync(path.join(root,name),Buffer.alloc(bytes.length+1));assert.equal((await nativeFetch(new URL(name,base))).status,404);
  fs.unlinkSync(path.join(root,name));fs.writeFileSync(path.join(root,'private.json'),bytes);fs.symlinkSync('private.json',path.join(root,name));assert.equal((await nativeFetch(new URL(name,base))).status,404);
  fs.unlinkSync(path.join(root,name));fs.writeFileSync(path.join(root,name),bytes);fs.unlinkSync(path.join(root,'policy-acceptance-public-codex.json'));assert.equal((await nativeFetch(new URL(name,base))).status,404);
  manifest();const invalid=Buffer.from('not json');global.fetch=async()=>new Response(invalid);await assert.rejects(Assets.fetchAsset({...ref,bytes:invalid.length,sha256:crypto.createHash('sha256').update(invalid).digest('hex')},base),SyntaxError);
  global.fetch=async()=>new Response(bytes);assert.deepEqual(await Assets.fetchAsset({...ref,file:'policy-acceptance-codex-retry.json'},base),{test:[1,2]});
  console.log('public experiment allowlist, no symlinks, bounded same-origin loading, checksum rejection and isolated cache passed');
 }finally{global.fetch=nativeFetch;await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
