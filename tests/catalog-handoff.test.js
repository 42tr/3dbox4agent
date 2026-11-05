'use strict';
const assert=require('node:assert/strict');
const H=require('../src/catalog-handoff');
const origin='http://localhost:18891',nonce='0123456789abcdef0123456789abcdef';
function pair(){
 const make=()=>({listeners:new Set(),addEventListener(_,f){this.listeners.add(f)},removeEventListener(_,f){this.listeners.delete(f)},emit(e){for(const f of [...this.listeners])f(e)}});
 const parent=make(),child=make();child.opener=parent;
 parent.postMessage=(data,to)=>queueMicrotask(()=>{if(to===origin)parent.emit({data,origin,source:child})});
 child.postMessage=(data,to)=>queueMicrotask(()=>{if(to===origin)child.emit({data,origin,source:parent})});
 return {parent,child};
}
(async()=>{
 {const {parent,child}=pair(),s=H.sender(parent,child,origin,nonce,100);let received;s.deliver({frames:[1]});H.receiver(child,origin,nonce,v=>{received=v});await s.promise;assert.deepEqual(received,{frames:[1]});assert.equal(parent.listeners.size,0);assert.equal(child.listeners.size,0)}
 {const {parent,child}=pair(),s=H.sender(parent,child,origin,nonce,100);let received;H.receiver(child,origin,nonce,v=>{received=v});await new Promise(r=>setImmediate(r));child.emit({origin,source:{},data:{type:'3dbox-catalog-data',nonce,payload:'forged'}});child.emit({origin:'http://evil',source:parent,data:{type:'3dbox-catalog-data',nonce,payload:'forged'}});assert.equal(received,undefined);s.deliver('valid');await s.promise;assert.equal(received,'valid')}
 {const {parent,child}=pair(),s=H.sender(parent,child,origin,nonce,100);H.receiver(child,origin,nonce,()=>{throw Error('invalid archive')});s.deliver({});await assert.rejects(s.promise,/invalid archive/)}
 {const {parent,child}=pair(),s=H.sender(parent,child,origin,nonce,10);parent.emit({origin,source:{},data:{type:'3dbox-catalog-ready',nonce}});parent.emit({origin,source:child,data:{type:'3dbox-catalog-done',nonce,ok:true}});await assert.rejects(s.promise,/未响应/);assert.equal(parent.listeners.size,0)}
 {const {parent,child}=pair(),s=H.sender(parent,child,origin,nonce,100);s.cancel();await assert.rejects(s.promise,/取消/);assert.equal(H.receiver(child,origin,'bad',()=>{}),false)}
 console.log('catalog handoff tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
