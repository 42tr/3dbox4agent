import unittest
from copy import deepcopy
from box_agent import SandboxError
from peer_ack_agent import accept_in_memory


class MemoryClient:
    def __init__(self):
        self.revision = 0
        self.value = {'unrelated': {'kept': True}}
        self.conflicts = 0
        self.lose_response = False

    def read_memory(self):
        return {'revision': self.revision, 'value': deepcopy(self.value)}

    def write_memory(self, value, revision):
        if self.conflicts:
            self.conflicts -= 1
            self.revision += 1
            raise SandboxError(409, 'memory_revision_conflict')
        if revision != self.revision:
            raise SandboxError(409, 'memory_revision_conflict')
        self.value = deepcopy(value)
        self.revision += 1
        if self.lose_response:
            self.lose_response = False
            raise SandboxError(0, 'connection_error')


class PeerMemoryTest(unittest.TestCase):
    def test_cas_conflict_restart_and_preserves_unrelated_memory(self):
        c = MemoryClient()
        c.conflicts = 1
        self.assertTrue(accept_in_memory(c, 'peer', 'item', 'body'))
        self.assertEqual(c.value['unrelated'], {'kept': True})
        revision = c.revision
        self.assertFalse(accept_in_memory(c, 'peer', 'item', 'body'))
        self.assertEqual(c.revision, revision)
        with self.assertRaises(ValueError):
            accept_in_memory(c, 'peer', 'item', 'different')

    def test_write_response_loss_does_not_duplicate_marker(self):
        c = MemoryClient()
        c.lose_response = True
        with self.assertRaises(SandboxError):
            accept_in_memory(c, 'peer', 'item', 'body')
        self.assertFalse(accept_in_memory(c, 'peer', 'item', 'body'))
        self.assertEqual(len(c.value['peerAckV1']), 1)


if __name__ == '__main__':
    unittest.main()
