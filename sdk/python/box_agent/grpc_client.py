"""Optional local gRPC clients for scoped agent and coordinator operations."""
import json
import re
import grpc
from .client import SandboxError
from .grpc_protocol import METHODS, TYPED_METHODS, SERVICE, message

_HTTP_STATUS = {grpc.StatusCode.INVALID_ARGUMENT: 400, grpc.StatusCode.UNAUTHENTICATED: 401,
                grpc.StatusCode.PERMISSION_DENIED: 403, grpc.StatusCode.NOT_FOUND: 404,
                grpc.StatusCode.FAILED_PRECONDITION: 409, grpc.StatusCode.RESOURCE_EXHAUSTED: 429,
                grpc.StatusCode.DATA_LOSS: 500}

class _Connection:
    def __init__(self, session_id, token, target, timeout):
        if not re.fullmatch(r'(?:127\.0\.0\.1|localhost):[0-9]{1,5}', target) or not 1 <= int(target.rsplit(':', 1)[1]) <= 65535:
            raise ValueError('target must be a loopback host and port')
        if not isinstance(session_id, str) or not session_id or not isinstance(token, str) or not token:
            raise ValueError('session_id and token are required')
        self.session_id, self.token, self.timeout = session_id, token, timeout
        self.channel = grpc.insecure_channel(target, options=[('grpc.max_receive_message_length', 32 * 1024 * 1024)])

    def call(self, method, **fields):
        request = message(METHODS[method])(session_id=self.session_id, **fields)
        rpc = self.channel.unary_unary('/' + SERVICE + '/' + method, request_serializer=request.SerializeToString, response_deserializer=message('JsonResult').FromString)
        try:
            reply = rpc(request, timeout=self.timeout, metadata=(('authorization', 'Bearer ' + self.token),))
        except grpc.RpcError as error:
            raise SandboxError(_HTTP_STATUS.get(error.code(), 0), error.details() or 'connection_error') from None
        return json.loads(reply.json_utf8)

    def call_typed(self, method, **fields):
        request_kind, response_kind = TYPED_METHODS[method]
        request = message(request_kind)(session_id=self.session_id, **fields)
        rpc = self.channel.unary_unary('/' + SERVICE + '/' + method, request_serializer=request.SerializeToString, response_deserializer=message(response_kind).FromString)
        try:
            return rpc(request, timeout=self.timeout, metadata=(('authorization','Bearer '+self.token),))
        except grpc.RpcError as error:
            raise SandboxError(_HTTP_STATUS.get(error.code(), 0), error.details() or 'connection_error') from None

    def close(self): self.channel.close()

class GrpcAgentClient:
    def __init__(self, session_id, agent_id, token, target='127.0.0.1:8788', timeout=5):
        if not isinstance(agent_id, str) or not agent_id: raise ValueError('agent_id is required')
        self._agent = agent_id
        self._connection = _Connection(session_id, token, target, timeout)
    def close(self): self._connection.close()
    def observe(self): return self._connection.call('ObserveAgent', agent_id=self._agent)
    def observe_typed(self): return self._connection.call_typed('ObserveAgentTyped', agent_id=self._agent)
    def lidar(self, count=36, max_range=None):
        fields = {'agent_id': self._agent, 'count': count}
        if max_range is not None: fields['max_range'] = max_range
        return self._connection.call('Lidar', **fields)
    def read_memory(self): return self._connection.call('ReadMemory', agent_id=self._agent)
    def write_memory(self, value, expected_revision):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        return self._connection.call('WriteMemory', agent_id=self._agent, expected_revision=expected_revision, value_json_utf8=data)
    def report_scan(self, request_id, scan_request_id):
        return self._connection.call('ReportScan', agent_id=self._agent, request_id=request_id, scan_request_id=scan_request_id)
    def cancel_action(self, request_id): return self._connection.call('CancelAction', agent_id=self._agent, request_id=request_id)
    def send_message(self, recipient_id, text, via=None, request_id=None):
        if isinstance(via, str): via = [via]
        return self._connection.call('SendMessage', agent_id=self._agent, recipient_id=recipient_id, text=text, via=via or [], request_id=request_id or '')
    def report_sample(self, request_id, task_id): return self._connection.call('ReportSample', agent_id=self._agent, request_id=request_id, task_id=task_id)
    def _action(self, request_id, kind, target_tick, expires_tick, **fields):
        return self._connection.call('SubmitAction', agent_id=self._agent, request_id=request_id, type=kind, target_tick=target_tick, expires_tick=expires_tick, **fields)
    def move_to(self, request_id, x, y, target_tick, expires_tick): return self._action(request_id, 'move', target_tick, expires_tick, target={'x': x, 'y': y})
    def rescue(self, request_id, target_agent_id, observed_tick, target_tick, expires_tick, fault_generation): return self._action(request_id, 'rescue', target_tick, expires_tick, target_agent_id=target_agent_id, observed_tick=observed_tick, fault_generation=fault_generation)
    def execute_task(self, request_id, task_id, target_tick, expires_tick): return self._action(request_id, 'execute_task', target_tick, expires_tick, task_id=task_id)
    def work_task(self, request_id, task_id, target_tick, expires_tick): return self._action(request_id, 'work_task', target_tick, expires_tick, task_id=task_id)
    def scan(self, request_id, target_tick, expires_tick): return self._action(request_id, 'scan', target_tick, expires_tick)
    def charge(self, request_id, target_tick, expires_tick): return self._action(request_id, 'charge', target_tick, expires_tick)

