'use strict';
// One child process per world; this is not an OS security sandbox.
const http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),{fork}=require('node:child_process');
const {WebSocket,WebSocketServer}=require('ws'),{createServer}=require('./world-server');
const {requestOriginError}=require('./request-origin');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/;
function createSupervisor({maxWorkers=4,maxSessions=32,startTimeoutMs=10000,requestTimeoutMs=30000,worldOptions={}}={}){
 for(const [name,n,max] of [['worker limit',maxWorkers,32],['session limit',maxSessions,32],['startup timeout',startTimeoutMs,60000],['request timeout',requestTimeoutMs,120000]])if(!Number.isInteger(n)||n<1||n>max)throw Error('invalid '+name);
 const allowed=['maxHistoryBytes','catalogPath','physicsBackend','taskBackend','communicationBackend','navigationBackend','journalDir','replayJournal'];
 if(!worldOptions||typeof worldOptions!=='object'||Array.isArray(worldOptions)||Object.keys(worldOptions).some(k=>!allowed.includes(k)))throw Error('invalid worker options');
 const options=structuredClone(worldOptions),control=createServer(options),routes=new Map(),workers=new Set();
 const wss=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});let closing=false;
 function json(res,status,value){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
 function originAllowed(req){return requestOriginError(req)===null}
 function headers(req,port,length){const out={host:`127.0.0.1:${port}`};for(const name of ['authorization','content-type','accept','content-length'])if(req.headers[name]!==undefined)out[name]=req.headers[name];if(req.headers.origin)out.origin=`http://127.0.0.1:${port}`;if(length!==undefined)out['content-length']=length;return out}
 function responseHeaders(upstream){return {'content-type':upstream.headers['content-type']||'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}}
 function retire(entry){
  if(entry.retiring)return;entry.retiring=true;entry.state='retiring';
  if(entry.sessionId&&routes.get(entry.sessionId)===entry)routes.delete(entry.sessionId);
  if(entry.exited)return;
  entry.child.kill('SIGTERM');const timer=setTimeout(()=>{if(!entry.exited)entry.child.kill('SIGKILL')},3500);timer.unref();entry.done.finally(()=>clearTimeout(timer));
 }
 function launch(){
  if(closing)throw Object.assign(Error('supervisor_closing'),{status:503});
  if(workers.size>=maxWorkers)throw Object.assign(Error('world_worker_limit'),{status:429});
  if(routes.size+[...workers].filter(w=>!w.sessionId).length>=maxSessions)throw Object.assign(Error('session_limit'),{status:429});
  const child=fork(path.join(__dirname,'world-worker.js'),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
  const entry={child,state:'starting',sessionId:null,exited:false,retiring:false};workers.add(entry);
  let finishExit;entry.done=new Promise(r=>finishExit=r);
  const ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{retire(entry);reject(Object.assign(Error('world_worker_start_timeout'),{status:503}))},startTimeoutMs);timer.unref();
   child.once('message',message=>{if(message?.type!=='ready'||!Number.isInteger(message.port)||message.port<1||message.port>65535){clearTimeout(timer);retire(entry);reject(Object.assign(Error('world_worker_start_failed'),{status:503}));return}clearTimeout(timer);entry.port=message.port;entry.state='ready';resolve(entry)});
   child.once('error',()=>{clearTimeout(timer);retire(entry);reject(Object.assign(Error('world_worker_start_failed'),{status:503}))});
   child.once('exit',()=>{clearTimeout(timer);reject(Object.assign(Error('world_worker_start_failed'),{status:503}))});
  });
  child.once('close',()=>{entry.exited=true;workers.delete(entry);if(!entry.retiring&&entry.sessionId&&routes.get(entry.sessionId)===entry){entry.state='failed';for(const client of wss.clients)if(client.worker===entry)client.close(1011,'world process exited')}finishExit()});
  child.send({type:'initialize',options},error=>{if(error)retire(entry)});return {entry,ready};
 }
 function readBody(req,limit){return new Promise((resolve,reject)=>{
  let size=0,parts=[],settled=false;const fail=(status,error)=>{if(settled)return;settled=true;parts=[];req.resume();reject(Object.assign(Error(error),{status}))};
  if(Number(req.headers['content-length'])>limit)return fail(413,'body too large');
  req.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>limit)fail(413,'body too large');else parts.push(chunk)});
  req.on('end',()=>{if(!settled){settled=true;resolve(Buffer.concat(parts))}});req.on('aborted',()=>fail(400,'request_aborted'));req.on('error',()=>fail(400,'request_aborted'));
 })}
 function createRequest(req,entry,body){return new Promise((resolve,reject)=>{
  const up=http.request({hostname:'127.0.0.1',port:entry.port,path:req.url,method:req.method,headers:headers(req,entry.port,body.length)},response=>{
   let bytes=0,chunks=[];response.on('data',chunk=>{bytes+=chunk.length;if(bytes>32*1024*1024){up.destroy();reject(Object.assign(Error('world_response_too_large'),{status:502}))}else chunks.push(chunk)});
   response.on('end',()=>resolve({status:response.statusCode,headers:responseHeaders(response),body:Buffer.concat(chunks)}));response.on('error',()=>reject(Object.assign(Error('world_process_unavailable'),{status:503})));
  });
  up.setTimeout(requestTimeoutMs,()=>{up.destroy();retire(entry);reject(Object.assign(Error('world_worker_timeout'),{status:504}))});
  up.on('error',()=>reject(Object.assign(Error('world_process_unavailable'),{status:503})));up.end(body);
 })}
 async function createWorld(req,res,limit){
  const body=await readBody(req,limit);if(req.aborted||res.destroyed)return;
  const {entry,ready}=launch();const cancel=()=>{if(!res.writableFinished)retire(entry)};res.once('close',cancel);
  try{
   await ready;if(entry.retiring||res.destroyed)return;
   const result=await createRequest(req,entry,body);
   if(result.status>=200&&result.status<300){let value;try{value=JSON.parse(result.body)}catch{}if(!value||!UUID.test(value.sessionId)||typeof value.adminToken!=='string'||!TOKEN.test(value.adminToken)||routes.has(value.sessionId)||entry.exited)throw Object.assign(Error('invalid_world_response'),{status:502});entry.sessionId=value.sessionId;entry.adminHash=crypto.createHash('sha256').update(value.adminToken).digest('hex');entry.state='active';routes.set(entry.sessionId,entry)}else retire(entry);
   if(res.destroyed){retire(entry);return}res.writeHead(result.status,result.headers);res.end(result.body);
  }catch(error){retire(entry);throw error}finally{if(res.writableFinished||entry.retiring)res.removeListener('close',cancel);else res.once('finish',()=>res.removeListener('close',cancel))}
 }
 function proxy(req,res,entry){
  let deadline=null,responded=false;const clearDeadline=()=>clearTimeout(deadline);
  const up=http.request({hostname:'127.0.0.1',port:entry.port,path:req.url,method:req.method,headers:headers(req,entry.port)},response=>{
   responded=true;clearDeadline();res.writeHead(response.statusCode,responseHeaders(response));response.pipe(res);response.on('error',()=>res.destroy());
   response.once('end',()=>{if(req.method==='DELETE'&&new URL(req.url,'http://localhost').pathname.split('/').filter(Boolean).join('/')==='sessions/'+entry.sessionId&&response.statusCode===200)retire(entry)});
  });
  up.once('finish',()=>{if(responded||up.destroyed)return;deadline=setTimeout(()=>{up.destroy();if(!res.headersSent)json(res,504,{error:'world_worker_timeout'});else res.destroy();entry.state='failed';entry.child.kill('SIGKILL')},requestTimeoutMs);deadline.unref()});up.once('close',clearDeadline);
  up.on('error',()=>{clearDeadline();if(res.writableEnded||res.destroyed)return;if(!res.headersSent)json(res,503,{error:entry.exited?'world_process_exited':'world_process_unavailable'});else res.destroy()});req.on('aborted',()=>up.destroy());res.on('close',()=>{if(!res.writableFinished)up.destroy()});req.pipe(up);
 }
 const server=http.createServer(async(req,res)=>{
  try{
   if(!originAllowed(req))return json(res,403,{error:'invalid_host_or_origin'});
   const url=new URL(req.url,'http://localhost'),parts=url.pathname.split('/').filter(Boolean);
   if(req.method==='GET'&&url.pathname==='/health'){const diagnostic=control.diagnostics();return json(res,200,{ok:true,...diagnostic,features:{...diagnostic.features,worldProcessIsolation:1},runtimeScope:'supervisor',worldProcesses:{limit:maxWorkers,sessionLimit:maxSessions,active:[...workers].filter(w=>w.state==='active').length,starting:[...workers].filter(w=>!w.sessionId).length,failed:[...routes.values()].filter(w=>w.state==='failed').length}})}
   if(req.method==='POST'&&(url.pathname==='/sessions'||parts.length===3&&parts[0]==='event-journals'&&parts[2]==='fork'))return await createWorld(req,res,url.pathname==='/sessions'?65536:16384);
   if(parts[0]==='sessions'&&parts[1]){
    const entry=routes.get(parts[1]);if(!entry)return json(res,404,{error:'session_not_found'});
    if(entry.state==='failed'||entry.exited){
     if(req.method==='DELETE'&&parts.length===2){const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];if(!token||crypto.createHash('sha256').update(token).digest('hex')!==entry.adminHash)return json(res,401,{error:'unauthorized'});retire(entry);return json(res,200,{ok:true})}
     return json(res,503,{error:'world_process_exited'});
    }
    return proxy(req,res,entry);
   }
   if(parts[0]==='event-journals'&&parts[1]){const entry=routes.get(parts[1]);if(entry&&!entry.exited&&entry.state==='active')return proxy(req,res,entry)}
   // Parent handles only static content, diagnostics and journals without a live owner.
   control.emit('request',req,res);
  }catch(error){json(res,error.status||500,{error:error.status?error.message:'supervisor_request_failed'})}
 });
 server.on('upgrade',(req,socket,head)=>{if(closing||req.url!=='/stream'||!originAllowed(req)||wss.clients.size>=64){socket.destroy();return}wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client,req))});
 function relaySend(target,data,binary){if(target.readyState!==WebSocket.OPEN)return;if(target.bufferedAmount>2*1024*1024){target.terminate();return}target.send(data,{binary},error=>{if(error)target.terminate()})}
 wss.on('connection',(client,req)=>{
  let upstream=null,subscribed=false;client.isAlive=true;client.on('pong',()=>client.isAlive=true);client.on('error',()=>{});
  const timer=setTimeout(()=>client.close(1008,'authentication timeout'),5000);timer.unref();
  client.on('close',()=>{clearTimeout(timer);if(upstream)upstream.terminate()});
  client.on('message',(raw,binary)=>{
   if(subscribed){if(upstream?.readyState!==WebSocket.OPEN)return client.close(1008,'invalid message');return relaySend(upstream,raw,binary)}
   let message;try{if(binary)throw Error();message=JSON.parse(raw.toString())}catch{return client.close(1008,'invalid message')}
   if(message?.type!=='subscribe'||typeof message.sessionId!=='string'||typeof message.token!=='string'||!TOKEN.test(message.token))return client.close(1008,'invalid subscription');
   const entry=routes.get(message.sessionId);if(!entry||entry.exited||entry.state!=='active')return client.close(1008,'world unavailable');subscribed=true;clearTimeout(timer);client.worker=entry;
   upstream=new WebSocket(`ws://127.0.0.1:${entry.port}/stream`,{headers:req.headers.origin?{origin:`http://127.0.0.1:${entry.port}`}:{},maxPayload:32*1024*1024,perMessageDeflate:false});
   upstream.once('open',()=>{if(client.readyState!==WebSocket.OPEN)return upstream.terminate();relaySend(upstream,raw,false)});
   upstream.on('message',(data,isBinary)=>relaySend(client,data,isBinary));upstream.on('error',()=>client.close(1011,'world connection failed'));
   upstream.on('close',(code,reason)=>{if(client.readyState===WebSocket.OPEN)client.close(code===1005||code===1006?1011:code,reason.toString().slice(0,100))});
  });
 });
 const heartbeat=setInterval(()=>{for(const client of wss.clients){if(!client.isAlive){client.terminate();continue}client.isAlive=false;client.ping()}},20000);heartbeat.unref();
 server.inspectWorkers=()=>[...new Set([...workers,...routes.values()])].map(w=>({sessionId:w.sessionId,pid:w.child.pid,state:w.state,exited:w.exited}));
 const closeBase=server.close.bind(server);server.close=function(callback){
  closing=true;clearInterval(heartbeat);for(const client of wss.clients)client.terminate();const pending=[...workers];for(const entry of pending)retire(entry);control.close(()=>{});
  closeBase(error=>{Promise.all(pending.map(w=>w.done)).then(()=>{routes.clear();wss.close();callback?.(error)})});server.closeIdleConnections?.();return server;
 };return server;
}
if(require.main===module){
 const port=Number(process.env.WORLD_PORT||8787),bind=process.env.WORLD_BIND||'127.0.0.1',maxWorkers=Number(process.env.BOX_WORLD_WORKERS||4);
 if(!Number.isInteger(port)||port<1||port>65535||!['127.0.0.1','0.0.0.0'].includes(bind))throw Error('invalid world listener');
 const server=createSupervisor({maxWorkers});server.listen(port,bind,()=>console.log(`Isolated world API: http://${bind}:${port}`));
 let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(()=>process.exit(0));const deadline=setTimeout(()=>process.exit(1),5000);deadline.unref()};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
module.exports={createSupervisor};
