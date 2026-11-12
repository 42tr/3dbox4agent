'use strict';
const fs=require('node:fs'),path=require('node:path');
const NAME=/^policy-acceptance-codex-[A-Za-z0-9-]+\.json$/;
const MAX=50*1024*1024;
function serve(req,res,url,root=path.join(__dirname,'../../../examples/experiments')){
 const name=url.pathname.slice(1);if(!['GET','HEAD'].includes(req.method)||!NAME.test(name))return false;
 function unavailable(){if(res.headersSent)return res.destroy();res.writeHead(404,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end('{"error":"experiment_asset_not_available"}')}
 try{
  const manifest=path.join(root,'policy-acceptance-public-codex.json'),info=fs.lstatSync(manifest);if(!info.isFile()||info.size>16384)throw Error();
  const files=JSON.parse(fs.readFileSync(manifest,'utf8')).files,ref=files&&Object.hasOwn(files,name)?files[name]:null;
  if(!ref||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>MAX||typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error();
  const file=path.join(root,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size!==ref.bytes)throw Error();
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':stat.size,'cache-control':'no-store','x-content-type-options':'nosniff'});
  if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',unavailable).pipe(res);
 }catch{unavailable()}return true;
}
module.exports={serve};
