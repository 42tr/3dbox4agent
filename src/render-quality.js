// Display-only settings; simulation state and time do not depend on them.
'use strict';
const profiles=Object.freeze({high:{pixelRatioCap:2,frameRate:60,detail:true},standard:{pixelRatioCap:1.5,frameRate:60,detail:true},low:{pixelRatioCap:1,frameRate:30,detail:false}});
function profile(name){if(!Object.hasOwn(profiles,name))throw Error('invalid render quality');return profiles[name]}
function pixelRatio(name,deviceRatio){const ratio=Number.isFinite(deviceRatio)&&deviceRatio>0?deviceRatio:1;return Math.min(ratio,profile(name).pixelRatioCap)}
module.exports={profile,pixelRatio};
