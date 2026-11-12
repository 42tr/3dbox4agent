"""Loopback-only gRPC adapter for the existing authoritative world service."""
import argparse
from concurrent import futures
import json
import re
import sys
import threading
from urllib.parse import urlsplit

import grpc
from box_agent.client import AgentClient, CoordinatorClient, SandboxError
from box_agent.grpc_protocol import METHODS, STREAM_METHODS, TYPED_METHODS, TYPED_STREAM_METHODS, SERVICE, message
from box_agent.typed_observation import encode as encode_observation

RESULT = message('JsonResult')
STATUS = {400: grpc.StatusCode.INVALID_ARGUMENT, 401: grpc.StatusCode.UNAUTHENTICATED,
          403: grpc.StatusCode.PERMISSION_DENIED, 404: grpc.StatusCode.NOT_FOUND,
          409: grpc.StatusCode.FAILED_PRECONDITION, 413: grpc.StatusCode.RESOURCE_EXHAUSTED,
          429: grpc.StatusCode.RESOURCE_EXHAUSTED, 0: grpc.StatusCode.UNAVAILABLE}

def credential(context):
    values = [v for k, v in context.invocation_metadata() if k == 'authorization']
    if len(values) != 1 or not re.fullmatch(r'Bearer [A-Za-z0-9_-]{43}', values[0]):
        context.abort(grpc.StatusCode.UNAUTHENTICATED, 'unauthorized')
    return values[0][7:]

def handler(method, world_url):
    def call(req, context):
        token = credential(context)
        try:
            if method in ('ObserveCoordinator', 'Assign', 'Revoke', 'ProposeSurvey'):
                client = CoordinatorClient(req.session_id, token, world_url)
                if method == 'ObserveCoordinator': result = client.observe()
                elif method == 'Assign': result = client.assign(req.request_id, req.task_id, req.agent_id, req.observed_tick)
                elif method == 'Revoke':
                    result = client.revoke(req.request_id, req.task_id, req.agent_id, req.assignment_id, req.observed_tick,
                                           req.require_blocked_since if req.HasField('require_blocked_since') else None)
                else:
                    if not req.HasField('target'): raise ValueError('target required')
                    optional = [getattr(req, name) if req.HasField(name) else None for name in ('priority', 'deadline', 'evidence_id', 'sensor_evidence_id', 'sample_report_id')]
                    result = client.propose_survey(req.request_id, req.task_id, req.name, req.role,
                                                   [req.target.x, req.target.y], req.duration, req.observed_tick,
                                                   list(req.depends_on), *optional)
            else:
                client = AgentClient(req.session_id, req.agent_id, token, world_url)
                if method == 'ObserveAgent': result = client.observe()
                elif method == 'Lidar': result = client.lidar(req.count, req.max_range if req.HasField('max_range') else None)
                elif method == 'CancelAction': result = client.cancel_action(req.request_id)
                elif method == 'SendMessage': result = client.send_message(req.recipient_id, req.text, list(req.via) if req.via else None, req.request_id or None)
                elif method == 'ReportSample': result = client.report_sample(req.request_id, req.task_id)
                elif method == 'ReportScan': result = client.report_scan(req.request_id, req.scan_request_id)
                elif method == 'ReadMemory': result = client.read_memory()
                elif method == 'WriteMemory': result = client.write_memory(json.loads(req.value_json_utf8), req.expected_revision)
                elif method == 'SubmitAction':
                    payload = {'requestId': req.request_id, 'type': req.type, 'targetTick': req.target_tick, 'expiresTick': req.expires_tick}
                    if req.HasField('target'): payload['target'] = {'x': req.target.x, 'y': req.target.y}
                    if req.task_id: payload['taskId'] = req.task_id
                    if req.target_agent_id: payload['targetAgentId'] = req.target_agent_id
                    if req.HasField('observed_tick'): payload['observedTick'] = req.observed_tick
                    if req.HasField('fault_generation'): payload['faultGeneration'] = req.fault_generation
                    result = client._request(f'/sessions/{client._session}/agents/{client._agent}/actions', payload)
            return RESULT(json_utf8=json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8'))
        except SandboxError as error:
            context.abort(STATUS.get(error.status, grpc.StatusCode.INTERNAL), error.code)
        except (ValueError, TypeError):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'invalid_request')
    return call

