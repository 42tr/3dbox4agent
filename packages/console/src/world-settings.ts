export const settingsOptions={
 scenario:[['industrial-park-v1','单线园区'],['industrial-park-fixed-sensor-v1','园区固定传感器演示'],['industrial-park-risk-v1','园区风险区域演示'],['industrial-park-risk-detour-v1','园区避险绕行演示'],['industrial-park-parallel-v1','并行巡检园区'],['industrial-park-priority-v1','限时并行巡检'],['lunar-base-v1','月球基地抽象原型'],['lunar-terrain-v1','月球基地地表通行'],['lunar-sampling-v1','月球基地勘察采样'],['lunar-outpost-v1','月面基地设施协作'],['lunar-heightfield-v1','月面基地高度地形'],['lunar-thermal-v1','月面基地热控约束'],['lunar-materials-v1','月面基地耗材约束'],['lunar-relay-v1','月面基地中继部署'],['lunar-construction-v1','月面基地建设'],['lunar-rescue-v1','月面设备协同救援'],['lunar-power-v1','月面基础运行耗电'],['shore-coordination-v1','海岸协同演练原型'],['shore-surface-v1','海岸水陆空协同'],['shore-sea-state-v1','海岸通航海况演练'],['shore-echelons-v1','海岸多梯队协同'],['shore-rescue-v1','海岸中继协同救援']],
 linkProfile:[['default','场景默认'],['long','长延迟示例']],radioVisibility:[['default','场景默认'],['on','建筑与地形遮挡'],['off','不模拟遮挡']],bandwidthProfile:[['default','场景默认'],['8','默认 8 字节 / 步']],routePolicy:[['default','场景默认'],['distance','距离优先'],['time','时间优先'],['energy','能耗优先']],riskPolicy:[['default','场景默认'],['monitor','仅监测'],['avoid','水陆规划绕行']],policy:[['nearest','最近优先'],['battery','电量优先']],executionMode:[['auto','自动执行'],['agent','设备启动任务'],['primitive','单体分步执行']],dispatchMode:[['rule','规则自动'],['networked','经通信下发'],['external','外部 / 人工'],['networked_external','外部指挥 / 模拟链路'],['networked_reported','外部指挥 / 延迟状态']],physicsMode:[['kinematic','运动学'],['rapier','Rapier 碰撞']],sensorMode:[['geometry','几何遮挡'],['rapier','Rust 射线（需 Rapier）']]
} as const;
export type SettingSelect=keyof typeof settingsOptions;
export type WorldSettings={scenario:string;seed:string;linkProfile:string;radioVisibility:string;bandwidthProfile:string;routePolicy:string;riskPolicy:string;policy:string;executionMode:string;dispatchMode:string;physicsMode:string;sensorMode:string};
export type SettingField=keyof WorldSettings;
export const defaultWorldSettings:WorldSettings={scenario:'lunar-outpost-v1',seed:'42',linkProfile:'default',radioVisibility:'default',bandwidthProfile:'default',routePolicy:'default',riskPolicy:'default',policy:'nearest',executionMode:'auto',dispatchMode:'rule',physicsMode:'kinematic',sensorMode:'geometry'};
const parsedSeed=(value:unknown):number|null=>{const raw=String(value),n=Number(raw);return /^\d+$/.test(raw)&&Number.isSafeInteger(n)&&n<=4294967295?n:null};
export function previewSettingsSeed(value:unknown,previous:unknown=42):number{return parsedSeed(value)??parsedSeed(previous)??42}
export type SettingsContext={key:string;values:WorldSettings;customLabel:string|null;notice?:string;networkSummary?:string;observer:boolean;busy:boolean;focused:boolean;latest:boolean;imported:boolean;failed:boolean;done:boolean;server:boolean;rays:boolean;current:{name:string;seed:number;policy:string;executionMode:string;dispatchMode:string;physicsMode:string;tick:number}};
export type SettingsResult={ok:boolean;reason?:string};
const own=(o:object,k:string)=>Object.prototype.hasOwnProperty.call(o,k);
export function settingAllowed(c:SettingsContext,field:unknown,value:unknown):field is SettingField{
 if(typeof field!=='string'||typeof value!=='string'||!own(defaultWorldSettings,field))return false;
 if(field==='seed')return value.length<=32;
 if(field==='scenario'&&value==='_custom')return !!c.customLabel;
 return settingsOptions[field as SettingSelect].some(([v])=>v===value);
}
export function validateSettings(c:SettingsContext):string|null{
 for(const [field,value] of Object.entries(c.values))if(!settingAllowed(c,field,value))return 'invalid_setting';
 if(Object.keys(c.values).length!==Object.keys(defaultWorldSettings).length)return 'invalid_setting';
 if(parsedSeed(c.values.seed)===null)return 'invalid_seed';
 if(c.server&&c.values.sensorMode==='rapier'&&(!c.rays||c.values.physicsMode!=='rapier'))return 'ray_requires_rapier';
 return null;
}
export function settingsConnectionDisabled(c:SettingsContext,connected:boolean):boolean{return c.busy||!connected&&!!validateSettings(c)}
export function customSettings(v:WorldSettings):boolean{return v.scenario==='_custom'||(['linkProfile','radioVisibility','bandwidthProfile','routePolicy','riskPolicy'] as const).some(k=>v[k]!=='default')}
export function configuredScene(engine:any,v:WorldSettings,custom:any){
 const scene=engine.withLinkProfile(v.scenario==='_custom'?custom:engine.getScene(v.scenario),v.linkProfile);
 if(v.routePolicy!=='default')scene.navigation=v.routePolicy;
 if(v.riskPolicy!=='default')scene.riskNavigation=v.riskPolicy;
 if(v.radioVisibility!=='default')scene.communication.lineOfSight=v.radioVisibility==='on';
 if(v.bandwidthProfile==='8')scene.communication.bytesPerTick=8;
 return engine.normalizeScene(scene);
}
export function settingsSession(engine:any,c:SettingsContext,custom:any){
 const reason=validateSettings(c);if(reason)throw Error(reason);const v=c.values,scene=configuredScene(engine,v,custom);
 return {seed:Number(v.seed),policy:v.policy,sceneId:scene.id,...(customSettings(v)?{scene}:{}),dispatchMode:v.dispatchMode,executionMode:v.executionMode,physicsMode:v.physicsMode,sensorMode:v.sensorMode};
}
export function settingsBlock(c:SettingsContext,operation:'edit'|'restart'|'dispatch'):string|null{
 if(c.observer)return 'read_only';if(c.busy)return 'busy';if(c.focused)return 'agent_view';
 if(operation==='dispatch'){if(c.imported)return 'imported_replay';if(!c.latest)return 'history_view';if(c.failed)return 'session_stopped';if(c.done)return 'world_finished'}
 return null;
}
const messages:Record<string,string>=Object.assign(Object.create(null),{read_only:'只读观察不能修改世界设置。',busy:'正在处理其他操作，请稍候。',agent_view:'请返回全局视图后修改世界设置。',imported_replay:'回放不支持即时切换指挥方式；可应用设置开始新运行。',history_view:'当前显示历史快照，请返回实时视图后切换指挥方式。',session_stopped:'会话已停止，可应用设置重新创建世界。',world_finished:'运行已结束，可应用设置重新开始。',context_changed:'运行已切换，请检查当前设置。',invalid_setting:'设置已变化，请重新选择有效选项。',invalid_seed:'随机种子须为 0 到 4294967295 的整数。',ray_requires_rapier:'Rust 射线需要原生物理服务，并选择 Rapier 碰撞。',restart_failed:'未能创建新的运行，已保留原世界，请检查连接后再试。',dispatch_failed:'指挥方式未确认，请检查最新状态后再操作。'});
export const settingsMessage=(reason?:string)=>messages[reason||'']||'操作结果未确认，请检查当前世界后再操作。';
type Environment={read:()=>SettingsContext;change:(field:SettingField,value:string)=>void;restart:()=>SettingsResult|Promise<SettingsResult>;dispatch:(mode:string)=>SettingsResult|Promise<SettingsResult>};
export function createWorldSettingsController(env:Environment){
 const pending=new Set<string>();
 return {
  edit(key:string,field:unknown,value:unknown):SettingsResult{const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};const reason=settingsBlock(c,'edit');if(reason||pending.has(key))return {ok:false,reason:reason||'busy'};if(!settingAllowed(c,field,value))return {ok:false,reason:'invalid_setting'};env.change(field,value as string);return {ok:true}},
  async submit(key:string,operation:'restart'|'dispatch'):Promise<SettingsResult>{
   const c=env.read();if(c.key!==key)return {ok:false,reason:'context_changed'};if(operation!=='restart'&&operation!=='dispatch')return {ok:false,reason:'invalid_setting'};
   const reason=settingsBlock(c,operation);if(reason||pending.has(key))return {ok:false,reason:reason||'busy'};
   const invalid=operation==='restart'?validateSettings(c):settingAllowed(c,'dispatchMode',c.values.dispatchMode)?null:'invalid_setting';if(invalid)return {ok:false,reason:invalid};
   pending.add(key);try{const r=await(operation==='restart'?env.restart():env.dispatch(c.values.dispatchMode));if(operation==='dispatch'&&env.read().key!==key)return {ok:false,reason:'context_changed'};return r?.ok===true?{ok:true}:{ok:false,reason:operation==='restart'?'restart_failed':'dispatch_failed'}}catch{return {ok:false,reason:operation==='restart'?'restart_failed':'dispatch_failed'}}finally{pending.delete(key)}
  }
 };
}
