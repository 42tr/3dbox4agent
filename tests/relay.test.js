'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),D=require('../src/relay'),{fixture}=require('./relay-support');
for(const value of [null,{},[],{deployed:0},{deployed:false,taskId:null},{deployed:true},{deployed:true,taskId:'x',assignmentId:1,deployedTick:1,position:[1,2],extra:1},{deployed:true,taskId:'__proto__',assignmentId:1,deployedTick:1,position:[1,2]}])assert.throws(()=>D.state(value));
assert.deepEqual(D.initial(),{deployed:false});assert(D.state({deployed:true,taskId:'deploy',assignmentId:1,deployedTick:1,position:[0,100]}));
for(const change of [a=>a.deployableRelay=false,a=>a.deployableRelay=null,a=>a.capabilities=[],a=>a.mobility='air']){const s=fixture();change(s.agents[0]);assert.throws(()=>E.create(42,'nearest',s))}
for(const change of [s=>s.tasks[0].capability='inspect',s=>delete s.agents[0].deployableRelay]){const s=fixture();change(s);assert.throws(()=>E.create(42,'nearest',s))}
const s=E.create(42,'nearest',fixture(),{dispatchMode:'external'});assert(!D.ready(s.agents[0]));assert(D.ready(s.agents[1]));assert.deepEqual(E.assign(s,'deploy','worker-1'),{ok:false,reason:'missing_capability'});assert(!Object.hasOwn(E.observe(s,'worker-1').self,'relayState'));assert.deepEqual(E.observe(s,'relay-1').self.relayState,{deployed:false});
for(const id of ['industrial-park-v1','lunar-outpost-v1','lunar-materials-v1']){const w=E.create(42,'nearest',E.getScene(id));assert(w.agents.every(a=>!Object.hasOwn(a,'relayState')&&!Object.hasOwn(a,'deployableRelay')));assert(!Object.hasOwn(E.observe(w,w.agents[0].id).self,'relayState'))}
console.log('Relay model: strict ground relay profile and provenance state, deployment capability, own-only observation, unchanged legacy relay semantics and no legacy extension passed');
