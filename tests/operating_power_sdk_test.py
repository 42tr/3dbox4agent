"""Verify a powered device through both real scoped SDK transports."""
import json
import os
from box_agent import AgentClient
from box_agent.grpc_client import GrpcAgentClient
from box_agent.typed_observation import encode, decode
from grpc_gateway import create_server

url, sid, token = [os.environ[k] for k in ('URL', 'SID', 'TOKEN')]
http = AgentClient(sid, 'worker-1', token, url)
server = create_server(url)
port = server.add_insecure_port('127.0.0.1:0')
assert port
server.start()
client = GrpcAgentClient(sid, 'worker-1', token, f'127.0.0.1:{port}')
try:
    own = http.observe()
    assert client.observe() == own
    assert decode('AgentObservation', client.observe_typed()) == own
    assert decode('AgentObservation', encode('AgentObservation', own)) == own
    assert own['self']['operatingEnergyPerTick'] == 3
    assert own['self']['operatingState'] == json.loads(os.environ['EXPECTED_STATE'])
    assert all('operatingState' not in contact and 'operatingEnergyPerTick' not in contact
               for contact in own['nearby'])
    if os.environ.get('SUBMIT_CHARGE') == '1':
        a = client.charge('powered-charge', own['tick'] + 1, own['tick'] + 40)
        b = http.charge('powered-charge', own['tick'] + 1, own['tick'] + 40)
        assert b['duplicate'] and a['action'] == b['action']
    print(json.dumps({'httpGrpcAndTypedObservationEqual': True,
                      'ownPowerState': own['self']['operatingState'],
                      'nearbyPrivatePowerOmitted': True}))
finally:
    client.close()
    server.stop(0).wait()
