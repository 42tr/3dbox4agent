'use strict';
// Private native references follow a participant's opaque checkpoint capability.
// Decorators can forward that capability without copying or exposing raw state.
const participants=new WeakMap();
function expose(store,kind,native,refresh){
 if(typeof store.checkpoint!=='function'||participants.has(store.checkpoint))throw Error('native participant capability unavailable');
 participants.set(store.checkpoint,Object.freeze({kind,native,refresh}));return Object.freeze(store);
}
function reference(store,kind){const entry=participants.get(store?.checkpoint);if(!entry||entry.kind!==kind)throw Error('native participant unavailable');return entry}
module.exports={expose,reference};
