'use strict';
const X=require('../src/experiments');
// Usage: node scripts/run-experiments.js [count] [startSeed] [faultTick|none] [maxTicks]
try{const [count='20',startSeed='0',faultTick='none',maxTicks='1000']=process.argv.slice(2);const config={count:Number(count),startSeed:Number(startSeed),faultTick:faultTick==='none'?null:Number(faultTick),maxTicks:Number(maxTicks),policies:['nearest','battery']};process.stdout.write(JSON.stringify(X.runBatch(config),null,2)+'\n')}catch(e){console.error(e.message);process.exitCode=1}
