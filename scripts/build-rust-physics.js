'use strict';
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'), manifest=path.join(root,'rust/physics/Cargo.toml');
const built=spawnSync('cargo',['build','--release','--locked','--manifest-path',manifest],{stdio:'inherit',cwd:root});
if(built.error)throw built.error;
if(built.status!==0)process.exit(built.status||1);
const name=process.platform==='darwin'?'libbox_physics.dylib':process.platform==='win32'?'box_physics.dll':'libbox_physics.so';
const dir=path.join(root,'rust/physics/target/release');
const destination=path.join(dir,'box_physics.node'), temporary=path.join(dir,`.box_physics-${process.pid}.node`);
try { fs.copyFileSync(path.join(dir,name),temporary,fs.constants.COPYFILE_EXCL); fs.renameSync(temporary,destination); }
finally { try { fs.unlinkSync(temporary); } catch(e) { if(e.code!=='ENOENT')throw e; } }
console.log('Native physics module ready:',path.join(dir,'box_physics.node'));
