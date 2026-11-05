"""Exercise the actual gRPC adapter against a live world service."""
import json
import os
from urllib.request import Request, urlopen
import grpc
from box_agent import AgentClient, CoordinatorClient, SandboxError
from box_agent.grpc_client import GrpcAgentClient, GrpcCoordinatorClient
from box_agent.grpc_protocol import message, SERVICE
from box_agent.typed_observation import decode
from grpc_gateway import create_server

url, sid, admin, token, coord_token = [os.environ[k] for k in ('URL', 'SID', 'ADMIN', 'TOKEN', 'COORD')]
server = create_server(url)
port = server.add_insecure_port('127.0.0.1:0')
assert port
server.start()
target = f'127.0.0.1:{port}'
agent = GrpcAgentClient(sid, 'vehicle-1', token, target)
other = GrpcAgentClient(sid, 'vehicle-2', token, target)
coordinator = GrpcCoordinatorClient(sid, coord_token, target)
try:
    http = AgentClient(sid, 'vehicle-1', token, url)
    assert agent.observe() == http.observe()
    typed = agent.observe_typed()
    assert typed.self.id == 'vehicle-1' and decode('AgentObservation', typed) == http.observe()
    if os.environ.get('BOX_GRPC_RUST_TEST'):
        scan = agent.lidar(8, 20)
        assert scan == http.lidar(8, 20) and len(scan['distances']) == 8
        try: other.lidar()
        except SandboxError as e: assert e.status == 403
        else: raise AssertionError('cross-agent lidar accepted')
    assert agent.read_memory() == {'revision': 0, 'value': {}}
    memory = {'位置': [1, 2], 'nested': {'flag': True}}
    assert agent.write_memory(memory, 0) == {'revision': 1, 'value': memory}
    assert agent.read_memory() == http.read_memory()
    try: agent.write_memory({}, 0)
    except SandboxError as e: assert e.status == 409 and e.code == 'memory_revision_conflict'
    else: raise AssertionError('stale memory write accepted')
    try: other.read_memory()
    except SandboxError as e: assert e.status == 403
    else: raise AssertionError('cross-agent memory accepted')
    coord_obs = coordinator.observe()
    assert coord_obs == CoordinatorClient(sid, coord_token, url).observe()
    typed_coord = coordinator.observe_typed()
    assert typed_coord.tasks and decode('CoordinatorObservation', typed_coord) == coord_obs
    task = coord_obs['tasks'][0]
    assigned = coordinator.assign('grpc-assign', task['id'], task['candidates'][0]['id'], coord_obs['tick'])
    assert assigned['decision']['status'] == 'accepted'
    assert coordinator.assign('grpc-assign', task['id'], task['candidates'][0]['id'], coord_obs['tick'])['duplicate']
    active = coordinator.observe()['active'][0]
    rejected = coordinator.revoke('grpc-guard', active['id'], active['assignee'], active['assignmentId'], 0, require_blocked_since=0)
    assert rejected['revocation']['status'] == 'rejected' and rejected['revocation']['reason'] == 'route_condition_changed'
    revoked = coordinator.revoke('grpc-revoke', active['id'], active['assignee'], active['assignmentId'], 0)
    assert revoked['revocation']['status'] == 'accepted'
    assert coordinator.revoke('grpc-revoke', active['id'], active['assignee'], active['assignmentId'], 0)['duplicate']
    proposal = coordinator.propose_survey('grpc-proposal', 'grpc-task', '复勘', 'drone', [40, 45], 5, 0, priority=0)
    assert proposal['proposal']['status'] == 'accepted' and proposal['proposal']['task']['priority'] == 0
    assert coordinator.propose_survey('grpc-proposal', 'grpc-task', '复勘', 'drone', [40, 45], 5, 0, priority=0)['duplicate']
    try: other.observe()
    except SandboxError as e: assert e.status == 403
    else: raise AssertionError('cross-agent observation accepted')
    try: GrpcCoordinatorClient(sid, token, target).observe()
    except SandboxError as e: assert e.status == 403
    else: raise AssertionError('agent credential accepted as coordinator')
    first = agent.move_to('grpc-move', 48, 50, 1, 10)
    assert first['action']['status'] == 'pending'
    assert agent.move_to('grpc-move', 48, 50, 1, 10)['duplicate']
    assert agent.cancel_action('grpc-move')['action']['status'] == 'cancelled'
    try: agent.report_scan('grpc-report', 'missing')
    except SandboxError as e: assert e.status == 409
    else: raise AssertionError('missing scan report accepted')
    sent = agent.send_message('vehicle-2', '测试 gRPC', request_id='grpc-msg')
    assert sent['messageId'] == agent.send_message('vehicle-2', '测试 gRPC', request_id='grpc-msg')['messageId']
    def admin_post(path, value):
        request = Request(url + path, data=json.dumps(value).encode('utf-8'), headers={'Authorization': 'Bearer ' + admin, 'Content-Type': 'application/json'})
        with urlopen(request) as response: return json.load(response)
    drone_token = admin_post(f'/sessions/{sid}/agents/drone-1/credentials', {})['agentToken']
    drone = GrpcAgentClient(sid, 'drone-1', drone_token, target)
    try:
        assert drone.scan('grpc-scan', 1, 10)['action']['status'] == 'pending'
        admin_post(f'/sessions/{sid}/step', {'count': 3})
        assert decode('AgentObservation', drone.observe_typed()) == drone.observe()
        report = drone.report_scan('grpc-scan-report', 'grpc-scan')
        assert report['report']['status'] == 'pending'
        assert drone.report_scan('grpc-scan-report', 'grpc-scan')['duplicate']
    finally: drone.close()
    admin_post(f'/sessions/{sid}/message', {'from':'vehicle-2','to':'vehicle-1','text':'unpaired-\ud800'})
    admin_post(f'/sessions/{sid}/step', {'count':3})
    ordinary = agent.observe()
    assert any(item['text'] == 'unpaired-\ud800' for item in ordinary['inbox'])
    assert decode('AgentObservation', agent.observe_typed()) == ordinary
    assert decode('CoordinatorObservation', coordinator.observe_typed()) == coordinator.observe()
    channel = grpc.insecure_channel(target)
    raw = channel.unary_unary('/' + SERVICE + '/ObserveAgent', request_serializer=message('AgentRef').SerializeToString, response_deserializer=message('JsonResult').FromString)
    try: raw(message('AgentRef')(session_id=sid, agent_id='vehicle-1'), timeout=3)
    except grpc.RpcError as e: assert e.code() == grpc.StatusCode.UNAUTHENTICATED
    else: raise AssertionError('missing credentials accepted')
    channel.close()
    request = Request(url + f'/sessions/{sid}/agents/vehicle-1/credentials', data=b'{}', headers={'Authorization': 'Bearer ' + admin, 'Content-Type': 'application/json'})
    with urlopen(request) as response: new_token = json.load(response)['agentToken']
    try: agent.observe()
    except SandboxError as e: assert e.status == 401
    else: raise AssertionError('rotated token still accepted')
    replacement = GrpcAgentClient(sid, 'vehicle-1', new_token, target)
    assert replacement.observe()['self']['id'] == 'vehicle-1'
    replacement.close()
    print('gRPC observation, actions, messages, isolation and rotation passed')
finally:
    agent.close(); other.close(); coordinator.close(); server.stop(0).wait()
