/* Session-bound diagnostic metadata. Validation does not authenticate its source. */
(function(root){
'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BACKENDS={physicsBackend:['wasm','rust'],taskBackend:['js','rust'],communicationBackend:['js','rust'],navigationBackend:['js','rust'],worldLedgerBackend:['js','rust'],worldMotionBackend:['js','rust'],worldTasksBackend:['js','rust'],worldExecutionBackend:['js','rust'],worldActionsBackend:['js','rust'],worldPeerBackend:['js','rust'],worldReportsBackend:['js','rust'],worldDispatchBackend:['js','rust'],worldResourcesBackend:['js','rust'],worldPerceptionsBackend:['js','rust'],worldEnvironmentBackend:['js','rust'],worldRequestsBackend:['js','rust'],worldControlBackend:['js','rust']};
function fail(){throw Error('录制环境信息格式无效')}
function object(v){return !!v&&typeof v==='object'&&!Array.isArray(v)}
function runtime(value){
 if(!object(value)||typeof value.instanceId!=='string'||!UUID.test(value.instanceId)||!object(value.sourceSha256))fail();
 const entries=Object.entries(value.sourceSha256);if(!entries.length||entries.length>128)fail();
 for(const [name,hash] of entries)if(name.length>240||!/^[A-Za-z0-9_.\/-]+$/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..')||['__proto__','constructor','prototype'].includes(name)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail();
 const out={instanceId:value.instanceId,sourceSha256:Object.fromEntries(entries)};
 for(const [name,allowed] of Object.entries(BACKENDS))if(value[name]!==undefined){if(!allowed.includes(value[name]))fail();out[name]=value[name]}
 if(value.worldAssignmentPlanningVersion!==undefined){if(value.worldAssignmentPlanningVersion!==1)fail();out.worldAssignmentPlanningVersion=1}
 if(value.worldAgentObservationVersion!==undefined){if(value.worldAgentObservationVersion!==1)fail();out.worldAgentObservationVersion=1}
 if(value.worldCoordinatorObservationVersion!==undefined){if(value.worldCoordinatorObservationVersion!==1)fail();out.worldCoordinatorObservationVersion=1}
 if(value.worldTaskAdvanceVersion!==undefined){if(value.worldTaskAdvanceVersion!==1)fail();out.worldTaskAdvanceVersion=1}
 if(value.worldActionAdvanceVersion!==undefined){if(value.worldActionAdvanceVersion!==1)fail();out.worldActionAdvanceVersion=1}
 if(value.worldInitializationVersion!==undefined){if(value.worldInitializationVersion!==1)fail();out.worldInitializationVersion=1}
 if(value.worldAdvanceVersion!==undefined){if(value.worldAdvanceVersion!==1)fail();out.worldAdvanceVersion=1}
 if(value.worldEnvironmentPlanningVersion!==undefined){if(value.worldEnvironmentPlanningVersion!==1)fail();out.worldEnvironmentPlanningVersion=1}
 if(value.worldActivationPlanningVersion!==undefined){if(value.worldActivationPlanningVersion!==1)fail();out.worldActivationPlanningVersion=1}
 if(value.worldCollisionReplanVersion!==undefined){if(value.worldCollisionReplanVersion!==1)fail();out.worldCollisionReplanVersion=1}
 if(value.worldAutomaticDispatchVersion!==undefined){if(value.worldAutomaticDispatchVersion!==1)fail();out.worldAutomaticDispatchVersion=1}
 if(value.worldDispatchEventsVersion!==undefined){if(value.worldDispatchEventsVersion!==1)fail();out.worldDispatchEventsVersion=1}
 if(value.worldReportEventsVersion!==undefined){if(value.worldReportEventsVersion!==1)fail();out.worldReportEventsVersion=1}
 if(value.worldPeerEventsVersion!==undefined){if(value.worldPeerEventsVersion!==1)fail();out.worldPeerEventsVersion=1}
 if(value.worldActivationEventsVersion!==undefined){if(value.worldActivationEventsVersion!==1)fail();out.worldActivationEventsVersion=1}
 if(value.worldLifecycleEventsVersion!==undefined){if(value.worldLifecycleEventsVersion!==1)fail();out.worldLifecycleEventsVersion=1}
 if(value.worldStationaryEventsVersion!==undefined){if(value.worldStationaryEventsVersion!==1)fail();out.worldStationaryEventsVersion=1}
 if(value.worldRouteEventsVersion!==undefined){if(value.worldRouteEventsVersion!==1)fail();out.worldRouteEventsVersion=1}
 if(value.worldTaskEventsVersion!==undefined){if(value.worldTaskEventsVersion!==1)fail();out.worldTaskEventsVersion=1}
 if(value.worldFinalizationVersion!==undefined){if(value.worldFinalizationVersion!==1)fail();out.worldFinalizationVersion=1}
 if(value.worldEndingVersion!==undefined){if(value.worldEndingVersion!==1)fail();out.worldEndingVersion=1}
 if(value.worldTimeVersion!==undefined){if(value.worldTimeVersion!==1)fail();out.worldTimeVersion=1}
 if(value.worldProposalVersion!==undefined){if(value.worldProposalVersion!==1)fail();out.worldProposalVersion=1}
 if(value.worldRevocationVersion!==undefined){if(value.worldRevocationVersion!==1)fail();out.worldRevocationVersion=1}
 if(value.worldInterruptionVersion!==undefined){if(value.worldInterruptionVersion!==1)fail();out.worldInterruptionVersion=1}
 if(value.worldAssignmentVersion!==undefined){if(value.worldAssignmentVersion!==1)fail();out.worldAssignmentVersion=1}
 if(value.worldLifecycleVersion!==undefined){if(value.worldLifecycleVersion!==1)fail();out.worldLifecycleVersion=1}
 if(value.worldActivationVersion!==undefined){if(value.worldActivationVersion!==1)fail();out.worldActivationVersion=1}
 if(value.worldWorkVersion!==undefined){if(value.worldWorkVersion!==1)fail();out.worldWorkVersion=1}
 if(value.worldStationaryVersion!==undefined){if(value.worldStationaryVersion!==1)fail();out.worldStationaryVersion=1}
 if(value.worldRouteVersion!==undefined){if(value.worldRouteVersion!==1)fail();out.worldRouteVersion=1}
 if(value.worldRollbackVersion!==undefined){if(value.worldRollbackVersion!==1)fail();out.worldRollbackVersion=1}
 for(const name of ['node','platform','arch','rapierPackage','rapierNativeVersion'])if(value[name]!==undefined){if(typeof value[name]!=='string'||!value[name]||value[name].length>80||/[^A-Za-z0-9_.+\/-]/.test(value[name]))fail();out[name]=value[name]}
 for(const name of ['eventJournalEnabled','replayJournalEnabled'])if(value[name]!==undefined){if(typeof value[name]!=='boolean')fail();out[name]=value[name]}
 return out;
}
function parent(value){
 if(!object(value)||typeof value.sessionId!=='string'||!UUID.test(value.sessionId)||!Number.isSafeInteger(value.revision)||value.revision<0)fail();
 const out={sessionId:value.sessionId,revision:value.revision};
 for(const name of ['sourceClosed','sourcePartialTail'])if(value[name]!==undefined){if(typeof value[name]!=='boolean')fail();out[name]=value[name]}
 return out;
}
function capture(sessionId,info,forkedFrom=null){
 if(typeof sessionId!=='string'||!UUID.test(sessionId))fail();
 const out={version:1,sessionId,runtime:runtime(info)};
 if(forkedFrom!==null&&forkedFrom!==undefined){out.forkedFrom=parent(forkedFrom);if(out.forkedFrom.sessionId===sessionId)fail()}
 return out;
}
function validate(value){if(!object(value)||value.version!==1)fail();return capture(value.sessionId,value.runtime,value.forkedFrom)}
function fromSession(value){
 if(value?.recordingContext===undefined)return null;
 const context=validate(value.recordingContext);if(value.sessionId!==context.sessionId)fail();return context;
}
function fromJournal(sessionId,metadata){
 if(metadata?.runtime===undefined)return null;
 const out=capture(sessionId,metadata.runtime,metadata.forkedFrom);
 if(metadata.runtimeInstanceId!==undefined&&metadata.runtimeInstanceId!==out.runtime.instanceId)fail();
 return out;
}
function extract(input){
 const archive=input?.archive||input;
 if(archive?.recordingContext!==undefined){const context=validate(archive.recordingContext);return {kind:'session',context,runtime:context.runtime}}
 const reported=input?.worldRuntime??input?.serverRuntime??archive?.worldRuntime;
 if(reported===undefined)return {kind:'missing',context:null,runtime:null};
 try{return {kind:'report',context:null,runtime:runtime(reported)}}catch{return {kind:'unrecognized',context:null,runtime:null}}
}
function describe(input){
 const info=extract(input),r=info.runtime,c=info.context;
 if(!r)return {summary:info.kind==='unrecognized'?'记录的运行时信息无法识别；来源未认证。':'此记录未保存服务运行时，无法确定实际后端。',details:''};
 const names={wasm:'WASM',rust:'Rust',js:'JS'},backend=name=>r[name]===undefined?'未记录':names[r[name]];
 const summary=`记录环境：物理 ${backend('physicsBackend')} · 任务 ${backend('taskBackend')} · 通信 ${backend('communicationBackend')} · 导航 ${backend('navigationBackend')} · 时钟与事件账本 ${backend('worldLedgerBackend')} · 位置与能量 ${backend('worldMotionBackend')} · 任务状态 ${backend('worldTasksBackend')} · 设备执行 ${backend('worldExecutionBackend')} · 动作状态 ${backend('worldActionsBackend')} · 设备通信 ${backend('worldPeerBackend')} · 中央报告 ${backend('worldReportsBackend')} · 指令与决策 ${backend('worldDispatchBackend')} · 备件与设施 ${backend('worldResourcesBackend')} · 局部感知与记忆 ${backend('worldPerceptionsBackend')} · 环境与扰动 ${backend('worldEnvironmentBackend')} · 提案与撤回 ${backend('worldRequestsBackend')} · 世界控制与计数 ${backend('worldControlBackend')} · 提交失败恢复 ${r.worldRollbackVersion===1?'原生检查点 v1':'未记录'} · 路线推进能力 ${r.worldRouteVersion===1?'原生阶段 v1':'未记录'} · 扫描／补能推进能力 ${r.worldStationaryVersion===1?'原生阶段 v1':'未记录'} · 任务作业推进能力 ${r.worldWorkVersion===1?'原生阶段 v1':'未记录'} · 动作启动能力 ${r.worldActivationVersion===1?'原生阶段 v1':'未记录'} · 动作结束／取消能力 ${r.worldLifecycleVersion===1?'原生阶段 v1':'未记录'} · 任务分配能力 ${r.worldAssignmentVersion===1?'原生阶段 v1':'未记录'} · 故障／低电量中断能力 ${r.worldInterruptionVersion===1?'原生阶段 v1':'未记录'} · 任务撤回能力 ${r.worldRevocationVersion===1?'原生阶段 v1':'未记录'} · 复勘提案能力 ${r.worldProposalVersion===1?'原生阶段 v1':'未记录'} · 时钟与定时恢复能力 ${r.worldTimeVersion===1?'原生阶段 v1':'未记录'} · 步末结果与恢复判定 ${r.worldEndingVersion===1?'原生阶段 v1':'未记录'} · 结束清理与关联事件 ${r.worldFinalizationVersion===1?'原生阶段 v1':'未记录'} · 任务状态与事件 ${r.worldTaskEventsVersion===1?'原生阶段 v1':'未记录'} · 移动状态与事件 ${r.worldRouteEventsVersion===1?'原生阶段 v1':'未记录'} · 扫描／补能状态与事件 ${r.worldStationaryEventsVersion===1?'原生阶段 v1':'未记录'} · 动作取消／移动结束状态与事件 ${r.worldLifecycleEventsVersion===1?'原生阶段 v1':'未记录'} · 动作启动状态与事件 ${r.worldActivationEventsVersion===1?'原生阶段 v1':'未记录'} · 设备消息状态与事件 ${r.worldPeerEventsVersion===1?'原生阶段 v1':'未记录'} · 中央报告状态与事件 ${r.worldReportEventsVersion===1?'原生阶段 v1':'未记录'} · 任务指令与决策状态及事件 ${r.worldDispatchEventsVersion===1?'原生阶段 v1（接令路线由原生地图计算）':'未记录'} · 自动任务排序与候选分配 ${r.worldAutomaticDispatchVersion===1?'原生批量阶段 v1':'未记录'} · 碰撞绕行与事件 ${r.worldCollisionReplanVersion===1?'原生地图与设备位置 v1':'未记录'} · 动作启动路线 ${r.worldActivationPlanningVersion===1?'原生地图与意图 v1':'未记录'} · 直接任务分配路线 ${r.worldAssignmentPlanningVersion===1?'原生地图与资源 v1':'未记录'} · 道路／地表扰动路线 ${r.worldEnvironmentPlanningVersion===1?'原生地图与路线事务 v1':'未记录'} · 设备局部观察 ${r.worldAgentObservationVersion===1?'原生参与者读取 v1':'未记录'} · 指挥观察 ${r.worldCoordinatorObservationVersion===1?'原生参与者读取 v1':'未记录'} · 任务帧推进 ${r.worldTaskAdvanceVersion===1?'原生批量阶段 v1':'未记录'} · 已接受动作推进 ${r.worldActionAdvanceVersion===1?'原生批量阶段 v1':'未记录'} · 完整世界步 ${r.worldAdvanceVersion===1?'原生循环 v1':'未记录'} · 世界初始化 ${r.worldInitializationVersion===1?'原生场景与种子 v1':'未记录'}；来源未认证。`;
 const lines=[`服务实例：${r.instanceId}`,`源会话：${c?c.sessionId:'报告未记录源会话'}`];
 if(c?.forkedFrom)lines.push(`分支起点：${c.forkedFrom.sessionId} · 版本 ${c.forkedFrom.revision}`);
 const archive=input?.archive||input,frame=archive?.frames?.[0];
 if(frame)lines.push(`会话模式：${frame.physicsMode==='rapier'?'Rapier 碰撞':'运动学'} · 感知：${frame.sensorModel??'geometry-v1'} · 寻路目标：${frame.navigation??'distance'}`);
 lines.push(`Node：${r.node??'未记录'} · 平台：${r.platform??'未记录'} / ${r.arch??'未记录'}`);
 if(r.rapierPackage!==undefined)lines.push(`已安装 Rapier JS 包：${r.rapierPackage}`);
 if(r.rapierNativeVersion!==undefined)lines.push(`原生 Rapier：${r.rapierNativeVersion}`);
 lines.push('源码与模块 SHA-256（诊断信息，不证明来源）：');
 for(const [file,digest] of Object.entries(r.sourceSha256).sort(([a],[b])=>a.localeCompare(b,'en')))lines.push(`${file}  ${digest}`);
 return {summary,details:lines.join('\n')};
}
const api={capture,validate,fromSession,fromJournal,extract,describe};
if(typeof module!=='undefined')module.exports=api;else root.SandboxRecordingContext=api;
})(typeof globalThis!=='undefined'?globalThis:this);
