'use strict';
const {Writer,Reader}=require('protobufjs/minimal');
const LIMIT=32*1024*1024,MAX_NODES=2000000,MAX_DEPTH=96;
function encode(input,version=1){
 if(![1,2].includes(version))throw Error('invalid protobuf version');
 const data=typeof input==='string'?JSON.parse(input):JSON.parse(JSON.stringify(input));let nodes=0;
 const counts=new Map();function count(v,depth){if(depth>MAX_DEPTH||++nodes>MAX_NODES)throw Error('protobuf value limit');if(Array.isArray(v)){for(const item of v)count(item,depth+1)}else if(v&&typeof v==='object'){for(const [k,item] of Object.entries(v)){counts.set(k,(counts.get(k)||0)+1);count(item,depth+1)}}}
 if(version===2)count(data,0);nodes=0;const textBytes=new TextEncoder(),ranked=[...counts].map(([key,n])=>{const literal=JSON.stringify(key),length=textBytes.encode(literal).length,cost=1+(length<128?1:length<16384?2:3)+length;return {key,literal,saving:n*(cost-2)-cost}}).filter(x=>x.saving>0).sort((a,b)=>b.saving-a.saving||(a.key<b.key?-1:a.key>b.key?1:0)).slice(0,127),indices=new Map(ranked.map((entry,i)=>[entry.key,i+1]));
 function value(w,v,depth){
  if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw Error('protobuf value limit');
  if(v===null)w.uint32(8).bool(true);
  else if(typeof v==='boolean')w.uint32(16).bool(v);
  else if(typeof v==='number')w.uint32(25).double(v);
  else if(typeof v==='string')w.uint32(34).string(JSON.stringify(v));
  else if(Array.isArray(v)){w.uint32(42).fork();for(const item of v){w.uint32(10).fork();value(w,item,depth+1);w.ldelim()}w.ldelim()}
  else if(typeof v==='object'){w.uint32(50).fork();for(const [k,item] of Object.entries(v)){w.uint32(10).fork();const index=indices.get(k);if(index)w.uint32(24).uint32(index);else w.uint32(10).string(JSON.stringify(k));w.uint32(18).fork();value(w,item,depth+1);w.ldelim().ldelim()}w.ldelim()}
  else throw Error('invalid protobuf value');
 }
 const w=Writer.create().uint32(8).uint32(version);for(const entry of ranked)w.uint32(26).string(entry.literal);w.uint32(18).fork();value(w,data,0);const result=w.ldelim().finish();if(result.length>LIMIT)throw Error('protobuf message too large');return result;
}
function decode(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length>LIMIT)throw Error('invalid protobuf message');
 let r=Reader.create(bytes),version=null,payloadBytes=null,dictionary=[];while(r.pos<r.len){const tag=r.uint32();if(tag===8&&version===null)version=r.uint32();else if(tag===18&&payloadBytes===null)payloadBytes=r.bytes();else if(tag===26){if(dictionary.length>=127)throw Error('protobuf dictionary limit');const key=JSON.parse(r.string());if(typeof key!=='string'||dictionary.includes(key))throw Error('invalid protobuf dictionary');dictionary.push(key)}else throw Error('invalid envelope')}
 if(![1,2].includes(version)||payloadBytes===null||(version===1&&dictionary.length))throw Error('invalid envelope');r=Reader.create(payloadBytes);let nodes=0;
 function limit(){const len=r.uint32(),end=r.pos+len;if(end>r.len||end<r.pos)throw Error('truncated protobuf');return end}
 function readValue(end,depth){
  if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw Error('protobuf value limit');let result,seen=false;
  while(r.pos<end){const tag=r.uint32();if(seen)throw Error('multiple protobuf value kinds');seen=true;
   if(tag===8){if(!r.bool())throw Error('invalid null');result=null}
   else if(tag===16)result=r.bool();
   else if(tag===25){result=r.double();if(!Number.isFinite(result))throw Error('invalid number')}
   else if(tag===34){result=JSON.parse(r.string());if(typeof result!=='string')throw Error('invalid string')}
   else if(tag===42){const e=limit();result=[];while(r.pos<e){if(r.uint32()!==10)throw Error('invalid list');const x=limit();result.push(readValue(x,depth+1));if(r.pos!==x)throw Error('invalid list value')}if(r.pos!==e)throw Error('invalid list size')}
   else if(tag===50){const e=limit(),keys=new Set();result={};while(r.pos<e){if(r.uint32()!==10)throw Error('invalid object');const f=limit();let key,entry,hasKey=false,hasValue=false;while(r.pos<f){const field=r.uint32();if(field===10&&!hasKey){key=JSON.parse(r.string());hasKey=true;if(typeof key!=='string'||keys.has(key))throw Error('invalid key')}else if(field===24&&!hasKey&&version===2){const index=r.uint32();if(index<1||index>dictionary.length)throw Error('invalid key index');key=dictionary[index-1];hasKey=true;if(keys.has(key))throw Error('invalid key')}else if(field===18&&!hasValue){const x=limit();entry=readValue(x,depth+1);hasValue=true;if(r.pos!==x)throw Error('invalid entry')}else throw Error('invalid field')}if(r.pos!==f||!hasKey||!hasValue)throw Error('invalid field size');keys.add(key);Object.defineProperty(result,key,{value:entry,writable:true,configurable:true,enumerable:true})}if(r.pos!==e)throw Error('invalid object size')}
   else throw Error('unknown protobuf value');if(r.pos>end)throw Error('invalid value size');
  }
  if(!seen||r.pos!==end)throw Error('invalid protobuf value');return result;
 }
 const payload=readValue(r.len,0);if(r.pos!==r.len)throw Error('invalid envelope');return payload;
}
module.exports={encode,decode,LIMIT};
