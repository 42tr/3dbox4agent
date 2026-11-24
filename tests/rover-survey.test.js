'use strict';

const assert = require('node:assert/strict');
const E = require('../packages/world/src/world-core');
const {deviceSnapshot} = require('../packages/world/src/device-telemetry');
const {validateArchive} = require('../packages/world/src/replay');

function scenario(taskCount=1) {
  const scene=E.getScene('lunar-materials-v1');
  const rover=scene.agents.find(a=>a.role==='rover');
  scene.agents=[{...rover,count:2,spawnArea:{x:10,y:20,w:2,h:8}}];
  scene.obstacles=[{id:'wall',x:22,y:5,w:3,h:60,height:6}];
  scene.terrain=[];
  scene.heightfield={rows:2,cols:2,heights:[0,2,1,3],maxSlopeDegrees:20};
  scene.communication={...scene.communication,lossRate:0,delay:2};
  scene.materials=[{id:'sample-case',name:'采样容器',quantity:taskCount}];
  const sample=scene.tasks.find(t=>t.id==='sample');
  scene.tasks=Array.from({length:taskCount},(_,index)=>({...sample,id:`sample-${index+1}`,
    target:index? [16,22]:[17,22],duration:4,dependsOn:[]}));
  const world=E.create(42,'nearest',scene,{dispatchMode:'external',executionMode:'primitive'});
  const rover1=world.agents.find(a=>a.id==='rover-1');
  let sequence=0;
  const step=times=>{for(let i=0;i<times;i++)E.step(world)};
  const device=(id=rover1.id)=>deviceSnapshot(E.snapshot(world),null,E.observe(world,id),{roverSurvey:true,taskOperations:true});
  const submit=(action,id=rover1.id)=>{
    const command={requestId:`rover-${++sequence}`,targetTick:world.tick+1,expiresTick:world.tick+10,...action};
    const receipt=E.submitAction(world,id,command);
    assert(receipt.ok,JSON.stringify(receipt));
    return command;
  };
  const result=command=>world.actions.find(action=>action.requestId===command.requestId);
  const run=(action,id=rover1.id)=>{
    const command=submit(action,id);
    for(let i=0;i<60&&['pending','accepted'].includes(result(command).status);i++)step(1);
    return result(command);
  };
  return {scene,world,rover1,step,submit,result,run,device};
}

