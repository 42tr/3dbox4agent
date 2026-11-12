# 3DBox Python SDK

`AgentClient` and `CoordinatorClient` default to Control at `http://127.0.0.1:8789`.
`ObservationStream` connects to World at `http://127.0.0.1:8787`.
In `multi_agent_demo.py`, use `--url` to set the World origin and `--control-url` to set the scoped HTTP origin. When only `--url` is supplied, both use that origin.

`box_agent` contains standard-library clients for a local 3DBox world service.

```python
from box_agent import AgentClient, CoordinatorClient, SandboxError

agent = AgentClient("session-id", "drone-1", "agent-token")
observation = agent.observe()
print(observation["self"]["id"])
```

A service administrator creates the session and issues scoped credentials. The
service and clients currently support only a loopback HTTP origin; session state
and tokens are lost when the service stops. `AgentClient` provides scoped
observations, messages, actions, evidence and session memory.
`AgentClient.lidar()` reads a local horizontal range scan when the session uses
the experimental Rust/Rapier backend. It is instantaneous and excludes the
agent itself; `None` distances mean no hit within range.
`CoordinatorClient` provides scoped task observations, assignments, revocations
and survey proposals. `box_agent.planner` includes a simple matching example.
The local service remains responsible for validating every action and decision.
This early SDK does not provide a remote security boundary or manage session
lifecycles.

To observe a submitted asynchronous action until it finishes:

```python
from box_agent.watch import wait_for_action

result = wait_for_action(agent, "request-id", timeout=30, poll_interval=0.2)
print(result["status"])
```

The world must be advanced separately. The helper returns completed, failed,
rejected or cancelled records, raises `TimeoutError` if its wall-clock wait
expires, and does not submit or cancel an action. An in-flight HTTP request
may extend the wait by up to the client's network timeout.

Optional scoped live observations (Python 3.9+):

```sh
python3 -m pip install './sdk/python[stream]'
```

```python
from box_agent.stream import ObservationStream

with ObservationStream('session-id', 'agent-token', 'agent',
                       agent_id='drone-1') as stream:
    message = stream.receive(timeout=10)
    print(message['observation'])
```

Use `role='coordinator'` with its token and omit `agent_id` for coordinator
observations. The stream sends credentials in the first WebSocket message,
not the URL. It does not advance the world. On reconnect, pass the last
`stream.last_revision` as `after_revision`; `unseen_revisions` reports how
many revisions occurred since that point, and the stream supplies only the
latest scoped observation, not missed intermediate observations. Timeout and
connection-closed exceptions propagate to the caller.

## Local gRPC adapter

Install `python3 -m pip install './sdk/python[grpc]'`, start the Node world
service and then `python3 sdk/python/grpc_gateway.py`. The adapter listens on
loopback port 8788. It forwards requests to the authoritative world; it does
not own or advance world state. It is a development adapter, without TLS or a
multi-user security boundary. Do not expose it to a network.

```python
from box_agent.grpc_client import GrpcAgentClient, GrpcCoordinatorClient
a = GrpcAgentClient('session-id', 'vehicle-1', 'agent-token')
print(a.observe())
a.move_to('move-1', 48, 50, 1, 10)
a.close()
```

The gRPC clients cover scoped observations, lidar, actions, cancellation,
messages, private memory, scan and sample reports, assignments, revocations and
survey proposals. Credentials
are sent as metadata, never in the target URL. The original observation and result bodies
are JSON bytes inside Protobuf; a full typed domain model and a complete event-history stream are
not yet implemented. The world remains responsible for all authorization and
validation. `SandboxError` exposes the world error code; transport failures
have status 0. Close clients when done.

To use gRPC for both agent and coordinator processes in the multi-process
demo, pass `--agent-grpc-target 127.0.0.1:8788` and
`--coordinator-grpc-target 127.0.0.1:8788`. The management process still
uses HTTP. A WebSocket observation stream can be selected separately; after
disconnection it falls back to the configured client transport.

### Scoped gRPC observations

Install `./sdk/python[grpc-stream]` in the gateway environment, then use
`GrpcObservationStream` from `box_agent.grpc_stream`. It yields a ready marker
followed by scoped observations and status updates. Set `after_revision` on a
new stream to see how many world revisions elapsed; only the latest snapshot is
sent on reconnect. There is no event-history replay. Call `close()` to cancel;
`timeout` applies to the whole stream. Gateway capacity is 32 streams.

Add `--grpc-observe-stream` together with both gRPC targets to use coalesced
gRPC observation streams in the multi-process demo. On disconnect, workers
fall back to unary gRPC observations.

### Typed scoped observations

`GrpcAgentClient.observe_typed()` and `GrpcCoordinatorClient.observe_typed()`
return Protobuf messages with named fields for the core observation. Convert a
message with `box_agent.typed_observation.decode('AgentObservation', value)`
or `decode('CoordinatorObservation', value)` to recover the existing dictionary.
Unknown and null-valued fields are preserved as per-message JSON extensions.
Set `typed=True` on `GrpcObservationStream` for typed stream observations.
The demo's gRPC observation reader uses the typed stream and converts it to
the existing strategy input. The original JSON interfaces remain available.


Optional ground rescue policy: launch `task_agent.py --auto-rescue --rescue-search` to enable bounded idle patrol using only the actor observation. Search yields to assigned tasks and an energy reserve, then uses the existing observation-bound rescue action after actual fault contact. Both flags are opt-in; `--rescue-search` requires `--auto-rescue`. Multi-process experiments report `config.rescueSearch: true` only when enabled. See [lunar rescue](../../docs/lunar-rescue.md) for limits and examples.
