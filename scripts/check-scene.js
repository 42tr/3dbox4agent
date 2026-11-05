'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),D=require('../src/scene-diagnostics'),F=require('../src/scene-format');
try{
 const args=process.argv.slice(2),strict=args.includes('--strict'),paths=args.filter(x=>x!=='--strict');
 if(paths.length!==1||args.filter(x=>x==='--strict').length>1)throw Error('usage: node scripts/check-scene.js <scene.json|scene.yaml> [--strict]');
 const fd=fs.openSync(paths[0],'r');let data;try{const buffer=Buffer.alloc(60*1024+1);let size=0,n;while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;if(size>60*1024)throw Error('scene exceeds 60 KiB');data=buffer.subarray(0,size)}finally{fs.closeSync(fd)}
 const scene=F.parseScene(new TextDecoder('utf-8',{fatal:true}).decode(data),paths[0]),result=D.analyze(scene);
 process.stdout.write(JSON.stringify({format:'3dbox-scene-diagnostics-v1',sceneFileSha256:crypto.createHash('sha256').update(data).digest('hex'),...result,warnings:result.warnings.map(w=>({...w,message:D.describe(w)}))},null,2)+'\n');
 if(strict&&result.warnings.length)process.exitCode=2;
}catch(error){console.error(error.message);process.exitCode=1}