{
  const {scene,world,rover1,step,submit,result,run,device}=scenario();
  const survey={mode:'terrain_scan',bearingDeg:90,radiusM:20};
  const command=submit({type:'scan',survey});
  assert(E.submitAction(world,rover1.id,command).duplicate);
  assert.equal(E.submitAction(world,rover1.id,{...command,survey:{...survey,bearingDeg:30}}).reason,'request_id_conflict');
  assert.equal(E.submitAction(world,rover1.id,{...command,requestId:'bad',survey:{...survey,radiusM:31}}).reason,'invalid_action');
  step(2);
  assert.equal(result(command).status,'accepted');
  assert.equal(result(command).result,undefined);
  step(1);
  const scan=result(command);
  assert.equal(scan.result.kind,'terrain_scan');
  assert(scan.result.points.length>4);
  assert(scan.result.points.every(p=>p.position[0]<22&&p.elevationM>0&&p.slopeDeg>0));
  assert.equal(E.submitEvidence(world,rover1.id,{requestId:'scan-report',scanRequestId:scan.requestId}).reason,'scan_not_available');
  assert.equal(device('rover-2').actions.length,0);
  const markable=device().availableActions.find(a=>a.name==='mark_access_point');
  assert(markable.available);
  const {scanRequestId,pointIndices}=markable.parameters.survey;
  const pointIndex=pointIndices.find(i=>scan.result.points[i].position[0]>18&&scan.result.points[i].position[1]===rover1.y);
  assert(Number.isInteger(pointIndex));
  const mark={type:'scan',survey:{mode:'mark_access_point',scanRequestId,pointIndex}};
  assert.equal(run(mark,'rover-2').reason,'survey_point_unavailable');
  const marked=run(mark);
  assert.equal(marked.result.kind,'access_point');
  assert.deepEqual(marked.result.position,scan.result.points[pointIndex].position);
  assert(E.injectRoadblock(world,{x:15,y:rover1.y-1,w:2,h:2},6).ok);
  assert.equal(run(mark).reason,'survey_point_blocked');
  step(30);
  assert.equal(run(mark).result.kind,'access_point');

  const taskId='sample-1', work={type:'work_task',taskId,operation:'collect_sample'};
  assert(E.assign(world,taskId,rover1.id).ok);
  assert.equal(run(work).reason,'out_of_reach');
  const target=world.tasks[0].target;
  assert.equal(run({type:'move',target:{x:target[0],y:target[1]}}).status,'completed');
  const task=E.observe(world,rover1.id).assignedTasks[0];
  assert(task.withinReach);
  assert.equal(task.workOperation.durationTicks,4);
  assert.equal(task.workOperation.operation,'collect_sample');
  const interrupted=submit(work);
  step(1);
  assert(E.cancelAction(world,rover1.id,interrupted.requestId).ok);
  assert.equal(device().sampleStorage.used,0);
  assert.equal(world.materials.stock[0].remaining,1);
  const collected=run(work);
  assert.equal(collected.result.sampleId,taskId);
  assert.deepEqual(collected.result.position,target);
  assert.equal(collected.progress,4);
  assert.deepEqual(device().sampleStorage,{capacity:4,used:1,available:3});
  assert.equal(world.materials.stock[0].remaining,0);
  assert.equal(device().samples[0].taskId,taskId);
  assert.equal(device('rover-2').samples.length,0);
  assert(!world.done);
  const report={requestId:'sample-report',taskId};
  assert.equal(E.submitSampleReport(world,'rover-2',report).reason,'sample_not_available');
  assert.equal(E.submitSampleReport(world,rover1.id,report).report.status,'pending');
  step(1);
  assert.equal(E.coordinatorObservation(world).sampleReports.length,0);
  step(1);
  assert.equal(E.coordinatorObservation(world).sampleReports[0].taskId,taskId);
  assert(world.done);
  const archive={format:'3dbox-prototype-v1',config:{seed:42,policy:'nearest',scene},frames:[E.snapshot(world)]};
  assert(validateArchive(archive));
  const tampered=structuredClone(archive);
  tampered.frames[0].actions.find(a=>a.requestId===marked.requestId).result.position=[0,0];
  assert.throws(()=>validateArchive(tampered));
}

{
  const {world,rover1,run,device}=scenario(5);
  assert.equal(run({type:'move',target:{x:16,y:22}}).status,'completed');
  for(let i=1;i<=4;i++){
    const taskId=`sample-${i}`;
    assert(E.assign(world,taskId,rover1.id).ok);
    assert.equal(run({type:'work_task',taskId,...(i!==4?{operation:'collect_sample'}:{})}).status,'completed');
  }
  assert.equal(device().sampleStorage.available,0);
  assert.equal(E.assign(world,'sample-5',rover1.id).reason,'sample_slots_full');
  assert.deepEqual(E.dispatchObservation(world,world.tasks[4]).candidates.map(a=>a.id),['rover-2']);
  assert(E.assign(world,'sample-5','rover-2').ok);
}

for(const submitLate of [false,true]){
  const {world,rover1,run,step}=scenario();
  const taskId='sample-1';
  assert(E.assign(world,taskId,rover1.id).ok);
  assert.equal(run({type:'move',target:{x:17,y:22}}).status,'completed');
  assert.equal(run({type:'work_task',taskId,operation:'collect_sample'}).status,'completed');
  step(119);
  assert(!world.done);
  if(submitLate)assert(E.submitSampleReport(world,rover1.id,{requestId:'late',taskId}).ok);
  step(1);
  assert.equal(world.done,!submitLate);
  if(submitLate){
    step(1);
    assert(world.done);
    assert.equal(world.sampleReports[0].status,'delivered');
  }
}

console.log('Rover survey, occlusion, access point validation, sample capacity, scoped reporting and replay passed');
