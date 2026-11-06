'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const YAML=require('yaml');
const {spawnSync,execFileSync}=require('node:child_process');

const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'3dbox-build-image-'));
try{
 const root=path.join(scratch,'repository with spaces'),scripts=path.join(root,'scripts'),bin=path.join(scratch,'bin'),log=path.join(scratch,'docker-calls');
 fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(bin);fs.mkdirSync(path.join(root,'deploy'));
 const script=path.join(scripts,'build-image.sh');
 fs.copyFileSync('scripts/build-image.sh',script);
 fs.copyFileSync('deploy/compose.runtime.yaml',path.join(root,'deploy/compose.runtime.yaml'));
 fs.copyFileSync('deploy/README.md',path.join(root,'deploy/README.md'));
 fs.writeFileSync(path.join(root,'Dockerfile'),'FROM scratch\n');
 execFileSync('git',['init','-q',root]);
 execFileSync('git',['-C',root,'-c','user.name=Build Test','-c','user.email=build-test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','fixture']);
 const commit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const docker=path.join(bin,'docker');
 fs.writeFileSync(docker,`#!/usr/bin/env bash
if [[ "$1" == buildx && "$2" == version ]]; then exit 0; fi
if [[ "$1" == buildx && "$2" == build ]]; then
  printf '%s\\0' "$PWD" "$@" > "$BUILD_TEST_CALLS"
  if [[ -n "$BUILD_TEST_EXIT" ]]; then exit "$BUILD_TEST_EXIT"; fi
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --platform ]]; then printf '%s' "$2" > "$BUILD_TEST_PLATFORM"; fi
    shift
  done
  exit 0
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$4" == '{{.Id}}' ]]; then printf 'sha256:test-image\\n'; exit 0; fi
  if [[ -n "$BUILD_TEST_WRONG_PLATFORM" ]]; then printf 'linux/ppc64le\\n'; else cat "$BUILD_TEST_PLATFORM"; fi
  exit 0
fi
if [[ "$1" == image && "$2" == save ]]; then
  printf '%s' "$3" > "$BUILD_TEST_SAVE_IMAGE"
  printf 'fake Docker image stream\\n'
  if [[ -n "$BUILD_TEST_SAVE_EXIT" ]]; then exit "$BUILD_TEST_SAVE_EXIT"; fi
  exit 0
fi
exit 99
`,{mode:0o755});
 const realGzip=execFileSync('sh',['-c','command -v gzip'],{encoding:'utf8'}).trim();
 fs.writeFileSync(path.join(bin,'gzip'),`#!/usr/bin/env bash
if [[ -n "$BUILD_TEST_GZIP_EXIT" ]]; then exit "$BUILD_TEST_GZIP_EXIT"; fi
exec "$BUILD_TEST_REAL_GZIP" "$@"
`,{mode:0o755});
 const saveLog=path.join(scratch,'saved-image');
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,BUILD_TEST_CALLS:log,BUILD_TEST_PLATFORM:path.join(scratch,'image-platform'),BUILD_TEST_SAVE_IMAGE:saveLog,BUILD_TEST_REAL_GZIP:realGzip};
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','PIP_INDEX_URL','NPM_REGISTRY'])delete env[key];
 function run(args=[],extra={}){return spawnSync('bash',[script,...args],{cwd:scratch,env:{...env,...extra},encoding:'utf8',timeout:10000})}
 function calls(){const [cwd,...args]=fs.readFileSync(log,'utf8').split('\0').slice(0,-1);return {cwd,args}}
 function result(){return execFileSync('bash',['-c','source "$1"; printf "%s\\n" "$source_commit" "$release_arch" "$release_platform" "$release_name" "$release_image" "$release_dir" "$release_archive" "$release_checksum"','--',path.join(root,'.3dbox/builds/last-build.env')],{encoding:'utf8'}).trim().split('\n')}
 function digest(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
 function checkPackage(saved){
  assert.equal(saved[6],saved[5]+'.tar.gz');assert.equal(saved[7],saved[6]+'.sha256');
  const checksum=fs.readFileSync(saved[7],'utf8').trim().match(/^([a-f0-9]{64})\s+(.+)$/);assert(checksum);
  assert.equal(checksum[1],digest(saved[6]));assert.equal(checksum[2],path.basename(saved[6]));
  const extracted=fs.mkdtempSync(path.join(scratch,'extracted-'));
  execFileSync('tar',['-xzf',saved[6],'-C',extracted]);
  const bundle=path.join(extracted,saved[3]);
  assert.deepEqual(fs.readdirSync(bundle).sort(),['.env','README.md','RELEASE.txt','SHA256SUMS','compose.yaml','image.tar.gz'].sort());
  for(const line of fs.readFileSync(path.join(bundle,'SHA256SUMS'),'utf8').trim().split('\n')){
   const [,hash,name]=line.match(/^([a-f0-9]{64})\s+(.+)$/);assert.equal(hash,digest(path.join(bundle,name)),name);
  }
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(bundle,'image.tar.gz'))).toString(),'fake Docker image stream\n');
  const settings=Object.fromEntries(fs.readFileSync(path.join(bundle,'.env'),'utf8').trim().split('\n').map(line=>line.split('=')));
  assert.equal(settings.BOX_IMAGE,saved[4]);assert.equal(settings.BOX_PLATFORM,saved[2]);assert.equal(settings.BOX_HTTP_BIND,'0.0.0.0');
  const compose=YAML.parse(fs.readFileSync(path.join(bundle,'compose.yaml'),'utf8'));
  assert.equal(compose.services.world.build,undefined);assert.equal(compose.services.runner.image,compose.services.world.image);
  assert(compose.services.world.image.includes('BOX_IMAGE'));assert.equal(compose.services.world.pull_policy,'never');
  assert(compose.services.world.ports[0].includes('BOX_HTTP_BIND'));assert.equal(compose.services.world.restart,'unless-stopped');
  assert(fs.readFileSync(path.join(bundle,'RELEASE.txt'),'utf8').includes('source_commit='+commit));
  assert.equal(fs.readFileSync(saveLog,'utf8'),saved[4]);
  assert(!fs.readFileSync(path.join(bundle,'.env'),'utf8').includes('user:test'));
 }

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
 checkPackage(saved);assert(first.stdout.includes(saved[6]));assert(!first.stdout.includes('source '));

 const custom=run(['--arch','arm64','--image','registry.example/3dbox:custom','--network','default'],{PIP_INDEX_URL:'https://pypi.example/simple',NPM_REGISTRY:'https://npm.example'});
 assert.equal(custom.status,0,custom.stderr);
 const overridden=calls().args;assert(overridden.includes('linux/arm64'));assert(overridden.includes('registry.example/3dbox:custom'));
 assert(!overridden.includes('--allow=network.host'));assert(overridden.includes('PIP_INDEX_URL=https://pypi.example/simple'));assert(overridden.includes('NPM_REGISTRY=https://npm.example'));
 assert.equal(result()[1],'arm64');assert.equal(result()[4],'registry.example/3dbox:custom');checkPackage(result());

 const resultFile=path.join(root,'.3dbox/builds/last-build.env'),lastSuccess=fs.readFileSync(resultFile,'utf8');
 const releaseRoot=path.join(root,'.3dbox/releases'),completedPackages=fs.readdirSync(releaseRoot).sort();
 const failure=run(['--network','host'],{BUILD_TEST_EXIT:'23'});assert.equal(failure.status,23,failure.stderr);
 assert(calls().args.includes('--allow=network.host'));assert.equal(fs.readFileSync(resultFile,'utf8'),lastSuccess);assert(!failure.stdout.includes('构建及打包完成'));
 for(const [failureEnv,code] of [[{BUILD_TEST_SAVE_EXIT:'19'},19],[{BUILD_TEST_GZIP_EXIT:'17'},17],[{BUILD_TEST_WRONG_PLATFORM:'1'},1]]){
  const failed=run([],failureEnv);assert.equal(failed.status,code,failed.stderr);
  assert.equal(fs.readFileSync(resultFile,'utf8'),lastSuccess);assert.deepEqual(fs.readdirSync(releaseRoot).sort(),completedPackages);
  assert(!failed.stdout.includes('构建及打包完成'));
 }

 const template=path.join(root,'deploy/compose.runtime.yaml');fs.renameSync(template,template+'.backup');
 const missing=run();assert.equal(missing.status,1);assert(missing.stderr.includes('缺少部署模板'));fs.renameSync(template+'.backup',template);

 fs.rmSync(log);
 for(const args of [['--arch'],['--arch','mips'],['--network','invalid'],['--image'],['--unknown']]){
  const rejected=run(args);assert.equal(rejected.status,2,JSON.stringify(args)+rejected.stderr);assert(!fs.existsSync(log));
 }
 const help=run(['--help']);assert.equal(help.status,0);assert(help.stdout.includes('--arch'));assert(!fs.existsSync(log));
 console.log('build-image: proxy forwarding, standalone bundles, portable checksums, ARM64/custom images, archive contents and build/export/compression failure cleanup passed');
}finally{fs.rmSync(scratch,{recursive:true,force:true})}
