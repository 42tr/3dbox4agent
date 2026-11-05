'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine'),Rules=require('../server/rust-task-rules');
function pair(scene=E.scene,opts={dispatchMode:'external'}){const a=E.create(42,'nearest',scene,opts),b=E.create(42,'nearest',scene,opts);E.bindTaskRules(b,Rules);return [a,b]}
function step(worlds){worlds.forEach(s=>E.step(s));assert.deepEqual(E.snapshot(worlds[1]),E.snapshot(worlds[0]));return worlds[0]}
// No candidate, temporary road closure, then failure on expiry.
{const worlds=pair();for(const s of worlds){for(const a of s.agents){a.disabled=true;a.status='fault'}assert(E.injectRoadblock(s,{x:0,y:0,w:2,h:2},2).ok)}assert(!step(worlds).done);assert(!step(worlds).done);const s=step(worlds);assert(s.done&&s.failed);assert(s.events.some(e=>e.kind==='run_failed'))}
// A reachable low-energy device can wait and later charge and complete its tasks.
{const scene=E.getScene();scene.agents.find(a=>a.role==='drone').count=1;const worlds=pair(scene,{dispatchMode:'rule'});for(const s of worlds)assert(E.injectLowEnergy(s,'drone-1',5).ok);for(let i=0;i<3;i++){const s=step(worlds);assert(!s.done&&s.chargeRecovery.agentIds.includes('drone-1'))}for(const s of worlds)assert(E.submitAction(s,'drone-1',{requestId:'recover',type:'charge',targetTick:s.tick+1,expiresTick:s.tick+30}).ok);while(!worlds[0].done&&worlds[0].tick<1000)step(worlds);assert(worlds[0].done&&!worlds[0].failed);assert(worlds[0].events.some(e=>e.kind==='charge_recovery_wait_ended'))}
// Pending actions prevent early failure, while completed tasks end the world first.
{const worlds=pair();for(const s of worlds){assert(E.submitAction(s,'drone-1',{requestId:'later',type:'scan',targetTick:5,expiresTick:10}).ok);for(const a of s.agents){a.disabled=true;a.status='fault'}}assert(!step(worlds).done);for(const s of worlds)for(const t of s.tasks)t.status='done';const s=step(worlds);assert(s.done&&!s.failed);assert(s.actions.some(a=>a.requestId==='later'&&a.status==='cancelled'))}
for(const termination of [()=>{throw Error('native termination failure')},()=>({})]){const s=E.create(42,'nearest',E.scene,{dispatchMode:'external'});E.bindTaskRules(s,{...Rules,termination});assert.throws(()=>E.step(s),/native termination failure|invalid native termination result/)}
console.log('Rust world termination, charge and roadblock recovery parity passed');
