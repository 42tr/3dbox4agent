"""Build and exercise an isolated Docker Compose stack, then remove its data.

Requires Docker Engine and Compose. Run from any directory; no third-party
Python modules or host Node/Rust installation is needed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', action='store_true', help='build and test the Rust image')
    args = parser.parse_args()
    if shutil.which('docker') is None:
        parser.error('Docker Engine and Docker Compose are required')
    target = 'world-rust' if args.native else 'world'
    name = '3dbox-smoke-' + uuid.uuid4().hex[:12]
    env = {**os.environ, 'BOX_HTTP_PORT': '0', 'BOX_CONTROL_PORT': '0', 'BOX_IMAGE_TARGET': target,
           'BOX_IMAGE_NAME': name, 'BOX_REPLAY_JOURNAL': '1'}
    compose = ['docker', 'compose', '-p', name, '-f', str(ROOT / 'compose.yaml')]

    def command(arguments, *, capture=False, data=None, timeout=120):
        result = subprocess.run(arguments, cwd=ROOT, env=env, input=data, text=True,
                                capture_output=capture, timeout=timeout)
        if result.returncode:
            # Command arguments never contain credentials; payloads go through stdin.
            raise RuntimeError(f'command failed ({result.returncode}): {arguments[:6]}\n'
                               + (result.stderr[-4000:] if capture else ''))
        return result.stdout if capture else None

    def exec_python(code, payload=None, timeout=120):
        operation = ['run', '--rm', '-T', '--no-deps', '--entrypoint', 'python3', 'runner']
        raw = command(compose + operation + ['-c', code],
                      capture=True, data=json.dumps(payload), timeout=timeout)
        return json.loads(raw)

    def check_recording_context(session, runtime):
        context = session['recordingContext']
        assert context['sessionId'] == session['sessionId']
        assert context['runtime']['instanceId'] != runtime['instanceId']
        assert context == exec_python('''
import json, sys
from box_agent.recording import capture_recording_context
payload = json.load(sys.stdin)
print(json.dumps(capture_recording_context(payload['session'], payload['runtime'])))
''', {'session': {'sessionId': session['sessionId'], 'recordingContext': context}, 'runtime': runtime})

    images = [f'{name}:{tag}' for tag in (target, 'control', 'console', 'agent')]
    print(f'Building independent images for the isolated {target} stack', flush=True)
    try:
        command(compose + ['--profile', 'experiments', 'build', 'world', 'control', 'console', 'runner'], timeout=1200)
        image_ids = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', *images], capture=True)
        assert len(set(image_ids.splitlines())) == 4
        command(compose + ['up', '-d', '--wait', '--wait-timeout', '90'], timeout=120)
        address = command(compose + ['port', 'console', '8787'], capture=True).strip()
        assert address.startswith('127.0.0.1:'), address
        base = 'http://' + address
        open_local = build_opener(ProxyHandler({})).open

        def request(path, method='GET', value=None, token=None, headers=None):
            h = {'Content-Type': 'application/json', **(headers or {})}
            if token:
                h['Authorization'] = 'Bearer ' + token
            req = Request(base + path, method=method, headers=h,
                          data=None if value is None else json.dumps(value).encode())
            try:
                with open_local(req, timeout=30) as response:
                    return response.status, response.read()
            except HTTPError as error:
                return error.code, error.read()

        def required(path, method='GET', value=None, token=None):
            status, body = request(path, method, value, token)
            assert 200 <= status < 300, (path, status)
            return json.loads(body)

        health = required('/health')
        assert required('/control/health')['service'] == 'control'
        assert required('/control/world/health')['runtime'] == health['runtime']
        assert health['features']['worldProcessIsolation'] == 1
        runtime = health['runtime']
        assert runtime['physicsBackend'] == ('rust' if args.native else 'wasm')
        assert runtime['taskBackend'] == ('rust' if args.native else 'js')
        assert runtime['communicationBackend'] == ('rust' if args.native else 'js')
        assert runtime['navigationBackend'] == ('rust' if args.native else 'js')
        assert runtime['worldLedgerBackend'] == ('rust' if args.native else 'js')
        assert runtime['worldMotionBackend'] == ('rust' if args.native else 'js')
        assert runtime['worldTasksBackend'] == ('rust' if args.native else 'js')
        assert runtime['worldExecutionBackend'] == ('rust' if args.native else 'js')
        assert runtime['worldActionsBackend'] == ('rust' if args.native else 'js')
        assert health['features']['worldLedger'] == (1 if args.native else 0)
        assert runtime['eventJournalEnabled'] and runtime['replayJournalEnabled']
        status, html = request('/')
        assert status == 200 and '园区态势'.encode() in html
        public_assets = json.loads((ROOT/'examples/experiments/policy-acceptance-public-codex.json').read_text())['files']
        for filename, ref in public_assets.items():
            status, asset = request('/'+filename)
            assert status == 200 and len(asset) == ref['bytes']
            assert hashlib.sha256(asset).hexdigest() == ref['sha256']
        assert request('/policy-acceptance-codex-not-allowed.json')[0] == 404
        assert request('/health', headers={'Host': '3dbox.42tr.cn'})[0] == 200
        assert request('/health', headers={'Host': '3dbox.42tr.cn', 'Origin': 'https://3dbox.42tr.cn'})[0] == 200
        assert request('/health', headers={'Host': 'bad@host'})[0] == 403
        assert request('/health', headers={'Origin': 'https://invalid.invalid'})[0] == 403
        license_files = ['third_party/rapier-js-0.19.3-LICENSE']
        if args.native:
            license_files.extend(['third_party/native/rapier3d-0.22.0/LICENSE',
                                  'third_party/native/Cargo.lock', 'third_party/napi-rs-2.16.17-LICENSE'])
        command(compose + ['exec', '-T', 'world', 'python3', '-c',
                           'import os, pathlib, sys; assert os.getuid() != 0; '
                           'assert all(pathlib.Path(name).is_file() for name in sys.argv[1:])', *license_files])

        session = required('/control/sessions', 'POST', {'seed': 42, 'physicsMode': 'rapier',
                           **({'sensorMode': 'rapier'} if args.native else {})})
        sid, token = session['sessionId'], session['adminToken']
        root = '/sessions/' + sid
        context = session['recordingContext']
        check_recording_context(session, runtime)
        assert token not in json.dumps(context)
        assert required(root + '/recording-context', token=token)['recordingContext'] == context
        assert request(root + '/recording-context')[0] == 401
        agent = required(root + '/agents/vehicle-1/credentials', 'POST', {}, token)
        scope = exec_python('''
import json, os, sys
from box_agent import AgentClient, SandboxError
from box_agent.stream import ObservationStream
from box_agent.grpc_client import GrpcAgentClient
sys.path.insert(0, 'sdk/python')
from grpc_gateway import create_server
p=json.load(sys.stdin)
assert os.getuid()!=0
world_url=os.environ['BOX_WORLD_URL']
control_url=os.environ['BOX_CONTROL_URL']
agent=AgentClient(p['sid'], 'vehicle-1', p['token'], control_url)
assert agent.observe()['self']['id']=='vehicle-1'
with ObservationStream(p['sid'],p['token'],'agent','vehicle-1','http://console:8787') as stream:
    assert stream.ready['encoding']=='protobuf-v2'
    assert stream.receive(timeout=5)['observation']['self']['id']=='vehicle-1'
gateway=create_server(world_url)
port=gateway.add_insecure_port('127.0.0.1:0'); assert port
gateway.start()
client=GrpcAgentClient(p['sid'],'vehicle-1',p['token'],f'127.0.0.1:{port}')
try:
    assert client.observe()==agent.observe()
    assert client.observe_typed().self.id=='vehicle-1'
    if p['native']: assert len(client.lidar(8,20)['distances'])==8
    try: AgentClient(p['sid'],'vehicle-2',p['token'],control_url).observe()
    except SandboxError as error: assert error.status==403
    else: raise AssertionError('cross-agent observation accepted')
finally:
    client.close(); gateway.stop(0).wait()
print(json.dumps({'http':True,'protobufStream':True,'grpc':True,'nonRoot':True}))
''', {'sid': sid, 'token': agent['agentToken'], 'native': args.native})
        required(root + '/step', 'POST', {'count': 5}, token)
        saved = required(root + '/catalog', 'POST', {'label': 'isolated container smoke'}, token)
        assert saved['revision'] == 5
        archived = required(root + '/catalog/' + saved['report']['id'], token=token)
        assert archived['frames'][-1]['tick'] == 5
        assert archived['recordingContext'] == context

        print('Checking separate algorithm container over gRPC, with replay validation', flush=True)
        multi = exec_python('''
import json, os, subprocess, sys
sys.path.insert(0,'sdk/python')
from grpc_gateway import create_server
p=json.load(sys.stdin)
gateway=create_server(os.environ['BOX_WORLD_URL'])
port=gateway.add_insecure_port('127.0.0.1:0'); assert port
gateway.start()
try:
    command=['python3','packages/agent/python/multi_agent_demo.py','--fault','none','--physics','rapier',
             '--archive','--timeout','75','--agent-grpc-target',f'127.0.0.1:{port}',
             '--coordinator-grpc-target',f'127.0.0.1:{port}','--grpc-observe-stream']
    if p['native']: command+=['--sensor-mode','rapier']
    result=subprocess.run(command,capture_output=True,text=True,timeout=100)
    assert result.returncode==0, result.stderr[-2000:]
    report=json.loads(result.stdout)
    assert report['status']=='completed' and report['agentProcesses']==15
    assert report['coordinatorProcesses']==1
    validate=subprocess.run(['node','-e',"require('./src/replay').unwrapArchive(JSON.parse(require('node:fs').readFileSync(0,'utf8')))"],
                            input=result.stdout,capture_output=True,text=True,timeout=15)
    assert validate.returncode==0,validate.stderr[-2000:]
    print(json.dumps({'status':report['status'],'agentProcesses':report['agentProcesses'],
                      'coordinatorProcesses':report['coordinatorProcesses'],
                      'archiveFrames':len(report['archive']['frames'])}))
finally: gateway.stop(0).wait()
''', {'native': args.native}, timeout=115)

        print('Checking the documented default runner command', flush=True)
        raw = command(compose + ['run', '--rm', '-T', 'runner'], capture=True, timeout=115)
        default_report = json.loads(raw)
        assert default_report['status'] == 'completed' and default_report['agentProcesses'] == 15
        assert default_report['coordinatorProcesses'] == 1
        command(compose + ['exec', '-T', 'world', 'node', '-e',
                          "require('./src/replay').unwrapArchive(JSON.parse(require('node:fs').readFileSync(0,'utf8')))"],
                capture=True, data=raw, timeout=20)

        print('Checking data after container replacement', flush=True)
        command(compose + ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90'], timeout=120)
        address = command(compose + ['port', 'console', '8787'], capture=True).strip()
        assert address.startswith('127.0.0.1:'), address
        base = 'http://' + address
        restarted_runtime = required('/health')['runtime']
        assert required('/control/world/health')['runtime'] == restarted_runtime
        assert restarted_runtime['instanceId'] != runtime['instanceId']
        assert request(root, token=token)[0] == 404
        journal = required('/event-journals/' + sid, token=token)
        assert journal['closed'] and journal['events']
        fork = required('/event-journals/' + sid + '/fork', 'POST', {'revision': 3}, token)
        assert fork['world']['tick'] == 3 and not fork['running']
        branch_context = fork['recordingContext']
        check_recording_context(fork, restarted_runtime)
        assert branch_context['forkedFrom']['sessionId'] == sid
        assert branch_context['forkedFrom']['revision'] == 3
        fork_root = '/sessions/' + fork['sessionId']
        restored = required(fork_root + '/catalog/' + saved['report']['id'], token=fork['adminToken'])
        assert restored == archived
        required(fork_root + '/', 'DELETE', token=fork['adminToken'])
        assert required('/health')['worldProcesses']['failed'] == 0
        print(json.dumps({'ok': True, 'target': target, 'scope': scope, 'multiAgent': multi,
                          'defaultRunner': {'status': default_report['status'],
                                            'archiveFrames': len(default_report['archive']['frames'])},
                          'persistentCatalog': True, 'persistentJournalFork': True}), flush=True)
    except Exception:
        subprocess.run(compose + ['logs', '--no-color', '--tail', '60', 'world', 'control', 'console'],
                       cwd=ROOT, env=env, timeout=30, check=False)
        raise
    finally:
        # Only this randomly named test project's resources are removed.
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], cwd=ROOT, env=env,
                       timeout=60, check=False)
        subprocess.run(['docker', 'image', 'rm', *images],
                       timeout=60, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
