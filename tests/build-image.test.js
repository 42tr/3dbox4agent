'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');

const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-build-image-'));
try{
 const root=path.join(scratch,'repository with spaces'),scripts=path.join(root,'scripts'),bin=path.join(scratch,'bin'),log=path.join(scratch,'docker-calls');
 fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(bin);
 const script=path.join(scripts,'build-image.sh');
 fs.copyFileSync('scripts/build-image.sh',script);
 fs.writeFileSync(path.join(root,'Dockerfile'),'FROM scratch\n');
 execFileSync('git',['init','-q',root]);
 execFileSync('git',['-C',root,'-c','user.name=Build Test','-c','user.email=build-test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','fixture']);
 const commit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const docker=path.join(bin,'docker');
 fs.writeFileSync(docker,`#!/usr/bin/env bash
if [[ "$1" == buildx && "$2" == version ]]; then exit 0; fi
if [[ "$1" != buildx || "$2" != build ]]; then exit 99; fi
printf '%s\\0' "$PWD" "$@" > "$BUILD_TEST_CALLS"
if [[ -n "$BUILD_TEST_EXIT" ]]; then exit "$BUILD_TEST_EXIT"; fi
exit 0
`,{mode:0o755});
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,BUILD_TEST_CALLS:log};
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','PIP_INDEX_URL','NPM_REGISTRY'])delete env[key];
 function run(args=[],extra={}){return spawnSync('bash',[script,...args],{cwd:scratch,env:{...env,...extra},encoding:'utf8',timeout:10000})}
 function calls(){const [cwd,...args]=fs.readFileSync(log,'utf8').split('\0').slice(0,-1);return {cwd,args}}
 function result(){return execFileSync('bash',['-c','source "$1"; printf "%s\\n" "$source_commit" "$release_arch" "$release_platform" "$release_name" "$release_image" "$release_dir"','--',path.join(root,'.3dbox/builds/last-build.env')],{encoding:'utf8'}).trim().split('\n')}

 const first=run([],{http_proxy:'http://user:test@127.0.0.1:7890',HTTPS_PROXY:'http://127.0.0.1:7890'});
 assert.equal(first.status,0,first.stderr);
 const initial=calls();assert.equal(initial.cwd,root);
 assert(initial.args.includes('linux/amd64'));assert(initial.args.includes('world-rust'));assert(initial.args.includes('--load'));
 assert(initial.args.includes('http_proxy'));assert(initial.args.includes('HTTPS_PROXY'));assert(!initial.args.includes('HTTP_PROXY'));
 assert(!fs.readFileSync(log,'utf8').includes('user:test'));
 const expectedNetwork=execFileSync('uname',['-s'],{encoding:'utf8'}).trim()==='Linux'?'host':'default';
 assert.equal(initial.args[initial.args.indexOf('--network')+1],expectedNetwork);
 assert.equal(initial.args.includes('--allow=network.host'),expectedNetwork==='host');
 const saved=result();assert.equal(saved[0],commit);assert.equal(saved[1],'amd64');assert.equal(saved[2],'linux/amd64');
 assert(saved[3].startsWith('3dbox4agent-'+commit.slice(0,12)+'-'));
 assert.equal(saved[4],saved[3]+':world-rust');assert(initial.args.includes(saved[4]));
 assert.equal(saved[5],path.join(root,'.3dbox/releases',saved[3]));

 const custom=run(['--arch','arm64','--image','registry.example/3dbox:custom','--network','default'],{PIP_INDEX_URL:'https://pypi.example/simple',NPM_REGISTRY:'https://npm.example'});
 assert.equal(custom.status,0,custom.stderr);
 const overridden=calls().args;assert(overridden.includes('linux/arm64'));assert(overridden.includes('registry.example/3dbox:custom'));
 assert(!overridden.includes('--allow=network.host'));assert(overridden.includes('PIP_INDEX_URL=https://pypi.example/simple'));assert(overridden.includes('NPM_REGISTRY=https://npm.example'));
 assert.equal(result()[1],'arm64');assert.equal(result()[4],'registry.example/3dbox:custom');

 const resultFile=path.join(root,'.3dbox/builds/last-build.env'),lastSuccess=fs.readFileSync(resultFile,'utf8');
 const failure=run(['--network','host'],{BUILD_TEST_EXIT:'23'});assert.equal(failure.status,23,failure.stderr);
 assert(calls().args.includes('--allow=network.host'));assert.equal(fs.readFileSync(resultFile,'utf8'),lastSuccess);assert(!failure.stdout.includes('构建完成'));

 fs.rmSync(log);
 for(const args of [['--arch'],['--arch','mips'],['--network','invalid'],['--image'],['--unknown']]){
  const rejected=run(args);assert.equal(rejected.status,2,JSON.stringify(args)+rejected.stderr);assert(!fs.existsSync(log));
 }
 const help=run(['--help']);assert.equal(help.status,0);assert(help.stdout.includes('--arch'));assert(!fs.existsSync(log));
 console.log('build-image: defaults, proxy forwarding, ARM64/custom options, paths with spaces, failed-build metadata and argument validation passed');
}finally{fs.rmSync(scratch,{recursive:true,force:true})}