class GrpcCoordinatorClient:
    def __init__(self, session_id, token, target='127.0.0.1:8788', timeout=5): self._connection = _Connection(session_id, token, target, timeout)
    def close(self): self._connection.close()
    def observe(self): return self._connection.call('ObserveCoordinator')
    def observe_typed(self): return self._connection.call_typed('ObserveCoordinatorTyped')
    def assign(self, request_id, task_id, agent_id, observed_tick):
        return self._connection.call('Assign', request_id=request_id, task_id=task_id, agent_id=agent_id, observed_tick=observed_tick)

    def revoke(self, request_id, task_id, agent_id, assignment_id, observed_tick, require_blocked_since=None):
        fields = dict(request_id=request_id, task_id=task_id, agent_id=agent_id, assignment_id=assignment_id, observed_tick=observed_tick)
        if require_blocked_since is not None: fields['require_blocked_since'] = require_blocked_since
        return self._connection.call('Revoke', **fields)
    def propose_survey(self, request_id, task_id, name, role, target, duration, observed_tick, depends_on=None, priority=None, deadline=None, evidence_id=None, sensor_evidence_id=None, sample_report_id=None):
        fields = dict(request_id=request_id, task_id=task_id, name=name, role=role, target={'x': target[0], 'y': target[1]}, duration=duration, observed_tick=observed_tick, depends_on=depends_on or [])
        for key, value in (('priority',priority),('deadline',deadline),('evidence_id',evidence_id),('sensor_evidence_id',sensor_evidence_id),('sample_report_id',sample_report_id)):
            if value is not None: fields[key] = value
        return self._connection.call('ProposeSurvey', **fields)

class GrpcEventHistoryClient:
    """Read a finite persisted event prefix with an administrator credential."""
    def __init__(self, session_id, token, target='127.0.0.1:8788', timeout=30):
        self._connection = _Connection(session_id, token, target, timeout)

    def close(self): self._connection.close()

    def stream(self, after_seq=0):
        return self._stream('StreamEventHistory', after_seq)

    def subscribe(self, after_seq=0):
        """Catch up from the journal, then receive newly persisted events."""
        return self._stream('SubscribeEvents', after_seq)

    def _stream(self, method, after_seq):
        if not isinstance(after_seq, int) or isinstance(after_seq, bool) or not 0 <= after_seq <= 2**53-1:
            raise ValueError('after_seq must be a nonnegative safe integer')
        c = self._connection
        request = message('EventHistoryRequest')(session_id=c.session_id, after_seq=after_seq)
        rpc = c.channel.unary_stream('/' + SERVICE + '/' + method, request_serializer=request.SerializeToString, response_deserializer=message('EventHistoryItem').FromString)
        call = rpc(request, timeout=c.timeout, metadata=(('authorization', 'Bearer ' + c.token),))
        try:
            yield from call
        except grpc.RpcError as error:
            raise SandboxError(_HTTP_STATUS.get(error.code(), 0), error.details() or 'connection_error') from None
        finally:
            call.cancel()
