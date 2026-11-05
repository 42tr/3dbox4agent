import unittest
from unittest.mock import patch
from websockets.exceptions import ConnectionClosed
from box_agent.observation_reader import ObservationReader


class Client:
    def __init__(self):
        self.calls = 0
    def observe(self):
        self.calls += 1
        return {'tick': 99}


class FakeStream:
    def __init__(self, messages):
        self.messages, self.closed = iter(messages), False
    def receive(self, timeout=None):
        item = next(self.messages)
        if isinstance(item, Exception):
            raise item
        return item
    def close(self):
        self.closed = True


class ReaderTest(unittest.TestCase):
    def test_coalesces_observations_and_ignores_status(self):
        client = Client()
        reader = ObservationReader(client, 's', 't', 'a', 'http://127.0.0.1:8787')
        reader.stream = FakeStream([{'type':'observation','observation':{'tick':1}}, {'type':'status'}, {'type':'observation','observation':{'tick':2}}, TimeoutError()])
        self.assertEqual(reader.observe()['tick'], 2)
        self.assertEqual(client.calls, 0)

    def test_coordinator_includes_corresponding_world_revision(self):
        reader = ObservationReader(Client(), 's', 't', None, 'http://127.0.0.1:8787', role='coordinator')
        reader.stream = FakeStream([{'type':'observation','revision':17,'observation':{'tick':3,'tasks':[]}}, TimeoutError()])
        self.assertEqual(reader.observe(), {'tick':3,'tasks':[],'worldRevision':17})

    def test_timeout_and_disconnect_fall_back_to_http(self):
        client = Client()
        reader = ObservationReader(client, 's', 't', 'a', 'http://127.0.0.1:8787')
        reader.stream = FakeStream([TimeoutError(), ConnectionClosed(None, None)])
        self.assertEqual(reader.observe()['tick'], 99)
        self.assertFalse(reader.fallback)
        with patch('builtins.print') as message:
            self.assertEqual(reader.observe()['tick'], 99)
            message.assert_called_once()
        self.assertTrue(reader.fallback)
        self.assertTrue(reader.stream.closed)
        self.assertEqual(reader.observe()['tick'], 99)
        self.assertEqual(client.calls, 3)

    def test_disconnect_falls_back_to_grpc_client(self):
        client = Client()
        client._connection = object()
        reader = ObservationReader(client, 's', 't', 'a', 'http://127.0.0.1:8787')
        reader.stream = FakeStream([ConnectionClosed(None, None)])
        with patch('builtins.print') as message:
            self.assertEqual(reader.observe()['tick'], 99)
            message.assert_called_once_with('观察流已断开，改用 gRPC 观察', flush=True)
        self.assertTrue(reader.fallback)
        self.assertEqual(client.calls, 1)


if __name__ == '__main__':
    unittest.main()
