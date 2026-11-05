'use strict';const assert=require('node:assert/strict');const P=require('../server/physics');
(async()=>{await P.initialize();const state={obstacles:[{x:4,y:0,w:2,h:8,height:8}],agents:[{id:'ground-1',role:'vehicle',x:1,y:4},{id:'ground-2',role:'vehicle',x:1,y:15},{id:'drone-1',role:'drone',x:1,y:4}]};const p=P.createPhysics(state);
 try{let blocked=p.move(state.agents[0],8,0);assert(blocked.contacts>0);assert(blocked.x<2.3);let air=p.move(state.agents[2],8,0);assert(Math.abs(air.x-8)<.01);let free=p.move(state.agents[1],2,0);assert(Math.abs(free.x-2)<.01);console.log('Rapier collision spike passed')}finally{p.free()}
})().catch(e=>{console.error(e);process.exitCode=1});
