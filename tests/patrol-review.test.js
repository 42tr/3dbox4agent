'use strict';
const assert=require('node:assert/strict');
const Review=require('../src/patrol-review');
const world={agents:[{id:'a',name:'甲'},{id:'b',name:'乙'}],actions:[
 {agentId:'a',requestId:'x',type:'scan',status:'completed',result:{kind:'not_detected',observedTick:2}},
 {agentId:'a',requestId:'y',type:'scan',status:'completed',result:{kind:'anomaly',position:[75,40],observedTick:8}},
 {agentId:'b',requestId:'y',type:'scan',status:'completed',result:{kind:'normal',position:[75,40],observedTick:9}},
 {agentId:'b',requestId:'z',type:'scan',status:'pending'}],evidenceReports:[
 {agentId:'a',scanRequestId:'y',status:'failed',reason:'interrupted',submittedTick:8,appliedTick:11},
 {agentId:'a',scanRequestId:'y',status:'delivered',submittedTick:12,appliedTick:15},
 {agentId:'b',scanRequestId:'y',status:'pending',submittedTick:10}]};
const all=Review.summarize(world);assert.deepEqual(all.counts,{total:3,notDetected:1,anomaly:1,normal:1,reports:3,delivered:1,failed:1});
assert.equal(all.scans[0].agentId,'b');assert.equal(all.scans[0].reports.length,1);assert.equal(all.scans[1].reports.length,2);assert.equal(all.scans[2].reports.length,0);
const selected=Review.summarize(world,'a');assert.equal(selected.counts.total,2);assert.equal(selected.counts.reports,2);assert.equal(selected.scans[0].reports[0].reason,'interrupted');
assert.equal(Review.summarize({...world,actions:[],evidenceReports:[]}).counts.total,0);
console.log('patrol review snapshot summary tests passed');
