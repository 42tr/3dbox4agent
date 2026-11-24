/* Geometry and routing for the JavaScript kinematic flight model. */
(function (root) {
'use strict';

const Elevation = typeof module !== 'undefined' ? require('./elevation') : root.SandboxElevation;
const Nav = typeof module !== 'undefined' ? require('./navigation') : root.SandboxNavigation;
const Sensors = typeof module !== 'undefined' ? require('./sensors') : root.SandboxSensors;
const Surface = typeof module !== 'undefined' ? require('./surface-domain') : root.SandboxSurfaceDomain;
const radius = .8;
const clearance = Object.freeze({minimum: 2, maximum: 35});
const verticalDistance = Object.freeze({minimum: .5, maximum: 20});
const verticalSpeed = 2;
const takeoffHeight = Object.freeze({minimum: 3, maximum: 15, default: 8});
const hoverDuration = Object.freeze({minimum: 1, maximum: 60});
const landingSlope = 12;
const distance = (a,b) => Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);
const pointAlong = (a,b,t) => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});

function heightRange(world,x,y) {
  const ground = Elevation.height(world.heightfield,x,y);
  return {minimum: ground+clearance.minimum, maximum: ground+clearance.maximum};
}

function worldHeightRange(world) {
  const heights=world.heightfield?.heights??[0];
  return {minimum: Math.min(...heights)+clearance.minimum, maximum: Math.max(...heights)+clearance.maximum};
}

function movementLimits(world,agent) {
  const {z}=Sensors.position(agent,world.heightfield),limit=heightRange(world,agent.x,agent.y);
  return {
    altitudeRange:worldHeightRange(world),minimumDeltaM:verticalDistance.minimum,
    ascendM:Math.max(0,Math.min(verticalDistance.maximum,limit.maximum-z)),
    descendM:Math.max(0,Math.min(verticalDistance.maximum,z-limit.minimum)),
    state:flightState(world,agent),
    takeoffHeight,
    hoverDuration,
  };
}

function flightState(world,agent) {
  if (agent.landed===true) return 'landed';
  const position=Sensors.position(agent,world.heightfield);
  return validHeight(world,position)?'airborne':'low_altitude';
}

function validHeight(world,point) {
  const {minimum,maximum} = heightRange(world,point.x,point.y);
  return Number.isFinite(point.z) && point.z >= minimum-1e-8 && point.z <= maximum+1e-8;
}

function validDelta(delta) {
  return Number.isFinite(delta) && Math.abs(delta) >= verticalDistance.minimum &&
    Math.abs(delta) <= verticalDistance.maximum;
}

function controlInput(input,size) {
  if (!input||typeof input!=='object'||Array.isArray(input)) return null;
  const keys=Object.keys(input),{mode}=input;
  if (mode==='takeoff'&&keys.every(key=>key==='mode'||key==='heightM')) {
    const heightM=input.heightM===undefined?takeoffHeight.default:input.heightM;
    if (Number.isFinite(heightM)&&heightM>=takeoffHeight.minimum&&heightM<=takeoffHeight.maximum) return {mode,heightM};
  }
  if (mode==='land'&&keys.length===3&&[input.x,input.y].every(n=>Number.isFinite(n)&&n>=0&&n<=size)) {
    return {mode,x:input.x,y:input.y};
  }
  if (mode==='hover'&&keys.length===2&&Number.isInteger(input.durationTicks)&&
      input.durationTicks>=hoverDuration.minimum&&input.durationTicks<=hoverDuration.maximum) {
    return {mode,durationTicks:input.durationTicks};
  }
  return null;
}

function landingPoint(world,x,y) {
  const size=world.worldSize??100;
  if ([x,y].some(n=>n<radius||n>size-radius)||!Surface.free(world.surfaceDomain,'ground',[x,y],radius)) return null;
  const footprint={x:x-radius,y:y-radius,w:2*radius,h:2*radius};
  if (Elevation.profile(world.heightfield).some(cell=>cell.slopeDegrees>landingSlope&&
      cell.x<x+radius&&cell.x+cell.w>x-radius&&cell.y<y+radius&&cell.y+cell.h>y-radius)) return null;
  return {x,y,z:Elevation.bounds(world.heightfield,footprint)[1]+radius};
}

function validPose(world,point) {
  if (validHeight(world,point)) return true;
  const ground=landingPoint(world,point.x,point.y),minimum=heightRange(world,point.x,point.y).minimum;
  return !!ground&&point.z>=ground.z-1e-8&&point.z<minimum;
}

function landedAtStation(world,agent) {
  const station=world.chargingStation;
  return agent.landed===true&&!!station&&Math.hypot(agent.x-station[0],agent.y-station[1])<=2.8&&
    Nav.clearSegment([agent.x,agent.y],station,obstacles(world),0,world.worldSize??100);
}

function obstacles(world) {
  return world.obstacles.concat(world.roadblocks ?? []).map(o => Elevation.prism(world.heightfield,o));
}

function hitsPrism(from,to,block) {
  let entry=0,exit=1;
  for (const [axis,minimum,maximum] of [
    ['x',block.x-radius,block.x+block.w+radius], ['y',block.y-radius,block.y+block.h+radius],
    ['z',(block.base??0)-radius,block.height+radius],
  ]) {
    const start=from[axis],delta=to[axis]-start;
    if (Math.abs(delta)<1e-10) {
      if (start<minimum||start>maximum) return false;
      continue;
    }
    const a=(minimum-start)/delta,b=(maximum-start)/delta;
    entry=Math.max(entry,Math.min(a,b));
    exit=Math.min(exit,Math.max(a,b));
    if (entry>exit) return false;
  }
  return true;
}

