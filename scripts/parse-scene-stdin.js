'use strict';
// A bounded, data-only parser bridge for Python experiment runners.
const fs=require('node:fs'),F=require('../src/scene-format');
try{
 const data=fs.readFileSync(0);if(data.length>60000)throw Error('scene file exceeds 60 KB');
 const format=process.argv[2]==='json'?'scene.json':'scene.yaml';
 const value=F.parseScene(new TextDecoder('utf-8',{fatal:true}).decode(data),format);
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('scene must be an object');
 const out=JSON.stringify(value);if(Buffer.byteLength(out)>60000)throw Error('scene content exceeds 60 KB');
 process.stdout.write(out);
}catch(error){console.error(error.message);process.exitCode=1}
