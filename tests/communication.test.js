'use strict';
const assert=require('node:assert/strict');const E=require('../src/engine');
function world(overrides={}){const scene=structuredClone(E.scene);Object.assign(scene.communication,overrides);return E.create(42,'nearest',scene)}
const a='drone-1',b='drone-2';let s=world({lossRate:0,range:100});
assert.equal(E.sendMessage(s,a,a,'x').reason,'same_agent');assert.equal(E.sendMessage(s,a,b,'').reason,'invalid_message');assert.equal(E.sendMessage(s,a,b,'中'.repeat(86)).reason,'invalid_message');assert(E.sendMessage(s,a,b,'状态正常').ok);assert.equal(E.observe(s,b).inbox.length,0);E.step(s);E.step(s);assert.equal(E.observe(s,b).inbox.length,0);E.step(s);let inbox=E.observe(s,b).inbox;assert.equal(inbox.length,1);assert.equal(inbox[0].text,'状态正常');assert.equal(inbox[0].sentTick,0);assert.equal(inbox[0].receivedTick,3);assert.equal(E.observe(s,a).inbox.length,0);inbox[0].text='changed';assert.equal(E.observe(s,b).inbox[0].text,'状态正常');
s=world({lossRate:1,range:100});E.sendMessage(s,a,b,'x');for(let i=0;i<3;i++)E.step(s);assert.equal(s.events.find(e=>e.kind==='message_failed').reason,'dropped');assert.equal(E.observe(s,b).inbox.length,0);
s=world({lossRate:0,range:.1});E.sendMessage(s,a,b,'x');for(let i=0;i<3;i++)E.step(s);assert.equal(s.events.find(e=>e.kind==='message_failed').reason,'out_of_range');
s=world({lossRate:0,range:100,ttl:1,delay:3});E.sendMessage(s,a,b,'x');for(let i=0;i<2;i++)E.step(s);assert.equal(s.events.find(e=>e.kind==='message_failed').reason,'expired');
s=world({lossRate:0,range:100});E.sendMessage(s,a,b,'x');s.agents.find(x=>x.id===b).disabled=true;for(let i=0;i<3;i++)E.step(s);assert.equal(s.events.find(e=>e.kind==='message_failed').reason,'unavailable');
s=world();for(let i=0;i<4;i++)assert(E.sendMessage(s,a,b,'x').ok);assert.equal(E.sendMessage(s,a,b,'x').reason,'rate_limit');E.step(s);assert(E.sendMessage(s,a,b,'x').ok);
function repeat(){const w=world();E.sendMessage(w,a,b,'same');for(let i=0;i<3;i++)E.step(w);return w}assert.deepEqual(repeat(),repeat());
console.log('communication tests passed');
