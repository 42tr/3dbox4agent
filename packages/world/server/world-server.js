'use strict';
// World service with per-session bearer credentials.
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const E=require('../src/world-core');
const WorldRuntime=require('../src/world-runtime');
const ControlApi=require('../src/control-api');
const Elevation=require('../src/elevation');
const Replay=require('../src/replay');
const Recording=require('../src/recording-context');
const PublicExperimentAssets=require('./public-experiment-assets');
const {requestOriginError}=require('./request-origin');
const {createControlForwarder}=require('../../control/src/control-http-forward');
const SceneDiagnostics=require('../src/scene-diagnostics');
const Delta=require('../src/delta');
const StreamProtobuf=require('../src/stream-protobuf');
const Journal=require('./event-journal');
const {WebSocketServer,WebSocket}=require('ws');
const MAX_SESSIONS=32, MAX_BODY=16384, MAX_STEPS=1000, MAX_FRAMES=2000, MAX_HISTORY_BYTES=16*1024*1024, STEP_MS=50;
function createServer({maxSessions=MAX_SESSIONS,maxHistoryBytes=MAX_HISTORY_BYTES,catalogPath=path.join(__dirname,'../../../.3dbox/experiment-catalog.sqlite3'),physicsBackend=process.env.BOX_PHYSICS_BACKEND||'wasm',taskBackend=process.env.BOX_TASK_BACKEND||'js',communicationBackend=process.env.BOX_COMM_BACKEND||'js',navigationBackend=process.env.BOX_NAV_BACKEND||'js',journalDir=process.env.BOX_EVENT_JOURNAL_DIR||null,replayJournal=process.env.BOX_REPLAY_JOURNAL==='1',journalApi=Journal,controlUrl}={}){
 const forwardControl=createControlForwarder(controlUrl);
 if(!Number.isInteger(maxSessions)||maxSessions<1||maxSessions>MAX_SESSIONS)throw Error('invalid session limit');
 if(!['wasm','rust'].includes(physicsBackend))throw Error('invalid physics backend');
 if(!['js','rust'].includes(taskBackend))throw Error('invalid task backend');
 if(!['js','rust'].includes(communicationBackend))throw Error('invalid communication backend');
 if(!['js','rust'].includes(navigationBackend))throw Error('invalid navigation backend');
 const Physics=physicsBackend==='rust'?require('./rust-physics'):require('./physics');
 const worldRuntime=WorldRuntime.fromEngine(E);
 const controlApi=ControlApi.createControlApi({runtime:worldRuntime});
 const TaskRules=taskBackend==='rust'?require('./rust-task-rules'):null;
 const NativeLedger=taskBackend==='rust'?require('./rust-world-ledger'):null;
 const NativeInitialization=taskBackend==='rust'&&communicationBackend==='rust'&&physicsBackend==='rust'?require('./rust-world-initialization'):null;
 const NativeControl=taskBackend==='rust'?require('./rust-world-control'):null;
 const NativeMotion=taskBackend==='rust'?require('./rust-world-motion'):null;
 const NativeTasks=taskBackend==='rust'?require('./rust-world-tasks'):null;
 const NativeActions=taskBackend==='rust'?require('./rust-world-actions'):null;
 const NativeResources=taskBackend==='rust'?require('./rust-world-resources'):null;
 const NativePerceptions=taskBackend==='rust'?require('./rust-world-perceptions'):null;
 const NativeEnvironment=taskBackend==='rust'?require('./rust-world-environment'):null;
 const NativeRequests=taskBackend==='rust'?require('./rust-world-requests'):null;
 const NativeDispatch=taskBackend==='rust'?require('./rust-world-dispatch'):null;
 const NativeReports=communicationBackend==='rust'?require('./rust-world-reports'):null;
 const NativePeer=communicationBackend==='rust'?require('./rust-world-peer'):null;
 const CommunicationRules=communicationBackend==='rust'?require('./rust-communication'):null;
 const Navigation=navigationBackend==='rust'?require('./rust-navigation'):null;
 if(!Number.isSafeInteger(maxHistoryBytes)||maxHistoryBytes<1)throw Error('invalid history limit');
 if(typeof catalogPath!=='string'||!catalogPath)throw Error('invalid catalog path');
 if(journalDir!==null&&(typeof journalDir!=='string'||!journalDir))throw Error('invalid journal directory');
 if(typeof replayJournal!=='boolean'||replayJournal&&!journalDir)throw Error('replay journal requires an event journal directory');
 if(!journalApi||typeof journalApi.create!=='function'||typeof journalApi.read!=='function'||replayJournal&&typeof journalApi.replay!=='function')throw Error('invalid journal API');
 let catalogWorkers=0;const sessions=new Map(),wss=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
 // Diagnostic fingerprint, not an attestation: files can change after modules load.
 const runtimeFiles=['examples/scenes/shore-surface.json','examples/scenes/shore-sea-state.json','examples/scenes/shore-echelons.json','examples/scenes/shore-rescue.json','src/echelons.js','packages/world/src/echelons.js','src/surface-domain.js','packages/world/src/surface-domain.js','src/operating-power.js','packages/world/src/operating-power.js','src/rescue.js','packages/world/src/rescue.js','src/construction.js','packages/world/src/construction.js','src/relay.js','packages/world/src/relay.js','src/materials.js','packages/world/src/materials.js','src/thermal.js','packages/world/src/thermal.js','src/elevation.js','packages/world/src/elevation.js','src/engine.js','src/world-core.js','packages/world/src/world-core.js','src/world-runtime.js','src/control-contracts.js','src/control-api.js','packages/world/src/world-runtime.js','packages/world/src/control-api.js','packages/control/src/control-contracts.js','src/recording-context.js','packages/world/src/recording-context.js','src/navigation.js','packages/world/src/navigation.js','src/sensors.js','packages/world/src/sensors.js','src/scene-diagnostics.js','packages/world/src/scene-diagnostics.js','src/replay.js','packages/world/src/replay.js','src/stream-protobuf.js','packages/world/src/stream-protobuf.js','proto/stream.proto','server/physics.js','packages/world/server/physics.js','server/world-server.js','server/world-worker.js','server/world-supervisor.js','server/public-experiment-assets.js','packages/world/server/public-experiment-assets.js','server/event-journal.js','packages/world/server/event-journal.js','server/world-transaction.js','packages/world/server/world-transaction.js','package-lock.json'],root=path.join(__dirname,'../../..');
 if(physicsBackend==='rust')runtimeFiles.push('server/rust-physics.js','packages/world/server/rust-physics.js');if(taskBackend==='rust')runtimeFiles.push('server/rust-task-rules.js','packages/world/server/rust-task-rules.js','server/rust-world-ledger.js','packages/world/server/rust-world-ledger.js','server/rust-world-control.js','packages/world/server/rust-world-control.js','server/rust-world-motion.js','packages/world/server/rust-world-motion.js','server/rust-world-execution.js','server/rust-world-tasks.js','packages/world/server/rust-world-tasks.js','server/rust-world-actions.js','packages/world/server/rust-world-actions.js','server/native-components.js','server/rust-world-dispatch.js','packages/world/server/rust-world-dispatch.js','server/rust-world-resources.js','packages/world/server/rust-world-resources.js','server/rust-world-perceptions.js','packages/world/server/rust-world-perceptions.js','server/rust-world-environment.js','packages/world/server/rust-world-environment.js','server/rust-world-requests.js','packages/world/server/rust-world-requests.js');if(communicationBackend==='rust')runtimeFiles.push('server/rust-communication.js','packages/world/server/rust-communication.js','server/rust-world-peer.js','packages/world/server/rust-world-peer.js','server/rust-world-reports.js','packages/world/server/rust-world-reports.js');if(navigationBackend==='rust')runtimeFiles.push('server/rust-navigation.js','packages/world/server/rust-navigation.js');if(physicsBackend==='rust'||taskBackend==='rust'||communicationBackend==='rust'||navigationBackend==='rust')runtimeFiles.push('rust/physics/Cargo.toml','rust/physics/Cargo.lock','rust/physics/src/lib.rs','rust/physics/src/navigation.rs','rust/physics/src/heightfield.rs','rust/physics/src/surface_domain.rs','rust/physics/src/materials.rs','rust/physics/src/construction.rs','rust/physics/src/relay.rs','rust/physics/src/thermal.rs','rust/physics/src/world_ledger.rs','rust/physics/src/world_control.rs','rust/physics/src/world_checkpoint.rs','rust/physics/src/world_route.rs','rust/physics/src/world_motion.rs','rust/physics/src/world_tasks.rs','rust/physics/src/world_execution.rs','rust/physics/src/world_actions.rs','rust/physics/src/world_peer.rs','rust/physics/src/world_reports.rs','rust/physics/src/ordered_map.rs','rust/physics/src/world_dispatch.rs','rust/physics/src/world_resources.rs','rust/physics/src/world_perceptions.rs','rust/physics/src/world_environment.rs','rust/physics/src/world_observations.rs','rust/physics/src/world_coordinator_observations.rs','rust/physics/src/world_task_advance.rs','rust/physics/src/world_action_advance.rs','rust/physics/src/operating_power.rs','rust/physics/src/world_power.rs','rust/physics/src/world_advance.rs','rust/physics/src/world_initialization.rs','server/rust-world-initialization.js','packages/world/server/rust-world-initialization.js','rust/physics/src/world_environment_planning.rs','rust/physics/src/world_requests.rs','rust/physics/target/release/box_physics.node');
 const runtime={operatingEnergyVersion:1,eventJournalEnabled:journalDir!==null,replayJournalEnabled:replayJournal,physicsBackend,taskBackend,communicationBackend,navigationBackend,worldLedgerBackend:taskBackend==='rust'?'rust':'js',worldMotionBackend:taskBackend==='rust'?'rust':'js',worldTasksBackend:taskBackend==='rust'?'rust':'js',worldExecutionBackend:taskBackend==='rust'?'rust':'js',worldActionsBackend:taskBackend==='rust'?'rust':'js',worldPeerBackend:communicationBackend==='rust'?'rust':'js',worldReportsBackend:communicationBackend==='rust'?'rust':'js',worldDispatchBackend:taskBackend==='rust'?'rust':'js',worldResourcesBackend:taskBackend==='rust'?'rust':'js',worldPerceptionsBackend:taskBackend==='rust'?'rust':'js',worldEnvironmentBackend:taskBackend==='rust'?'rust':'js',worldRequestsBackend:taskBackend==='rust'?'rust':'js',worldControlBackend:taskBackend==='rust'?'rust':'js',...((NativeLedger||NativePeer||physicsBackend==='rust')?{worldRollbackVersion:1,...(NativeLedger?{worldRouteVersion:1,worldCollisionReplanVersion:1,worldActivationPlanningVersion:1,worldAssignmentPlanningVersion:1,worldStationaryVersion:1,worldWorkVersion:1,worldActivationVersion:1,worldLifecycleVersion:1,worldAssignmentVersion:1,worldInterruptionVersion:1,worldRevocationVersion:1,worldEndingVersion:1,worldTaskEventsVersion:1,worldLifecycleEventsVersion:1,worldActivationEventsVersion:1,...(physicsBackend==='rust'?{worldRouteEventsVersion:1,worldStationaryEventsVersion:1}:{}),...(NativeReports?{worldProposalVersion:1}:{}),...(NativePeer?{worldAgentObservationVersion:1,worldCoordinatorObservationVersion:1,...(physicsBackend==='rust'?{worldTaskAdvanceVersion:1,worldActionAdvanceVersion:1,worldAdvanceVersion:1,worldInitializationVersion:1}:{}),worldEnvironmentPlanningVersion:1,worldTimeVersion:1,worldFinalizationVersion:1,worldPeerEventsVersion:1,worldDispatchEventsVersion:1,worldAutomaticDispatchVersion:1,...(physicsBackend==='rust'?{worldReportEventsVersion:1}:{})}:{})}:{})}:{}),...(physicsBackend==='rust'?{rapierNativeVersion:'0.22.0'}:{}),instanceId:crypto.randomUUID(),node:process.version,platform:process.platform,arch:process.arch,rapierPackage:JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('@dimforge/rapier3d-compat')),'package.json'),'utf8')).version,sourceSha256:Object.fromEntries(runtimeFiles.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]))};
 function json(res,status,data,observationMetric){const dataString=JSON.stringify(data);if(observationMetric){observationMetric.httpResponses++;observationMetric.httpBodyBytes+=Buffer.byteLength(dataString)}res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(dataString)}
 function body(req,limit=MAX_BODY){return new Promise((resolve,reject)=>{let size=0,chunks=[];req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(Object.assign(Error('body too large'),{status:413}));req.destroy()}else chunks.push(chunk)});req.on('end',()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{})}catch{reject(Object.assign(Error('invalid JSON'),{status:400}))}});req.on('error',reject)})}
 // Bounded raw JSON upload: preserve original bytes for content-addressed storage.
 function rawReport(req,limit){return new Promise((resolve,reject)=>{let size=0,chunks=[],ended=false;const length=req.headers['content-length'];
  if(length!==undefined&&Number(length)>limit){req.resume();reject(Object.assign(Error('catalog_report_too_large'),{status:413}));return}
  req.on('data',chunk=>{if(ended)return;size+=chunk.length;if(size>limit){ended=true;chunks=[];req.resume();reject(Object.assign(Error('catalog_report_too_large'),{status:413}))}else chunks.push(chunk)});
  req.on('end',()=>{if(!ended){ended=true;resolve(Buffer.concat(chunks))}});req.on('aborted',()=>{if(!ended){ended=true;reject(Object.assign(Error('upload_aborted'),{status:400}))}});req.on('error',error=>{if(!ended){ended=true;reject(error)}});
 })}
 // Run a bounded local catalog worker without a shell; the live world remains in this process.
 function catalog(args,input){
  if(catalogWorkers>=2)return Promise.reject(Object.assign(Error('catalog_busy'),{status:429}));catalogWorkers++;
  return new Promise((resolve,reject)=>{let settled=false,child,timer,output=[],bytes=0,stderr='';
   function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);catalogWorkers--;error?reject(error):resolve(value)}
   try{child=spawn(process.env.BOX_PYTHON||'python3',[path.join(__dirname,'../../../sdk/python/experiment_catalog.py'),'--db',catalogPath,...args],{stdio:['pipe','pipe','pipe']})}catch{finish(Object.assign(Error('catalog_unavailable'),{status:503}));return}
   timer=setTimeout(()=>{child.kill();finish(Object.assign(Error('catalog_timeout'),{status:503}))},30000);timer.unref();
   child.on('error',()=>finish(Object.assign(Error('catalog_unavailable'),{status:503})));
   child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>50*1024*1024+4096){child.kill();finish(Object.assign(Error('catalog_output_too_large'),{status:500}))}else output.push(chunk)});
   child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString('utf8')});child.stdin.on('error',()=>{});
   child.on('close',code=>{if(code!==0){const missing=stderr.includes('report not found'),invalid=stderr.includes('invalid UTF-8 JSON')||stderr.includes('expected a 3dbox report format');finish(Object.assign(Error(missing?'catalog_not_found':invalid?'invalid_catalog_report':'catalog_operation_failed'),{status:missing?404:invalid?400:500}));return}finish(null,Buffer.concat(output))});
   child.stdin.end(input);
  });
 }
 function newToken(){return crypto.randomBytes(32).toString('base64url')}
 function digest(token){return crypto.createHash('sha256').update(token).digest('hex')}
 function identifyDigest(session,key){if(key===session.adminHash)return {role:'admin'};if(key===session.observerHash)return {role:'observer'};if(key===session.coordinatorHash)return {role:'coordinator'};const coordinator=session.coordinatorTokens.get(key);if(coordinator)return {role:'coordinator',coordinator};const agent=session.agentTokens.get(key);return agent?{role:'agent',agent}:null}
 function readsWorld(identity){return identity.role==='admin'||identity.role==='observer'}
 function identify(session,req){const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');return match?identifyDigest(session,digest(match[1])):null}
 function stop(session){if(session.timer){clearInterval(session.timer);session.timer=null}session.running=false}
 function sessionError(session){return session.simulationError||(session.journalFailed?'journal_write_failed':null)}
 function state(session){return {sessionId:session.id,...(session.forkedFrom?{forkedFrom:session.forkedFrom}:{}),revision:session.revision,statusRevision:session.statusRevision,running:session.running,speed:session.speed,...(sessionError(session)?{sessionError:sessionError(session)}:{}),...(session.simulationError?{simulationError:session.simulationError}:{}),...(session.journal?{journal:{...session.journal.info(),healthy:session.journal.info().healthy&&!session.journalFailed}}:{}),world:worldRuntime.snapshot(session.world),metrics:E.metrics(session.world)}}
 // Credential metadata is administrator-only and deliberately outside world
 // snapshots, replay and observations. A valid credential is not a live process.
 function coordinatorRoster(session){return {version:1,sessionId:session.id,rosterRevision:session.rosterRevision,worldRevision:session.revision,tick:session.world.tick,legacyCredentialActive:session.coordinatorHash!==null,named:[...session.coordinatorTokens.values()].sort().map(id=>({id}))}}
 function agentObservation(session,id){const view=session.frozenAgentObservations?JSON.parse(JSON.stringify(session.frozenAgentObservations.get(id)||null)):controlApi.observe(session.world,id),error=sessionError(session);return view&&error?{...view,sessionError:error,...(session.simulationError?{simulationError:session.simulationError}:{})}:view}
 function coordinatorObservation(session,coordinatorId){const view=session.frozenCoordinatorObservation?JSON.parse(JSON.stringify(session.frozenCoordinatorObservation)):E.coordinatorObservation(session.world);return {...view,...(coordinatorId?{coordinatorId}:{}),...(sessionError(session)?{sessionError:sessionError(session)}:{}),...(session.simulationError?{simulationError:session.simulationError}:{})}}
 function registerSession(world,scene,physics,forkedFrom=null){
  const id=crypto.randomUUID(),adminToken=newToken(),initial=worldRuntime.snapshot(world),initialBytes=Buffer.byteLength(JSON.stringify(initial)),session={id,world,scene,physics,forkedFrom,adminHash:digest(adminToken),journal:null,journalFailed:false,simulationError:null,coordinatorHash:null,rosterRevision:0,coordinatorTokens:new Map(),agentTokens:new Map(),agentMemory:new Map(),observationTransport:{version:1,agent:{httpResponses:0,httpBodyBytes:0,streamMessages:0,streamPayloadBytes:0},coordinator:{httpResponses:0,httpBodyBytes:0,streamMessages:0,streamPayloadBytes:0}},revision:0,statusRevision:0,running:false,speed:1,timer:null,clients:new Set(),historyBytes:initialBytes,frames:[{revision:0,world:initial,bytes:initialBytes}]};
  session.observerHash=null;session.recordingContext=Recording.capture(id,runtime,forkedFrom);
  if(journalDir){try{session.journal=journalApi.create(journalDir,id,session.adminHash,{sceneId:world.sceneId,seed:world.seed,policy:world.policy,physicsMode:world.physicsMode,sensorModel:world.sensorModel??'geometry-v1',runtimeInstanceId:runtime.instanceId,runtime,...(forkedFrom?{forkedFrom}:{}),...(replayJournal?{scene}: {})},world.events,replayJournal?{initialWorld:initial}:{})}catch{physics?.free();worldRuntime.dispose(world);throw Object.assign(Error('journal_create_failed'),{status:503})}}
  sessions.set(id,session);return {session,adminToken};
 }
 function bindNativeWorld(world,physics){
  const participants=[],bind=(fn,store)=>{fn(world,store);participants.push(store);return store};
  if(NativeEnvironment)bind(E.bindWorldEnvironment,NativeEnvironment.create(world));
  if(NativeMotion){
   const ledger=bind(E.bindWorldLedger,NativeLedger.create(world));bind(E.bindWorldControl,ledger.control(world));
   const motion=NativeMotion.create(world);E.bindWorldMotion(world,motion);bind(E.bindWorldExecution,motion.execution(world));
   bind(E.bindWorldTasks,NativeTasks.create(world));bind(E.bindWorldActions,NativeActions.create(world));
  }
  if(NativePeer)bind(E.bindWorldPeer,NativePeer.create(world));if(NativeReports)bind(E.bindWorldReports,NativeReports.create(world));
  if(NativeDispatch)bind(E.bindWorldDispatch,NativeDispatch.create(world));if(NativeResources)bind(E.bindWorldResources,NativeResources.create(world));
  if(NativePerceptions)bind(E.bindWorldPerceptions,NativePerceptions.create(world,physics));if(NativeRequests)bind(E.bindWorldRequests,NativeRequests.create(world));
  E.bindWorldAgentObservations(world);E.bindWorldCoordinatorObservations(world);if(physicsBackend==='rust'){E.bindWorldTaskAdvance(world,physics);E.bindWorldActionAdvance(world,physics);E.bindWorldAdvance(world,physics)}
  if(participants.length||physics&&physicsBackend==='rust'){if(physics)participants.push(physics);E.bindWorldTransaction(world,require('./world-transaction').create(world,participants,worldRuntime.snapshot,E.restoreHostState))}
 }
 function matchingRuntime(source){return !!source&&['physicsBackend','taskBackend','communicationBackend','navigationBackend','worldLedgerBackend','worldMotionBackend','worldTasksBackend','worldExecutionBackend','worldActionsBackend','worldPeerBackend','worldReportsBackend','worldDispatchBackend','worldResourcesBackend','worldPerceptionsBackend','worldEnvironmentBackend','worldRequestsBackend','worldControlBackend','worldRollbackVersion','worldRouteVersion','worldStationaryVersion','worldWorkVersion','worldActivationVersion','worldLifecycleVersion','worldAssignmentVersion','worldInterruptionVersion','worldRevocationVersion','worldProposalVersion','worldTimeVersion','worldEndingVersion','worldFinalizationVersion','worldTaskEventsVersion','worldRouteEventsVersion','worldStationaryEventsVersion','worldLifecycleEventsVersion','worldActivationEventsVersion','worldPeerEventsVersion','worldReportEventsVersion','worldDispatchEventsVersion','worldAutomaticDispatchVersion','worldCollisionReplanVersion','worldActivationPlanningVersion','worldAssignmentPlanningVersion','worldEnvironmentPlanningVersion','worldAgentObservationVersion','worldCoordinatorObservationVersion','worldTaskAdvanceVersion','worldActionAdvanceVersion','worldAdvanceVersion','worldInitializationVersion','node','platform','arch','rapierPackage'].every(k=>source[k]===runtime[k])&&JSON.stringify(source.sourceSha256)===JSON.stringify(runtime.sourceSha256)}
 function record(session){const previous=session.frames[session.frames.length-1];session.revision++;let journalFailed=false;
  const world=worldRuntime.snapshot(session.world),bytes=Buffer.byteLength(JSON.stringify(world));
  if(session.journal){try{const count=session.journal.info().eventCount;if(previous.world.events.length!==count||JSON.stringify(previous.world.events)!==JSON.stringify(world.events.slice(0,count)))throw Error('journal_event_history_changed');session.journal.append(session.revision,world.events.slice(count),world)}catch{session.journal.invalidate?.();journalFailed=true;session.journalFailed=true;stop(session);session.statusRevision++}}
  session.frames.push({revision:session.revision,world,bytes});session.historyBytes+=bytes;while(session.frames.length>1&&(session.frames.length>MAX_FRAMES||session.historyBytes>maxHistoryBytes))session.historyBytes-=session.frames.shift().bytes;broadcast(session,'frame',previous);if(journalFailed)throw Object.assign(Error('journal_write_failed'),{status:503})}

 function freezeFailedSession(session){stop(session);if(runtime.worldAgentObservationVersion===1){try{session.frozenAgentObservations=new Map(session.world.agents.map(a=>[a.id,controlApi.observe(session.world,a.id)]))}catch{session.frozenAgentObservations=null}}if(runtime.worldCoordinatorObservationVersion===1){try{session.frozenCoordinatorObservation=E.coordinatorObservation(session.world)}catch{session.frozenCoordinatorObservation=null}}worldRuntime.dispose(session.world);session.world=worldRuntime.snapshot(session.frames.at(-1).world);session.simulationError='world_step_failed';session.statusRevision++;broadcast(session,'status')}
 function advance(session){if(session.world.done){stop(session);return false}try{worldRuntime.step(session.world,session.physics)}catch{freezeFailedSession(session);throw Object.assign(Error('world_step_failed'),{status:503})}if(session.world.done){stop(session);session.statusRevision++}record(session);return true}
 const server=http.createServer(async(req,res)=>{
  let mutationSession=null;
  try{
   const originError=requestOriginError(req);if(originError)return json(res,403,{error:originError});
   if(forwardControl(req,res))return;
   const url=new URL(req.url,'http://localhost'),parts=url.pathname.split('/').filter(Boolean);
   if(PublicExperimentAssets.serve(req,res,url))return;
   if(req.method==='GET'&&url.pathname==='/'){const html=fs.readFileSync(path.join(__dirname,'../../../index.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(html)}
   if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,...server.diagnostics()});
   if(req.method==='POST'&&url.pathname==='/scene-diagnostics'){
    const input=await body(req,65536);if(!input||typeof input!=='object'||Array.isArray(input)||(input.scene===undefined)===(input.sceneId===undefined))throw Error('provide exactly one scene or sceneId');
    const scene=input.scene===undefined?E.getScene(input.sceneId):input.scene;return json(res,200,{version:1,...SceneDiagnostics.analyze(scene)});
   }
   if(req.method==='POST'&&url.pathname==='/sessions'){
    const input=await body(req,65536);if(sessions.size>=maxSessions)return json(res,429,{error:'session_limit'});
    if(input.scene!==undefined&&input.sceneId!==undefined&&input.scene?.id!==input.sceneId)return json(res,400,{error:'scene_id_mismatch'});const scene=E.withLinkProfile(input.scene===undefined?E.getScene(input.sceneId??E.scene.id):input.scene,input.linkProfile??'default');
    if(input.sensorMode!==undefined&&!['geometry','rapier'].includes(input.sensorMode))return json(res,400,{error:'invalid_sensor_mode'});
    if(input.sensorMode==='rapier'&&(physicsBackend!=='rust'||input.physicsMode!=='rapier'))return json(res,400,{error:'ray_sensor_backend_unavailable'});
    const world=worldRuntime.create(input.seed??42,input.policy??'nearest',scene,{dispatchMode:input.dispatchMode??'rule',physicsMode:input.physicsMode??'kinematic',executionMode:input.executionMode??'auto'},NativeInitialization?.create);if(Navigation)E.bindNavigation(world,Navigation);if(TaskRules)E.bindTaskRules(world,TaskRules);if(CommunicationRules)E.bindCommunicationRules(world,CommunicationRules);if(world.physicsMode==='rapier'){await Physics.initialize();if(sessions.size>=maxSessions)return json(res,429,{error:'session_limit'})}const physics=world.physicsMode==='rapier'?Physics.createPhysics(world):null;try{if(input.sensorMode==='rapier'){if(NativeInitialization)NativeInitialization.finishRay(world,physics);E.bindRaySensors(world,physics,!!NativeInitialization)}bindNativeWorld(world,physics)}catch(error){physics?.free();worldRuntime.dispose(world);throw error}const {session,adminToken}=registerSession(world,scene,physics);return json(res,201,{...state(session),scene,recordingContext:session.recordingContext,adminToken});
   }
   // Fork a new paused session from an authenticated, validated journal snapshot.
   if(req.method==='POST'&&parts.length===3&&parts[0]==='event-journals'&&parts[2]==='fork'){
    if(!journalDir||typeof journalApi.replay!=='function')return json(res,404,{error:'journal_disabled'});
    const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');if(!match)return json(res,401,{error:'unauthorized'});
    const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='revision')||!Number.isSafeInteger(input.revision)||input.revision<0)return json(res,400,{error:'invalid_fork_revision'});
    if(sessions.size>=maxSessions)return json(res,429,{error:'session_limit'});
    let saved;try{saved=journalApi.replay(journalDir,parts[1],digest(match[1]),input.revision-1,1,input.revision)}catch(error){return json(res,error.status||500,{error:error.status?error.message:'journal_read_failed'})}
    if(saved.frames.length!==1||saved.frames[0].revision!==input.revision)return json(res,409,{error:'snapshot_not_available'});
    if(!matchingRuntime(saved.metadata?.runtime))return json(res,409,{error:'fork_runtime_mismatch'});
    const world=saved.frames[0].world,scene=saved.metadata?.scene;if(!scene||world.done)return json(res,409,{error:world.done?'fork_finished_world':'fork_scene_missing'});
    try{Replay.validateArchive({format:'3dbox-prototype-v1',config:{seed:world.seed,policy:world.policy,sceneId:world.sceneId,scene},frames:[world]},{createWorld:NativeInitialization?NativeInitialization.create:E.create})}catch{return json(res,409,{error:'fork_invalid_snapshot'})}
    if(!['geometry-v1','rapier-ray-v1'].includes(world.sensorModel??'geometry-v1')||(world.sensorModel==='rapier-ray-v1'&&(physicsBackend!=='rust'||world.physicsMode!=='rapier')))return json(res,409,{error:'fork_sensor_unavailable'});
    if(Navigation)E.bindNavigation(world,Navigation,true);if(TaskRules)E.bindTaskRules(world,TaskRules,true);if(CommunicationRules)E.bindCommunicationRules(world,CommunicationRules,true);
    if(world.physicsMode==='rapier'){await Physics.initialize();if(sessions.size>=maxSessions)return json(res,429,{error:'session_limit'})}
    const physics=world.physicsMode==='rapier'?Physics.createPhysics(world):null;try{if(world.sensorModel==='rapier-ray-v1')E.bindRaySensors(world,physics,true);bindNativeWorld(world,physics)}catch(error){physics?.free();worldRuntime.dispose(world);throw error}
    const forkedFrom={sessionId:parts[1],revision:input.revision,sourceClosed:saved.closed,sourcePartialTail:saved.partialTail};const {session,adminToken}=registerSession(world,scene,physics,forkedFrom);return json(res,201,{...state(session),scene,recordingContext:session.recordingContext,adminToken,forkedFrom,privateMemoryRestored:false});
   }
   if(req.method==='GET'&&parts.length===3&&parts[0]==='event-journals'&&parts[2]==='replay'){
    if(!journalDir)return json(res,404,{error:'journal_disabled'});const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');if(!match)return json(res,401,{error:'unauthorized'});
    const a=url.searchParams.get('after')??'-1',l=url.searchParams.get('limit')??'25',t=url.searchParams.get('through'),after=Number(a),limit=Number(l),through=t===null?null:Number(t);
    if(!/^-?\d+$/.test(a)||!Number.isSafeInteger(after)||after< -1||!/^\d+$/.test(l)||!Number.isInteger(limit)||limit<1||limit>100||(t!==null&&(!/^\d+$/.test(t)||!Number.isSafeInteger(through)||through<0||after>through)))return json(res,400,{error:'invalid_replay_cursor'});
    try{const result=journalApi.replay(journalDir,parts[1],digest(match[1]),after,limit,through),active=sessions.get(parts[1]);return json(res,200,{...result,active:!!active?.journal,healthy:active?.journal?(active.journal.info().healthy&&!active.journalFailed):null})}
    catch(error){return json(res,error.status||500,{error:error.status?error.message:'journal_replay_failed'})}
   }
   if(req.method==='GET'&&parts.length===2&&parts[0]==='event-journals'){
    if(!journalDir)return json(res,404,{error:'journal_disabled'});
    const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');if(!match)return json(res,401,{error:'unauthorized'});
    const afterRaw=url.searchParams.get('after')??'0',limitRaw=url.searchParams.get('limit')??'100',after=Number(afterRaw),limit=Number(limitRaw);
    if(!/^\d+$/.test(afterRaw)||!Number.isSafeInteger(after)||after<0||!/^\d+$/.test(limitRaw)||!Number.isInteger(limit)||limit<1||limit>500)return json(res,400,{error:'invalid_journal_cursor'});
    try{const result=journalApi.read(journalDir,parts[1],digest(match[1]),after,limit),active=sessions.get(parts[1]);return json(res,200,{...result,active:!!active?.journal,healthy:active?.journal?(active.journal.info().healthy&&!active.journalFailed):null})}
    catch(error){return json(res,error.status||500,{error:error.status?error.message:'journal_read_failed'})}
   }
   if(parts[0]!=='sessions'||!parts[1])return json(res,404,{error:'not_found'});
   const session=sessions.get(parts[1]);if(!session)return json(res,404,{error:'session_not_found'});
   const identity=identify(session,req);if(!identity)return json(res,401,{error:'unauthorized'});mutationSession=session;
   // Observers may read this live world's retained snapshots, never control it or access private services.
   if(req.method==='GET'&&parts.length===3&&parts[2]==='observer'){
    if(identity.role!=='observer')return json(res,403,{error:'forbidden'});
    return json(res,200,{...state(session),role:'observer',scene:session.scene,recordingContext:session.recordingContext});
   }
   if(identity.role==='observer'&&(req.method!=='GET'||!(parts.length===2||parts.length===3&&parts[2]==='history')))return json(res,403,{error:'forbidden'});
   const revokingObserver=req.method==='DELETE'&&parts.length===4&&parts[2]==='observer'&&parts[3]==='credentials';
   if(session.journalFailed&&!revokingObserver&&((req.method==='POST'&&parts[2]!=='pause')||(req.method==='DELETE'&&parts.length!==2)))return json(res,503,{error:'journal_write_failed'});
   if(session.simulationError&&!revokingObserver&&((req.method==='POST'&&parts[2]!=='pause')||(req.method==='DELETE'&&parts.length!==2)))return json(res,503,{error:session.simulationError});
   // Re-check after reading asynchronous bodies: credentials may be rotated or the session deleted.
   const stillAuthorized=()=>{if(session.journalFailed&&req.method==='POST'&&parts[2]!=='pause')throw Object.assign(Error('journal_write_failed'),{status:503});if(session.simulationError&&req.method==='POST'&&parts[2]!=='pause')throw Object.assign(Error(session.simulationError),{status:503});const now=identify(session,req);return sessions.get(session.id)===session&&now&&now.role===identity.role&&now.agent===identity.agent&&now.coordinator===identity.coordinator};
   // Instantaneous local range scan; this reads the physical scene but never advances the world.
   if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[4]==='lidar'){
    if(identity.role!=='admin'&&(identity.role!=='agent'||identity.agent!==parts[3]))return json(res,403,{error:'forbidden'});
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});
    const agent=session.world.agents.find(a=>a.id===parts[3]);if(!agent)return json(res,404,{error:'agent_not_found'});
    if(agent.disabled)return json(res,409,{error:'agent_unavailable'});
    if(!session.physics||typeof session.physics.lidar!=='function')return json(res,409,{error:'lidar_backend_unavailable'});
    const count=input?.count??36,limit=Math.min(agent.sensorRange??session.world.sensorRange,1000),range=input?.range??Math.min(limit,30);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['count','range'].includes(k))||!Number.isInteger(count)||count<4||count>72||!Number.isFinite(range)||range<=0||range>limit)return json(res,400,{error:'invalid_lidar_parameters'});
    const air=(agent.mobility??(agent.role==='drone'?'air':'ground'))==='air',height=air?16:1.5+Elevation.height(session.world.heightfield,agent.x,agent.y);
    session.physics.syncRoadblocks(session.world.roadblocks||[]);
    const distances=session.physics.lidar(agent,height,count,range);
    return json(res,200,{version:1,agentId:agent.id,tick:session.world.tick,worldRevision:session.revision,origin:{x:agent.x,y:agent.y,z:height},maxRange:range,distances});
   }
   if(identity.role==='agent'){
    if(parts.length===5&&parts[2]==='agents'&&parts[3]===identity.agent&&parts[4]==='memory'){
     const current=session.agentMemory.get(identity.agent)||{revision:0,value:{}};
     if(req.method==='GET')return json(res,200,current);
     if(req.method==='POST'){
      const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});
      if(!input||typeof input!=='object'||Array.isArray(input)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!input.value||typeof input.value!=='object'||Array.isArray(input.value))return json(res,400,{error:'invalid_memory'});
      if(Buffer.byteLength(JSON.stringify(input.value),'utf8')>8192)return json(res,413,{error:'memory_too_large'});
      const latest=session.agentMemory.get(identity.agent)||{revision:0,value:{}};
      if(input.expectedRevision!==latest.revision)return json(res,409,{error:'memory_revision_conflict',revision:latest.revision});
      const updated={revision:latest.revision+1,value:input.value};session.agentMemory.set(identity.agent,updated);return json(res,200,updated);
     }
    }
    if(req.method==='GET'&&parts.length===4&&parts[2]==='observations'&&parts[3]===identity.agent)return json(res,200,agentObservation(session,identity.agent),session.observationTransport.agent);
    if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[3]===identity.agent&&parts[4]==='messages'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input.from!==undefined&&input.from!==identity.agent)return json(res,403,{error:'forbidden'});
     const result=controlApi.sendMessage(session.world,identity.agent,input.to,input.text,input.via,input.requestId);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{messageId:result.messageId,...(result.duplicate!==undefined?{duplicate:result.duplicate}:{})});
    }
    if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[3]===identity.agent&&parts[4]==='sample-reports'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input.agentId!==undefined&&input.agentId!==identity.agent)return json(res,403,{error:'forbidden'});const result=controlApi.submitSampleReport(session.world,identity.agent,input);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{report:result.report,duplicate:result.duplicate});
    }
    if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[3]===identity.agent&&parts[4]==='evidence'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input.agentId!==undefined&&input.agentId!==identity.agent)return json(res,403,{error:'forbidden'});const result=controlApi.submitEvidence(session.world,identity.agent,input);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{report:result.report,duplicate:result.duplicate});
    }
    if(req.method==='POST'&&parts.length===6&&parts[2]==='agents'&&parts[3]===identity.agent&&parts[4]==='actions'&&parts[5]==='cancel'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input?.agentId!==undefined&&input.agentId!==identity.agent)return json(res,403,{error:'forbidden'});const result=controlApi.cancelAction(session.world,identity.agent,input?.requestId);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{action:result.action,duplicate:result.duplicate});
    }
    if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[3]===identity.agent&&parts[4]==='actions'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input.agentId!==undefined&&input.agentId!==identity.agent)return json(res,403,{error:'forbidden'});
     const result=controlApi.submitAction(session.world,identity.agent,input);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{action:result.action,duplicate:result.duplicate});
    }
    return json(res,403,{error:'forbidden'});
   }
   // Named coordinators share the observation contract, but ownership and retries remain tied to their credentials.
   function requestOwnerAllowed(collection,input){const prior=(session.world[collection]||[]).find(x=>x.requestId===input?.requestId&&(collection!=='decisions'||x.actor==='external'));return !prior||prior.coordinatorId===identity.coordinator}

   if(identity.role==='coordinator'||identity.role==='admin'){
    if(req.method==='GET'&&parts.length===4&&parts[2]==='coordinator'&&parts[3]==='observation')return json(res,200,{...coordinatorObservation(session,identity.coordinator),worldRevision:session.revision},identity.role==='coordinator'?session.observationTransport.coordinator:null);
    if(req.method==='POST'&&parts.length===4&&parts[2]==='coordinator'&&parts[3]==='proposals'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(!['external','networked_external','networked_reported'].includes(session.world.dispatchMode))return json(res,409,{error:'external_mode_required'});
     if(!requestOwnerAllowed('proposals',input))return json(res,409,{error:'request_id_conflict'});const result=controlApi.withCoordinator(session.world,identity.coordinator,input?.requestId,()=>controlApi.proposeSurvey(session.world,input));if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{proposal:result.proposal,duplicate:result.duplicate});
    }
    if(req.method==='POST'&&parts.length===4&&parts[2]==='coordinator'&&parts[3]==='revocations'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(!['external','networked_external','networked_reported'].includes(session.world.dispatchMode))return json(res,409,{error:'external_mode_required'});
     if(!requestOwnerAllowed('revocations',input))return json(res,409,{error:'request_id_conflict'});const result=controlApi.withCoordinator(session.world,identity.coordinator,input?.requestId,()=>controlApi.revokeTask(session.world,input));if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{revocation:result.revocation,duplicate:result.duplicate});
    }
    if(req.method==='POST'&&parts.length===4&&parts[2]==='coordinator'&&parts[3]==='decisions'){
     const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(!['external','networked_external','networked_reported'].includes(session.world.dispatchMode))return json(res,409,{error:'external_mode_required'});
     if(!requestOwnerAllowed('decisions',input))return json(res,409,{error:'request_id_conflict'});
     const priorDecision=session.world.decisions.some(d=>d.actor==='external'&&d.requestId===input?.requestId);
     if(input&&Object.hasOwn(input,'expectedRevision')){if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)return json(res,400,{error:'invalid_revision'});if(!priorDecision&&input.expectedRevision!==session.revision)return json(res,409,{error:'world_revision_changed'})}
     if(input&&Object.hasOwn(input,'requirePaused')){if(typeof input.requirePaused!=='boolean')return json(res,400,{error:'invalid_pause_guard'});if(input.requirePaused&&session.running&&!priorDecision)return json(res,409,{error:'world_running'})}
     const result=controlApi.withCoordinator(session.world,identity.coordinator,input?.requestId,()=>controlApi.submitExternalDecision(session.world,input));if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{decision:result.decision,duplicate:result.duplicate});
    }
   }
   if(identity.role==='coordinator')return json(res,403,{error:'forbidden'});
   if(parts.length===4&&parts[2]==='observer'&&parts[3]==='credentials'&&['POST','DELETE'].includes(req.method)){
    if(req.method==='POST')await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});
    if(req.method==='DELETE'){session.observerHash=null;revokeChanged(session);return json(res,200,{revoked:true})}
    const observerToken=newToken();session.observerHash=digest(observerToken);revokeChanged(session);return json(res,201,{sessionId:session.id,observerToken});
   }
   if(req.method==='GET'&&parts.length===3&&parts[2]==='observation-transport')return json(res,200,session.observationTransport);
   if(req.method==='GET'&&parts.length===3&&parts[2]==='coordinators')return json(res,200,coordinatorRoster(session));
   if(req.method==='POST'&&parts.length===4&&parts[2]==='coordinator'&&parts[3]==='credentials'){
    await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});const coordinatorToken=newToken();session.coordinatorHash=digest(coordinatorToken);session.rosterRevision++;revokeChanged(session);return json(res,201,{coordinatorToken});
   }
   if(parts.length===5&&parts[2]==='coordinators'&&parts[4]==='credentials'&&['POST','DELETE'].includes(req.method)){
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});const coordinatorId=parts[3];if(!/^[A-Za-z0-9_-]{1,40}$/.test(coordinatorId))return json(res,400,{error:'invalid_coordinator_id'});
    if(input&&Object.hasOwn(input,'expectedRosterRevision')){if(!Number.isSafeInteger(input.expectedRosterRevision)||input.expectedRosterRevision<0)return json(res,400,{error:'invalid_roster_revision'});if(input.expectedRosterRevision!==session.rosterRevision)return json(res,409,{error:'coordinator_roster_changed'})}
    const existing=[...session.coordinatorTokens].find(([,id])=>id===coordinatorId);if(req.method==='DELETE'){if(!existing)return json(res,404,{error:'coordinator_not_found'});session.coordinatorTokens.delete(existing[0]);session.rosterRevision++;revokeChanged(session);return json(res,200,{coordinatorId,revoked:true,rosterRevision:session.rosterRevision})}
    if(!existing&&session.coordinatorTokens.size>=16)return json(res,409,{error:'coordinator_limit'});if(existing)session.coordinatorTokens.delete(existing[0]);const coordinatorToken=newToken();session.coordinatorTokens.set(digest(coordinatorToken),coordinatorId);session.rosterRevision++;revokeChanged(session);return json(res,201,{coordinatorId,coordinatorToken,rosterRevision:session.rosterRevision});
   }
   if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[4]==='credentials'){
    await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(!session.world.agents.some(a=>a.id===parts[3]))return json(res,404,{error:'agent_not_found'});
    for(const [key,agent] of session.agentTokens)if(agent===parts[3])session.agentTokens.delete(key);
    const agentToken=newToken();session.agentTokens.set(digest(agentToken),parts[3]);revokeChanged(session);return json(res,201,{agentId:parts[3],agentToken});
   }

   if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[4]==='sample-reports'){
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input.agentId!==undefined&&input.agentId!==parts[3])return json(res,403,{error:'forbidden'});const result=controlApi.submitSampleReport(session.world,parts[3],input);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{report:result.report,duplicate:result.duplicate});
   }
   if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[4]==='evidence'){
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input.agentId!==undefined&&input.agentId!==parts[3])return json(res,403,{error:'forbidden'});const result=controlApi.submitEvidence(session.world,parts[3],input);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{report:result.report,duplicate:result.duplicate});
   }
   if(req.method==='POST'&&parts.length===6&&parts[2]==='agents'&&parts[4]==='actions'&&parts[5]==='cancel'){
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input?.agentId!==undefined&&input.agentId!==parts[3])return json(res,403,{error:'forbidden'});const result=controlApi.cancelAction(session.world,parts[3],input?.requestId);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{action:result.action,duplicate:result.duplicate});
   }
   if(req.method==='POST'&&parts.length===5&&parts[2]==='agents'&&parts[4]==='actions'){
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(input.agentId!==undefined&&input.agentId!==parts[3])return json(res,403,{error:'forbidden'});
    const result=controlApi.submitAction(session.world,parts[3],input);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{action:result.action,duplicate:result.duplicate});
   }
   if(req.method==='DELETE'&&parts.length===2){stop(session);session.journal?.close(session.revision,'deleted');for(const client of session.clients)client.close(1008,'session closed');if(session.physics)session.physics.free();worldRuntime.dispose(session.world);sessions.delete(parts[1]);return json(res,200,{ok:true})}
   if(req.method==='GET'&&parts.length===2)return json(res,200,state(session));
   if(req.method==='GET'&&parts.length===3&&parts[2]==='recording-context')return json(res,200,{sessionId:session.id,recordingContext:session.recordingContext});
   if(req.method==='GET'&&parts.length===3&&parts[2]==='history'){
    const raw=url.searchParams.get('after')??'-1',after=Number(raw);if(!/^-?\d+$/.test(raw)||!Number.isSafeInteger(after)||after< -1)return json(res,400,{error:'invalid_revision'});
    const first=session.frames[0].revision;return json(res,200,{sessionId:session.id,...(session.forkedFrom?{forkedFrom:session.forkedFrom}:{}),revision:session.revision,statusRevision:session.statusRevision,running:session.running,speed:session.speed,...(sessionError(session)?{sessionError:sessionError(session)}:{}),...(session.simulationError?{simulationError:session.simulationError}:{}),truncated:after<first-1,frames:session.frames.filter(f=>f.revision>after).map(({revision,world})=>({revision,world}))});
   }
   if(req.method==='GET'&&parts.length===4&&parts[2]==='observations'){const obs=agentObservation(session,parts[3]);return obs?json(res,200,obs):json(res,404,{error:'agent_not_found'})}
   if(parts[2]==='catalog'&&parts.length===3&&req.method==='GET'){
    const limit=Number(url.searchParams.get('limit')??50),sceneFilter=url.searchParams.get('scene'),formatFilter=url.searchParams.get('format'),labelFilter=url.searchParams.get('label'),beforeTime=url.searchParams.get('beforeCreatedAt'),beforeId=url.searchParams.get('beforeId');if(!Number.isInteger(limit)||limit<1||limit>500||[sceneFilter,formatFilter].some(x=>x!==null&&(x.length>100||/[\x00-\x1f]/.test(x)))||labelFilter!==null&&(labelFilter.length>200||/[\x00-\x1f]/.test(labelFilter))||(beforeTime===null)!==(beforeId===null)||beforeTime!==null&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(beforeTime)||!/^[0-9a-f]{64}$/.test(beforeId)))return json(res,400,{error:'invalid_catalog_filter'});
    if(!fs.existsSync(catalogPath))return json(res,200,{reports:[],nextCursor:null});const args=['list','--limit',String(limit+1)];if(sceneFilter!==null)args.push('--scene='+sceneFilter);if(formatFilter!==null)args.push('--format='+formatFilter);if(labelFilter!==null)args.push('--label='+labelFilter);if(beforeTime!==null)args.push('--before-created-at='+beforeTime,'--before-id='+beforeId);const output=await catalog(args);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});const rows=JSON.parse(output.toString('utf8')),reports=rows.slice(0,limit),last=reports.at(-1),nextCursor=rows.length>limit?{createdAt:last.created_at,id:last.id}:null;return json(res,200,{reports,nextCursor});
   }
   if(parts[2]==='catalog'&&parts.length===4&&req.method==='GET'){
    if(!/^[0-9a-f]{64}$/.test(parts[3]))return json(res,400,{error:'invalid_catalog_id'});if(!fs.existsSync(catalogPath))return json(res,404,{error:'catalog_not_found'});const output=await catalog(['read',parts[3]]);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(output);
   }
   if(parts[2]==='catalog'&&parts[3]==='import'&&parts.length===4&&req.method==='POST'){
    const label=url.searchParams.get('label')??'';if(label.length>200||/[\x00-\x1f]/.test(label))return json(res,400,{error:'invalid_catalog_label'});if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'catalog_json_required'});
    const data=await rawReport(req,50*1024*1024);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});const output=await catalog(['add','-','--label='+label],data);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});return json(res,200,JSON.parse(output.toString('utf8')));
   }
   if(parts[2]==='catalog'&&parts.length===3&&req.method==='POST'){
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});if(!input||typeof input.label!=='string'||input.label.length>200||/[\x00-\x1f]/.test(input.label))return json(res,400,{error:'invalid_catalog_label'});
    const first=session.frames[0].revision,last=session.frames.at(-1),world=last.world,archive={format:'3dbox-prototype-v1',source:'server',recordingContext:session.recordingContext,config:{seed:world.seed,policy:world.policy,sceneId:world.sceneId,scene:session.scene},metrics:E.metrics(world),events:world.events,coverage:{start:first===0&&!session.forkedFrom?'complete':'partial',end:world.done?'finished':'unfinished',revisionRange:[first,last.revision]},frames:session.frames.map(f=>f.world)},data=Buffer.from(JSON.stringify(archive));
    if(data.length>50*1024*1024)return json(res,413,{error:'catalog_report_too_large'});const output=await catalog(['add','-','--label='+input.label],data);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});return json(res,200,{...JSON.parse(output.toString('utf8')),revision:last.revision,coverage:archive.coverage});
   }
   if(req.method==='POST'&&parts.length===3){
    const input=await body(req);if(!stillAuthorized())return json(res,401,{error:'unauthorized'});
    if(parts[2]==='step'){
     if(session.running)return json(res,409,{error:'session_running'});const count=input.count??1;if(!Number.isInteger(count)||count<1||count>MAX_STEPS)return json(res,400,{error:'invalid_step_count'});
     let executed=0;while(executed<count&&advance(session))executed++;return json(res,200,{...state(session),executed});
    }
    if(parts[2]==='run'){
     if(session.world.done)return json(res,409,{error:'world_finished'});const speed=input.speed??1;if(![1,2,5].includes(speed))return json(res,400,{error:'invalid_speed'});stop(session);session.speed=speed;session.running=true;
     session.timer=setInterval(()=>{try{for(let i=0;i<session.speed&&session.running;i++)advance(session)}catch(error){if(!session.journalFailed&&!session.simulationError)throw error;stop(session)}},STEP_MS);session.timer.unref();session.statusRevision++;broadcast(session,'status');return json(res,200,state(session));
    }
    if(parts[2]==='pause'){stop(session);session.statusRevision++;broadcast(session,'status');return json(res,200,state(session))}
    if(parts[2]==='dispatch-mode'){const result=controlApi.setDispatchMode(session.world,input.mode);if(!result.ok)return json(res,409,{error:result.reason});if(result.changed)record(session);return json(res,200,{...state(session),changed:result.changed})}
    if(parts[2]==='fault'){if(!input||typeof input!=='object'||Array.isArray(input))return json(res,400,{error:'invalid_fault'});if(Object.hasOwn(input,'agentId')||Object.hasOwn(input,'expectedFaultGeneration')){const result=controlApi.injectFault(session.world,input);if(!result.ok)return json(res,result.reason==='invalid_fault'?400:409,{error:result.reason})}else{if(Object.keys(input).length)return json(res,400,{error:'invalid_fault'});if(!controlApi.fault(session.world))return json(res,409,{error:'no_active_task'})}record(session);return json(res,200,state(session))}
    if(parts[2]==='low-energy'){const result=controlApi.injectLowEnergy(session.world,input.agentId,input.level);if(!result.ok)return json(res,409,{error:result.reason});record(session);return json(res,200,state(session))}
    if(parts[2]==='roadblock'){const result=controlApi.injectRoadblock(session.world,input.rect,input.duration);if(!result.ok)return json(res,409,{error:result.reason,...(result.agentId?{agentId:result.agentId}:{})});record(session);return json(res,200,{...state(session),roadblock:result.roadblock,replanned:result.replanned,waiting:result.waiting})}
    if(parts[2]==='terrain-effect'){const result=controlApi.injectTerrainEffect(session.world,input.zoneId,input.duration,input.speedFactor,input.energyFactor);if(!result.ok)return json(res,409,{error:result.reason});record(session);return json(res,200,state(session))}
    if(parts[2]==='communication-outage'){const result=controlApi.interruptCommunication(session.world,input.agentId,input.duration);if(!result.ok)return json(res,409,{error:result.reason});record(session);return json(res,200,state(session))}
    if(parts[2]==='message'){const result=controlApi.sendMessage(session.world,input.from,input.to,input.text,input.via,input.requestId);if(!result.ok)return json(res,409,{error:result.reason});if(!result.duplicate)record(session);return json(res,200,{...state(session),messageId:result.messageId,...(result.duplicate!==undefined?{duplicate:result.duplicate}:{})})}
    if(parts[2]==='assign'){const result=controlApi.assign(session.world,input.taskId,input.agentId);if(!result.ok)return json(res,409,{error:result.reason});record(session);return json(res,200,state(session))}
   }
   return json(res,404,{error:'not_found'});
  }catch(err){if((err.worldLedgerFailure||err.worldMotionFailure||err.worldTasksFailure||err.worldExecutionFailure||err.worldActionsFailure||err.worldPeerFailure||err.worldReportsFailure||err.worldDispatchFailure||err.worldResourcesFailure||err.worldPerceptionsFailure||err.worldEnvironmentFailure||err.worldRequestsFailure||err.worldControlFailure||err.worldTransactionFailure)&&mutationSession&&!mutationSession.simulationError)freezeFailedSession(mutationSession);if(!res.headersSent&&!res.destroyed)json(res,err.status||400,{error:err.message});}
 });
 function authorizedClient(session,client){const now=identifyDigest(session,client.credentialHash);return now&&now.role===client.identity.role&&now.agent===client.identity.agent&&now.coordinator===client.identity.coordinator}
 function safeSend(client,data){if(client.readyState!==WebSocket.OPEN)return;if(client.bufferedAmount>2*1024*1024){client.terminate();return}try{const wire=client.protobuf?StreamProtobuf.encode(data,client.protobuf):typeof data==='string'?data:JSON.stringify(data);client.send(wire,error=>{if(error)client.terminate()});if(client.metrics&&typeof data!=='string'&&data?.type==='observation'){client.metrics.streamMessages++;client.metrics.streamPayloadBytes+=typeof wire==='string'?Buffer.byteLength(wire):wire.byteLength}}catch{client.close(1011,'stream encoding failed')}}
 function revokeChanged(session){for(const client of session.clients)if(!authorizedClient(session,client))client.close(1008,'credential revoked')}
 function broadcast(session,kind,previous){let fullText=null,deltaText=null;const meta={revision:session.revision,statusRevision:session.statusRevision,running:session.running,speed:session.speed,...(sessionError(session)?{sessionError:sessionError(session)}:{}),...(session.simulationError?{simulationError:session.simulationError}:{})};for(const client of session.clients){if(!authorizedClient(session,client)){client.close(1008,'credential revoked');continue}if(client.eventsOnly){if(session.simulationError){client.close(1011,'world step failed');continue}if(session.journalFailed){client.close(1011,'journal write failed');continue}if(kind==='frame'){const events=session.frames.at(-1).world.events.slice(previous.world.events.length);if(events.length)safeSend(client,{type:'events',revision:session.revision,events})}continue}if(kind==='status'){safeSend(client,{type:'status',...meta});if(session.simulationError&&!readsWorld(client.identity)){const observation=client.identity.role==='agent'?agentObservation(session,client.identity.agent):coordinatorObservation(session,client.identity.coordinator);safeSend(client,{type:'observation',...meta,observation})}}else if(readsWorld(client.identity)){
   const world=session.frames[session.frames.length-1].world;if(fullText===null)fullText=JSON.stringify({type:'frame',...meta,world});
   if(client.delta&&previous&&client.lastRevision===previous.revision){if(deltaText===null)deltaText=JSON.stringify({type:'delta',...meta,baseRevision:previous.revision,patch:Delta.diff(previous.world,world)});safeSend(client,Buffer.byteLength(deltaText)<Buffer.byteLength(fullText)?deltaText:fullText)}else safeSend(client,fullText);client.lastRevision=session.revision;
  }else if(client.identity.role==='agent')safeSend(client,{type:'observation',...meta,observation:agentObservation(session,client.identity.agent)});else safeSend(client,{type:'observation',...meta,observation:coordinatorObservation(session,client.identity.coordinator)})}}
 server.on('upgrade',(req,socket,head)=>{if(req.url!=='/stream'||requestOriginError(req)||wss.clients.size>=64){socket.destroy();return}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws))});
 const heartbeat=setInterval(()=>{for(const client of wss.clients){if(!client.isAlive){client.terminate();continue}client.isAlive=false;client.ping()}},20000);heartbeat.unref();
 wss.on('connection',client=>{client.isAlive=true;client.on('pong',()=>{client.isAlive=true});let session=null;const authTimer=setTimeout(()=>client.close(1008,'authentication timeout'),5000);authTimer.unref();client.on('error',()=>{});client.on('close',()=>{clearTimeout(authTimer);if(session)session.clients.delete(client)});client.on('message',(raw,isBinary)=>{
  if(session||isBinary){client.close(1008,'invalid message');return}let message;try{message=JSON.parse(raw.toString('utf8'))}catch{client.close(1008,'invalid message');return}
  if(!message||message.type!=='subscribe'||typeof message.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(message.token)||typeof message.sessionId!=='string'||!Number.isSafeInteger(message.afterRevision)||message.afterRevision< -1){client.close(1008,'invalid subscription');return}
  const candidate=sessions.get(message.sessionId),hash=digest(message.token),identity=candidate&&identifyDigest(candidate,hash),eventsOnly=message.encoding==='events-v1';if(!identity||message.afterRevision>candidate.revision||(eventsOnly&&(identity.role!=='admin'||!candidate.journal||candidate.journalFailed||candidate.simulationError))){client.close(1008,'unauthorized or journal unavailable');return}
  clearTimeout(authTimer);session=candidate;client.identity=identity;client.credentialHash=hash;client.eventsOnly=eventsOnly;client.metrics=session.observationTransport[identity.role]||null;client.protobuf=message.encoding==='protobuf-v2'?2:message.encoding==='protobuf-v1'?1:0;client.delta=readsWorld(identity)&&(message.encoding==='delta-v1'||client.protobuf);client.lastRevision=message.afterRevision;session.clients.add(client);safeSend(client,{type:'ready',role:identity.role,encoding:eventsOnly?'events-v1':client.protobuf?'protobuf-v'+client.protobuf:client.delta?'delta-v1':'full-v1',revision:session.revision,oldestRevision:session.frames[0].revision,statusRevision:session.statusRevision,running:session.running,speed:session.speed,...(sessionError(session)?{sessionError:sessionError(session)}:{}),...(session.simulationError?{simulationError:session.simulationError}:{}),...(eventsOnly?{eventCount:session.journal.info().eventCount}:{})});
  if(identity.role==='agent')safeSend(client,{type:'observation',revision:session.revision,statusRevision:session.statusRevision,running:session.running,speed:session.speed,observation:agentObservation(session,identity.agent)});
  else if(identity.role==='coordinator')safeSend(client,{type:'observation',revision:session.revision,statusRevision:session.statusRevision,running:session.running,speed:session.speed,observation:coordinatorObservation(session,identity.coordinator)});
 })});
 const closeServer=server.close.bind(server);server.close=function(callback){clearInterval(heartbeat);for(const client of wss.clients)client.terminate();return closeServer(callback)};
 server.on('close',()=>{for(const s of sessions.values()){stop(s);s.journal?.close(s.revision,'server_shutdown');if(s.physics)s.physics.free();worldRuntime.dispose(s.world)}sessions.clear();wss.close()});server.diagnostics=()=>({protocol:3,features:{observerAccess:1,decisionPreconditions:1,worldLedger:NativeLedger?1:0,worldMotion:NativeMotion?1:0,worldTasks:NativeTasks?1:0,worldExecution:NativeMotion?1:0,worldActions:NativeActions?1:0,worldPeer:NativePeer?1:0,worldReports:NativeReports?1:0,worldDispatch:NativeDispatch?1:0,worldResources:NativeResources?1:0,worldPerceptions:NativePerceptions?1:0,worldEnvironment:NativeEnvironment?1:0,worldRequests:NativeRequests?1:0,worldControl:NativeControl?1:0},runtime:structuredClone(runtime)});return server;
}
function run(){
 const port=Number(process.env.WORLD_PORT||8787),bind=process.env.WORLD_BIND||'127.0.0.1';
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid WORLD_PORT');
 if(!['127.0.0.1','0.0.0.0'].includes(bind))throw Error('invalid WORLD_BIND');
 const server=createServer();
 server.listen(port,bind,()=>console.log(`World API: http://${bind}:${port}`));
 let stopping=false;const shutdown=()=>{if(stopping)return;stopping=true;const timer=setTimeout(()=>process.exit(1),5000);timer.unref();server.close(()=>{clearTimeout(timer);process.exit(0)});server.closeIdleConnections?.()};
 process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(require.main===module)run();
module.exports={createServer,run};
