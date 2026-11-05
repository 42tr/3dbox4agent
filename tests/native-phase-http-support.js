'use strict';
// Historical HTTP fault fixtures deliberately exercise the leaf phase adapter:
// their exceptions occur between native phases. This test-only decorator omits
// the whole-step binding method; production factories and metadata are untouched.
// The default fully bound service has separate whole-step matrix/atomic/HTTP tests.
function adapter(control){return {...control,bindWorldStep:undefined}}
function install(){const Control=require('../server/rust-world-control'),original=Control.create;Control.create=(...args)=>adapter(original(...args));return ()=>{Control.create=original}}
module.exports=install;module.exports.adapter=adapter;
