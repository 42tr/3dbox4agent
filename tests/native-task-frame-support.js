'use strict';
const crypto=require('node:crypto'),E=require('../src/engine'),C=require('../server/native-components'),NativeNav=require('../server/rust-navigation');
const order=['execution','environment','tasks','actions','resources','peer','reports','perceptions','dispatch','requests','ledger'];
function bind(w,p,{batch=true,probe,actionBatch=false,actionProbe,worldBatch=false,worldProbe}={}){
 const stores={},participants=[];
 function add(name,method,value){let s=value||require('../server/rust-world-'+name).create(w,name==='perceptions'?p:undefined);if(worldProbe)s=Object.defineProperties({},Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(s)).map(([k,d])=>[k,{...d,configurable:true,...('value'in d?{writable:true}:{})}])));stores[name]=s;E[method](w,s);participants.push(s);return s}
 add('environment','bindWorldEnvironment');const ledger=add('ledger','bindWorldLedger'),control=ledger.control(w);
 add('control','bindWorldControl',{...control,...(probe?{advanceWorkingTasks(...args){return probe(w,stores,control,args)}}:{}),...(actionProbe?{advanceAcceptedActions(...args){return actionProbe(w,stores,control,args)}}:{}),...(worldProbe?{advanceWorldStep(...args){return worldProbe(w,stores,control,args)}}:{})});
 const motion=require('../server/rust-world-motion').create(w);E.bindWorldMotion(w,motion);add('execution','bindWorldExecution',motion.execution(w));
 for(const name of ['tasks','actions','peer','reports','dispatch','resources','perceptions','requests'])add(name,'bindWorld'+name[0].toUpperCase()+name.slice(1));
 E.bindNavigation(w,NativeNav);E.bindTaskRules(w,require('../server/rust-task-rules'));E.bindCommunicationRules(w,require('../server/rust-communication'));
 if(!E.bindWorldAgentObservations(w)||!E.bindWorldCoordinatorObservations(w))throw Error('observation binding required');
 if(batch&&!E.bindWorldTaskAdvance(w,p))throw Error('task frame binding required');
 if(actionBatch&&!E.bindWorldActionAdvance(w,p))throw Error('action frame binding required');
 if(worldBatch&&!E.bindWorldAdvance(w,p))throw Error('world frame binding required');
 E.bindWorldTransaction(w,require('../server/world-transaction').create(w,[...participants,...(p?[p]:[])],E.snapshot,E.restoreHostState));return stores;
}
function raw(stores){return Object.fromEntries([...order,'control'].map(k=>[k,C.reference(stores[k],k).native]))}
function hashes(stores,p,w){const rows=Object.entries(raw(stores)).map(([k,n])=>[k,crypto.createHash('sha256').update(k==='execution'?n.snapshot()+n.snapshotExecution():n.snapshot()).digest('hex')]);if(p)rows.push(['colliders',crypto.createHash('sha256').update(JSON.stringify(w.agents.map(a=>p.lidar(a,1.5,8,100)))).digest('hex')]);return rows}
module.exports={bind,raw,hashes,order};
