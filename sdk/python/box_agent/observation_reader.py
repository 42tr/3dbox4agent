"""Scoped live observations with a bounded wait and HTTP fallback."""
from websockets.exceptions import ConnectionClosed
from .stream import ObservationStream


class ObservationReader:
    def __init__(self, client, session_id, token, agent_id, base_url, wait=0.1, role='agent'):
        self.client, self.wait, self.role = client, wait, role
        self.stream = ObservationStream(session_id, token, role, agent_id, base_url)
        self.fallback = False

    def __enter__(self):
        self.stream.__enter__()
        print('观察流已连接', flush=True)
        return self

    def observe(self):
        if self.fallback:
            return self.client.observe()
        latest = None
        def extract(message):
            observation = message['observation']
            return {**observation, 'worldRevision':int(message['revision'])} if self.role == 'coordinator' else observation
        try:
            message = self.stream.receive(timeout=self.wait)
            if message['type'] == 'observation':
                latest = extract(message)
            # Keep only the latest available snapshot: all action state remains
            # in each observation, but intermediate observations may be skipped.
            for _ in range(64):
                try:
                    message = self.stream.receive(timeout=0)
                except TimeoutError:
                    break
                if message['type'] == 'observation':
                    latest = extract(message)
        except TimeoutError:
            pass
        except ConnectionClosed:
            self.stream.close()
            self.fallback = True
            transport = 'gRPC' if hasattr(self.client, '_connection') else 'HTTP'
            print(f'观察流已断开，改用 {transport} 观察', flush=True)
        return latest if latest is not None and not self.fallback else self.client.observe()

    def __exit__(self, *_exc):
        self.stream.close()
