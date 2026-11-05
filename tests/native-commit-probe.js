'use strict';
const E=require('../src/engine');
// Observe the actual accepted-action batch after its native state and cache
// commit. Keeping this in tests preserves the production phase boundary.
module.exports=function acceptedFrameProbe(control,world,active,committed){return {...control,advanceAcceptedActions(...args){const before=active()?E.snapshot(world):null;const result=control.advanceAcceptedActions(...args);if(before)committed(before,E.snapshot(world));return result}}};
