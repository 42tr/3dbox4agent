/* Stable device-type colors shared by map, 3D view and legend. */
(function(root){
'use strict';
const fixed={drone:'#168d8a',rover:'#168d8a',vehicle:'#d28a42',robot:'#6d7eaa',boat:'#267e9a'};
const palette=['#4779b8','#a15796','#8a6c36','#4f8660','#b35e4d','#6c63a9','#557b82','#9b773c'];
function color(role){if(Object.hasOwn(fixed,role))return fixed[role];let hash=2166136261;for(const c of String(role)){hash=Math.imul(hash^c.codePointAt(0),16777619)}return palette[(hash>>>0)%palette.length]}
function model(agent,isAir){if(isAir)return 'air';if(agent.mobility==='water')return 'water';if(agent.role==='vehicle'||agent.role==='rover')return 'wheeled';if(agent.role==='robot'||agent.capabilities?.includes('repair'))return 'robot';return 'wheeled'}
const api={color,model};if(typeof module!=='undefined')module.exports=api;else root.SandboxAgentVisual=api;
})(typeof globalThis!=='undefined'?globalThis:this);
