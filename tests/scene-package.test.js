'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const F=require('../src/scene-format'),E=require('../src/engine');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-scene-package-'));
try{
 for(const id of ['industrial-park-v1','lunar-base-v1','shore-coordination-v1']){
  const scene=E.getScene(id),raw=F.stringifyPackage(scene,{version:'2.1.3',description:'可移植场景'}),pkg=F.parsePackage(raw);
  assert.deepEqual(pkg.scene,scene);assert.deepEqual(F.parseScene(raw),scene);assert.equal(pkg.manifest.version,'2.1.3');
  const file=path.join(dir,id+'.json');fs.writeFileSync(file,raw);const expected=crypto.createHash('sha256').update(raw).digest('hex');
  const py=cp.spawnSync('python3',['-c','import json,sys; from scene_input import load_scene_file; s,h=load_scene_file(sys.argv[1]); print(json.dumps({"scene":s,"hash":h},ensure_ascii=False))',file],{env:{...process.env,PYTHONPATH:path.resolve('sdk/python')},encoding:'utf8'});assert.equal(py.status,0,py.stderr);const parsed=JSON.parse(py.stdout);assert.equal(parsed.hash,expected);assert.deepEqual(parsed.scene,scene);
  const check=cp.spawnSync(process.execPath,['scripts/check-scene.js',file],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout).sceneId,id);
 }
 const scene=E.getScene(),base=JSON.parse(F.stringifyPackage(scene));
 for(const change of [x=>x.format='3dbox-scene-package-v2',x=>x.assets=['a.glb'],x=>x.manifest.version='latest',x=>x.manifest.script='run',x=>delete x.scene]){const copy=structuredClone(base);change(copy);assert.throws(()=>F.parseScene(JSON.stringify(copy)));const f=path.join(dir,'invalid.json');fs.writeFileSync(f,JSON.stringify(copy));const py=cp.spawnSync('python3',['-c','import sys; from scene_input import load_scene_file; load_scene_file(sys.argv[1])',f],{env:{...process.env,PYTHONPATH:path.resolve('sdk/python')},encoding:'utf8'});assert.notEqual(py.status,0)}
 const exported=cp.spawnSync(process.execPath,['scripts/export-scene.js','industrial-park-v1','--package'],{encoding:'utf8'});assert.equal(exported.status,0,exported.stderr);assert.deepEqual(F.parseScene(exported.stdout),scene);
 const f=path.join(dir,'experiment.json');fs.writeFileSync(f,exported.stdout);const run=cp.spawnSync(process.execPath,['scripts/run-scene.js',f,'42','1000','none'],{encoding:'utf8',maxBuffer:10*1024*1024});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).status,'completed');
 console.log('versioned scene packages, three scenes, Python import, rejection and simulation passed');
}finally{fs.rmSync(dir,{recursive:true,force:true})}
