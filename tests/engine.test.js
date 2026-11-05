const assert=require('node:assert/strict');const E=require('../src/engine');
const fleet=E.create(42);assert.equal(fleet.agents.length,15);for(const role of ['drone','vehicle','robot'])assert.equal(fleet.agents.filter(a=>a.role===role).length,5);assert.equal(new Set(fleet.agents.map(a=>a.id)).size,15);
function run(seed,fail=false){const s=E.create(seed);while(!s.done&&s.tick<1000){E.step(s);if(fail&&s.tick===3)assert(E.fault(s));}return s}
const a=run(42,true),b=run(42,true);assert.deepEqual(a,b);assert.equal(a.tasks.filter(t=>t.status==='done').length,5);assert.equal(a.replans,1);assert(a.done);assert.notDeepEqual(E.create(42).agents,E.create(43).agents);assert.equal(E.fault(a),false);assert(run(8,false).done);console.log('engine tests passed');
const blocked=E.create(42);while(!blocked.done){E.step(blocked);if(blocked.tasks.some(t=>t.status==='active'))assert(E.fault(blocked));}assert(blocked.failed);assert(blocked.events.at(-1).message.includes('无法继续'));