function clear(world,from,to,blocks=obstacles(world)) {
  const size=world.worldSize??100;
  if ([from.x,from.y,to.x,to.y].some(n=>n<radius||n>size-radius)) return false;
  const cuts=Elevation.cuts(world.heightfield,[from.x,from.y],[to.x,to.y]);
  return cuts.every(t=>validHeight(world,pointAlong(from,to,t))) &&
    !blocks.some(block=>hitsPrism(from,to,block));
}

function clearLandingColumn(world,from,to) {
  return from.x===to.x&&from.y===to.y&&!!landingPoint(world,from.x,from.y)&&
    validPose(world,from)&&validPose(world,to)&&!obstacles(world).some(block=>hitsPrism(from,to,block));
}

function horizontalRoute(world,from,to,blocks=obstacles(world)) {
  if (clear(world,from,to,blocks)) return [to];
  const atHeight=blocks.filter(block=>from.z>=(block.base??0)-radius&&from.z<=block.height+radius);
  const map=atHeight.map(block=>({...block,padding:radius}));
  const route=Nav.plan([from.x,from.y],[to.x,to.y],map,[],'distance',null,world.worldSize??100);
  if (!route) return null;
  const path=route.map(([x,y])=>({x,y,z:from.z}));
  return path.every((point,index)=>clear(world,path[index-1]??from,point,blocks))?path:null;
}

function plan(world,from,to) {
  const blocks=obstacles(world);
  if (clear(world,from,to,blocks)) return [to];
  if (from.x===to.x&&from.y===to.y) return null;
  if (!clear(world,from,from,blocks)||!clear(world,to,to,blocks)) return null;
  const maxTerrain = Math.max(0,...(world.heightfield?.heights ?? []));
  const candidates = [...new Set([from.z,to.z,maxTerrain+clearance.minimum,
    ...blocks.map(block=>block.height+radius+.01)])].sort((a,b)=>
    Math.abs(a-from.z)+Math.abs(a-to.z)-Math.abs(b-from.z)-Math.abs(b-to.z)||a-b);
  for (const z of candidates) {
    const departure={x:from.x,y:from.y,z},arrival={x:to.x,y:to.y,z};
    if (!clear(world,from,departure,blocks)||!clear(world,arrival,to,blocks)) continue;
    const route=horizontalRoute(world,departure,arrival,blocks);
    if (route) return [...(from.z===z?[]:[departure]),...route,...(to.z===z?[]:[to])];
  }
  return null;
}

function planControl(world,agent,start,control) {
  const state=flightState(world,agent);
  if (control.mode==='takeoff') {
    if (state==='airborne') return {reason:'already_airborne'};
    const target={...start,z:Elevation.height(world.heightfield,start.x,start.y)+control.heightM};
    return clearLandingColumn(world,start,target)?{target,path:[target]}:{reason:'takeoff_site_unavailable'};
  }
  if (state==='landed') return {reason:'takeoff_required'};
  if (control.mode==='hover') return {target:start,path:[]};

  const target=landingPoint(world,control.x,control.y);
  if (!target) return {reason:'landing_site_unavailable'};
  if (start.x===target.x&&start.y===target.y) {
    return clearLandingColumn(world,start,target)?{target,path:[target]}:{reason:'landing_site_unavailable'};
  }
  if (state!=='airborne') return {reason:'takeoff_required'};
  const approach={...target,z:Elevation.height(world.heightfield,target.x,target.y)+takeoffHeight.minimum};
  if (!clearLandingColumn(world,approach,target)) return {reason:'landing_site_unavailable'};
  const route=plan(world,start,approach);
  return route?{target,path:[...route,target]}:{reason:'unreachable_target'};
}

// A swept sphere blocks every segment, including vertical passes between agents.
function bodyFraction(world,agent,from,to) {
  const dx=to.x-from.x,dy=to.y-from.y,dz=to.z-from.z;
  const lengthSquared=dx*dx+dy*dy+dz*dz;
  let fraction=1;
  for (const other of world.agents) {
    if (other.id===agent.id) continue;
    const center=Sensors.position(other,world.heightfield);
    const x=from.x-center.x,y=from.y-center.y,z=from.z-center.z;
    const dot=x*dx+y*dy+z*dz;
    if (dot>=0) continue;
    const gap=x*x+y*y+z*z-4*radius*radius;
    if (gap<=1e-9) return 0;
    const discriminant=dot*dot-lengthSquared*gap;
    if (discriminant>=0) {
      const entry=gap/(-dot+Math.sqrt(discriminant));
      if (entry<=1) fraction=Math.min(fraction,Math.max(0,entry-1e-7));
    }
  }
  return fraction;
}

const api={clearance,verticalDistance,verticalSpeed,takeoffHeight,hoverDuration,distance,pointAlong,heightRange,worldHeightRange,
  movementLimits,flightState,validHeight,validPose,validDelta,controlInput,landingPoint,landedAtStation,clearLandingColumn,planControl,
  clear,horizontalRoute,plan,bodyFraction};
if (typeof module !== 'undefined') module.exports=api;
else root.SandboxFlight=api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
