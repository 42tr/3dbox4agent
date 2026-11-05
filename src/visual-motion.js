// Display-only interpolation. Never changes a simulation snapshot.
'use strict';
function eligible(previous,current,expectedPrevious,selected,lastSelected,running,reducedMotion){
 return !!running&&!reducedMotion&&!!previous&&previous===expectedPrevious&&current!==previous&&current.sceneId===previous.sceneId&&current.tick===previous.tick+1&&selected===lastSelected;
}
function position(from,to,start,duration,now){
 const t=Math.max(0,Math.min(1,(now-start)/duration));
 return {x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t,done:t===1};
}
module.exports={eligible,position};
