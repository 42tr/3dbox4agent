'use strict';
const assert=require('node:assert/strict');
const Display=require('../src/planner-report');
function run(algorithm,seed,status,ticks,energy){return {seed,status,faultInjected:true,config:{algorithm,seed,sceneId:'industrial-park-parallel-v1',faultTick:3,maxTicks:100,dispatchMode:'external'},metrics:{ticks,distance:10,energyUsed:energy}}}
const report={format:'3dbox-planner-comparison-v1',config:{count:2,startSeed:42,sceneId:'industrial-park-parallel-v1',faultTick:3,maxTicks:100,dispatchMode:'external',physicsMode:'kinematic'},pairs:[{seed:42,nearest:run('nearest',42,'completed',20,5),planner:run('planner',42,'completed',17,6)},{seed:43,nearest:run('nearest',43,'timeout',100,10),planner:run('planner',43,'completed',30,8)}]};
let result=Display.summarize(report);assert.equal(result.bothCompleted,1);assert.equal(result.completionTickDifference.mean,-3);assert.equal(result.energyDifference.mean,-.5);assert.equal(result.groups[0].timedOut,1);
for(const mutate of [x=>x.pairs[0].planner.seed=99,x=>x.pairs[0].nearest.metrics.ticks=NaN,x=>x.config.sceneId='<script>',x=>x.pairs[1].planner.config.algorithm='nearest',x=>x.config.count=3]){const copy=structuredClone(report);mutate(copy);assert.throws(()=>Display.summarize(copy))}
console.log('planner comparison report tests passed');
