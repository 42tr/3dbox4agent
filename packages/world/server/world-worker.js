'use strict';
// A supervisor-owned process contains exactly one authoritative world session.
const {createServer}=require('./world-server');
if(!process.send)throw Error('world worker requires an IPC parent');
let server,started=false,stopping=false;
function shutdown(){
 if(stopping)return;stopping=true;
 const deadline=setTimeout(()=>process.exit(1),3000);deadline.unref();
 if(!server)process.exit(0);
 server.close(()=>{clearTimeout(deadline);process.exit(0)});server.closeIdleConnections?.();
}
process.once('message',message=>{
 if(started||message?.type!=='initialize')return shutdown();started=true;
 try{
  server=createServer({...message.options,maxSessions:1});
  server.on('error',()=>process.exit(1));
  server.listen(0,'127.0.0.1',()=>{if(!process.connected)return shutdown();process.send({type:'ready',port:server.address().port})});
 }catch{process.exit(1)}
});
process.on('disconnect',shutdown);process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
