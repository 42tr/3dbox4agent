'use strict';
const E=require('../src/engine'),F=require('../src/scene-format');
try{
 const args=process.argv.slice(2),yaml=args.includes('--yaml'),pack=args.includes('--package'),ids=args.filter(arg=>arg!=='--yaml'&&arg!=='--package');
 if(ids.length>1||args.filter(arg=>arg==='--yaml').length>1||args.filter(arg=>arg==='--package').length>1||yaml&&pack)throw Error('usage: node scripts/export-scene.js [scene-id] [--yaml|--package]');
 const scene=E.getScene(ids[0]||E.scene.id);
 process.stdout.write(pack?F.stringifyPackage(scene):yaml?F.stringifyScene(scene):JSON.stringify(scene,null,2)+'\n');
}catch(error){console.error(error.message);process.exitCode=1}
