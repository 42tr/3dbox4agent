'use strict';
const assert=require('node:assert/strict'),E=require('../src/engine');
(async()=>{
 const THREE=await import('three'),{updateRouteGeometry}=await import('../src/route-geometry.mjs'),line=new THREE.Line(new THREE.BufferGeometry());
 const original=console.warn,warnings=[];console.warn=(...args)=>warnings.push(args);
 try{
  const shapes=[[[0,0,0],[1,0,1]],[[100,0,100],[100,0,90],[90,0,90],[90,0,80],[80,0,80]],[[0,0,0],[2,0,2]],[[50,0,50],[60,0,60]]];let replaced=0;
  for(const shape of shapes){const previous=line.geometry,oldCount=previous.getAttribute('position')?.count;let disposed=0;previous.addEventListener('dispose',()=>disposed++);const points=shape.map(p=>new THREE.Vector3(...p));updateRouteGeometry(line,points);assert.equal(disposed,oldCount===points.length?0:1);if(disposed)replaced++;assert.equal(line.geometry.getAttribute('position').count,points.length);assert.equal(line.geometry.drawRange.count,points.length);assert.deepEqual([...line.geometry.getAttribute('position').array],shape.flat());for(const point of points)assert(line.geometry.boundingSphere.containsPoint(point));}
  assert.equal(replaced,3);assert(line.geometry.boundingSphere.radius<8,'old route must not inflate or move the new bounds');
  const world=E.create(42,'nearest',E.getScene('lunar-outpost-v1'));let counts=new Set(),frames=0;
  while(!world.done&&world.tick<1000){if(world.tick===3)E.fault(world);E.step(world);const moving=world.agents.find(a=>(a.status==='working'||a.status==='manual')&&a.route.length);if(!moving)continue;const points=[[moving.x,moving.y],...moving.route].map(p=>new THREE.Vector3(p[0]-50,.3,p[1]-50));updateRouteGeometry(line,points);counts.add(points.length);frames++;assert.equal(line.geometry.drawRange.count,points.length);assert.equal(line.geometry.getAttribute('position').count,points.length);const last=new THREE.Vector3().fromBufferAttribute(line.geometry.getAttribute('position'),points.length-1);assert(last.distanceTo(points.at(-1))<1e-4)}
  assert(world.done&&frames>50&&counts.size>1);assert.deepEqual(warnings,[]);
 }finally{console.warn=original;line.geometry.dispose();line.material.dispose()}
 console.log('Actual Three route growth/shrinkage, disposal, vertex coverage, bounds and faulted mission paths passed without warnings');
})().catch(error=>{console.error(error);process.exitCode=1});
