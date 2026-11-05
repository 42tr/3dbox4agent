"""Scoped gRPC observation stream with explicit cancellation and gap metadata."""
import json
import math
import grpc
from .client import SandboxError
from .grpc_client import _Connection, _HTTP_STATUS
from .grpc_protocol import SERVICE, STREAM_METHODS, TYPED_STREAM_METHODS, message

class GrpcObservationStream:
    """Receive scoped snapshots; reconnect fetches only the latest, not history.

    `timeout`, when set, is the deadline for the entire stream, not each receive.
    Call close() to cancel, including from another thread while receive() blocks.
    """
    def __init__(self, session_id, token, role, agent_id=None, target='127.0.0.1:8788', after_revision=None, timeout=None, typed=False):
        if role not in ('agent', 'coordinator') or (role == 'agent' and (not isinstance(agent_id, str) or not agent_id)) or (role == 'coordinator' and agent_id is not None):
            raise ValueError('role must be agent with agent_id, or coordinator')
        if after_revision is not None and (type(after_revision) is not int or not 0 <= after_revision <= 2**53-1):
            raise ValueError('invalid after_revision')
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('invalid stream timeout')
        if not isinstance(typed, bool): raise ValueError('typed must be bool')
        self.typed = typed
        self._conn = _Connection(session_id, token, target, 5)
        self.role, self.agent_id, self.after_revision, self.timeout = role, agent_id, after_revision, timeout
        self._call, self._closed, self.ready = None, False, None
        self.last_revision = after_revision
        self.revisions_since = None

    def __enter__(self):
        if self._call is not None or self._closed: raise RuntimeError('stream already used')
        name = 'StreamAgentObservations' if self.role == 'agent' else 'StreamCoordinatorObservations'
        if self.typed: name += 'Typed'
        fields = {'session_id': self._conn.session_id}
        if self.role == 'agent': fields['agent_id'] = self.agent_id
        if self.after_revision is not None: fields['after_revision'] = self.after_revision
        request = message((TYPED_STREAM_METHODS if self.typed else STREAM_METHODS)[name])(**fields)
        response_type = 'TypedObservationUpdate' if self.typed else 'ObservationUpdate'
        rpc = self._conn.channel.unary_stream('/' + SERVICE + '/' + name, request_serializer=request.SerializeToString, response_deserializer=message(response_type).FromString)
        self._call = rpc(request, timeout=self.timeout, metadata=(('authorization', 'Bearer ' + self._conn.token),))
        try:
            ready = self._next()
            if ready['type'] != 'ready': raise ValueError('unexpected stream handshake')
            self.ready = ready
            self.revisions_since = ready.get('revisionsSince')
            return self
        except BaseException:
            self.close()
            raise

    def _next(self):
        try: update = next(self._call)
        except grpc.RpcError as error:
            if self._closed: raise StopIteration from None
            raise SandboxError(_HTTP_STATUS.get(error.code(), 0), error.details() or 'connection_error') from None
        kinds = {0:'ready',1:'observation',2:'status'}
        if update.kind not in kinds or update.revision > 2**53-1 or (self.last_revision is not None and update.revision < self.last_revision):
            raise ValueError('invalid stream update')
        result = {'type':kinds[update.kind], 'revision':update.revision, 'statusRevision':update.status_revision,
                  'running':update.running, 'speed':update.speed}
        if update.kind == 0 and update.HasField('revisions_since'): result['revisionsSince'] = update.revisions_since
        if update.kind == 1:
            if self.typed:
                if update.WhichOneof('observation') != self.role: raise ValueError('unexpected observation role')
                obs = getattr(update, self.role)
                extras = json.loads(obs.extra_json_utf8) if obs.extra_json_utf8 else {}
                if not isinstance(extras, dict) or 'world' in extras or 'agents' in extras: raise ValueError('unexpected observation')
                if self.role == 'agent' and (not obs.HasField('self') or obs.self.id != self.agent_id): raise ValueError('unexpected agent')
            else:
                obs = json.loads(update.observation_json_utf8)
                own = obs.get('self') if isinstance(obs, dict) else None
                if not isinstance(obs, dict) or 'world' in obs or 'agents' in obs or (self.role == 'agent' and (not isinstance(own, dict) or own.get('id') != self.agent_id)):
                    raise ValueError('unexpected observation')
            result['observation'] = obs
            self.last_revision = update.revision
        return result

    def receive(self):
        if self._closed or self._call is None: raise RuntimeError('stream not open')
        result = self._next()
        if result['type'] == 'ready': raise ValueError('duplicate stream handshake')
        return result

    def close(self):
        if not self._closed:
            self._closed = True
            if self._call is not None: self._call.cancel()
            self._conn.close()

    def __exit__(self, *_exc): self.close()
