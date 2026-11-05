'use strict';
const E=require('../src/engine');
function fixture(){const scene=JSON.parse(JSON.stringify(E.scene));scene.id='field-rescue-test';scene.name='Field rescue';scene.obstacles=[];scene.terrain=[];scene.riskZones=[];scene.agents=[{role:'worker',label:'Worker',count:1,mobility:'ground',capabilities:['inspect'],speed:3,recoverableFault:true},{role:'rescuer',label:'Rescuer',count:2,mobility:'ground',capabilities:['rescue'],rescue:{workTicks:6},speed:3}];scene.tasks=[{id:'survey',name:'Survey',behavior:'survey',role:'worker',capability:'inspect',target:[80,40],duration:50,dependsOn:[]}];return scene}
function intent(world,type,more={},requestId=type+'-'+world.actions.length){return {requestId,type,...(type==='rescue'?{faultGeneration:world.agents.find(a=>a.id===more.targetAgentId)?.faultGeneration}:{}),targetTick:world.tick+1,expiresTick:world.tick+60,...more}}
module.exports={fixture,intent};
