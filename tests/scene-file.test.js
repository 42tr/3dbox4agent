'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const E=require('../src/engine');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-scene-'));
try{
 const exported=spawnSync(process.execPath,['scripts/export-scene.js','industrial-park-parallel-v1'],{encoding:'utf8'});assert.equal(exported.status,0,exported.stderr);
 const scene=JSON.parse(exported.stdout);assert.equal(scene.id,'industrial-park-parallel-v1');
 const mapping=Object.fromEntries(scene.tasks.map((t,i)=>[t.id,'task-'+i]));
 for(const task of scene.tasks){task.id=mapping[task.id];task.dependsOn=task.dependsOn.map(id=>mapping[id])}
 scene.id='custom-parallel';const file=path.join(dir,'scene.json');fs.writeFileSync(file,JSON.stringify(scene));
 const run=spawnSync(process.execPath,['scripts/run-scene.js',file,'42','1000','3'],{encoding:'utf8',maxBuffer:10*1024*1024});assert.equal(run.status,0,run.stderr);
 const result=JSON.parse(run.stdout);assert.equal(result.status,'completed');assert(result.faultInjected);assert.equal(result.finalState.sceneId,'custom-parallel');assert.equal(result.finalState.asset.condition,'operational');assert.equal(result.metrics.total,6);
 assert.equal(result.sceneSha256,require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
 const invalid=structuredClone(scene);invalid.tasks[0].behavior='not-supported';fs.writeFileSync(file,JSON.stringify(invalid));
 const failed=spawnSync(process.execPath,['scripts/run-scene.js',file],{encoding:'utf8'});assert.notEqual(failed.status,0);assert.match(failed.stderr,/invalid task/);
 const forbidden=structuredClone(E.scene);forbidden.tasks[0].id='__proto__';assert.throws(()=>E.validateScene(forbidden));
 console.log('scene file integration tests passed');
}finally{fs.rmSync(dir,{recursive:true,force:true})}
