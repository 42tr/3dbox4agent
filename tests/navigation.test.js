'use strict';
const assert=require('node:assert/strict');const Nav=require('../src/navigation');const E=require('../src/engine');
const wall=[{x:40,y:30,w:20,h:40}];const start=[10,50],target=[90,50];assert(!Nav.clearSegment(start,target,wall));const path=Nav.plan(start,target,wall);assert(path&&path.length>1);let from=start;for(const p of path){assert(Nav.clearSegment(from,p,wall));from=p}assert.deepEqual(path.at(-1),target);assert.equal(Nav.plan(start,[50,50],wall),null);
for(let seed=0;seed<30;seed++){
 const s=E.create(seed);while(!s.done&&s.tick<1000){const before=s.agents.map(a=>({id:a.id,x:a.x,y:a.y,role:a.role}));E.step(s);for(const a of s.agents){const b=before.find(v=>v.id===a.id);if(a.role!=='drone')assert(Nav.clearSegment([b.x,b.y],[a.x,a.y],s.obstacles),`seed=${seed} agent=${a.id} tick=${s.tick}`)}if(seed%2===0&&s.tick===4)E.fault(s)}assert(s.done&&!s.failed,`seed ${seed} failed`);
}
const scene=structuredClone(E.scene);scene.tasks=[{...scene.tasks.find(t=>t.id==='deliver'),target:[70,20],dependsOn:[]}];let s=E.create(42,'nearest',scene);assert.equal(E.assign(s,'deliver','vehicle-1').reason,'unreachable_target');E.step(s);assert(s.done&&s.failed);
const near=[{x:40,y:40,w:10,h:10}],nearStart=[37.9,45],nearEnd=[55,45];assert(Nav.free(...nearStart,near));assert(!Nav.free(38,46,near));const nearRoute=Nav.plan(nearStart,nearEnd,near);assert(nearRoute);let previous=nearStart;for(const point of nearRoute){assert(Nav.clearSegment(previous,point,near));previous=point}assert.deepEqual(nearRoute.at(-1),nearEnd);
console.log('navigation tests passed');
