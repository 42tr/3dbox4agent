"""Optional scoped WebSocket observation client for local world sessions.

Install box-agent-sdk[stream] to use this module. It does not provide an admin
snapshot subscription or automatically reconnect across missing revisions.
"""
import json
import math
from pathlib import Path
from urllib.parse import urlsplit

try:
    from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
    from websockets.sync.client import connect
except ImportError as error:
    raise ImportError('install box-agent-sdk[stream] to use observation streams') from error

from .client import AgentClient

_MAX_MESSAGE = 32 * 1024 * 1024
_MAX_NODES = 2_000_000
_MAX_DEPTH = 96


def _envelope_type():
    descriptor = descriptor_pb2.FileDescriptorSet.FromString((Path(__file__).parent / 'stream.desc').read_bytes())
    if len(descriptor.file) != 1:
        raise ValueError('invalid bundled stream descriptor')
    pool = descriptor_pool.DescriptorPool()
    pool.AddSerializedFile(descriptor.file[0].SerializeToString())
    return message_factory.GetMessageClass(pool.FindMessageTypeByName('box.stream.v1.Envelope'))


_Envelope = _envelope_type()


def decode_message(raw):
    """Decode v1/v2 protobuf messages; text is supported for older services."""
    if isinstance(raw, str):
        if len(raw.encode('utf-8')) > _MAX_MESSAGE:
            raise ValueError('stream message too large')
        result = json.loads(raw)
    elif isinstance(raw, bytes):
        if len(raw) > _MAX_MESSAGE:
            raise ValueError('stream message too large')
        envelope = _Envelope.FromString(raw)
        if envelope.version not in (1, 2) or not envelope.HasField('payload'):
            raise ValueError('invalid stream envelope')
        keys = [json.loads(key) for key in envelope.json_keys]
        if len(keys) > 127 or any(not isinstance(k, str) for k in keys) or len(set(keys)) != len(keys) or envelope.version == 1 and keys:
            raise ValueError('invalid stream dictionary')
        nodes = 0
        def convert(value, depth):
            nonlocal nodes
            nodes += 1
            if nodes > _MAX_NODES or depth > _MAX_DEPTH:
                raise ValueError('stream value limit')
            kind = value.WhichOneof('kind')
            if kind == 'null_value':
                if not value.null_value:
                    raise ValueError('invalid null')
                return None
            if kind == 'bool_value':
                return value.bool_value
            if kind == 'number_value':
                if not math.isfinite(value.number_value):
                    raise ValueError('invalid number')
                number = value.number_value
                return int(number) if number.is_integer() and abs(number) <= 2**53-1 else number
            if kind == 'json_string':
                result = json.loads(value.json_string)
                if not isinstance(result, str):
                    raise ValueError('invalid string')
                return result
            if kind == 'list_value':
                return [convert(item, depth + 1) for item in value.list_value.values]
            if kind == 'object_value':
                result = {}
                for field in value.object_value.fields:
                    key_kind = field.WhichOneof('key')
                    if key_kind == 'json_key':
                        key = json.loads(field.json_key)
                    elif key_kind == 'key_index' and envelope.version == 2 and 1 <= field.key_index <= len(keys):
                        key = keys[field.key_index - 1]
                    else:
                        raise ValueError('invalid key')
                    if not isinstance(key, str) or key in result or not field.HasField('value'):
                        raise ValueError('invalid field')
                    result[key] = convert(field.value, depth + 1)
                return result
            raise ValueError('invalid value kind')
        result = convert(envelope.payload, 0)
    else:
        raise ValueError('unsupported stream message')
    if not isinstance(result, dict):
        raise ValueError('stream message must be an object')
    return result


class ObservationStream:
    """Blocking scoped stream. A reconnect returns the latest observation only."""
    def __init__(self, session_id, token, role, agent_id=None, base_url='http://127.0.0.1:8787', after_revision=-1, timeout=5):
        if role not in ('agent', 'coordinator') or role == 'agent' and not agent_id or role == 'coordinator' and agent_id is not None:
            raise ValueError('role must be agent with agent_id, or coordinator')
        if type(after_revision) is not int or after_revision < -1 or after_revision > 2**53-1:
            raise ValueError('invalid after_revision')
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError('timeout must be positive')
        checked = AgentClient(session_id, agent_id or '_coordinator', token, base_url, timeout)
        self._base, self._session, self._token = checked._base, session_id, token
        self.role, self.agent_id, self.after_revision, self.timeout = role, agent_id, after_revision, timeout
        self._socket, self.ready = None, None
        self.last_revision = after_revision
        self.unseen_revisions = None

    def __enter__(self):
        if self._socket is not None:
            raise RuntimeError('stream already open')
        origin = urlsplit(self._base)
        self._socket = connect('ws://' + origin.netloc + '/stream', open_timeout=self.timeout,
                               close_timeout=2, max_size=_MAX_MESSAGE, compression=None, proxy=None)
        try:
            self._socket.send(json.dumps({'type':'subscribe', 'sessionId':self._session, 'token':self._token,
                                          'afterRevision':self.after_revision, 'encoding':'protobuf-v2'}))
            self.ready = decode_message(self._socket.recv(timeout=self.timeout))
            if self.ready.get('type') != 'ready' or self.ready.get('role') != self.role or self.ready.get('encoding') not in ('protobuf-v1','protobuf-v2','full-v1'):
                raise ValueError('unexpected stream handshake')
            revision = self.ready.get('revision')
            if isinstance(revision, bool) or not isinstance(revision, (int, float)) or not math.isfinite(revision) or int(revision) != revision or not 0 <= revision <= 2**53-1:
                raise ValueError('invalid stream revision')
            revision = int(revision)
            if revision < self.after_revision or revision < 0:
                raise ValueError('invalid stream revision')
            self.unseen_revisions = max(0, revision - self.after_revision) if self.after_revision >= 0 else None
            return self
        except BaseException:
            self.close()
            raise

    def receive(self, timeout=None):
        if self._socket is None:
            raise RuntimeError('stream not open')
        message = decode_message(self._socket.recv(timeout=timeout))
        if message.get('type') not in ('status', 'observation') or 'world' in message:
            raise ValueError('unexpected scoped stream message')
        revision = message.get('revision')
        if isinstance(revision, bool) or not isinstance(revision, (int, float)) or not math.isfinite(revision) or int(revision) != revision or revision < self.last_revision or revision > 2**53-1:
            raise ValueError('invalid stream revision')
        if message['type'] == 'observation':
            observation = message.get('observation')
            if not isinstance(observation, dict) or 'agents' in observation or 'world' in observation or self.role == 'agent' and (not isinstance(observation.get('self'), dict) or observation['self'].get('id') != self.agent_id):
                raise ValueError('unexpected observation')
            self.last_revision = int(revision)
        return message

    def close(self):
        if self._socket is not None:
            sock, self._socket = self._socket, None
            sock.close()

    def __exit__(self, *_exc):
        self.close()
