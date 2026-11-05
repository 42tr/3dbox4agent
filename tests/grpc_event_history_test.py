"""Exercise real gRPC event history against the Node journal API."""
import json, os
from box_agent.client import SandboxError
from box_agent.grpc_client import GrpcEventHistoryClient
from grpc_gateway import create_server

server = create_server(os.environ['URL'], stream_limit=2)
port = server.add_insecure_port('127.0.0.1:0')
server.start()
target = f'127.0.0.1:{port}'
client = GrpcEventHistoryClient(os.environ['SID'], os.environ['ADMIN'], target)
wrong = GrpcEventHistoryClient(os.environ['SID'], os.environ['WRONG'], target)
try:
    try: list(wrong.stream())
    except SandboxError as e: assert e.status == 401
    else: raise AssertionError('unauthorized history accepted')
    try: list(client.stream(999))
    except SandboxError as e: assert e.status == 400
    else: raise AssertionError('invalid cursor accepted')
    stream = client.stream()
    ready = next(stream)
    assert ready.kind == 0 and ready.through_seq == 250 and not ready.closed
    print('READY', flush=True)
    assert input() == 'APPENDED'
    items = list(stream)
    assert len(items) == 250
    assert [x.seq for x in items] == list(range(1,251))
    assert all(x.through_seq == 250 and json.loads(x.event_json_utf8)['seq'] == x.seq for x in items)
    resumed = list(client.stream(248))
    assert resumed[0].closed and resumed[0].through_seq == 252
    assert [x.seq for x in resumed[1:]] == [249,250,251,252]
    assert resumed[-1].revision == 1
    print('gRPC persisted history pagination, fixed boundary, authorization and resume passed', flush=True)
finally:
    client.close(); wrong.close(); server.stop(0).wait()
