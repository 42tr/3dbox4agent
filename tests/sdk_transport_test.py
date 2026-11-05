import unittest
from unittest.mock import patch
from box_agent import AgentClient, SandboxError


class TransportTest(unittest.TestCase):
    def test_socket_timeouts_and_connection_resets_are_reported_as_transport_errors(self):
        client = AgentClient('session', 'agent', 'token')
        for error in (TimeoutError('timed out'), ConnectionResetError('reset')):
            with self.subTest(error=type(error).__name__), patch('box_agent.client.urlopen', side_effect=error):
                with self.assertRaises(SandboxError) as result:
                    client.send_message('other', 'hello', request_id='retry-1')
                self.assertEqual((result.exception.status, result.exception.code), (0, 'connection_error'))


if __name__ == '__main__':
    unittest.main()
