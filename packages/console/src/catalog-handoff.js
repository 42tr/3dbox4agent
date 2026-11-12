(function(root){
'use strict';
const READY='3dbox-catalog-ready', DATA='3dbox-catalog-data', DONE='3dbox-catalog-done';
function sender(host,target,origin,nonce,timeout=40000){
 let ready=false,delivered=false,sent=false,settled=false,payload,resolve,reject;
 const promise=new Promise((a,b)=>{resolve=a;reject=b});
 function finish(error){if(settled)return;settled=true;host.removeEventListener('message',onMessage);clearTimeout(timer);error?reject(error):resolve()}
 function send(){if(ready&&delivered&&!sent&&!settled){sent=true;target.postMessage({type:DATA,nonce,payload},origin)}}
 function onMessage(e){if(e.origin!==origin||e.source!==target||!e.data||e.data.nonce!==nonce)return;if(e.data.type===READY){ready=true;send()}else if(e.data.type===DONE&&sent){if(e.data.ok===true)finish();else finish(Error(typeof e.data.error==='string'?e.data.error.slice(0,300):'回放加载失败'))}}
 host.addEventListener('message',onMessage);const timer=setTimeout(()=>finish(Error('回放页面未响应，请检查弹窗设置')),timeout);
 return {promise,deliver(value){payload=value;delivered=true;send()},cancel(){finish(Error('回放已取消'))}};
}
function receiver(host,origin,nonce,accept){
 const parent=host.opener;if(!parent||!/^[0-9a-f]{32}$/.test(nonce))return false;
 function onMessage(e){if(e.origin!==origin||e.source!==parent||!e.data||e.data.type!==DATA||e.data.nonce!==nonce)return;host.removeEventListener('message',onMessage);try{accept(e.data.payload);parent.postMessage({type:DONE,nonce,ok:true},origin)}catch(error){parent.postMessage({type:DONE,nonce,ok:false,error:String(error.message||error).slice(0,300)},origin)}}
 host.addEventListener('message',onMessage);parent.postMessage({type:READY,nonce},origin);return true;
}
const api={sender,receiver};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SandboxCatalogHandoff=api;
})(typeof globalThis!=='undefined'?globalThis:this);
