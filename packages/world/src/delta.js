/* Copy-on-write JSON delta codec. A delta always applies to one exact base revision. */
(function(root){
'use strict';
const BLOCKED=new Set(['__proto__','prototype','constructor']);
function container(value){return value!==null&&typeof value==='object'}
function replacement(value){return [0,value]}
function compact(value,patch){const full=replacement(value);return JSON.stringify(patch).length<JSON.stringify(full).length?patch:full}
function diff(before,after){
 if(Object.is(before,after))return null;
 if(Array.isArray(before)&&Array.isArray(after)){const changes=Object.create(null);let changed=before.length!==after.length;for(let i=0;i<after.length;i++){const next=i<before.length?diff(before[i],after[i]):replacement(after[i]);if(next!==null){changes[i]=next;changed=true}}return changed?compact(after,[2,after.length,changes]):null}
 if(container(before)&&container(after)&&!Array.isArray(before)&&!Array.isArray(after)){const changes=Object.create(null);let changed=false;for(const key of Object.keys(before))if(!Object.hasOwn(after,key)){changes[key]=[3];changed=true}for(const key of Object.keys(after)){if(BLOCKED.has(key))throw Error('unsafe delta key');const next=Object.hasOwn(before,key)?diff(before[key],after[key]):replacement(after[key]);if(next!==null){changes[key]=next;changed=true}}return changed?compact(after,[1,changes]):null}
 return replacement(after);
}
function apply(base,patch,depth=0){
 if(patch===null)return base;if(depth>64||!Array.isArray(patch)||!Number.isInteger(patch[0]))throw Error('invalid delta');
 if(patch[0]===0&&patch.length===2)return patch[1];
 if(patch[0]===1&&patch.length===2&&container(base)&&!Array.isArray(base)&&container(patch[1])&&!Array.isArray(patch[1])){const out={...base};for(const key of Object.keys(patch[1])){if(BLOCKED.has(key))throw Error('unsafe delta key');const entry=patch[1][key];if(Array.isArray(entry)&&entry.length===1&&entry[0]===3){if(!Object.hasOwn(out,key))throw Error('invalid deletion');delete out[key]}else{if(!Object.hasOwn(out,key)&&(!Array.isArray(entry)||entry[0]!==0))throw Error('missing base key');out[key]=apply(out[key],entry,depth+1)}}return out}
 if(patch[0]===2&&patch.length===3&&Array.isArray(base)&&Number.isSafeInteger(patch[1])&&patch[1]>=0&&patch[1]<=20000&&container(patch[2])&&!Array.isArray(patch[2])){const out=base.slice(0,patch[1]),oldLength=out.length;out.length=patch[1];const keys=Object.keys(patch[2]);for(const key of keys){if(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=patch[1])throw Error('invalid array index');const index=Number(key),entry=patch[2][key];if(index>=oldLength&&(!Array.isArray(entry)||entry[0]!==0))throw Error('missing array base');out[index]=apply(out[index],entry,depth+1)}for(let i=oldLength;i<out.length;i++)if(!Object.hasOwn(out,i))throw Error('missing array item');return out}
 throw Error('invalid delta');
}
const api={diff,apply};if(typeof module!=='undefined')module.exports=api;else root.SandboxDelta=api;
})(typeof globalThis!=='undefined'?globalThis:this);
