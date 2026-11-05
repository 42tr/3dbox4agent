'use strict';
const assert=require('node:assert/strict'),Q=require('../src/render-quality');
assert.deepEqual([Q.pixelRatio('high',3),Q.pixelRatio('standard',3),Q.pixelRatio('low',3)],[2,1.5,1]);
assert.equal(Q.pixelRatio('high',1),1);assert.equal(Q.pixelRatio('low',NaN),1);assert.equal(Q.pixelRatio('low',0),1);
assert.equal(Q.profile('high').detail,true);assert.equal(Q.profile('low').detail,false);assert.equal(Q.profile('low').frameRate,30);assert.throws(()=>Q.profile('unknown'));
console.log('display quality caps, optional details and frame rate passed');
