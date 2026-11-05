"""Actual HTTP/gRPC/typed transport of one device's shoreline approach."""
import json
import math
import os
from box_agent import AgentClient
from box_agent.grpc_client import GrpcAgentClient
from box_agent.typed_observation import encode, decode
from grpc_gateway import create_server

url, sid, agent, token, phase = [os.environ[k] for k in ('URL', 'SID', 'AGENT', 'TOKEN', 'PHASE')]
http = AgentClient(sid, agent, token, url)
server = create_server(url)
port = server.add_insecure_port('127.0.0.1:0')
assert port
server.start()
client = GrpcAgentClient(sid, agent, token, f'127.0.0.1:{port}')
try:
    own = http.observe()
    assert client.observe() == own
    assert decode('AgentObservation', client.observe_typed()) == own
    assert decode('AgentObservation', encode('AgentObservation', own)) == own
    assert own['self']['id'] == agent and own['self']['mobility'] == 'water'
    assert 'surfaceDomain' not in own and 'agents' not in own and 'world' not in own
    task = own['assignedTasks'][0]
    if phase != 'done':
        assert task['waypoint'] == [45, 50]
        x, y = task['approachPoint']
        assert x > 47 and math.hypot(x - 45, y - 50) <= 3.7 + 1e-8
        assert task['withinReach'] == (phase == 'in_reach')
        tick = own['tick']
        if phase == 'assigned':
            first = client.move_to('sdk-shore-move', x, y, tick + 1, tick + 40)
            again = http.move_to('sdk-shore-move', x, y, tick + 1, tick + 40)
        else:
            first = http.work_task('sdk-shore-work', task['id'], tick + 1, tick + 40)
            again = client.work_task('sdk-shore-work', task['id'], tick + 1, tick + 40)
        assert again['duplicate'] and again['action'] == first['action']
    else:
        assert own['done'] and task['status'] == 'done' and 'approachPoint' not in task
    print(json.dumps({'httpGrpcTypedEqual': True, 'phase': phase, 'ownDevice': agent,
                      'physicalTargetPreserved': True, 'noGlobalMap': True}))
finally:
    client.close()
    server.stop(0).wait()
