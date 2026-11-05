'use strict';
const E=require('../src/engine');
function fixture(kind){
 if(['resident','pending','rescue'].includes(kind)){
  const s=require('./fleet-fault-support').fixture();s.id='operating-'+kind;s.communication.delay=1;s.agents.find(a=>a.role===(kind==='resident'?'relay':kind==='rescue'?'rescuer':'endpoint')).operatingEnergyPerTick=kind==='resident'?.5:5;return s;
 }
 if(kind==='construction'){
  const s=require('./construction-support').fixture();s.agents[0].operatingEnergyPerTick=5;s.agents[0].moveEnergyPerUnit=.001;s.agents[0].workEnergyPerTick=.001;s.agents[0].recoverableFault=true;s.tasks[0].duration=100;return s;
 }
 const s=E.getScene('lunar-outpost-v1');s.id='operating-'+kind;s.obstacles=[];s.terrain=[];s.riskZones=[];
 const cargo=kind==='cargo',rate=kind==='charge-gain'?1:kind==='charge-loss'?3:kind==='thermal'?1:5;
 s.agents=[{role:cargo?'vehicle':'worker',label:'Powered device',count:1,mobility:'ground',speed:3,capabilities:[cargo?'deliver':'inspect'],operatingEnergyPerTick:rate,moveEnergyPerUnit:.001,workEnergyPerTick:.001,recoverableFault:true},{role:'monitor',label:'Monitor',count:1,mobility:'ground',speed:3,capabilities:['monitor']}];
 if(kind==='thermal')s.agents[0].thermal={ambientC:-20,initialC:55,limitC:55,resumeC:30,coolingCPerTick:1.2,heatCPerEnergy:30};
 s.tasks=[{id:cargo?'deliver':'work',name:'Long operation',role:cargo?'vehicle':'worker',capability:cargo?'deliver':'inspect',behavior:cargo?'deliver':'survey',target:[90,90],duration:100,dependsOn:[]},{id:'hold',name:'Monitoring',role:'monitor',capability:'monitor',behavior:'survey',target:[10,10],duration:1000,dependsOn:[]}];
 const probe=E.create(42,'nearest',s);s.resource.warehouse=[probe.agents[0].x,probe.agents[0].y];s.resource.site=[90,90];return s;
}
module.exports={fixture};
