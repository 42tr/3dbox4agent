'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),E=require('../src/engine'),F=require('../src/scene-format');
const path='examples/scenes/laxity-example.yaml',text=fs.readFileSync(path,'utf8'),scene=F.parseScene(text,path),normalized=E.normalizeScene(scene);
assert.equal(normalized.id,'laxity-yaml-example-v1');assert(E.create(42,'nearest',normalized));
assert.deepEqual(F.parseScene('{"x":1}','scene.json'),{x:1});
for(const value of ['x: 1\nx: 2','x: &a [1,2]\ny: *a','x: !custom hello','x: .inf','1: value','__proto__: {bad: true}'])assert.throws(()=>F.parseScene(value,'scene.yaml'));
assert.throws(()=>F.parseScene('x: '+ 'a'.repeat(60000),'scene.yaml'));
for(const id of ['industrial-park-v1','industrial-park-parallel-v1','lunar-base-v1','shore-coordination-v1']){
 const original=E.getScene(id),yaml=F.stringifyScene(original);assert.deepEqual(F.parseScene(yaml,'export.yaml'),original);
 const exported=cp.spawnSync(process.execPath,['scripts/export-scene.js',id,'--yaml'],{encoding:'utf8'});assert.equal(exported.status,0,exported.stderr);assert.deepEqual(F.parseScene(exported.stdout,'export.yaml'),original);
}
const weird=structuredClone(normalized);weird.name='值: null # 示例';assert.deepEqual(F.parseScene(F.stringifyScene(weird),'weird.yml'),weird);
const convert=cp.spawnSync(process.execPath,['scripts/convert-scene.js',path],{encoding:'utf8'});assert.equal(convert.status,0,convert.stderr);assert.deepEqual(JSON.parse(convert.stdout),normalized);
const check=cp.spawnSync(process.execPath,['scripts/check-scene.js',path],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout).sceneName,normalized.name);
const run=cp.spawnSync(process.execPath,['scripts/run-scene.js',path,'42','1000','none'],{encoding:'utf8',maxBuffer:10*1024*1024});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).status,'completed');
console.log('YAML scene parsing, rejection, conversion and simulation passed');
