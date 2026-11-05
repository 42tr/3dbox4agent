import json, os
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from box_agent.client import SandboxError
from box_agent.grpc_client import GrpcEventHistoryClient
from grpc_gateway import create_server

url, sid, token, agent = (os.environ[k] for k in ('URL','SID','ADMIN','AGENT'))
server = create_server(url, stream_limit=2)
port=server.add_insecure_port('127.0.0.1:0'); server.start(); target=f'127.0.0.1:{port}'
client=GrpcEventHistoryClient(sid,token,target,timeout=15)
bad=GrpcEventHistoryClient(sid,agent,target,timeout=15)
def send(text):
    request=Request(url+f'/sessions/{sid}/message',data=json.dumps({'from':'drone-1','to':'drone-2','text':text}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urlopen(request) as response: return json.load(response)['world']['events']
try:
    try: list(bad.subscribe())
    except SandboxError as e: assert e.status == 401
    else: raise AssertionError('agent was authorized for event subscription')
    first=send('before')
    subscription=client.subscribe(); ready=next(subscription)
    assert ready.kind==0 and ready.active and ready.through_seq==len(first)
    current=send('during catch-up')
    caught=[next(subscription) for _ in first]
    assert [v.seq for v in caught] == list(range(1,len(first)+1))
    new=[next(subscription) for _ in range(len(current)-len(first))]
    assert [v.seq for v in new] == list(range(len(first)+1,len(current)+1))
    assert [json.loads(v.event_json_utf8) for v in new] == current[len(first):]
    subscription.close()
    offline=send('offline')
    resumed=client.subscribe(len(current)); ready=next(resumed)
    assert ready.through_seq==len(offline)
    recovered=[next(resumed) for _ in range(len(offline)-len(current))]
    assert [v.seq for v in recovered] == list(range(len(current)+1,len(offline)+1))
    final=send('after resume')
    live=[next(resumed) for _ in range(len(final)-len(offline))]
    assert [v.seq for v in live] == list(range(len(offline)+1,len(final)+1))
    failing=Request(url+f'/sessions/{sid}/step',data=b'{"count":1}',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try: urlopen(failing)
    except HTTPError as e: assert e.code == 503
    else: raise AssertionError('journal failure did not reject operation')
    try: next(resumed)
    except SandboxError as e: assert e.code == 'event_stream_closed'
    else: raise AssertionError('failed write leaked to live stream')
    resumed.close()
    print('gRPC live event catch-up, delivery, scoped access, cancellation and reconnect passed')
finally:
    client.close();bad.close();server.stop(0).wait()
