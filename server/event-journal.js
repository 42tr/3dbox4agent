'use strict';
// Optional local append-only journal. Hashes detect accidental corruption,
// not a malicious writer with access to the journal directory.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const Delta=require('../src/delta');
const MAX_BYTES=64*1024*1024,MAX_STATE_BYTES=16*1024*1024,MAX_PAGE_BYTES=8*1024*1024;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,ZERO='0'.repeat(64);
function hash(previous,payload){return crypto.createHash('sha256').update(previous+'\n'+JSON.stringify(payload)).digest('hex')}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object'){const result=Object.create(null);for(const key of Object.keys(value).sort())result[key]=canonical(value[key]);return result}return value}
function worldDigest(world){return crypto.createHash('sha256').update(JSON.stringify(canonical(world))).digest('hex')}
function pathname(directory,id){if(!ID.test(id))throw Object.assign(Error('invalid_journal_id'),{status:400});return path.join(directory,id+'.jsonl')}
function encodeFrame(world,previous,revision,events){
 const full=Buffer.from(JSON.stringify(world));if(full.length>MAX_STATE_BYTES)throw Error('snapshot_too_large');
 let encoding='full',raw=full,compressed=zlib.deflateRawSync(full,{level:1});
 if(previous&&revision%64!==0){const candidate=Buffer.from(JSON.stringify(Delta.diff(previous,world)));if(candidate.length<=MAX_STATE_BYTES){const packed=zlib.deflateRawSync(candidate,{level:1});if(packed.length<compressed.length){encoding='delta';raw=candidate;compressed=packed}}}
 return {type:'frame',revision,events,encoding,rawBytes:raw.length,worldHash:worldDigest(world),data:compressed.toString('base64')};
}
function create(directory,id,adminHash,metadata,initialEvents=[],options={}){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const file=pathname(directory,id),fd=fs.openSync(file,'wx',0o600),snapshots=options.initialWorld!==undefined;
 let head=ZERO,bytes=0,eventCount=0,lastRevision=-1,lastWorld=null,closed=false,failed=false;
 function write(payload){
  const next=hash(head,payload),buffer=Buffer.from(JSON.stringify({previous:head,payload,hash:next})+'\n');
  if(bytes+buffer.length>((payload.type==='events'||payload.type==='frame')?MAX_BYTES-4096:MAX_BYTES))throw Error('journal_limit');
  let offset=0;while(offset<buffer.length){const n=fs.writeSync(fd,buffer,offset,buffer.length-offset);if(n<=0)throw Error('journal_write_failed');offset+=n}
  fs.fsyncSync(fd);bytes+=buffer.length;head=next;
 }
 function append(revision,events,world){
  if(closed||failed)throw Error('journal_unavailable');
  if(!Number.isSafeInteger(revision)||revision<0||events.some((e,i)=>e.seq!==eventCount+i+1))throw Error('journal_event_sequence');
  if(snapshots&&(!world||revision!==lastRevision+1))throw Error('journal_revision_sequence');
  if(!snapshots&&!events.length)return;
  try{write(snapshots?encodeFrame(world,lastWorld,revision,events):{type:'events',revision,events});eventCount+=events.length;if(snapshots){lastRevision=revision;lastWorld=world}}catch(error){failed=true;throw error}
 }
 try{write({type:'header',version:snapshots?2:1,sessionId:id,adminHash,metadata});append(0,initialEvents,options.initialWorld)}catch(error){try{fs.closeSync(fd)}catch{};throw error}
 return {append,info(){return {enabled:true,healthy:!failed,eventCount,snapshots}},invalidate(){failed=true},
  close(revision,reason){if(closed)return;try{if(!failed)write({type:'closed',revision,eventCount,reason})}catch{failed=true}finally{closed=true;try{fs.closeSync(fd)}catch{failed=true}}}};
}
function parse(directory,id,tokenHash){
 const file=pathname(directory,id);let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0))}catch(e){if(e.code==='ENOENT')throw Object.assign(Error('journal_not_found'),{status:404});throw e}
 let raw;try{const size=fs.fstatSync(fd).size;if(size>MAX_BYTES)throw Error('journal_too_large');raw=fs.readFileSync(fd)}finally{fs.closeSync(fd)}
 const lastNewline=raw.lastIndexOf(10),partialTail=lastNewline!==raw.length-1;if(lastNewline<0)throw Error('journal_incomplete_header');
 const lines=raw.subarray(0,lastNewline).toString('utf8').split('\n');let head=ZERO,header=null,eventCount=0,revision=0,lastFrame=-1,footer=null,records=[];
 for(let i=0;i<lines.length;i++){
  let row;try{row=JSON.parse(lines[i])}catch{throw Error('journal_corrupt')}
  if(!row||row.previous!==head||!row.payload||row.hash!==hash(head,row.payload))throw Error('journal_corrupt');head=row.hash;const p=row.payload;
  if(i===0){if(p.type!=='header'||![1,2].includes(p.version)||p.sessionId!==id||typeof p.adminHash!=='string'||!/^[0-9a-f]{64}$/.test(p.adminHash))throw Error('journal_corrupt');
   const expected=Buffer.from(p.adminHash,'hex'),actual=Buffer.from(tokenHash,'hex');if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))throw Object.assign(Error('unauthorized'),{status:401});header=p;continue}
  if(footer)throw Error('journal_corrupt');
  if(p.type==='events'||p.type==='frame'){
   if(!Number.isSafeInteger(p.revision)||p.revision<revision||!Array.isArray(p.events)||(p.type==='events'&&!p.events.length)||(p.type==='events'&&header.version!==1)||(p.type==='frame'&&(header.version!==2||p.revision!==lastFrame+1)))throw Error('journal_corrupt');
   revision=p.revision;if(p.type==='frame')lastFrame=p.revision;
   for(const event of p.events)if(!event||event.seq!==++eventCount)throw Error('journal_corrupt');records.push(p);
  }else if(p.type==='closed'){
   if(!Number.isSafeInteger(p.revision)||p.revision<revision||(header.version===2&&p.revision!==lastFrame)||p.eventCount!==eventCount||!['deleted','server_shutdown'].includes(p.reason))throw Error('journal_corrupt');revision=p.revision;footer=p;
  }else throw Error('journal_corrupt');
 }
 return {header,records,partialTail,eventCount,revision,lastFrame,footer};
}
function summary(id,p){return {version:p.header.version,sessionId:id,metadata:p.header.metadata,eventCount:p.eventCount,lastRecordedRevision:p.revision,closed:!!p.footer,closeReason:p.footer?.reason??null,partialTail:p.partialTail,snapshots:p.header.version===2};}
function read(directory,id,tokenHash,after,limit){
 const p=parse(directory,id,tokenHash),events=[];for(const record of p.records)for(const event of record.events)if(event.seq>after&&events.length<limit)events.push({revision:record.revision,event});
 return {...summary(id,p),events,nextAfter:events.length&&events.at(-1).event.seq<p.eventCount?events.at(-1).event.seq:null};
}
function decodeFrame(record,previous){
 if((record.revision===0&&record.encoding!=='full')||!['full','delta'].includes(record.encoding)||!Number.isSafeInteger(record.rawBytes)||record.rawBytes<1||record.rawBytes>MAX_STATE_BYTES||typeof record.data!=='string'||record.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(record.data)||!/^[0-9a-f]{64}$/.test(record.worldHash))throw Error('journal_corrupt');
 let raw,value;try{raw=zlib.inflateRawSync(Buffer.from(record.data,'base64'),{maxOutputLength:MAX_STATE_BYTES});if(raw.length!==record.rawBytes)throw Error();value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw Error('journal_corrupt')}
 let world;try{world=record.encoding==='full'?value:Delta.apply(previous,value)}catch{throw Error('journal_corrupt')}
 if(!world||typeof world!=='object'||Array.isArray(world)||!Array.isArray(world.events)||worldDigest(world)!==record.worldHash)throw Error('journal_corrupt');
 const prior=previous?.events||[];if(world.events.length!==prior.length+record.events.length||JSON.stringify(world.events.slice(0,prior.length))!==JSON.stringify(prior)||JSON.stringify(world.events.slice(prior.length))!==JSON.stringify(record.events))throw Error('journal_corrupt');
 return world;
}
function replay(directory,id,tokenHash,after,limit,through){
 const p=parse(directory,id,tokenHash);if(p.header.version!==2)throw Object.assign(Error('snapshots_not_recorded'),{status:409});
 if(p.lastFrame<0)throw Object.assign(Error('snapshot_not_available'),{status:409});
 const end=through===null?p.lastFrame:through;if(end>p.lastFrame||after>end)throw Object.assign(Error('invalid_replay_revision'),{status:400});
 let world=null,frames=[],bytes=0;for(const record of p.records){if(record.revision>end)break;world=decodeFrame(record,world);
  if(record.revision>after){const size=Buffer.byteLength(JSON.stringify(world));if(size>MAX_PAGE_BYTES)throw Object.assign(Error('snapshot_page_too_large'),{status:413});if(frames.length&&(frames.length>=limit||bytes+size>MAX_PAGE_BYTES))break;frames.push({revision:record.revision,world});bytes+=size}
 }
 const last=frames.length?frames.at(-1).revision:after;
 return {...summary(id,p),frames,through:end,nextAfter:last<end?last:null};
}
module.exports={create,read,replay,MAX_BYTES,MAX_STATE_BYTES,MAX_PAGE_BYTES};
