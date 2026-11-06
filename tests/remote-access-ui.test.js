'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('src/app.html','utf8');
const start=html.lastIndexOf('\nreset();const catalogReplayHash=');
assert(start>=0);
const bootstrap=html.slice(start,html.indexOf('\n</script>',start));

async function boot(address,{available=true,opener=false}={}){
 const nodes=new Map(),requests=[],handoffs=[];
 const context={
  location:new URL(address),window:{opener:opener?{}:null},
  $(id){if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:''});return nodes.get(id)},
  reset(){},render(){},loadReplay(){},history:{replaceState(){}},
  request(route){requests.push(route);return available?Promise.resolve({protocol:3,features:{observerAccess:1,decisionPreconditions:1,worldProcessIsolation:1},worldProcesses:{limit:2},runtime:{physicsBackend:'rust',taskBackend:'rust',communicationBackend:'rust',navigationBackend:'rust'}}):Promise.reject(Error('not a world service'))},
  SandboxCatalogHandoff:{receiver(...args){handoffs.push(args)}},
  serverSettingsAvailable:false,planGuardsAvailable:false,observerAvailable:false,journalAvailable:false,raySettingsAvailable:false,taskBackend:'js',communicationBackend:'js',navigationBackend:'js',
 };
 vm.runInNewContext(bootstrap,context);
 await new Promise(resolve=>setImmediate(resolve));
 return {context,nodes,requests,handoffs};
}

(async()=>{
 for(const address of ['https://3dbox.42tr.cn/','http://192.0.2.1:8787/','http://127.0.0.1:8787/']){
  const result=await boot(address);
  assert.deepEqual(result.requests,['/health']);
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
 console.log('HTTPS domain, public IP, local bootstrap, static preview and HTTPS replay handoff passed');
})().catch(error=>{console.error(error);process.exitCode=1});
