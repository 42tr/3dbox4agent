'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const E=require('../src/engine'),F=require('../src/scene-format');
try{
 const [path,seedText='42',maxText='1000',faultText='none']=process.argv.slice(2);
 if(!path)throw Error('usage: node scripts/run-scene.js <scene.json|scene.yaml> [seed] [maxTicks] [faultTick|none]');
 const raw=fs.readFileSync(path);if(raw.length>1024*1024)throw Error('scene exceeds 1 MiB');
 const scene=F.parseScene(new TextDecoder('utf-8',{fatal:true}).decode(raw),path),seed=Number(seedText),maxTicks=Number(maxText),faultTick=faultText==='none'?null:Number(faultText);
 if(!Number.isSafeInteger(maxTicks)||maxTicks<1||maxTicks>10000||faultTick!==null&&(!Number.isSafeInteger(faultTick)||faultTick<1||faultTick>maxTicks))throw Error('invalid maxTicks or faultTick');
 const world=E.create(seed,'nearest',scene);let faultAttempted=false,faultInjected=false;
 while(!world.done&&world.tick<maxTicks){E.step(world);if(world.tick===faultTick){faultAttempted=true;faultInjected=E.fault(world)}}
 const result={format:'3dbox-scene-run-v1',sceneSha256:crypto.createHash('sha256').update(raw).digest('hex'),scene,config:{seed,maxTicks,faultTick,physicsMode:'kinematic',policy:'nearest'},status:world.done?(world.failed?'failed':'completed'):'timeout',faultAttempted,faultInjected,metrics:E.metrics(world),events:world.events,finalState:E.snapshot(world)};
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){console.error(error.message);process.exitCode=1}
