'use strict';
const {isDeepStrictEqual}=require('node:util');
// A synchronous boundary: no observer or timer can see intermediate commits.
// Native handles retain opaque copies, including transient tickets and clocks.
function create(world,participants,snapshot,restoreHost){
 if(!participants.length||participants.some(p=>!p||['checkpoint','rollback'].some(k=>typeof p[k]!=='function')))throw Error('world transaction participant unavailable');
 let running=false;
 return Object.freeze({run(operation){
  if(running)return operation();
  const before=snapshot(world),points=[];running=true;
  try{
   for(const participant of participants)points.push([participant,participant.checkpoint()]);
   const result=operation();
   if(result&&typeof result.then==='function')throw Error('asynchronous world mutation');
   for(const participant of participants)participant.validateCommit?.();
   return result;
  }catch(cause){
   const failures=[];
   for(const [participant,point] of points.slice().reverse())try{participant.rollback(point)}catch(error){failures.push(error)}
   try{restoreHost(world,before)}catch(error){failures.push(error)}
   try{if(!isDeepStrictEqual(snapshot(world),before))failures.push(Error('world rollback mismatch'))}catch(error){failures.push(error)}
   throw Object.assign(Error('world_step_failed'),{status:503,worldTransactionFailure:true,rollbackRestored:failures.length===0,rollbackErrors:failures,cause});
  }finally{
   for(const [,point] of points)try{point.free()}catch{}
   running=false;
  }
 }});
}
module.exports={create};
