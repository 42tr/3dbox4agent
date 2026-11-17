import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import vehicleCamera from './vehicle-camera.js';
import vehicleHeading from './vehicle-heading.js';
import {updateRouteGeometry} from './route-geometry.mjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import motion from './visual-motion.js';
import quality from './render-quality.js';
import graphics from './graphics-state.js';
import {createLunarEnvironment} from './lunar-environment.js';
import {createIndustrialPark,industrialCampusLayout,isIndustrialPark} from './industrial-park.mjs';
import {createSurfacePresentation} from './surface-presentation.js';
import surfaceDomain from '@42tr/3dbox4agent-world/surface-domain';

// Visuals consume snapshots only; geometry is illustrative, not collision geometry.
window.SandboxGraphics=graphics;
window.SandboxIndustrialCampus=industrialCampusLayout;
window.createParkView = function(canvas, onSelect, onUnavailable) {
  const renderer = new THREE.WebGLRenderer({canvas, context:graphics.createContext(canvas), antialias:true, alpha:false});
  let graphicsLost=false;
  canvas.addEventListener('webglcontextlost',()=>{graphicsLost=true;onUnavailable?.({code:'WEBGL_CONTEXT_LOST'})});
  let qualityName='high',nextRenderAt=-Infinity,lastRenderAt=-Infinity;
  renderer.setPixelRatio(quality.pixelRatio(qualityName,window.devicePixelRatio));
  renderer.setClearColor(0xdce9e4);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  // The light is fixed. Moving the viewpoint doesn't change the shadow map.
  renderer.shadowMap.autoUpdate=false;
  renderer.shadowMap.needsUpdate=true;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  const elevation=window.SandboxElevation;const floor=(x,y)=>elevation.height(lastState?.heightfield,x,y);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xdce9e4, 230, 400);
  const camera = new THREE.PerspectiveCamera(42, 1, 2, 500);
  const viewCamera=camera.clone();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping=true;controls.dampingFactor=.08;controls.minDistance=18;controls.maxDistance=210;controls.zoomToCursor=true;
  controls.maxPolarAngle=Math.PI*.49;controls.target.set(0,0,0);
  let lunarCamera=false,industrial=false,modern=false,center=50,cameraFocus=null,overviewCamera=null;
  let followRadius=Infinity,lastRequestedRadius=Infinity;
  const followTarget=new THREE.Vector3();
  const toWorld=p=>({x:p.x+center,y:p.z+center,z:p.y});
  function setCameraLimits(following) {
    // A farther near plane preserves depth precision for thin paint and roof details.
    camera.near=following ? .1 : 2;
    camera.updateProjectionMatrix();
    controls.minDistance=following?4:18;
    controls.maxDistance=industrial?410:210;
    controls.maxTargetRadius=!following&&industrial?170:Infinity;
    controls.enablePan=!following;
  }
  function resetCamera(){
    controls.enableDamping=false;
    controls.update();
    followRadius=lastRequestedRadius=Infinity;
    const object=agents.get(cameraFocus)?.group;
    setCameraLimits(!!object);
    if(object){
      const offset=vehicleCamera.offset(toWorld(object.position),object.rotation.y,lastState.obstacles,1.6,lastState.heightfield);
      camera.position.copy(object.position).add(new THREE.Vector3(offset.x,offset.y,offset.z));
      controls.target.copy(object.position);
      controls.target.y+=1;
    }else{
      const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
      if(lunarCamera){
        const fit=Math.max(1,Math.min(1.55,1.65/aspect));
        if(lunarCamera==='outpost'){camera.position.set(-12*fit,42*fit,2+68*fit);controls.target.set(4,0,2)}
        else{camera.position.set(-45*fit,40*fit,-6+56*fit);controls.target.set(0,0,-6)}
      }else if(modern){
        const fit=Math.max(1,Math.min(1.45,1.38/aspect));
        controls.target.set(10,0,21);camera.position.set(10+138*fit,220*fit,21+178*fit);
      }else if(industrial){
        const fit=Math.max(1,Math.min(1.45,1.42/aspect));
        controls.target.set(13,0,41);camera.position.set(13+82*fit,209*fit,41+183*fit);
      }else{camera.position.set(85,92,105);controls.target.set(0,0,0)}
    }
    controls.update();
    controls.enableDamping=true;
  }
  const ambient=new THREE.HemisphereLight(0xc9d5e7,0x766148,2.0);scene.add(ambient);
  const sun=new THREE.DirectionalLight(0xfff2df,3.6);sun.position.set(-50,60,-40);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-110,right:110,top:110,bottom:-110,near:1,far:250});sun.shadow.bias=-.0004;sun.shadow.normalBias=.12;scene.add(sun);const lunarEnvironment=createLunarEnvironment(scene,renderer);
  const mat=(color,options={})=>new THREE.MeshStandardMaterial({color,roughness:.82,...options});
  const ground=mat(0xc7dbd1),road=mat(0x9db5aa),building=mat(0xf4f7f3),roof=mat(0xb1c9bf),dark=mat(0x587d70),windowMat=mat(0x86afa4),accent=mat(0x098b83),orange=mat(0xd8904d),violet=mat(0x7585ad),red=mat(0xcf6650);
  const agentMetal=mat(0xc2c8c5,{roughness:.48,metalness:.18});
  const agentPanel=mat(0x263d46,{roughness:.5,metalness:.12});
  const agentLamp=mat(0xffe0a1,{roughness:.3,emissive:0x4a3210,emissiveIntensity:.22});
  function box(parent,w,h,d,material,x,y,z){const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh}
  // Device silhouettes are rebuilt often as snapshots change. Shared unit
  // geometry avoids allocating and disposing the same primitives for every
  // rover and robot while preserving per-device materials and transforms.
  function sharedGeometry(geometry){geometry.userData.sharedAgentAsset=true;return geometry}
  const agentGeometry={
    box:sharedGeometry(new THREE.BoxGeometry(1,1,1)),
    cylinder:sharedGeometry(new THREE.CylinderGeometry(.5,.5,1,10)),
    sphere:sharedGeometry(new THREE.SphereGeometry(.5,8,6)),
  };
  function agentMesh(parent,geometry,material,x,y,z,sx=1,sy=1,sz=1,rx=0,ry=0,rz=0){
    const mesh=new THREE.Mesh(geometry,material);
    mesh.position.set(x,y,z);mesh.scale.set(sx,sy,sz);mesh.rotation.set(rx,ry,rz);
    mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
  }
  const surfacePresentation=createSurfacePresentation(scene);
  const legacyPark=createIndustrialPark(scene);
  const modernPark=createIndustrialPark(scene,{modern:true});
  let park=legacyPark;
  const parkGround=box(scene,100,1,100,ground,0,-.5,0);
  const shoreWater=box(scene,35,.04,100,mat(0x77acba),-32.5,.02,0);shoreWater.visible=false;
  const roads=new THREE.Group();scene.add(roads);box(roads,100,.08,12,road,0,.04,0);box(roads,9,.09,100,road,0,.05,0);
  const line=mat(0xe8eee9);for(let i=-45;i<=45;i+=9){box(roads,4,.1,.25,line,i,.12,0);box(roads,.25,.1,4,line,0,.13,i)}
  function buildingAt(x,z,w,d,h){
    const g=new THREE.Group();g.position.set(x,0,z);scene.add(g);
    box(g,w,h,d,building,0,h/2,0);box(g,w+.6,.8,d+.6,roof,0,h+.4,0);
    for(let off=-w/2+3;off<w/2-2;off+=5){const windowMesh=box(g,2.8,2.3,.12,windowMat,off,h*.62,d/2+.08);windowMesh.userData.decorative=true;windowMesh.visible=quality.profile(qualityName).detail}
    box(g,w*.4,.35,d*.3,dark,0,h+1,0);return g;
  }
  let obstacleKey=null,buildingGroups=[];
  function updateBuildings(obstacles) {
    const key=JSON.stringify([industrial,modern,center,obstacles,lastState?.heightfield]);
    if(key===obstacleKey)return;
    obstacleKey=key;
    for(const group of buildingGroups){
      group.removeFromParent();
      if(group.userData.industrial)park.dispose(group);
      else group.traverse(object=>{if(object.isMesh)object.geometry.dispose()});
    }
    buildingGroups=obstacles.map(obstacle=>{
      const {id,x,y,w,h,height}=obstacle;
      const group=(industrial?park.building(obstacle):null)??buildingAt(x+w/2-center,y+h/2-center,w,h,height);
      group.userData.obstacleId=id;
      group.position.y=elevation.bounds(lastState?.heightfield,obstacle)[1];
      if(group.userData.industrial)park.setDetail(group,quality.profile(qualityName).detail);
      return group;
    });
  }
  const constructionOverlays=new Map(),constructionMaterial=new THREE.LineBasicMaterial({color:0xd8b479}),unknownConstructionMaterial=new THREE.LineBasicMaterial({color:0x929eae});
  function updateConstruction(state,plan){
   lunarEnvironment.setConstruction(plan);const status=new Map(plan.map(s=>[s.obstacleId,s.state]));for(const g of buildingGroups)g.visible=!status.has(g.userData.obstacleId)||status.get(g.userData.obstacleId)==='built';
   const pending=plan.filter(s=>s.state!=='built');for(const [id,item]of constructionOverlays)if(!pending.some(s=>s.obstacleId===id)){scene.remove(item.line);item.line.geometry.dispose();constructionOverlays.delete(id)}
   for(const s of pending){const o=state.obstacles.find(o=>o.id===s.obstacleId);if(!o)continue;const top=elevation.bounds(state.heightfield,o)[1],key=JSON.stringify([o,top]);let item=constructionOverlays.get(o.id);if(!item||item.key!==key){if(item){scene.remove(item.line);item.line.geometry.dispose()}const box=new THREE.BoxGeometry(o.w,o.height,o.h),line=new THREE.LineSegments(new THREE.EdgesGeometry(box),constructionMaterial);box.dispose();line.position.set(o.x+o.w/2-center,top+o.height/2,o.y+o.h/2-center);line.name='construction-perimeter-'+o.id;scene.add(line);item={key,line};constructionOverlays.set(o.id,item)}item.line.material=s.state==='unknown'?unknownConstructionMaterial:constructionMaterial}
  }
  let fieldKey='',fieldFloor=null;
  const fieldMaterial=mat(0x9b9487);
  function surfaceGeometry(rect,offset=0){const field=lastState?.heightfield,vertices=[],indices=[];
   if(!field){vertices.push(rect.x-center,offset,rect.y-center,rect.x+rect.w-center,offset,rect.y-center,rect.x-center,offset,rect.y+rect.h-center,rect.x+rect.w-center,offset,rect.y+rect.h-center);indices.push(0,2,1,1,2,3)}else{
    const mesh=elevation.mesh(field);function clip(poly,axis,bound,sign){const out=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],da=sign*(a[axis]-bound),db=sign*(b[axis]-bound),ina=da>=0,inb=db>=0;if(ina)out.push(a);if(ina!==inb){const t=da/(da-db);out.push(a.map((n,j)=>n+(b[j]-n)*t))}}return out}
    for(let t=0;t<mesh.indices.length;t+=3){let poly=mesh.indices.slice(t,t+3).map(i=>mesh.vertices.slice(i*3,i*3+3));for(const [axis,bound,sign]of [[0,rect.x,1],[0,rect.x+rect.w,-1],[2,rect.y,1],[2,rect.y+rect.h,-1]])poly=clip(poly,axis,bound,sign);const start=vertices.length/3;for(const p of poly)vertices.push(p[0]-center,p[1]+offset,p[2]-center);for(let i=1;i+1<poly.length;i++)indices.push(start,start+i,start+i+1)}
   }const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();return g;
  }
  const slopeMaterial=new THREE.MeshBasicMaterial({color:0xd1934c,transparent:true,opacity:.30,depthWrite:false,side:THREE.DoubleSide});let slopeOverlay=null;
  function updateField(state,lunar){const key=JSON.stringify([state.heightfield,lunar]);if(key===fieldKey)return;fieldKey=key;for(const object of [fieldFloor,slopeOverlay])if(object){scene.remove(object);object.geometry.dispose()}fieldFloor=slopeOverlay=null;if(!state.heightfield)return;
   if(!lunar){fieldFloor=new THREE.Mesh(surfaceGeometry({x:0,y:0,w:100,h:100}),fieldMaterial);fieldFloor.receiveShadow=true;scene.add(fieldFloor)}
   const vertices=[];for(const cell of elevation.profile(state.heightfield).filter(c=>c.blocked)){const geometry=surfaceGeometry(cell,.08),p=geometry.attributes.position,index=geometry.index;for(let i=0;i<index.count;i++){const n=index.getX(i);vertices.push(p.getX(n),p.getY(n),p.getZ(n))}geometry.dispose()}const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));slopeOverlay=new THREE.Mesh(geometry,slopeMaterial);scene.add(slopeOverlay);
  }
  function surfacePatch(rect,material,offset){if(!lastState?.heightfield)return box(scene,rect.w,.06,rect.h,material,rect.x+rect.w/2-center,offset,rect.y+rect.h/2-center);const object=new THREE.Mesh(surfaceGeometry(rect,offset),material);scene.add(object);return object}
  const terrainMaterial=new THREE.MeshStandardMaterial({color:0xbd9666,transparent:true,opacity:.54,roughness:1,depthWrite:false}),hazardMaterial=new THREE.MeshStandardMaterial({color:0xc75b3a,transparent:true,opacity:.66,roughness:1,depthWrite:false});let terrainKey=null,terrainMeshes=[];function updateTerrain(zones,effects){const key=JSON.stringify([zones,effects,lastState?.heightfield]);if(key===terrainKey)return;terrainKey=key;for(const mesh of terrainMeshes){scene.remove(mesh);mesh.geometry.dispose()}terrainMeshes=zones.map(z=>surfacePatch(z,effects.some(e=>e.zoneId===z.id)?hazardMaterial:terrainMaterial,.07))}
  const roadblockMaterial=mat(0xc45237);let roadblockKey='',roadblockMeshes=[];function updateRoadblocks(blocks,visible){const key=JSON.stringify([visible?blocks:[],lastState?.heightfield]);if(key===roadblockKey)return;roadblockKey=key;for(const mesh of roadblockMeshes){scene.remove(mesh);mesh.geometry.dispose()}roadblockMeshes=(visible?blocks:[]).map(b=>(()=>{const p=elevation.prism(lastState?.heightfield,b),base=p.base||0;return box(scene,b.w,p.height-base,b.h,roadblockMaterial,b.x+b.w/2-center,(base+p.height)/2,b.y+b.h/2-center)})())}
  // Peripheral equipment and trees communicate scale while remaining low-poly.
  // Static foliage is batched into instanced trunks and two-tone crown layers.
  const trees=new THREE.Group();scene.add(trees);
  const treeLocations=[[-45,-10],[-40,12],[-8,-36],[42,-8],[40,12],[-6,39]];
  const treeDummy=new THREE.Object3D();
  const treeTrunks=new THREE.InstancedMesh(new THREE.CylinderGeometry(.38,.52,1,6),dark,treeLocations.length);
  treeTrunks.castShadow=true;treeTrunks.receiveShadow=true;
  treeLocations.forEach(([x,z],index)=>{treeDummy.position.set(x,1.5,z);treeDummy.scale.set(1,3,1);treeDummy.rotation.set(0,0,0);treeDummy.updateMatrix();treeTrunks.setMatrixAt(index,treeDummy.matrix)});
  treeTrunks.instanceMatrix.needsUpdate=true;treeTrunks.computeBoundingSphere();trees.add(treeTrunks);
  const treeCrownA=mat(0x5e896c,{roughness:1}),treeCrownB=mat(0x78a88a,{roughness:1});
  const crownGeometry=new THREE.ConeGeometry(1,1,7);
  const lowerCrowns=new THREE.InstancedMesh(crownGeometry,treeCrownA,treeLocations.length);
  const upperCrowns=new THREE.InstancedMesh(crownGeometry,treeCrownB,treeLocations.length);
  lowerCrowns.castShadow=upperCrowns.castShadow=true;lowerCrowns.receiveShadow=upperCrowns.receiveShadow=true;
  treeLocations.forEach(([x,z],index)=>{
    treeDummy.position.set(x,4.25,z);treeDummy.scale.set(2.5,3.4,2.5);treeDummy.updateMatrix();lowerCrowns.setMatrixAt(index,treeDummy.matrix);
    treeDummy.position.set(x,5.85,z);treeDummy.scale.set(1.85,2.65,1.85);treeDummy.updateMatrix();upperCrowns.setMatrixAt(index,treeDummy.matrix);
  });
  lowerCrowns.instanceMatrix.needsUpdate=true;upperCrowns.instanceMatrix.needsUpdate=true;
  lowerCrowns.computeBoundingSphere();upperCrowns.computeBoundingSphere();
  trees.add(lowerCrowns,upperCrowns);
  const fixedSensorMaterial=new THREE.MeshStandardMaterial({color:0x5f63ad,roughness:.5});let fixedSensorKey=null,fixedSensorMarkers=[];function updateFixedSensors(sensors,visible){const key=JSON.stringify([sensors,lastState?.heightfield]);if(key!==fixedSensorKey){fixedSensorKey=key;for(const g of fixedSensorMarkers){scene.remove(g);g.traverse(o=>{if(o.isMesh&&!o.geometry.userData.sharedLunarAsset&&!o.geometry.userData.sharedSurfaceAsset)o.geometry.dispose()})}fixedSensorMarkers=sensors.map(f=>{const g=new THREE.Group(),pole=new THREE.Mesh(new THREE.CylinderGeometry(.18,.18,Math.max(f.height,.2),8),fixedSensorMaterial),head=new THREE.Mesh(new THREE.SphereGeometry(.7,12,8),fixedSensorMaterial);pole.position.y=Math.max(f.height,.2)/2;head.position.y=f.height;g.add(pole,head);g.position.set(f.x-center,floor(f.x,f.y),f.y-center);scene.add(g);return g})}for(const g of fixedSensorMarkers)g.visible=visible}
  const markers=new Map();function createMarker(){const marker=new THREE.Group();const ring=new THREE.Mesh(new THREE.TorusGeometry(2.6,.25,8,32),red);ring.rotation.x=Math.PI/2;ring.position.y=.3;marker.add(ring);const pillar=new THREE.Mesh(new THREE.ConeGeometry(1,3.4,5),red);pillar.position.y=4;pillar.rotation.z=Math.PI;marker.add(pillar);scene.add(marker);return marker}
  const sampleMarkers=new Map(),sampleMaterial=new THREE.MeshBasicMaterial({color:0x9252bd});function createSampleMarker(){const marker=new THREE.Group(),ring=new THREE.Mesh(new THREE.TorusGeometry(3.2,.3,8,24),sampleMaterial),crystal=new THREE.Mesh(new THREE.OctahedronGeometry(1.25),sampleMaterial);ring.rotation.x=Math.PI/2;ring.position.y=.4;crystal.position.y=3.2;marker.add(ring,crystal);scene.add(marker);return marker}
  const riskMaterial=new THREE.MeshBasicMaterial({color:0xb54555,transparent:true,opacity:.28,depthWrite:false,side:THREE.DoubleSide});let riskKey=null,riskMeshes=[];function updateRisk(zones){const key=JSON.stringify([zones,lastState?.heightfield]);if(key===riskKey)return;riskKey=key;for(const mesh of riskMeshes){scene.remove(mesh);mesh.geometry.dispose()}riskMeshes=zones.map(z=>surfacePatch(z,riskMaterial,.17))}
  const partMesh=box(scene,1.8,1.8,1.8,orange,0,.9,0);
  const agents=new Map(),pickables=[],transitions=new Map(),agentMaterials=new Map();let lastState=null,lastSelected=null,carriedBy=null;const reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const routeLine=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x107d77,transparent:true,opacity:.85}));scene.add(routeLine);
  const messageLines=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.9,depthTest:false}));messageLines.renderOrder=5;scene.add(messageLines);let linksKey='';
  const VISUAL_RADIUS=.78;
  function fitAgentVisual(group,excluded){const bounds=new THREE.Box3();group.traverse(o=>{if(o.isMesh&&o!==excluded&&o.visible!==false)bounds.expandByObject(o)});if(!Number.isFinite(bounds.min.x))return;const radius=Math.hypot(bounds.max.x-bounds.min.x,bounds.max.z-bounds.min.z)/2;if(radius>VISUAL_RADIUS)group.scale.multiplyScalar(VISUAL_RADIUS/radius)}
  function updateLinks(hops,visible){messageLines.visible=visible&&hops.length>0;if(!messageLines.visible)return;const key=JSON.stringify([hops,lastState?.heightfield]);if(key===linksKey)return;linksKey=key;const positions=[],colors=[],palette={in_range:0x087a76,out_of_range:0xd07a3b,obstructed:0x985ac0,interrupted:0xc45444,unavailable:0xc45444};function segment(a,b,color){positions.push(...a,...b);colors.push(color.r,color.g,color.b,color.r,color.g,color.b)}for(const h of hops){const color=new THREE.Color(palette[h.status]??0xc45444),a=[h.fromX-center,h.fromAir?16.5:2+floor(h.fromX,h.fromY),h.fromY-center],b=[h.toX-center,h.toAir?16.5:2+floor(h.toX,h.toY),h.toY-center];segment(a,b,color);const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);if(length>1e-6){const ux=dx/length,uz=dz/length,p=[a[0]+dx*.7,a[1]+(b[1]-a[1])*.7,a[2]+dz*.7],size=Math.min(2,length*.12);segment(p,[p[0]-ux*size-uz*size*.5,p[1],p[2]-uz*size+ux*size*.5],color);segment(p,[p[0]-ux*size+uz*size*.5,p[1],p[2]-uz*size-ux*size*.5],color)}}const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));messageLines.geometry.dispose();messageLines.geometry=geometry;}
  function createAgent(a){const g=new THREE.Group();g.userData.agentId=a.id;const visual=new THREE.Group();g.add(visual);
    const hex=window.SandboxAgentVisual.color(a.role),model=window.SandboxAgentVisual.model(a,window.SandboxSensors.isAir(a));let color=agentMaterials.get(hex);if(!color){color=mat(hex);agentMaterials.set(hex,color)}
    if(model==='air'){
      box(visual,2.6,.7,2.6,color,0,0,0);box(visual,5,.18,.3,dark,0,0,0);box(visual,.3,.18,5,dark,0,0,0);
      for(const [x,z] of [[-2.2,-2.2],[-2.2,2.2],[2.2,-2.2],[2.2,2.2]]){const rotor=new THREE.Mesh(new THREE.TorusGeometry(.65,.08,6,16),dark);rotor.rotation.x=Math.PI/2;rotor.position.set(x,.25,z);visual.add(rotor)}
    } else if(model==='water'){g.userData.releaseSurface=surfacePresentation.boat(visual,hex);} else if(model==='wheeled'){
      // Compact transport rover: lower chassis, protected cab, cargo deck,
      // four shared low-poly wheels, and small front/rear lights.
      agentMesh(visual,agentGeometry.box,dark,0,.58,0,4.15,.34,2.45);
      agentMesh(visual,agentGeometry.box,color,0,1.08,0,3.75,1.02,2.25);
      agentMesh(visual,agentGeometry.box,building,1.02,1.82,0,1.28,1.22,1.92);
      agentMesh(visual,agentGeometry.box,windowMat,1.66,1.88,0,.08,.62,1.52);
      agentMesh(visual,agentGeometry.box,agentPanel,-.94,1.58,0,1.35,.55,1.92);
      agentMesh(visual,agentGeometry.box,agentMetal,-1.02,1.92,0,1.46,.10,2.02);
      for(const [x,z] of [[-1.25,-1.28],[-1.25,1.28],[1.25,-1.28],[1.25,1.28]]){
        agentMesh(visual,agentGeometry.cylinder,dark,x,.56,z,1.08,.46,1.08,Math.PI/2);
        agentMesh(visual,agentGeometry.cylinder,agentMetal,x,.56,z, .42,.48,.42,Math.PI/2);
      }
      for(const z of [-.72,.72]){
        agentMesh(visual,agentGeometry.box,agentLamp,1.88,1.03,z,.08,.22,.24);
        agentMesh(visual,agentGeometry.box,red, -1.88,1.02,z,.08,.18,.22);
      }
      for(const z of [-1.18,1.18])agentMesh(visual,agentGeometry.box,dark,1.12,2.42,z,.28,.12,.08);
    }else{
      // Service robot: weighted base, reinforced body, sensor head, side arms
      // and a front tool plate. All parts use shared primitives.
      agentMesh(visual,agentGeometry.box,dark,0,.22,0,1.95,.34,1.65);
      agentMesh(visual,agentGeometry.box,color,0,1.02,0,1.78,1.38,1.52);
      agentMesh(visual,agentGeometry.box,agentPanel,.88,1.12,0,.08,.58,.82);
      agentMesh(visual,agentGeometry.box,orange,.94,.77,0,.08,.14,.58);
      agentMesh(visual,agentGeometry.sphere,building,0,2.22,0,.72,.62,.68);
      agentMesh(visual,agentGeometry.box,windowMat,.58,2.24,0,.10,.30,.48);
      agentMesh(visual,agentGeometry.cylinder,dark,0,2.86,0,.12,.34,.12);
      agentMesh(visual,agentGeometry.sphere,orange,0,3.22,0,.18,.18,.18);
      for(const z of [-.98,.98]){
        agentMesh(visual,agentGeometry.sphere,agentMetal,0,1.38,z,.22,.22,.22);
        agentMesh(visual,agentGeometry.cylinder,color,0,1.12,z, .16,.72,.16,Math.PI/2);
        agentMesh(visual,agentGeometry.box,agentMetal,.05,1.12,z*1.28,.28,.22,.18);
      }
    }
    const hit=new THREE.Mesh(new THREE.BoxGeometry(5,5,5),new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false}));hit.position.y=window.SandboxSensors.isAir(a)?0:2;hit.userData.agentId=a.id;g.add(hit);pickables.push(hit);scene.add(g);if(lastState?.sceneId?.startsWith('lunar')&&model!=='air')lunarEnvironment.agentModel(visual,a.role);agents.set(a.id,{group:g,hit,visualKey:a.role+'|'+model+'|'+(lastState?.sceneId?.startsWith('lunar')?'lunar':'other')});if(!lastState?.sceneId?.startsWith('lunar'))fitAgentVisual(visual,hit);
  }
  function focusTerrainEffects(state,selected){return state.agents.some(a=>a.id===selected)?[]:state.terrainEffects||[]}
  function update(state,selected,showLinks=true,options={}){const previousDisplay=lastState;const smooth=motion.eligible(lastState,state,options.previous,selected,lastSelected,options.running,reducedMotion?.matches),same=state===lastState&&selected===lastSelected,now=performance.now();lastState=state;lastSelected=selected;if(previousDisplay?.sceneId!==state.sceneId)lastThumbnailAt=-Infinity;const lunar=['lunar-base-v1','lunar-terrain-v1','lunar-sampling-v1','lunar-outpost-v1','lunar-heightfield-v1','lunar-thermal-v1','lunar-materials-v1','lunar-relay-v1','lunar-construction-v1','lunar-rescue-v1','lunar-power-v1'].includes(state.sceneId),shore=state.sceneId==='shore-coordination-v1'||!!state.surfaceDomain;const cameraLayout=lunar?(['lunar-outpost-v1','lunar-heightfield-v1','lunar-thermal-v1','lunar-materials-v1','lunar-relay-v1','lunar-construction-v1','lunar-rescue-v1','lunar-power-v1'].includes(state.sceneId)?'outpost':'lunar'):false;const sceneChanged=previousDisplay?.sceneId!==state.sceneId||previousDisplay?.worldSize!==state.worldSize||lunarCamera!==cameraLayout;
    lunarCamera=cameraLayout;
    industrial=isIndustrialPark(state.sceneId)&&!state.heightfield&&!shore&&((state.worldSize??100)===100||state.sceneId==='industrial-park-v2'&&state.worldSize===224);
    if(sceneChanged)overviewCamera=null;
    modern=state.sceneId==='industrial-park-v2'&&state.worldSize===224;
    if(sceneChanged){camera.far=modern?1100:500;camera.updateProjectionMatrix()}
    center=(state.worldSize??100)/2;
    park=modern?modernPark:legacyPark;
    legacyPark.ground.visible=legacyPark.yard.visible=industrial&&!modern&&center===50;
    modernPark.ground.visible=modernPark.yard.visible=modern;
    if(industrial){
      park.updateYard(state.chargingStation,state.part?.site);
      park.setDetail(park.yard,quality.profile(qualityName).detail);
    }
    lunarEnvironment.root.visible=lunar;parkGround.visible=!industrial&&!lunar&&!state.heightfield;parkGround.scale.set((state.worldSize??100)/100,1,(state.worldSize??100)/100);updateField(state,lunar);if(lunar)lunarEnvironment.mount(state.obstacles,state.heightfield);roads.visible=!industrial&&!lunar&&!shore&&!state.heightfield&&center===50;trees.visible=!industrial&&!lunar&&!shore&&quality.profile(qualityName).detail;shoreWater.visible=shore&&!state.surfaceDomain;surfacePresentation.update(state.surfaceDomain,state.terrain||[],focusTerrainEffects(state,selected));ground.color.setHex(lunar?0x8b8985:shore?0xd8c9a5:0xc7dbd1);building.color.setHex(lunar?0xbcbcb6:shore?0xc4b89b:0xf4f7f3);roof.color.setHex(lunar?0x8b8f8c:shore?0x938f7d:0xb1c9bf);const backdrop=lunar?0x756754:industrial?0x758a94:0xdce9e4;renderer.setClearColor(backdrop);scene.fog.color.setHex(backdrop);updateBuildings(lunar&&state.obstacles.some(o=>o.id==='habitat')?[]:state.obstacles);scene.fog.near=lunar?160:modern?475:industrial?345:230;scene.fog.far=lunar?330:modern?610:industrial?485:400;const focus=state.agents.find(a=>a.id===selected);updateFixedSensors(state.fixedSensors||[],!focus);updateRoadblocks(state.roadblocks||[],!focus);updateRisk(focus?[]:state.riskZones||[]);updateTerrain(lunar?[]:(state.terrain||[]).filter(z=>!state.surfaceDomain||surfaceDomain.regionKind(state.surfaceDomain,z)!=='water'),focus?[]:state.terrainEffects||[]);const observation=focus?window.SandboxEngine.observe(state,focus.id):null,visibleIds=new Set(observation?.nearby.map(a=>a.id)||[]);updateConstruction(state,window.SandboxConstruction.visualPlan(state.construction,!!focus));updateLinks(focus?[]:window.SandboxLinks.activeHops(state),!focus&&showLinks);
    for(const a of state.agents){const old=agents.get(a.id),model=window.SandboxAgentVisual.model(a,window.SandboxSensors.isAir(a)),key=a.role+'|'+model+'|'+(lastState?.sceneId?.startsWith('lunar')?'lunar':'other');if(old&&old.visualKey!==key){old.group.userData.releaseSurface?.();scene.remove(old.group);pickables.splice(pickables.indexOf(old.hit),1);old.group.traverse(o=>{if(o.isMesh&&!o.geometry.userData.sharedAgentAsset&&!o.geometry.userData.sharedLunarAsset&&!o.geometry.userData.sharedSurfaceAsset)o.geometry.dispose()});old.hit.material.dispose();agents.delete(a.id)}if(!agents.has(a.id))createAgent(a);const {group}=agents.get(a.id),wasVisible=group.visible,visible=!focus||a.id===focus.id||visibleIds.has(a.id),height=window.SandboxSensors.isAir(a)?16:floor(a.x,a.y),target={x:a.x-center,y:a.y-center};if(smooth&&old&&old.visualKey===key&&wasVisible&&visible){transitions.set(a.id,{from:{x:group.position.x,y:group.position.z},to:target,start:now,duration:options.duration||50});group.position.y=height}else if(!same||!options.running){transitions.delete(a.id);group.position.set(target.x,height,target.y)}group.visible=visible;if((lunar||modern)&&model!=='air'){const previous=previousDisplay&&state.tick===previousDisplay.tick+1&&state.sceneId===previousDisplay.sceneId?previousDisplay.agents.find(p=>p.id===a.id):null;group.rotation.y=vehicleHeading.yaw(a,previous,group.rotation.y)}else group.rotation.y=model==='wheeled'?Math.PI/2:0;group.traverse(o=>{if(o.isMesh&&o!==agents.get(a.id).hit)o.material=a.disabled?disabledMaterial(o.material):restoreMaterial(o.material)});}
    const ids=new Set(state.agents.map(a=>a.id));for(const [id,v] of agents)if(!ids.has(id)){v.group.userData.releaseSurface?.();scene.remove(v.group);v.group.traverse(o=>{if(o.isMesh&&!o.geometry.userData.sharedAgentAsset&&!o.geometry.userData.sharedLunarAsset&&!o.geometry.userData.sharedSurfaceAsset)o.geometry.dispose()});v.hit.material.dispose();pickables.splice(pickables.indexOf(v.hit),1);agents.delete(id);transitions.delete(id)}
    const nextFocus=focus?.id||null;
    if(sceneChanged||cameraFocus!==nextFocus){
      if(!sceneChanged&&!cameraFocus&&nextFocus){
        overviewCamera={position:camera.position.clone(),target:controls.target.clone()};
      }
      cameraFocus=nextFocus;
      if(!cameraFocus&&overviewCamera){
        controls.enableDamping=false;
        controls.update();
        setCameraLimits(false);
        camera.position.copy(overviewCamera.position);
        controls.target.copy(overviewCamera.target);
        controls.update();
        controls.enableDamping=true;
        overviewCamera=null;
      }else{
        resetCamera();
      }
      lastThumbnailAt=-Infinity;
    }
    const part=state.part;const carrier=state.agents.find(a=>a.id===part.carrierId);const p=carrier?[carrier.x,carrier.y]:part.position;carriedBy=carrier?.id||null;partMesh.scale.setScalar(lunar ? .6 : 1);partMesh.visible=!focus&&!!p&&part.location!=='consumed';if(p)partMesh.position.set(p[0]-center,(carrier&&window.SandboxSensors.isAir(carrier)?16:floor(p[0],p[1]))+(carrier?(lunar?1.8:3):(lunar ? .54 : .9)),p[1]-center);
    const moving=state.agents.find(a=>(a.status==='working'||a.status==='manual')&&a.route.length&&(!focus||a.id===focus.id));routeLine.visible=!!moving&&!focus;if(moving&&!focus){const air=window.SandboxSensors.isAir(moving),route=[[moving.x,moving.y],...moving.route],points=[];for(let i=1;i<route.length;i++){const a=route[i-1],b=route[i],cuts=air?[0,1]:elevation.cuts(state.heightfield,a,b);for(const t of cuts){const x=a[0]+(b[0]-a[0])*t,y=a[1]+(b[1]-a[1])*t;points.push(new THREE.Vector3(x-center,air?16:floor(x,y)+.3,y-center))}}updateRouteGeometry(routeLine,points)}
    const samples=focus?(observation.samples||[]):state.events.filter(e=>e.kind==='sample_collected');const sampleIds=new Set(samples.map(x=>x.taskId));for(const [id,marker] of sampleMarkers)if(!sampleIds.has(id))marker.visible=false;for(const item of samples){if(!sampleMarkers.has(item.taskId))sampleMarkers.set(item.taskId,createSampleMarker());const marker=sampleMarkers.get(item.taskId);marker.visible=true;marker.position.set(item.position[0]-center,floor(...item.position),item.position[1]-center)}
    const targets=focus?[...new Map([...observation.visibleTargets.map(t=>({id:t.id,target:[t.x,t.y]})),...observation.assignedTasks].map(t=>[t.id,t])).values()]:state.tasks.filter(t=>t.status==='active'||(t.status==='pending'&&t.dependsOn.every(id=>state.tasks.some(x=>x.id===id&&x.status==='done'))));const activeIds=new Set(targets.map(t=>t.id));for(const [id,marker] of markers)if(!activeIds.has(id))marker.visible=false;for(const t of targets){if(!markers.has(t.id))markers.set(t.id,createMarker());const marker=markers.get(t.id);marker.visible=true;marker.children[1].visible=!focus;marker.scale.setScalar(focus ? .32 : 1);marker.position.set(t.target[0]-center,floor(...t.target),t.target[1]-center)}
    renderer.shadowMap.needsUpdate=true;
  }
  const disabledCache=new Map();function disabledMaterial(original){if(original.userData.original)return original;if(!disabledCache.has(original)){const copy=original.clone();copy.color.set(0x889995);copy.userData.original=original;disabledCache.set(original,copy)}return disabledCache.get(original)}function restoreMaterial(material){return material.userData.original||material}
  const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();let down=null;
  canvas.addEventListener('pointerdown',event=>{down=event.isPrimary&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey?event:null});
  const beyondClick=event=>Math.hypot(event.clientX-down.clientX,event.clientY-down.clientY)>5;
  canvas.addEventListener('pointermove',event=>{if(down&&event.pointerId===down.pointerId&&beyondClick(event))down=null});
  canvas.addEventListener('pointercancel',()=>{down=null});
  canvas.addEventListener('pointerup',event=>{
    const clicked=down&&event.pointerId===down.pointerId&&!beyondClick(event);
    down=null;
    if(!clicked)return;
    const rect=canvas.getBoundingClientRect();
    mouse.set((event.clientX-rect.left)/rect.width*2-1,-((event.clientY-rect.top)/rect.height)*2+1);
    ray.setFromCamera(mouse,viewCamera);
    const hit=ray.intersectObjects(pickables,false).find(h=>h.object.parent.visible);
    if(hit&&lastState)onSelect(hit.object.userData.agentId);
  });
  function setQuality(name){quality.profile(name);qualityName=name;renderer.setPixelRatio(quality.pixelRatio(name,window.devicePixelRatio));for(const g of buildingGroups)g.traverse(o=>{if(o.userData.decorative)o.visible=quality.profile(name).detail});const lunar=['lunar-base-v1','lunar-terrain-v1','lunar-sampling-v1','lunar-outpost-v1','lunar-heightfield-v1','lunar-thermal-v1','lunar-materials-v1','lunar-relay-v1','lunar-construction-v1','lunar-rescue-v1','lunar-power-v1'].includes(lastState?.sceneId),shore=lastState?.sceneId==='shore-coordination-v1'||!!lastState?.surfaceDomain;park.setDetail(park.yard,quality.profile(name).detail);trees.visible=!!lastState&&!industrial&&!lunar&&!shore&&quality.profile(name).detail;nextRenderAt=-Infinity;renderer.shadowMap.needsUpdate=true}
  const thumbnailTarget=new THREE.WebGLRenderTarget(320,170),thumbnailSource=new THREE.WebGLRenderTarget(320,170,{type:renderer.extensions.has('EXT_color_buffer_float')?THREE.HalfFloatType:THREE.UnsignedByteType}),thumbnailOutput=new OutputPass(),thumbnailCamera=new THREE.PerspectiveCamera(48,320/170,.1,500),pixels=new Uint8Array(320*170*4),thumbnailImage=new ImageData(320,170);
  let lastThumbnailAt=-Infinity,thumbnailIndex=0,thumbnailPending=false;
  let draggingCamera=false,lastCameraInputAt=-Infinity;
  controls.addEventListener('start',()=>{draggingCamera=true;lastCameraInputAt=performance.now()});
  controls.addEventListener('end',()=>{draggingCamera=false;lastCameraInputAt=performance.now()});
  function refreshAssets(){lastThumbnailAt=-Infinity;renderer.shadowMap.needsUpdate=true}
  lunarEnvironment.ready.then(refreshAssets);
  surfacePresentation.ready.then(refreshAssets);
  function thumbnails(now){
    if(thumbnailPending||draggingCamera||now-lastCameraInputAt<200||now-lastThumbnailAt<375||!lastState)return;
    lastThumbnailAt=now;
    const destinations=new Map();
    for(const target of document.querySelectorAll('canvas[data-device-camera]')){
      const id=target.dataset.deviceCamera;
      if(!agents.has(id)||!target.getClientRects().length)continue;
      if(!destinations.has(id))destinations.set(id,[]);
      destinations.get(id).push(target);
    }
    if(!destinations.size)return;
    const [id,targets]=[...destinations][thumbnailIndex%destinations.size];
    thumbnailIndex=(thumbnailIndex+1)%destinations.size;
    const object=agents.get(id).group;
    const spec=lastState.agents.find(agent=>agent.id===id);
    const mountedCamera=spec?.camera?.enabled?spec.camera:null;
    if(mountedCamera){
      // Render from the camera mounted on the model. Camera mount coordinates
      // use the same local X/Y/Z basis as the model, with +X as forward.
      const mount=Array.isArray(mountedCamera.mount)&&mountedCamera.mount.length===3?mountedCamera.mount:[0,1.5,.8];
      const position=object.localToWorld(new THREE.Vector3(mount[0],mount[1],mount[2]));
      const yaw=THREE.MathUtils.degToRad(Number.isFinite(mountedCamera.yaw)?mountedCamera.yaw:0);
      const pitch=THREE.MathUtils.degToRad(Number.isFinite(mountedCamera.pitch)?mountedCamera.pitch:0);
      const direction=new THREE.Vector3(Math.cos(yaw),Math.tan(pitch),-Math.sin(yaw)).applyQuaternion(object.quaternion).normalize();
      thumbnailCamera.position.copy(position);
      thumbnailCamera.lookAt(position.clone().add(direction.multiplyScalar(Math.max(1,Number(mountedCamera.range)||60))));
      thumbnailCamera.fov=Number.isFinite(mountedCamera.fov)?mountedCamera.fov:48;
    }else{
      // Legacy/custom devices without a camera definition keep the generic
      // nearby preview instead of failing the device-card renderer.
      const position=object.position;
      const offset=vehicleCamera.offset(toWorld(position),object.rotation.y,lastState.obstacles,1,lastState.heightfield);
      thumbnailCamera.position.copy(position).add(new THREE.Vector3(offset.x,offset.y,offset.z));
      thumbnailCamera.lookAt(position.x,position.y+.9,position.z);
      thumbnailCamera.fov=48;
    }
    thumbnailCamera.aspect=320/170;
    thumbnailCamera.near=.1;
    thumbnailCamera.far=Math.max(100,Number(mountedCamera?.range)||500);
    thumbnailCamera.updateProjectionMatrix();
    const sceneId=lastState.sceneId;
    thumbnailPending=true;
    try{
      renderer.setRenderTarget(thumbnailSource);renderer.render(scene,thumbnailCamera);
      // Match the main canvas: linear lighting -> ACES/exposure -> sRGB bytes.
      thumbnailOutput.render(renderer,thumbnailTarget,thumbnailSource);
      renderer.readRenderTargetPixelsAsync(thumbnailTarget,0,0,320,170,pixels).then(()=>{
        if(graphicsLost||lastState.sceneId!==sceneId)return;
        for(let y=0;y<170;y++)thumbnailImage.data.set(pixels.subarray((169-y)*320*4,(170-y)*320*4),y*320*4);
        for(const target of targets){
          if(!target.isConnected||target.dataset.deviceCamera!==id)continue;
          target.getContext('2d').putImageData(thumbnailImage,0,0);
          target.dataset.ready='true';
        }
      }).catch(error=>{if(!graphicsLost)console.warn('Device preview readback failed:',error)})
        .finally(()=>{thumbnailPending=false});
    }finally{
      renderer.setRenderTarget(null);
    }
  }
  function updateViewCamera(elapsed){
    const object=agents.get(cameraFocus)?.group;
    if(object){
      followTarget.copy(object.position);
      followTarget.y+=1;
      camera.position.add(followTarget).sub(controls.target);
      controls.target.copy(followTarget);
    }
    controls.update();
    viewCamera.copy(camera);
    if(object){
      // Apply occlusion only to the rendered camera; OrbitControls retains the user's orbit.
      const radius=camera.position.distanceTo(controls.target);
      const fraction=vehicleCamera.visibleFraction(toWorld(camera.position),toWorld(controls.target),lastState.obstacles,lastState.heightfield);
      const limit=fraction<1?Math.max(.2,radius*fraction-.15):radius;
      const previous=followRadius*radius/lastRequestedRadius;
      followRadius=!Number.isFinite(previous)||reducedMotion?.matches?limit:
        Math.min(limit,previous+(limit-previous)*-Math.expm1(-elapsed/140));
      lastRequestedRadius=radius;
      viewCamera.position.lerpVectors(controls.target,camera.position,followRadius/radius);
    }
  }
  let renderWidth=0,renderHeight=0;
  function animate(now){
    if(graphicsLost)return;
    requestAnimationFrame(animate);
    if(now+1<nextRenderAt)return;
    const interval=1000/quality.profile(qualityName).frameRate;
    nextRenderAt=(now>=nextRenderAt+interval?now:nextRenderAt)+interval;
    const elapsed=now-lastRenderAt;
    lastRenderAt=now;
    for(const [id,transition] of transitions){
      const agent=agents.get(id);
      if(!agent){transitions.delete(id);continue}
      const p=motion.position(transition.from,transition.to,transition.start,transition.duration,reducedMotion?.matches?transition.start+transition.duration:now);
      if(agent.group.position.x!==p.x||agent.group.position.z!==p.y)renderer.shadowMap.needsUpdate=true;
      agent.group.position.x=p.x;agent.group.position.z=p.y;
      const spec=lastState?.agents.find(a=>a.id===id);
      if(spec&&!window.SandboxSensors.isAir(spec))agent.group.position.y=floor(p.x+center,p.y+center);
      if(p.done)transitions.delete(id);
    }
    if(carriedBy&&partMesh.visible){
      const agent=agents.get(carriedBy);
      if(agent){partMesh.position.x=agent.group.position.x;partMesh.position.z=agent.group.position.z;partMesh.position.y=agent.group.position.y+(lastState?.sceneId?.startsWith('lunar')?1.8:3)}
    }
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if(w&&h&&(w!==renderWidth||h!==renderHeight)){
      renderWidth=w;renderHeight=h;
      renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
    }
    updateViewCamera(elapsed);
    if(w&&h)renderer.render(scene,viewCamera);
    thumbnails(now);
  }
  requestAnimationFrame(animate);
  return {update,resetCamera,setQuality};
};
