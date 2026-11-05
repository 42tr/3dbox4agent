'use strict';
const E=require('../src/engine');
function fixture(relays=1){
 const s=E.getScene('lunar-outpost-v1');s.id='relay-lifecycle';s.obstacles=[];s.terrain=[];s.riskZones=[];
 s.agents=[{role:'relay',label:'Relay',count:relays,mobility:'ground',deployableRelay:true,capabilities:['relay'],speed:1.4},{role:'worker',label:'Worker',count:2,mobility:'ground',capabilities:['inspect'],speed:3}];
 const w=E.create(42,'nearest',s),a=w.agents.filter(a=>a.role==='worker'),target=[(a[0].x+a[1].x)/2,(a[0].y+a[1].y)/2];
 s.communication={range:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)/2+3,delay:2,ttl:40,maxPerTick:4,maxBytes:256,lossRate:0};
 s.materials=[{id:'kit',name:'Relay kit',quantity:1}];
 s.tasks=[{id:'deploy',name:'Deploy relay',behavior:'deploy',role:'relay',capability:'relay',target,duration:3,dependsOn:[],materialCost:[{id:'kit',amount:1}]},{id:'hold',name:'Pending work',behavior:'survey',role:'worker',capability:'inspect',target:[a[0].x,a[0].y],duration:30,dependsOn:[]}];
 return s;
}
module.exports={fixture};
