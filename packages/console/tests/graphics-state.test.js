'use strict';
const assert=require('node:assert/strict');
const {createContext,failure}=require('../src/graphics-state');

let calls=0;
const context={renderer:'owned context'};
assert.equal(createContext({getContext(kind,options){calls++;assert.equal(kind,'webgl2');assert.equal(options.alpha,false);assert.equal(options.antialias,true);assert.equal(options.preserveDrawingBuffer,false);return context}}),context);
assert.equal(calls,1,'probe and renderer share the same context');
let unavailable;
try{createContext({getContext(){return null}})}catch(e){unavailable=e}
assert.equal(unavailable.code,'WEBGL2_UNAVAILABLE');
assert.equal(failure(unavailable).code,'webgl2-unavailable');

const blocked=new Error('private renderer detail');
assert.throws(()=>createContext({getContext(){throw blocked}}),e=>e===blocked);
assert.equal(failure(blocked).code,'initialization-failed','a scene exception must not blame browser support');
assert.equal(failure({code:'WEBGL_CONTEXT_LOST'}).code,'context-lost');
assert.equal(failure(null).code,'initialization-failed');
assert.ok(!JSON.stringify(failure(blocked)).includes(blocked.message),'diagnostic details stay out of user-facing copy');
console.log('graphics context ownership and unavailable/initialization/lost failure classification passed');
