"""Failure remains visible through typed and JSON gRPC scoped observations."""
import json, os
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from box_agent.grpc_stream import GrpcObservationStream
from box_agent.grpc_client import GrpcAgentClient, GrpcCoordinatorClient
from box_agent.typed_observation import decode
from grpc_gateway import create_server
url,sid,admin,agent_token,coord_token=(os.environ[k] for k in ('URL','SID','ADMIN','TOKEN','COORD'))
error_code=os.environ.get('FAILURE_KIND','world_step_failed')
expected_revision=0 if error_code=='world_step_failed' else 1
expected_tick=0 if error_code=='world_step_failed' else 1
server=create_server(url,stream_limit=4);port=server.add_insecure_port('127.0.0.1:0');server.start();target=f'127.0.0.1:{port}'
agent=GrpcObservationStream(sid,agent_token,'agent','drone-1',target,timeout=10,typed=True)
coord=GrpcObservationStream(sid,coord_token,'coordinator',None,target,timeout=10,typed=False)
try:
    agent.__enter__();coord.__enter__()
    assert agent.receive()['type']=='observation'
    assert coord.receive()['type']=='observation'
    request=Request(f'{url}/sessions/{sid}/step',data=b'{"count":1}',headers={'Authorization':'Bearer '+admin,'Content-Type':'application/json'})
    try: urlopen(request)
    except HTTPError as error: assert error.code==503 and json.load(error)['error']==error_code
    else: raise AssertionError('failure not reported')
    def failed(stream,typed):
        for _ in range(5):
            item=stream.receive()
            if item['type']=='observation':
                observation=decode('AgentObservation',item['observation']) if typed else item['observation']
                if observation.get('sessionError')==error_code:
                    assert item['revision']==expected_revision and observation['tick']==expected_tick
                    return
        raise AssertionError('failure observation absent')
    failed(agent,True);failed(coord,False)
    a=GrpcAgentClient(sid,'drone-1',agent_token,target);c=GrpcCoordinatorClient(sid,coord_token,target)
    try:
        assert a.observe()['sessionError']==error_code
        assert c.observe()['sessionError']==error_code
        assert decode('AgentObservation',a.observe_typed())['sessionError']==error_code
        assert decode('CoordinatorObservation',c.observe_typed())['sessionError']==error_code
    finally:a.close();c.close()
    print('gRPC scoped observations carry '+error_code)
finally:
    agent.close();coord.close();server.stop(0).wait()
