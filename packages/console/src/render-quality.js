// Display-only settings; simulation state and time do not depend on them.
'use strict';
const profiles=Object.freeze({high:{pixelRatioCap:2,frameRate:60,detail:true},standard:{pixelRatioCap:1.5,frameRate:60,detail:true},low:{pixelRatioCap:1,frameRate:30,detail:false}});
function profile(name){if(!Object.hasOwn(profiles,name))throw Error('invalid render quality');return profiles[name]}
function pixelRatio(name,deviceRatio){const ratio=Number.isFinite(deviceRatio)&&deviceRatio>0?deviceRatio:1;return Math.min(ratio,profile(name).pixelRatioCap)}
function cameraWidth(name,cssWidth,deviceRatio){
 const width=Number.isFinite(cssWidth)&&cssWidth>0?cssWidth:0;
 // Fixed steps keep camera buffers from being reallocated on every pixel of a resize.
 const rounded=Math.ceil(width*pixelRatio(name,deviceRatio)/160)*160;
 return Math.max(320,Math.min(rounded,640*profile(name).pixelRatioCap));
}
module.exports={profile,pixelRatio,cameraWidth};
