import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import regolith from '../assets/mission-control/regolith-codex-20261102.png';
import dome from '../assets/mission-control/kenney-space-kit/hangar-rounda.glb';
import greenhouse from '../assets/mission-control/kenney-space-kit/hangar-roundglass.glb';
import hangar from '../assets/mission-control/kenney-space-kit/hangar-largea.glb';
import corridor from '../assets/mission-control/kenney-space-kit/corridor.glb';
import generator from '../assets/mission-control/kenney-space-kit/machine-generatorlarge.glb';
import dish from '../assets/mission-control/kenney-space-kit/satellitedish-detailed.glb';
import scout from '../assets/mission-control/codex-outpost/scout-rover.glb';
import cargo from '../assets/mission-control/codex-outpost/cargo-carrier.glb';
import service from '../assets/mission-control/codex-outpost/service-robot.glb';
import powerUnit from '../assets/mission-control/codex-outpost/power-unit.glb';
import commsDish from '../assets/mission-control/codex-outpost/comms-dish.glb';
import rock from '../assets/mission-control/kenney-space-kit/rock-largea.glb';
import crater from '../assets/mission-control/kenney-space-kit/craterlarge.glb';
// These meshes are a presentation layer. Collision and navigation use the snapshot's
// documented simplified obstacles, never the decorative glTF mesh geometry.
export function createLunarEnvironment(scene,renderer){
 const root=new THREE.Group();root.name='Lunar outpost / snapshot presentation';root.visible=false;scene.add(root);
 const scenery=new THREE.Group();root.add(scenery);const loader=new GLTFLoader(),models={},pending=[];
 const palette={metal:0xd9d6c9,metalRed:0xb3b3ac,metalDark:0x818482,dark:0x343638,rock:0x8d7964,rockDark:0x6c5b49,rockTrack:0xa38d72};
 const ready=Promise.all(Object.entries({dome,greenhouse,hangar,corridor,generator,dish,scout,cargo,service,powerUnit,commsDish,rock,crater}).map(async([name,url])=>{const gltf=await loader.loadAsync(url);gltf.scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;o.geometry.userData.sharedLunarAsset=true;const materials=Array.isArray(o.material)?o.material:[o.material];for(const m of materials){if(!['scout','cargo','service','powerUnit','commsDish'].includes(name)){m.metalness=.08;m.roughness=.82}if(palette[m.name])m.color.setHex(palette[m.name]);if(m.name==='_defaultMat')m.color.setHex(0x87908d);m.needsUpdate=true}}});models[name]=gltf.scene;return name})).then(()=>{for(const job of pending.splice(0))job();renderer.domElement.dataset.assets='ready';window.dispatchEvent(new Event('sandbox-lunar-assets-ready'))}).catch(error=>{renderer.domElement.dataset.assets='failed';console.error('Lunar glTF assets:',error)});
 function model(name,width,x,z,rotation=0,depth,height){const holder=new THREE.Group();holder.position.set(x,0,z);holder.rotation.y=rotation;scenery.add(holder);const load=()=>{if(!holder.parent)return;const obj=models[name].clone(true),bounds=new THREE.Box3().setFromObject(obj),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),factor=width/size.x;obj.position.set(-center.x,-bounds.min.y,-center.z);const pivot=new THREE.Group();pivot.add(obj);pivot.scale.set(factor,height?height/size.y:factor,depth?depth/size.z:factor);holder.add(pivot)};if(models[name])load();else pending.push(load);return holder}
 const texture=new THREE.TextureLoader().load(regolith);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(14,14);texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
 const groundMaterial=new THREE.MeshStandardMaterial({map:texture,color:0xb9c1c8,roughness:1,bumpMap:texture,bumpScale:.18});
 const terrainGeometry=new THREE.PlaneGeometry(420,420,100,100);terrainGeometry.rotateX(-Math.PI/2);const positions=terrainGeometry.attributes.position;
 for(let i=0;i<positions.count;i++){const x=positions.getX(i),z=positions.getZ(i),r=Math.hypot(x,z),edge=THREE.MathUtils.smoothstep(r,62,135);positions.setY(i,-.12+edge*(8+8*Math.sin(x*.022+z*.011)+5*Math.cos(z*.036-x*.014)))}terrainGeometry.computeVertexNormals();
 const terrain=new THREE.Mesh(terrainGeometry,groundMaterial);terrain.receiveShadow=true;root.add(terrain);
 let activeField=null;const elevation=window.SandboxElevation;
 const facilityObjects=new Map();
 let mountedKey='';const base=new THREE.Group();root.add(base);
 const solarMat=new THREE.MeshStandardMaterial({color:0x263047,metalness:.45,roughness:.55}),frameMat=new THREE.MeshStandardMaterial({color:0x8f9290,metalness:.4,roughness:.65}),lampMat=new THREE.MeshStandardMaterial({color:0xc5cbc4,emissive:0xa7a686,emissiveIntensity:.25});
 function box(parent,w,h,d,material,x,y,z){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m}
 function solarArray(x,z,w,d){const group=new THREE.Group();group.position.set(x,0,z);base.add(group);
  for(let row=0;row<2;row++)for(let col=0;col<5;col++){const gx=(col-2)*w/5,gz=(row-.5)*d/2,pw=w/5-.24,pd=d/2-.5;box(group,.16,1.8,.16,frameMat,gx,.9,gz);const module=new THREE.Group();module.position.set(gx,1.9,gz);module.rotation.x=-.25;group.add(module);box(module,pw,.12,pd,frameMat,0,0,0);box(module,pw-.12,.06,pd-.12,solarMat,0,.09,0);
   for(let n=1;n<4;n++)box(module,.025,.02,pd-.12,frameMat,(n/4-.5)*(pw-.12),.13,0);
   for(let n=1;n<6;n++)box(module,pw-.12,.02,.025,frameMat,0,.13,(n/6-.5)*(pd-.12));
  }
 }

 
 const habitatMaterial=new THREE.MeshStandardMaterial({color:0xe1dfd3,roughness:.78,metalness:.12,bumpMap:texture,bumpScale:.035}),seamMaterial=new THREE.MeshStandardMaterial({color:0x999b95,roughness:.7}),glassMaterial=new THREE.MeshStandardMaterial({color:0xbfc3bc,roughness:.46,metalness:.22});
 function habitat(x,z,w,d,height=7.5,detailed=false){const offset=detailed?-2:0;if(detailed)d-=6;const g=new THREE.Group();g.position.set(x,0,z+offset);base.add(g);const dome=new THREE.Mesh(new THREE.SphereGeometry(1,48,24,0,Math.PI*2,0,Math.PI/2),habitatMaterial);dome.scale.set(w*.5,height,d*.5);dome.castShadow=true;dome.receiveShadow=true;g.add(dome);const skirt=new THREE.Mesh(new THREE.CylinderGeometry(w*.5,w*.5,1.3,48),habitatMaterial);skirt.scale.z=d/w;skirt.position.y=.65;skirt.castShadow=true;g.add(skirt);for(let i=-1;i<=1;i++){const port=new THREE.Mesh(new THREE.BoxGeometry(2.5,1.25,.15),glassMaterial);port.position.set(i*3.4,3.2,d*.5*Math.sqrt(1-(i*3.4/(w*.5))**2));g.add(port)}const door=new THREE.Mesh(new THREE.CylinderGeometry(1.9,1.9,5,32),habitatMaterial);door.rotation.x=Math.PI/2;door.position.set(0,1.9,d*.5+1.2);door.castShadow=true;g.add(door);const cap=new THREE.Mesh(new THREE.CircleGeometry(1.65,32),seamMaterial);cap.position.set(0,1.9,d*.5+3.72);g.add(cap);box(g,1.5,.18,.7,seamMaterial,0,height+.12,0);
 if(detailed){
  for(let n=0;n<12;n++){const a=n*Math.PI/6,points=[];for(let i=0;i<=32;i++){const t=i*Math.PI/64;points.push(new THREE.Vector3(Math.sin(t)*Math.cos(a)*w*.503,Math.cos(t)*height+.015,Math.sin(t)*Math.sin(a)*d*.503))}tube(g,points,.028,seamMaterial)}
  for(const y of [2.1,4.4]){const r=Math.sqrt(1-(y/height)**2),ring=new THREE.Mesh(new THREE.TorusGeometry(1,.012,5,96),seamMaterial);ring.rotation.x=Math.PI/2;ring.scale.set(w*.5*r,d*.5*r,1);ring.position.y=y;g.add(ring)}
  for(let n=0;n<8;n++){const a=n*Math.PI/4;const port=new THREE.Mesh(new THREE.CylinderGeometry(.55,.55,.16,24),seamMaterial);port.rotation.x=Math.PI/2;port.rotation.z=-a;port.position.set(Math.sin(a)*w*.465,2.5,Math.cos(a)*d*.465);g.add(port)}
 }
 }

 const pebbleMaterial=new THREE.MeshStandardMaterial({color:0x91806a,roughness:1});
 const greenhouseMaterial=new THREE.MeshStandardMaterial({color:0xc1c5ba,roughness:.33,metalness:.12,transparent:true,opacity:.7,depthWrite:false,side:THREE.DoubleSide}),bedMaterial=new THREE.MeshStandardMaterial({color:0x726f58,roughness:1}),plantMaterial=new THREE.MeshStandardMaterial({color:0x637255,roughness:1});
 function greenhouseTube(x,z,w,length){
  const g=new THREE.Group();g.position.set(x,0,z);base.add(g);const radius=w/2;
  const roof=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,48,1,true,0,Math.PI),greenhouseMaterial);roof.rotation.z=Math.PI/2;roof.position.y=.2;g.add(roof);
  for(let i=0;i<8;i++){const hoop=new THREE.Mesh(new THREE.TorusGeometry(radius,.065,6,48,Math.PI),habitatMaterial);hoop.rotation.y=Math.PI/2;hoop.position.set((i/7-.5)*length,.2,0);g.add(hoop)}
  for(let i=1;i<6;i++){const a=i*Math.PI/6;tube(g,[new THREE.Vector3(-length/2,.2+Math.sin(a)*radius,Math.cos(a)*radius),new THREE.Vector3(length/2,.2+Math.sin(a)*radius,Math.cos(a)*radius)],.045,habitatMaterial)}
  box(g,length,.3,w,habitatMaterial,0,.15,0);
  for(const side of [-1,1]){
   const end=new THREE.Mesh(new THREE.CircleGeometry(radius,48,0,Math.PI),greenhouseMaterial);end.rotation.y=side*Math.PI/2;end.position.set(side*length/2,.2,0);g.add(end);
   box(g,length*.91,.18,w*.25,bedMaterial,0,.38,side*w*.23);
   for(let i=0;i<18;i++){const plant=new THREE.Mesh(new THREE.SphereGeometry(.23,7,5),plantMaterial);plant.scale.y=1.4;plant.position.set((i/17-.5)*length*.85,.67,side*w*.23);g.add(plant)}
  }
 }

 function tube(parent,points,radius,material){const curve=new THREE.CatmullRomCurve3(points),mesh=new THREE.Mesh(new THREE.TubeGeometry(curve,Math.max(12,points.length*2),radius,5,false),material);mesh.castShadow=true;parent.add(mesh);return mesh}
 function archedHangar(x,z,w,d,height){
  const g=new THREE.Group();g.position.set(x,0,z);base.add(g);
  // Open shell, rather than a solid box; its obstacle remains a conservative rectangle.
  const shape=new THREE.Shape();shape.absarc(0,0,w/2,0,Math.PI,false);shape.lineTo(-w/2+.3,0);shape.absarc(0,0,w/2-.3,Math.PI,0,true);shape.closePath();
  const shell=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:d,steps:1,bevelEnabled:false,curveSegments:48}),habitatMaterial);shell.scale.y=height/(w/2);shell.position.z=-d/2;shell.castShadow=true;shell.receiveShadow=true;g.add(shell);
  for(let n=0;n<7;n++){const points=[];for(let i=0;i<=32;i++){const a=i*Math.PI/32;points.push(new THREE.Vector3(Math.cos(a)*(w/2+.05),Math.sin(a)*(height+.05),(n/6-.5)*d))}tube(g,points,.055,seamMaterial)}
  box(g,w-.4,.1,d,new THREE.MeshStandardMaterial({color:0x495340,roughness:1}),0,.02,0);box(g,w-.6,height*.9,.2,new THREE.MeshStandardMaterial({color:0x20291f,roughness:1}),0,height*.45,-d/2+.1);
  for(const side of [-1,1])box(g,.2,.22,d+.4,frameMat,side*w/2,.1,0);
 }
 function outpostPad(x,z){
  const g=new THREE.Group();g.position.set(x,0,z);base.add(g);
  const pad=new THREE.Mesh(new THREE.CircleGeometry(17,96),new THREE.MeshStandardMaterial({color:0x8c8a7d,roughness:1}));pad.rotation.x=-Math.PI/2;pad.position.y=.01;pad.receiveShadow=true;g.add(pad);
  for(const [radius,color] of [[16.6,0xe1d4a5],[15.9,0xb7b5a7]]){const rim=new THREE.Mesh(new THREE.TorusGeometry(radius,.10,6,96),new THREE.MeshStandardMaterial({color,roughness:1}));rim.rotation.x=Math.PI/2;rim.position.y=.04;g.add(rim)}
  box(g,.6,.03,10,habitatMaterial,0,.05,0);box(g,6,.03,.6,habitatMaterial,0,.05,0);
  for(let i=0;i<12;i++){const a=i*Math.PI/6;const light=new THREE.Mesh(new THREE.SphereGeometry(.13,8,6),lampMat);light.position.set(Math.cos(a)*16.9,.15,Math.sin(a)*16.9);g.add(light)}
 }
 function mountOutpost(obstacles){
  for(const o of obstacles){const beforeBase=base.children.length,beforeScenery=scenery.children.length;const x=o.x+o.w/2-50,z=o.y+o.h/2-50;
   if(o.id==='habitat')habitat(x,z,o.w,o.h,o.height,true);
   else if(o.id==='hangar')archedHangar(x,z,o.w,o.h,o.height);
   else if(o.id==='greenhouse')greenhouseTube(x,z,o.h,o.w);
   else if(o.id==='warehouse'){const g=new THREE.Group();g.position.set(x,0,z);base.add(g);const body=new THREE.Mesh(new THREE.CylinderGeometry(o.w*.44,o.w*.44,o.h,48),habitatMaterial);body.rotation.x=Math.PI/2;body.position.y=o.height*.55;body.scale.z=o.height*.45/(o.w*.44);body.castShadow=true;body.receiveShadow=true;g.add(body);for(let i=0;i<6;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(o.w*.445,.065,6,48),seamMaterial);ring.scale.y=o.height*.45/(o.w*.44);ring.position.set(0,o.height*.55,(i/5-.5)*o.h);g.add(ring)}box(g,o.w*.7,.8,o.h,frameMat,0,.4,0);for(const side of [-1,1])box(g,o.w*.6,1.8,.2,seamMaterial,0,o.height*.55,side*o.h*.502)}
   else if(o.id==='power'){solarArray(x-o.w*.1,z-o.h*.25,o.w*.8,o.h*.48);solarArray(x+o.w*.1,z+o.h*.25,o.w*.8,o.h*.48)}
   else if(o.id==='generator')model('powerUnit',o.w,x,z,0,o.h,o.height);
   else if(o.id==='comms'){const dishModel=model('commsDish',o.w,x,z,-.15,o.h,o.height-1.5);dishModel.position.y=1.5;box(base,1.1,1.5,1.1,habitatMaterial,x,.75,z)}
   if(activeField){const top=elevation.bounds(activeField,o)[1];for(const object of [...base.children.slice(beforeBase),...scenery.children.slice(beforeScenery)])object.position.y+=top}
   facilityObjects.set(o.id,[...base.children.slice(beforeBase),...scenery.children.slice(beforeScenery)]);
  }
  outpostPad(21,54);if(activeField)base.children.at(-1).position.y=elevation.height(activeField,71,104);
  // Surface pebbles stay below wheel height and do not add simulation obstacles.
  const pebbleGeometry=new THREE.DodecahedronGeometry(1,0),pebbles=new THREE.InstancedMesh(pebbleGeometry,pebbleMaterial,90),transform=new THREE.Object3D();let count=0,seed=90491;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  for(let tries=0;count<90&&tries<1000;tries++){const x=4+random()*92,z=4+random()*92;if(obstacles.some(o=>x>o.x-2&&x<o.x+o.w+2&&z>o.y-2&&z<o.y+o.h+2))continue;const size=.16+random()*.28;transform.position.set(x-50,.03+elevation.height(activeField,x,z),z-50);transform.scale.set(size,.08+random()*.1,size*.7);transform.rotation.set(0,random()*Math.PI,0);transform.updateMatrix();pebbles.setMatrixAt(count++,transform.matrix)}pebbles.count=count;pebbles.receiveShadow=true;base.add(pebbles);
  // Reuse licensed glTF rocks at the perimeter; small surface pebbles are decorative.
  for(let i=0;i<23;i++){const angle=i*2.3999,radius=64+(i%5)*8;model('rock',.6+(i%4)*.45,Math.cos(angle)*radius,Math.sin(angle)*radius,angle)}
  for(const [x,z] of [[-27,-17],[-8,-22],[-3,8],[22,-10],[39,25]]){const pole=new THREE.Mesh(new THREE.CylinderGeometry(.075,.11,4.8,10),frameMat);pole.position.set(x,2.4+elevation.height(activeField,x+50,z+50),z);pole.castShadow=true;base.add(pole);box(base,.7,.18,.3,lampMat,x,4.8+elevation.height(activeField,x+50,z+50),z);tube(base,[new THREE.Vector3(x,.05+elevation.height(activeField,x+50,z+50),z),new THREE.Vector3(x*.7,.05+elevation.height(activeField,x*.7+50,z*.7+50),z*.7),new THREE.Vector3(4,.05+elevation.height(activeField,54,59),9)],.035,seamMaterial)}
 }
 function mountGround(field){
  if(!field){if(terrain.geometry!==terrainGeometry){terrain.geometry.dispose();terrain.geometry=terrainGeometry}return}
  const source=elevation.mesh(field),vertices=source.vertices.map((n,i)=>i%3===1?n:n-50),indices=source.indices.slice(),uv=[];
  for(let i=0;i<vertices.length;i+=3)uv.push((vertices[i]+210)/420,1-(vertices[i+2]+210)/420);
  const xs=Array.from({length:field.cols},(_,i)=>i*100/(field.cols-1)-50),zs=Array.from({length:field.rows},(_,i)=>i*100/(field.rows-1)-50),low=Array.from({length:21},(_,i)=>-210+i*8),high=Array.from({length:21},(_,i)=>50+i*8),allX=[...low.slice(0,-1),...xs,...high.slice(1)];
  function outer(x,z){const cx=Math.max(-50,Math.min(50,x)),cz=Math.max(-50,Math.min(50,z)),edgeHeight=elevation.height(field,cx+50,cz+50),blend=THREE.MathUtils.smoothstep(Math.max(Math.abs(x)-50,Math.abs(z)-50),0,26),r=Math.hypot(x,z),hill=-.12+THREE.MathUtils.smoothstep(r,62,135)*(8+8*Math.sin(x*.022+z*.011)+5*Math.cos(z*.036-x*.014));return edgeHeight*(1-blend)+hill*blend}
  function patch(xx,zz){const start=vertices.length/3;for(const z of zz)for(const x of xx){vertices.push(x,outer(x,z),z);uv.push((x+210)/420,1-(z+210)/420)}for(let r=0;r<zz.length-1;r++)for(let c=0;c<xx.length-1;c++){const i=start+r*xx.length+c;indices.push(i,i+xx.length,i+1,i+1,i+xx.length,i+xx.length+1)}}
  patch(allX,low);patch(allX,high);patch(low,zs);patch(high,zs);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();if(terrain.geometry!==terrainGeometry)terrain.geometry.dispose();terrain.geometry=geometry;
 }
 function mount(obstacles,heightfield){const key=JSON.stringify([obstacles,heightfield]);if(key===mountedKey)return;mountedKey=key;facilityObjects.clear();activeField=heightfield||null;mountGround(activeField);for(const parent of [scenery,base])for(const child of [...parent.children]){child.traverse(o=>{if(o.geometry&&!o.geometry.userData.sharedLunarAsset)o.geometry.dispose()});parent.remove(child)}
 // Canonical lunar layouts have named facilities. Custom layouts keep their own
 // simplified obstacles in scene3d.js rather than inheriting unrelated buildings.
 if(!obstacles.some(o=>o.id==='habitat'))return;
 if(obstacles.some(o=>o.id==='hangar')&&obstacles.some(o=>o.id==='greenhouse')){mountOutpost(obstacles);return}
 for(const o of obstacles){const x=o.x+o.w/2-50,z=o.y+o.h/2-50;if(o.id==='habitat'){habitat(x,z,o.w,o.h);greenhouseTube(x+20,z,6,18);model('dome',6,x-10,z+8,0,5);model('corridor',5,x+10,z+2,Math.PI/2,4);model('dish',6,x-13,z-2,-.5)}else if(o.id==='ridge'){model('hangar',o.w,x,z,Math.PI, o.h)}else if(o.id==='crater'){model('crater',o.w*1.8,x,z,0,o.h)}else if(o.id==='power'){solarArray(x,z,o.w,o.h);model('generator',5,x-14,z+2)} }
 model('dish',5,30,-18,.5);model('generator',5,-20,-10);
 for(let i=0;i<14;i++){const angle=i*2.3999,radius=70+(i%4)*16;model(i%4===0?'crater':'rock',i%4===0?12:2+i%3,Math.cos(angle)*radius,Math.sin(angle)*radius,angle)}
 // A few poles and cables give scale without inventing device telemetry.
 for(const [x,z] of [[-37,-21],[-16,-31],[-6,3],[17,10],[33,-27]]){const pole=new THREE.Mesh(new THREE.CylinderGeometry(.11,.16,5,8),frameMat);pole.position.set(x,2.5,z);pole.castShadow=true;base.add(pole);box(base,1,.25,.35,lampMat,x,5,z);const cable=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x,0,z),new THREE.Vector3(-5,.05,-17)]),new THREE.LineBasicMaterial({color:0x46443d}));base.add(cable)}
 const pad=new THREE.Mesh(new THREE.CircleGeometry(12,64),new THREE.MeshStandardMaterial({color:0x67675e,roughness:1}));pad.rotation.x=-Math.PI/2;pad.position.set(43,.02,42);pad.receiveShadow=true;base.add(pad);const rim=new THREE.Mesh(new THREE.TorusGeometry(11.4,.13,8,64),new THREE.MeshStandardMaterial({color:0xc9b88b,roughness:1}));rim.rotation.x=Math.PI/2;rim.position.set(43,.05,42);base.add(rim);box(base,1,.08,14,lampMat,43,.09,42);
 }
 function agentModel(target,role='rover'){
  const name=role==='vehicle'?'cargo':role==='robot'?'service':'scout',holder=new THREE.Group();
  target.traverse(o=>{if(o.isMesh&&!o.userData.agentId)o.visible=false});target.add(holder);
  const load=()=>{if(!target.parent)return;const object=models[name].clone(true);object.name='lunar-vehicle-'+name;const bounds=new THREE.Box3().setFromObject(object),size=bounds.getSize(new THREE.Vector3()),radius=Math.hypot(size.x,size.z)/2;if(radius>.78)holder.scale.setScalar(.78/radius);holder.add(object)};
  if(models[name])load();else pending.push(load);return holder;
 }
 function setConstruction(plan){const states=new Map(plan.map(s=>[s.obstacleId,s.state]));for(const [id,objects]of facilityObjects)for(const object of objects)object.visible=!states.has(id)||states.get(id)==='built'}
 return {root,ready,mount,agentModel,setConstruction};
}
