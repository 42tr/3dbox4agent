"""Actual gRPC subscriptions backed by the scoped world WebSocket."""
import json
import os
import threading
import time
from urllib.request import Request, urlopen
from box_agent import SandboxError
from box_agent.grpc_client import GrpcAgentClient
from box_agent.grpc_stream import GrpcObservationStream
from box_agent.typed_observation import decode
from box_agent import CoordinatorClient
from grpc_gateway import create_server

url,sid,admin,token,coord = (os.environ[k] for k in ('URL','SID','ADMIN','TOKEN','COORD'))
server=create_server(url,stream_limit=2)
port=server.add_insecure_port('127.0.0.1:0');server.start();target=f'127.0.0.1:{port}'
def post(path,value):
    req=Request(url+path,data=json.dumps(value).encode(),headers={'Authorization':'Bearer '+admin,'Content-Type':'application/json'})
    with urlopen(req) as res:return json.load(res)
def stream(role,agent=None,after=None,typed=False):return GrpcObservationStream(sid,token if role=='agent' else coord,role,agent,target,after_revision=after,timeout=15,typed=typed)
agent=stream('agent','vehicle-1');coordinator=stream('coordinator',typed=True); resumed=None
try:
    observer=post(f'/sessions/{sid}/observer/credentials',{})['observerToken']
    for role in ('agent','coordinator'):
        for typed in (False,True):
            denied=GrpcObservationStream(sid,observer,role,'vehicle-1' if role=='agent' else None,target,timeout=5,typed=typed)
            try: denied.__enter__()
            except SandboxError as e: assert e.status==403
            else: raise AssertionError('observer subscribed to algorithm scope')
            finally: denied.close()
    observer_unary=GrpcAgentClient(sid,'vehicle-1',observer,target)
    try:
        for read in (observer_unary.observe,observer_unary.read_memory):
            try: read()
            except SandboxError as e: assert e.status==403
            else: raise AssertionError('observer accessed algorithm scope')
    finally: observer_unary.close()
    try: stream('agent','vehicle-2').__enter__()
    except SandboxError as e: assert e.status==403
    else: raise AssertionError('cross-agent subscription accepted')
    agent.__enter__();coordinator.__enter__()
    assert agent.ready['revision']==0 and 'revisionsSince' not in agent.ready
    initial=agent.receive();assert initial['type']=='observation' and initial['observation']['self']['id']=='vehicle-1'
    coord_msg=coordinator.receive();assert coord_msg['type']=='observation' and coord_msg['observation'].tasks
    http_coord=CoordinatorClient(sid,coord,url).observe();http_coord.pop('worldRevision')
    assert decode('CoordinatorObservation',coord_msg['observation'])==http_coord
    too_many=stream('agent','vehicle-1')
    try: too_many.__enter__()
    except SandboxError as e: assert e.status==429 and e.code=='stream_limit'
    else: raise AssertionError('stream limit not enforced')
    unary=GrpcAgentClient(sid,'vehicle-1',token,target);assert unary.observe()['tick']==0;unary.close()
    post(f'/sessions/{sid}/step',{'count':2})
    revisions=[]
    while not revisions or revisions[-1]<2:
        item=agent.receive()
        if item['type']=='observation':revisions.append(item['revision'])
    assert revisions==[1,2]
    # Cancellation must interrupt a blocking receive and release the slot.
    stopped = threading.Event()
    def wait_for_update():
        try: coordinator.receive()
        except (StopIteration, SandboxError): pass
        finally: stopped.set()
    thread=threading.Thread(target=wait_for_update);thread.start();coordinator.close();thread.join(timeout=3)
    assert stopped.is_set() and not thread.is_alive()
    agent.close()
    deadline=time.monotonic()+5
    while True:
        resumed=stream('agent','vehicle-1',0,typed=True)
        try: resumed.__enter__();break
        except SandboxError as e:
            if e.status!=429 or time.monotonic()>deadline:raise
            time.sleep(.05)
    assert resumed.ready['revisionsSince']==2
    latest=resumed.receive();assert latest['revision']==2 and latest['observation'].tick==2 and latest['observation'].self.id=='vehicle-1'
    post(f'/sessions/{sid}/run',{'speed':1})
    while True:
        event=resumed.receive()
        if event['type']=='status' and event['running']:break
    post(f'/sessions/{sid}/pause',{})
    while True:
        event=resumed.receive()
        if event['type']=='status' and not event['running']:break
    # Rotating the credential must terminate the active upstream subscription.
    post(f'/sessions/{sid}/agents/vehicle-1/credentials',{})
    try:
        while True: resumed.receive()
    except SandboxError as e: assert e.code=='observation_stream_closed'
    else: raise AssertionError('revoked stream stayed open')
    print('gRPC scoped streams, observer rejection, limits, resume and credential rotation passed')
finally:
    agent.close();coordinator.close()
    if resumed:resumed.close()
    server.stop(0).wait()
