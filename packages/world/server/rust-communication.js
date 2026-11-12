'use strict';
const {messageQueueTick,centralLinkTick}=require('../native/physics/target/release/box_physics.node');
function tick(world,packets){return JSON.parse(messageQueueTick(JSON.stringify({tick:world.tick,seed:world.seed,delay:world.communication.config.delay,lossRate:world.communication.config.lossRate,packets})))}
function central(world,packets,offset){return JSON.parse(centralLinkTick(JSON.stringify({tick:world.tick,seed:world.seed,lossRate:world.communication.config.lossRate,offset,packets})))}
module.exports={tick,central};
