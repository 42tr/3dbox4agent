'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(process.argv[2]||'src/app.html','utf8');
const start=html.lastIndexOf('\nreset();const catalogReplayHash=');
assert(start>=0);
const bootstrap=html.slice(start,html.indexOf('\n</script>',start));
const transport=html.slice(html.indexOf('function controlFetch('),html.indexOf('function stopRemoteAccess('));
const stream=html.slice(html.indexOf('function startStream('),html.indexOf('async function remoteAction('));

async function boot(address,{available=true,opener=false}={}){
 const nodes=new Map(),requests=[],handoffs=[],streams=[];
 const context={
  location:new URL(address),window:{opener:opener?{}:null},
  $(id){if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:''});return nodes.get(id)},
  reset(){},render(){},loadReplay(){},history:{replaceState(){}},
  async fetch(route,options){requests.push({route,options});if(!available)throw Error('not a world service');return {ok:true,json:async()=>({protocol:3,features:{observerAccess:1,decisionPreconditions:1,worldProcessIsolation:1},worldProcesses:{limit:2},runtime:{physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust'}})}},
  WebSocket:class {constructor(url){streams.push(url)}},
  remoteId:'session',remoteToken:'test-token',remoteObserver:false,observerEnded:false,remoteFailure:false,epoch:1,socket:null,
  SandboxCatalogHandoff:{receiver(...args){handoffs.push(args)}},
  serverSettingsAvailable:false,planGuardsAvailable:false,observerAvailable:false,journalAvailable:false,raySettingsAvailable:false,taskBackend:'js',communicationBackend:'js',navigationBackend:'js',
 };
 vm.runInNewContext(transport+stream+bootstrap,context);
 await new Promise(resolve=>setImmediate(resolve));
 return {context,nodes,requests,handoffs,streams};
}

(async()=>{
 for(const address of ['https://3dbox.42tr.cn/','http://192.0.2.1:8787/','http://127.0.0.1:8787/']){
  const result=await boot(address);
  assert.deepEqual(result.requests.map(request=>request.route),['/control/world/health']);
  await result.context.request('/sessions/session/step','POST',{count:1});
  assert.equal(result.requests[1].route,'/control/sessions/session/step');
  assert.equal(result.requests[1].options.headers.authorization,'Bearer test-token');
  result.context.startStream('session','test-token',1);
  const url=new URL(address);
  assert.deepEqual(result.streams,[(url.protocol==='https:'?'wss:':'ws:')+'//'+url.host+'/stream']);
  assert.equal(result.nodes.get('connect').hidden,false);
  assert.equal(result.context.observerAvailable,true);
  assert.equal(result.context.raySettingsAvailable,true);
 }
 const staticPage=await boot('https://show.42tr.cn/3dbox4agent/',{available:false});
 assert(!staticPage.nodes.has('connect'));
 const file=await boot('file:///tmp/index.html');assert.deepEqual(file.requests,[]);
 const nonce='0123456789abcdef0123456789abcdef';
 const replay=await boot('https://3dbox.42tr.cn/#catalog-replay='+nonce,{opener:true});
 assert.equal(replay.handoffs.length,1);
 assert.equal(replay.handoffs[0][1],'https://3dbox.42tr.cn');
 assert.equal(replay.handoffs[0][2],nonce);
 console.log('Console routes HTTP through Control and WebSocket to World on HTTPS, public IP and loopback; static preview and replay handoff passed');
})().catch(error=>{console.error(error);process.exitCode=1});
