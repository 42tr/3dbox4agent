/* Optional abstract energy-to-heat balance. One completed world tick cools once. */
(function(root){
'use strict';
const keys=['ambientC','initialC','limitC','resumeC','coolingCPerTick','heatCPerEnergy'],stateKeys=['temperatureC','peakC','protected','trips','protectionTicks','tick'],MAX_TICK=10000000;
function validate(p,workEnergy=.08){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k))||keys.some(k=>!Number.isFinite(p[k]))||p.ambientC< -150||p.ambientC>100||p.initialC<p.ambientC||p.initialC>p.limitC||p.limitC>200||p.resumeC<=p.ambientC||p.resumeC>=p.limitC||p.coolingCPerTick<.01||p.coolingCPerTick>20||p.heatCPerEnergy<.01||p.heatCPerEnergy>200||!Number.isFinite(workEnergy)||workEnergy<.001||workEnergy>5||p.limitC-p.resumeC+1e-9<p.heatCPerEnergy*workEnergy)throw Error('invalid thermal profile');return true;
}
function normalize(p,workEnergy=.08){validate(p,workEnergy);return Object.freeze(Object.fromEntries(keys.map(k=>[k,p[k]])))}
function initial(p){return {temperatureC:p.initialC,peakC:p.initialC,protected:p.initialC>=p.limitC,trips:0,protectionTicks:0,tick:0}}
function validateState(p,s,tick){
 if(!p||!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==stateKeys.length||Object.keys(s).some(k=>!stateKeys.includes(k))||![s.temperatureC,s.peakC].every(Number.isFinite)||s.temperatureC<p.ambientC-1e-7||s.temperatureC>p.limitC+1e-7||s.peakC<s.temperatureC-1e-7||s.peakC>p.limitC+1e-7||typeof s.protected!=='boolean'||['trips','protectionTicks','tick'].some(k=>!Number.isSafeInteger(s[k])||s[k]<0||s[k]>MAX_TICK)||s.trips>s.tick+1||s.protectionTicks>s.tick+1||tick!==undefined&&s.tick!==tick)throw Error('invalid thermal state');return true;
}
function observation(p,s){return {...p,...s}}
function effect(p,s,kind,reason){return {kind,temperatureC:s.temperatureC,limitC:p.limitC,resumeC:p.resumeC,...(reason?{reason}:{})}}
function protect(p,s,reason='heat_budget'){
 if(!p||s.protected)return {state:s,effects:[]};const next={...s,protected:true,trips:s.trips+1};return {state:next,effects:[effect(p,next,'thermal_protection_entered',reason)]};
}
function moveLimit(p,s,energyRate,minimumStep){
 if(!p)return Infinity;if(s.protected)return 0;return Math.max(0,(p.limitC-s.temperatureC)/(p.heatCPerEnergy*energyRate)-2*minimumStep-1e-9);
}
function guardWork(p,s,energy){
 if(!p||energy<=0)return {allowed:true,state:s,effects:[]};if(s.protected)return {allowed:false,state:s,effects:[]};if((p.limitC-s.temperatureC)/p.heatCPerEnergy+1e-12>=energy)return {allowed:true,state:s,effects:[]};return {allowed:false,...protect(p,s)};
}
function spend(p,s,energy){
 if(!p||energy<=0)return {state:s,effects:[]};const value=s.temperatureC+energy*p.heatCPerEnergy;if(!Number.isFinite(value)||value>p.limitC+1e-7)throw Error('thermal budget exceeded');const temperatureC=Math.min(p.limitC,value),next={...s,temperatureC,peakC:Math.max(s.peakC,temperatureC)};return temperatureC>=p.limitC-1e-9?protect(p,next,'limit'): {state:next,effects:[]};
}
function finish(p,s,tick){
 if(!p)return {state:s,effects:[]};if(tick===s.tick)return {state:s,effects:[]};if(!Number.isSafeInteger(tick)||tick!==s.tick+1||tick>MAX_TICK)throw Error('invalid thermal tick');const next={...s,temperatureC:Math.max(p.ambientC,s.temperatureC-p.coolingCPerTick),protectionTicks:s.protectionTicks+(s.protected?1:0),tick};const clear=s.protected&&next.temperatureC<=p.resumeC;if(clear)next.protected=false;return {state:next,effects:clear?[effect(p,next,'thermal_protection_cleared')]:[]};
}
function event(name,id,e){const clear=e.kind==='thermal_protection_cleared';return {message:clear?`${name} 温度已恢复至安全范围`:`${name} 进入热保护，等待散热`,type:clear?'success':'warning',...e,agentId:id}}
const api={validate,normalize,initial,validateState,observation,protect,moveLimit,guardWork,spend,finish,event};if(typeof module!=='undefined')module.exports=api;else root.SandboxThermal=api;
})(typeof globalThis!=='undefined'?globalThis:this);
