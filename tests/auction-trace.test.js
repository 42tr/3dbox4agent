'use strict';
const assert=require('node:assert/strict'),Trace=require('../src/auction-trace');
const auctionId='1234abcd-1';
const r={format:'3dbox-multiprocess-v1',auctionTraceTruncated:false,auctionTraceIncomplete:[],events:[
 {kind:'message_sent',messageId:1,from:'a',to:'b',tick:1,requestId:`call-${auctionId}-b`},
 {kind:'message_delivered',messageId:1,from:'a',to:'b',tick:2},
 {kind:'message_sent',messageId:2,from:'b',to:'a',tick:3,requestId:'bid-1'},
 {kind:'message_delivered',messageId:2,from:'b',to:'a',tick:4}],decisions:[{requestId:`auction-${auctionId}`,taskId:'task',agentId:'b',status:'accepted',appliedTick:8}],auctionTrace:[
 {kind:'open',auctionId,taskId:'task',broker:'a',candidates:['a','b'],observedTick:1,worldRevision:5},
 {kind:'call',auctionId,agentId:'b',messageId:1},{kind:'bid',auctionId,agentId:'b',source:'message',messageId:2,receivedTick:4,score:3},
 {kind:'window',auctionId,deadlineTick:8},{kind:'close',auctionId,status:'pending',winner:'b',score:3,requestId:`auction-${auctionId}`,observedTick:8,worldRevision:10}]};
const t=Trace.build(r);assert.equal(t.rounds[0].worldResult.status,'accepted');assert.equal(Trace.locate(t.rounds[0],[{tick:1}],{revisionRange:[5,5]}),0);assert.equal(Trace.locate(t.rounds[0],[{tick:2}],{revisionRange:[5,5]}),-1);
for(const modify of [x=>x.events[3].tick++,x=>x.events[2].requestId='bid-9',x=>x.auctionTrace[2].score=NaN,x=>x.decisions[0].agentId='a']){const bad=structuredClone(r);modify(bad);assert.throws(()=>Trace.build(bad))}
const partial=structuredClone(r);partial.auctionTrace.pop();partial.auctionTraceTruncated=true;partial.auctionTraceIncomplete=[auctionId];assert.equal(Trace.build(partial).rounds[0].close,null);partial.auctionTraceIncomplete=[];assert.throws(()=>Trace.build(partial));
console.log('auction trace message links, decisions, partial records and snapshot location passed');
