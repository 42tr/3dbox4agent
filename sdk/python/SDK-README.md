# 3DBox Python SDK

`box_agent` lets Python agents and coordinators use scoped 3DBox credentials. From the repository root:

```sh
python3 -m pip install ./sdk/python
```

An administrator creates the session and issues credentials. Use the session ID, device ID and device token to connect:

```python
from box_agent import AgentClient

agent = AgentClient("session-id", "drone-1", "agent-token")
observation = agent.observe()
print(observation["self"]["id"])

tick = observation["tick"]
agent.scan("scan-1", target_tick=tick + 1, expires_tick=tick + 10)
```

`AgentClient` and `CoordinatorClient` default to Control at `http://127.0.0.1:8789`. Pass `base_url` to select another HTTP or HTTPS origin. The agent client supports actions, messages, private memory and reports. The coordinator client provides authorized task observations, assignments, revocations and proposals. `SandboxError` exposes `status` and `code`, with status `0` for connection failures.

Actions execute as World advances. After submitting an action, use `box_agent.watch.wait_for_action(agent, "scan-1", timeout=30)` to poll for its final record while another caller advances the world.

## Live observations

Install `./sdk/python[stream]` to use WebSocket observations:

```python
from box_agent.stream import ObservationStream

with ObservationStream("session-id", "agent-token", "agent", agent_id="drone-1") as stream:
    print(stream.receive(timeout=10))
```

The default stream origin is World at `http://127.0.0.1:8787`. If you connect through Console, pass the Console origin as `base_url`. For coordinators, set `role="coordinator"`, use a coordinator token and omit `agent_id`. Pass the last `stream.last_revision` as `after_revision` on reconnect. The server returns the latest scoped observation and reports how many revisions elapsed.

## gRPC

Install `./sdk/python[grpc]` for unary calls or `./sdk/python[grpc-stream]` for streams. The optional gateway is started separately and listens on `127.0.0.1:8788`.

```python
from box_agent.grpc_client import GrpcAgentClient

agent = GrpcAgentClient("session-id", "drone-1", "agent-token")
try:
    print(agent.observe())
finally:
    agent.close()
```

- `GrpcAgentClient.observe_typed()` and `GrpcCoordinatorClient.observe_typed()` return Protobuf observations.
- `GrpcObservationStream` supports `typed=True`. Its timeout applies to the whole stream.
- `GrpcEventHistoryClient.stream()` reads persisted events with administrator credentials. Use `subscribe()` to catch up and continue receiving live events.
