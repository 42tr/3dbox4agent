import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import boatUrl from '../assets/mission-control/kenney-pirate-kit/boat-row-large.glb';
import domain from './surface-domain.js';

// Snapshot geometry only. This layer adds no motion, buoyancy or physics state.
export function createSurfacePresentation(scene){
 const water=new THREE.Group();water.name='configured-water-domain';scene.add(water);
 const material=new THREE.MeshStandardMaterial({color:0x488f9f,roughness:.6,metalness:.08});
 const conditions=new THREE.Group();conditions.name='configured-water-conditions';scene.add(conditions);
 const calm=new THREE.MeshStandardMaterial({color:0x65b5c4,transparent:true,opacity:.16,roughness:1,depthWrite:false}),rough=new THREE.MeshStandardMaterial({color:0xd79436,transparent:true,opacity:.48,roughness:1,depthWrite:false});
 let key='',conditionKey='',model=null,loading=false,pending=[];let settled;const tints=new Map();
 const ready=new Promise(resolve=>{settled=resolve});
 function update(profile,zones=[],effects=[]){
  const next=JSON.stringify(profile??null);if(next!==key){key=next;
  for(const mesh of [...water.children]){water.remove(mesh);mesh.geometry.dispose()}
  if(profile)for(const r of domain.partition(profile,true)){
   const mesh=new THREE.Mesh(new THREE.BoxGeometry(r.w,.04,r.h),material);
   mesh.position.set(r.x+r.w/2-50,.02,r.y+r.h/2-50);mesh.receiveShadow=true;water.add(mesh);
  }}
  const visible=profile?zones.filter(z=>domain.regionKind(profile,z)==='water'):[],nextConditions=JSON.stringify([visible,effects]);if(conditionKey===nextConditions)return;conditionKey=nextConditions;
  for(const mesh of [...conditions.children]){conditions.remove(mesh);mesh.geometry.dispose()}
  for(const z of visible){const effect=effects.find(e=>e.zoneId===z.id),mesh=new THREE.Mesh(new THREE.BoxGeometry(z.w,.02,z.h),effect?rough:calm);mesh.position.set(z.x+z.w/2-50,.075,z.y+z.h/2-50);mesh.userData={zoneId:z.id,active:!!effect,speedFactor:z.speedFactor*(effect?.speedFactor??1),energyFactor:z.energyFactor*(effect?.energyFactor??1)};conditions.add(mesh)}
 }
function tint(original,color){const key=original.uuid+'|'+color;if(!tints.has(key)){const copy=original.clone();copy.color.set(color);tints.set(key,copy)}return tints.get(key)}
 function boat(group,color='#267e9a'){
  let released=false;
  function mount(){if(released)return;const copy=model.clone(true);copy.traverse(o=>{if(o.isMesh)o.material=Array.isArray(o.material)?o.material.map(m=>tint(m,color)):tint(o.material,color)});group.add(copy)}
  if(model)mount();else{
   pending.push(mount);
   if(!loading){loading=true;new GLTFLoader().load(boatUrl,gltf=>{
    const paddles=gltf.scene.getObjectByName('paddles');if(paddles){paddles.removeFromParent();paddles.traverse(o=>{if(o.isMesh)o.geometry.dispose()})}
    const object=gltf.scene,bounds=new THREE.Box3().setFromObject(object),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
    object.position.set(-center.x,-bounds.min.y,-center.z);const pivot=new THREE.Group();pivot.add(object);
    const scale=4/Math.max(size.x,size.z);pivot.scale.setScalar(scale);if(size.z>size.x)pivot.rotation.y=Math.PI/2;
    pivot.position.y=.04;pivot.traverse(o=>{if(o.isMesh){o.geometry.userData.sharedSurfaceAsset=true;o.castShadow=true;o.receiveShadow=true}});model=pivot;
    const callbacks=pending;pending=[];callbacks.forEach(fn=>fn());settled(true);
   },undefined,error=>{pending=[];console.error('3DBox boat asset could not be loaded',error);settled(false)})}
  }
  return ()=>{released=true};
 }
 return {water,conditions,ready,update,boat};
}
