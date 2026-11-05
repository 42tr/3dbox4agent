"""Run the local patrol policy over actual scoped gRPC observations/actions."""
import os
import time
from box_agent.grpc_client import GrpcAgentClient
from box_agent.rescue_policy import RescuePolicy
from grpc_gateway import create_server

server = create_server(os.environ['URL'])
port = server.add_insecure_port('127.0.0.1:0')
assert port
server.start()
client = GrpcAgentClient(os.environ['SID'], 'rescuer-1', os.environ['TOKEN'], f'127.0.0.1:{port}')
try:
    policy = RescuePolicy(10, search=True)
    while True:
        own = client.observe()
        assert own['self']['id'] == 'rescuer-1' and 'agents' not in own
        if own['done']:
            break
        policy.step(client, own)
        time.sleep(.01)
finally:
    client.close()
    server.stop(0).wait()
