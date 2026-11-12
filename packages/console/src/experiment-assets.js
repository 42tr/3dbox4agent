(function(root){
'use strict';
const MAX=50*1024*1024,cache=new Map();
function validate(ref){if(!ref||typeof ref!=='object'||Array.isArray(ref)||typeof ref.file!=='string'||!/^policy-acceptance-codex-[A-Za-z0-9-]+\.json$/.test(ref.file)||typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256)||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>MAX)throw Error('验收数据引用无效');return {file:ref.file,sha256:ref.sha256,bytes:ref.bytes}}
async function fetchAsset(value,base){
 const ref=validate(value),source=new URL(base),url=new URL(ref.file,source);
 if(!['http:','https:'].includes(source.protocol)||url.origin!==source.origin||url.username||url.password)throw Error('请通过本机 HTTP 服务或线上地址查看验收数据');
 const key=url.href+'|'+ref.sha256+'|'+ref.bytes;
 if(!cache.has(key))cache.set(key,(async()=>{
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),60000);
  try{
   const response=await fetch(url,{signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});if(!response.ok||!response.body)throw Error('验收数据读取失败');
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>ref.bytes)throw Error('验收数据大小不符');chunks.push(value)}}catch(error){await reader.cancel();throw error}
   if(size!==ref.bytes)throw Error('验收数据大小不符');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
   if(!root.crypto?.subtle)throw Error('当前环境无法校验验收数据');const hash=[...new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
   if(hash!==ref.sha256)throw Error('验收数据校验和不符');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{clearTimeout(deadline)}
 })().catch(error=>{cache.delete(key);throw error}));
 return structuredClone(await cache.get(key));
}
const api={validate,fetchAsset};if(typeof module!=='undefined')module.exports=api;else root.SandboxExperimentAssets=api;
})(typeof globalThis!=='undefined'?globalThis:this);
