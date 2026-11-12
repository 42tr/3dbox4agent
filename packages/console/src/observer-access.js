(function(root){
'use strict';
function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['format','sessionId','observerToken'].includes(k))||value.format!=='3dbox-observer-access-v1'||typeof value.sessionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.sessionId)||typeof value.observerToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.observerToken))throw Error('不是有效的只读观察凭据');
 return {format:value.format,sessionId:value.sessionId,observerToken:value.observerToken};
}
const api={validate};if(typeof module!=='undefined')module.exports=api;else root.SandboxObserverAccess=api;
})(typeof globalThis!=='undefined'?globalThis:this);
