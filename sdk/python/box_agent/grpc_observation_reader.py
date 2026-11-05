"""Coalescing gRPC observation reader with bounded storage and unary fallback."""
import threading
from .grpc_stream import GrpcObservationStream
from .typed_observation import decode

class GrpcObservationReader:
    def __init__(self, client, session_id, token, agent_id, target, wait=0.1, role='agent'):
        self.client, self.wait, self.role = client, wait, role
        self.stream = GrpcObservationStream(session_id, token, role, agent_id, target, typed=True)
        self._condition = threading.Condition()
        self._latest = None
        self._last_tick = -1
        self._failed = self._closing = False
        self._thread = None

    def __enter__(self):
        self.stream.__enter__()
        self._thread = threading.Thread(target=self._pump, name='grpc-observation-reader', daemon=True)
        self._thread.start()
        print('gRPC 观察流已连接', flush=True)
        return self

    def _pump(self):
        try:
            while True:
                update = self.stream.receive()
                if update['type'] != 'observation': continue
                kind = 'AgentObservation' if self.role == 'agent' else 'CoordinatorObservation'
                obs = decode(kind, update['observation'])
                if self.role == 'coordinator': obs = {**obs, 'worldRevision':update['revision']}
                with self._condition:
                    if obs.get('tick', -1) >= self._last_tick:
                        self._latest = obs
                    self._condition.notify_all()
        except Exception:
            with self._condition:
                self._failed = True
                self._condition.notify_all()
                closing = self._closing
            if not closing: print('gRPC 观察流已断开，改用 gRPC 请求观察', flush=True)

    def observe(self):
        with self._condition:
            if self._latest is None and not self._failed:
                self._condition.wait_for(lambda:self._latest is not None or self._failed, timeout=self.wait)
            cached = None if self._failed else self._latest
            if cached is not None and cached.get('tick', -1) >= self._last_tick:
                self._last_tick = cached['tick']
                return cached
        value = self.client.observe()
        with self._condition:
            self._last_tick = max(self._last_tick, value.get('tick', -1))
            if self._latest is not None and self._latest.get('tick', -1) < self._last_tick:
                self._latest = None
        return value

    def __exit__(self, *_exc):
        with self._condition:
            self._closing = True
        self.stream.close()
        if self._thread is not None: self._thread.join(timeout=3)
