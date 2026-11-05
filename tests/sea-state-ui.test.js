'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{buildSync}=require('esbuild'),D=require('../src/surface-domain'),E=require('../src/engine');
function bundle(file){const scope={module:{exports:{}},exports:{},require,console};vm.runInNewContext(buildSync({entryPoints:[file],bundle:true,write:false,platform:'node',format:'cjs',external:['react','react-dom','react/jsx-runtime']}).outputFiles[0].text,scope);return scope.module.exports}
const Controls=bundle('src/world-disturbance-controls.tsx').WorldDisturbanceControls,C=bundle('src/world-disturbances.ts');
const profile=require('../examples/scenes/shore-sea-state.json').surfaceDomain;
assert.equal(D.regionKind(profile,{x:45,y:4,w:50,h:32}),'water'); // several adjoining union pieces
assert.equal(D.regionKind(profile,{x:45,y:30,w:50,h:40}),'mixed'); // center can be water while a corner contains land
assert.equal(D.regionKind(profile,{x:62,y:40,w:10,h:15}),'ground');
assert.equal(D.regionKind(profile,{x:0,y:0,w:45,h:100}),'ground'); // boundary-only contact
assert.equal(D.regionKind(undefined,{x:1,y:1,w:10,h:10}),'ground');
for(const r of [{x:0,y:0,w:0,h:1},{x:NaN,y:0,w:1,h:1},{x:99,y:0,w:2,h:1}])assert.throws(()=>D.regionKind(profile,r));
const joined={water:[{id:'a',name:'A',x:10,y:10,w:30,h:30},{id:'b',name:'B',x:40,y:10,w:30,h:30}]};assert.equal(D.regionKind(joined,{x:20,y:20,w:40,h:10}),'water');
const meta={key:'sea',observer:false,imported:false,focused:false,latest:true,failed:false,done:false,busy:false,running:false},scene=E.getScene('shore-sea-state-v1'),world=E.create(42,'nearest',scene,{dispatchMode:'external'}),before=E.snapshot(world);
assert(E.injectTerrainEffect(world,'north-sea',8,.35,2.5).ok);const context=C.projectDisturbances(world,meta);assert(context.zones.every(z=>z.surface==='water'));assert.equal(context.effects[0].speedFactor,.35);assert.equal(context.effects[0].energyFactor,2.5);
const render=context=>renderToStaticMarkup(React.createElement(Controls,{context,submit:async()=>({ok:true}),global(){},live(){}}));
const html=render(context);for(const s of ['海况与通航扰动','海况扰动水域','海况恶化持续步数','注入海况恶化','速度 ×0.35','单位距离能耗 ×2.5','含当前步剩余 9 步'])assert(html.includes(s),s);
const past=render(C.projectDisturbances(before,{...meta,latest:false}));assert(!past.includes('×0.35'));assert(!past.includes('<form'));assert(past.includes('当前无海况恶化'));
for(const gate of [{observer:true},{focused:true},{imported:true}])assert(!render(C.projectDisturbances(world,{...meta,...gate})).includes('<form'));
const poison={tick:7};for(const key of ['agents','terrain','terrainEffects','surfaceDomain','communication','roadblocks','events'])Object.defineProperty(poison,key,{get(){throw Error('unscoped '+key)}});const own=C.projectDisturbances(poison,{...meta,focused:true});assert.equal(own.zones.length,0);assert.equal(own.effects.length,0);
context.zones[0].name='forged';context.effects[0].speedFactor=1;assert.equal(world.terrain[0].name,'北部通航海况区');assert.equal(world.terrainEffects[0].speedFactor,.35);
const land=C.projectDisturbances(E.create(42,'nearest',E.getScene('shore-coordination-v1')),meta);assert(!('surface'in land.zones[0]));assert(render(land).includes('地表条件扰动'));assert(render(land).includes('注入通行恶化'));
console.log('Sea condition UI: full-rectangle union/hole classification, actual effect multipliers and inclusive remaining time, detached projections, legacy controls and poisoned-global own/history/read-only fences passed; SSR is not browser visual acceptance');
