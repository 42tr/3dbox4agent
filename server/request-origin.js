'use strict';

// Public domains and IPs are valid authorities. Browser requests must use the
// same authority as the page; HTTPS may terminate at a reverse proxy.
function requestOriginError(req){
 const host=req.headers.host;
 if(typeof host!=='string'||!host||/[\s\\/?#@%,]/.test(host))return 'invalid_host';
 try{
  const target=new URL(`http://${host}`);
  if(!target.hostname||target.username||target.password||target.pathname!=='/'||target.search||target.hash)return 'invalid_host';
 }catch{return 'invalid_host'}
 const origin=req.headers.origin;
 if(origin===undefined)return null;
 if(typeof origin!=='string')return 'invalid_origin';
 try{
  const source=new URL(origin);
  if(!['http:','https:'].includes(source.protocol)||source.origin!==origin||source.origin!==new URL(`${source.protocol}//${host}`).origin)return 'invalid_origin';
 }catch{return 'invalid_origin'}
 return null;
}

module.exports={requestOriginError};