def typed_handler(role, world_url):
    def call(req, context):
        token = credential(context)
        try:
            if role == 'agent':
                observation = AgentClient(req.session_id, req.agent_id, token, world_url).observe()
                return encode_observation('AgentObservation', observation)
            observation = CoordinatorClient(req.session_id, token, world_url).observe()
            return encode_observation('CoordinatorObservation', observation)
        except SandboxError as error:
            context.abort(STATUS.get(error.status, grpc.StatusCode.INTERNAL), error.code)
        except (ValueError, TypeError, KeyError, OverflowError):
            context.abort(grpc.StatusCode.INTERNAL, 'invalid_world_observation')
    return call


def stream_handler(role, world_url, slots, typed=False):
    def call(req, context):
        token = credential(context)
        if req.HasField('after_revision') and req.after_revision > 2**53-1:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'invalid_revision')
        if not slots.acquire(blocking=False):
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, 'stream_limit')
        upstream = None
        try:
            try:
                from box_agent.stream import ObservationStream
                from websockets.exceptions import ConnectionClosed
            except ImportError:
                context.abort(grpc.StatusCode.FAILED_PRECONDITION, 'install_grpc_stream_extra')
            try:
                # Authenticate the exact requested scope before sending a ready marker.
                if role == 'agent': AgentClient(req.session_id, req.agent_id, token, world_url).observe()
                else: CoordinatorClient(req.session_id, token, world_url).observe()
                after = req.after_revision if req.HasField('after_revision') else -1
                upstream = ObservationStream(req.session_id, token, role,
                                             req.agent_id if role == 'agent' else None, world_url,
                                             after_revision=after)
                upstream.__enter__()
                ready = upstream.ready
                fields = {'kind': 0, 'revision': int(ready['revision']),
                          'status_revision': int(ready['statusRevision']), 'running': ready['running'],
                          'speed': int(ready['speed'])}
                if upstream.unseen_revisions is not None: fields['revisions_since'] = upstream.unseen_revisions
                response_type = 'TypedObservationUpdate' if typed else 'ObservationUpdate'
                yield message(response_type)(**fields)
                while context.is_active():
                    try: item = upstream.receive(timeout=0.25)
                    except TimeoutError: continue
                    fields = {'kind':2 if item['type'] == 'status' else 1,
                              'revision':int(item['revision']), 'status_revision':int(item['statusRevision']),
                              'running':item['running'], 'speed':int(item['speed'])}
                    if item['type'] == 'observation':
                        if typed:
                            kind = 'AgentObservation' if role == 'agent' else 'CoordinatorObservation'
                            fields[role] = encode_observation(kind, item['observation'])
                        else:
                            fields['observation_json_utf8'] = json.dumps(item['observation'], ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8')
                    yield message(response_type)(**fields)
            except SandboxError as error:
                context.abort(STATUS.get(error.status, grpc.StatusCode.INTERNAL), error.code)
            except ConnectionClosed:
                if context.is_active(): context.abort(grpc.StatusCode.UNAVAILABLE, 'observation_stream_closed')
            except (ValueError, TypeError, KeyError, OverflowError):
                if context.is_active(): context.abort(grpc.StatusCode.FAILED_PRECONDITION, 'invalid_stream_or_revision')
            except OSError:
                if context.is_active(): context.abort(grpc.StatusCode.UNAVAILABLE, 'observation_stream_unavailable')
        finally:
            if upstream is not None: upstream.close()
            slots.release()
    return call

def event_history_handler(world_url, slots):
    def call(req, context):
        token = credential(context)
        if req.after_seq > 2**53-1:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'invalid_cursor')
        if not slots.acquire(blocking=False):
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, 'stream_limit')
        try:
            client = AgentClient(req.session_id, 'history', token, world_url)
            after = req.after_seq
            page = client._request(f'/event-journals/{client._session}?after={after}&limit=100')
            through = page['eventCount']
            if after > through:
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'invalid_cursor')
            yield message('EventHistoryItem')(through_seq=through, closed=page['closed'],
                                              partial_tail=page['partialTail'], active=page['active'])
            while context.is_active() and after < through:
                for entry in page['events']:
                    event = entry['event']
                    if event['seq'] > through: break
                    if event['seq'] != after + 1: raise ValueError('noncontiguous_history')
                    after = event['seq']
                    yield message('EventHistoryItem')(kind=1, through_seq=through,
                        revision=entry['revision'], seq=after,
                        event_json_utf8=json.dumps(event, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8'))
                if after >= through or not context.is_active(): break
                if page['nextAfter'] != after: raise ValueError('noncontiguous_history')
                page = client._request(f'/event-journals/{client._session}?after={after}&limit=100')
        except SandboxError as error:
            context.abort(STATUS.get(error.status, grpc.StatusCode.INTERNAL), error.code)
        except (ValueError, TypeError, KeyError, OverflowError):
            if context.is_active(): context.abort(grpc.StatusCode.DATA_LOSS, 'invalid_event_history')
        finally:
            slots.release()
    return call

def live_events_handler(world_url, slots):
    def call(req, context):
        token = credential(context)
        if req.after_seq > 2**53-1: context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'invalid_cursor')
        if not slots.acquire(blocking=False): context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, 'stream_limit')
        upstream = None
        WebSocketException = OSError
        try:
            try:
                from websockets.sync.client import connect
                from websockets.exceptions import WebSocketException
            except ImportError:
                context.abort(grpc.StatusCode.FAILED_PRECONDITION, 'install_grpc_stream_extra')
            client = AgentClient(req.session_id, 'history', token, world_url)
            # Authenticate before opening a socket; the handshake establishes the catch-up boundary.
            client._request(f'/event-journals/{client._session}?after=0&limit=1')
            origin = urlsplit(client._base)
            scheme = 'wss' if origin.scheme == 'https' else 'ws'
            upstream = connect(f'{scheme}://{origin.netloc}/stream',
                               open_timeout=5, close_timeout=2, max_size=32*1024*1024,
                               max_queue=16, compression=None, proxy=None)
            upstream.send(json.dumps({'type':'subscribe', 'sessionId':req.session_id, 'token':token,
                                      'afterRevision':-1, 'encoding':'events-v1'}))
            ready = json.loads(upstream.recv(timeout=5))
            if ready.get('type') != 'ready' or ready.get('role') != 'admin' or ready.get('encoding') != 'events-v1': raise ValueError('bad_handshake')
            boundary = ready['eventCount']
            if type(boundary) is not int or not 0 <= boundary <= 2**53-1: raise ValueError('bad_boundary')
            after = req.after_seq
            if after > boundary: context.abort(grpc.StatusCode.INVALID_ARGUMENT, 'invalid_cursor')
            yield message('EventHistoryItem')(through_seq=boundary, active=True)
            while context.is_active() and after < boundary:
                page = client._request(f'/event-journals/{client._session}?after={after}&limit=100')
                for entry in page['events']:
                    event = entry['event']; seq = event['seq']
                    if seq > boundary: break
                    if seq != after+1: raise ValueError('event_gap')
                    after = seq
                    yield message('EventHistoryItem')(kind=1, through_seq=boundary, revision=entry['revision'], seq=seq,
                        event_json_utf8=json.dumps(event, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8'))
                if after < boundary and page['nextAfter'] != after: raise ValueError('event_gap')
            while context.is_active():
                try: update = json.loads(upstream.recv(timeout=.25))
                except TimeoutError: continue
                if update.get('type') != 'events' or type(update.get('revision')) is not int or not isinstance(update.get('events'), list): raise ValueError('bad_update')
                for event in update['events']:
                    seq = event['seq']
                    if seq <= boundary: continue
                    if seq != after+1: raise ValueError('event_gap')
                    after = seq
                    yield message('EventHistoryItem')(kind=1, through_seq=boundary, revision=update['revision'], seq=seq,
                        event_json_utf8=json.dumps(event, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8'))
        except SandboxError as error:
            context.abort(STATUS.get(error.status, grpc.StatusCode.INTERNAL), error.code)
        except (WebSocketException, OSError, TimeoutError):
            if context.is_active(): context.abort(grpc.StatusCode.UNAVAILABLE, 'event_stream_closed')
        except (ValueError, TypeError, KeyError, OverflowError):
            if context.is_active(): context.abort(grpc.StatusCode.DATA_LOSS, 'invalid_event_stream')
        finally:
            if upstream is not None: upstream.close()
            slots.release()
    return call


def create_server(world_url='http://127.0.0.1:8787', stream_limit=32):
    # Validate origin before accepting requests; AgentClient applies the same constraint.
    AgentClient('session', 'agent', 'token', world_url)
    if not isinstance(stream_limit, int) or not 1 <= stream_limit <= 32: raise ValueError('invalid stream limit')
    slots = threading.BoundedSemaphore(stream_limit)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=stream_limit + 16), options=[('grpc.max_receive_message_length', 16384), ('grpc.max_send_message_length', 32 * 1024 * 1024)])
    methods = {name: grpc.unary_unary_rpc_method_handler(handler(name, world_url), request_deserializer=message(kind).FromString, response_serializer=RESULT.SerializeToString) for name, kind in METHODS.items()}
    for name, (request_kind, response_kind) in TYPED_METHODS.items():
        role = 'agent' if name == 'ObserveAgentTyped' else 'coordinator'
        methods[name] = grpc.unary_unary_rpc_method_handler(typed_handler(role, world_url), request_deserializer=message(request_kind).FromString, response_serializer=message(response_kind).SerializeToString)
    for typed, group in ((False, STREAM_METHODS), (True, TYPED_STREAM_METHODS)):
        for name, kind in group.items():
            role = 'agent' if name.startswith('StreamAgent') else 'coordinator'
            response = 'TypedObservationUpdate' if typed else 'ObservationUpdate'
            methods[name] = grpc.unary_stream_rpc_method_handler(stream_handler(role, world_url, slots, typed), request_deserializer=message(kind).FromString, response_serializer=message(response).SerializeToString)
    methods['StreamEventHistory'] = grpc.unary_stream_rpc_method_handler(event_history_handler(world_url, slots), request_deserializer=message('EventHistoryRequest').FromString, response_serializer=message('EventHistoryItem').SerializeToString)
    methods['SubscribeEvents'] = grpc.unary_stream_rpc_method_handler(live_events_handler(world_url, slots), request_deserializer=message('EventHistoryRequest').FromString, response_serializer=message('EventHistoryItem').SerializeToString)
    server.add_generic_rpc_handlers((grpc.method_handlers_generic_handler(SERVICE, methods),))
    return server

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world-url', default='http://127.0.0.1:8787')
    parser.add_argument('--port', type=int, default=8788)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535: parser.error('port must be 0–65535; 0 requests an ephemeral port')
    server = create_server(args.world_url)
    bound_port = server.add_insecure_port(f'127.0.0.1:{args.port}')
    if not bound_port:
        raise RuntimeError('could not bind loopback gRPC port')
    server.start()
    print(f'local gRPC adapter listening on 127.0.0.1:{bound_port}', flush=True)
    try: server.wait_for_termination()
    except KeyboardInterrupt: server.stop(2).wait()

if __name__ == '__main__':
    main()
