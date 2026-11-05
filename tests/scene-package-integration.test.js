'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),F=require('../src/scene-format'),Replay=require('../src/replay'),{createServer}=require('../server/world-server');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-package-run-')),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const input='examples/scenes/laxity-example.yaml',scene=F.parseScene(fs.readFileSync(input,'utf8'),input),file=path.join(dir,'scenario.3dbox.json'),raw=F.stringifyPackage(scene,{version:'1.2.0',description:'实验'});fs.writeFileSync(file,raw);
 const args=['sdk/python/multi_agent_demo.py','--url',`http://127.0.0.1:${server.address().port}`,'--scene-file',file,'--fault','none','--timeout','45','--archive'];
 const result=await new Promise((resolve,reject)=>{const child=spawn('python3',args,{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>resolve({code,out,err}))});
 assert.equal(result.code,0,result.err);const report=JSON.parse(result.out);assert.equal(report.status,'completed');assert.equal(report.scene.id,scene.id);assert.equal(report.config.sceneFileSha256,crypto.createHash('sha256').update(raw).digest('hex'));assert(Replay.unwrapArchive(report).archive);console.log('scene package multi-agent experiment and replay passed');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
