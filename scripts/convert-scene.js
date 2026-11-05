'use strict';
const fs=require('node:fs'),E=require('../src/engine'),F=require('../src/scene-format');
try{
 const args=process.argv.slice(2);if(args.length!==1)throw Error('usage: node scripts/convert-scene.js <scene.yaml|scene.json>');
 const raw=fs.readFileSync(args[0]);if(raw.length>60000)throw Error('scene exceeds 60 KB');
 const scene=E.normalizeScene(F.parseScene(new TextDecoder('utf-8',{fatal:true}).decode(raw),args[0]));
 if(Buffer.byteLength(JSON.stringify(scene))>60000)throw Error('normalized scene exceeds 60 KB');
 E.create(42,'nearest',scene);
 process.stdout.write(JSON.stringify(scene,null,2)+'\n');
}catch(error){console.error(error.message);process.exitCode=1}
