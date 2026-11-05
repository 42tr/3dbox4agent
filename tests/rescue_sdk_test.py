"""Both real SDK transports submit the same physically certified reset intention."""
import json
import os
from box_agent import AgentClient
from box_agent.grpc_client import GrpcAgentClient
from box_agent.typed_observation import encode, decode
from grpc_gateway import create_server

url,sid,token,target_id,request_id=[os.environ[k]for k in ('URL','SID','TOKEN','TARGET','REQUEST')]
http=AgentClient(sid,'rescuer-1',token,url)
server=create_server(url)
port=server.add_insecure_port('127.0.0.1:0')
assert port
server.start()
grpc=GrpcAgentClient(sid,'rescuer-1',token,f'127.0.0.1:{port}')
try:
    own=http.observe()
    assert grpc.observe()==own
    assert decode('AgentObservation',grpc.observe_typed())==own
    assert decode('AgentObservation',encode('AgentObservation',own))==own
    contact=next(c for c in own['nearby']if c['id']==target_id and c['status']=='fault')
    due=own['tick']+1
    a=http.rescue(request_id,target_id,contact['observedTick'],due,due+40,contact['faultGeneration'])
    b=grpc.rescue(request_id,target_id,contact['observedTick'],due,due+40,contact['faultGeneration'])
    assert b['duplicate'] and a['action']==b['action']
    assert a['action']['targetAgentId']==target_id and a['action']['faultSeq']>0
    assert decode('AgentObservation',grpc.observe_typed())==http.observe()
    print(json.dumps({'httpAndGrpcRescueSameIdentity':True,'typedOwnProfileAndEpisodeLossless':True}))
finally:
    grpc.close()
    server.stop(0).wait()
