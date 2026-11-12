'use strict';
const {planGroundRoute}=require('../native/physics/target/release/box_physics.node');
if(typeof planGroundRoute!=='function')throw Error('native navigation unavailable; rebuild the Rust module');
function plan(start,target,obstacles,zones=[],metric='distance',heightfield=null){
 return JSON.parse(planGroundRoute(JSON.stringify({start,target,obstacles,zones,metric,...(heightfield?{heightfield}:{})})));
}
module.exports={plan};
