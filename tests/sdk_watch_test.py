import unittest
from unittest.mock import patch
from box_agent.watch import wait_for_action
from box_agent import SandboxError


class Client:
    def __init__(self, snapshots):
        self.snapshots = iter(snapshots)
    def observe(self):
        return next(self.snapshots)


def observation(status, done=False):
    return {'done': done, 'actions': [] if status is None else [{'requestId': 'a', 'status': status}]}


class WatchTest(unittest.TestCase):
    @patch('box_agent.watch.time.sleep')
    def test_returns_any_terminal_record(self, sleep):
        for status in ('completed', 'failed', 'rejected', 'cancelled'):
            client = Client([observation('pending'), observation(status)])
            self.assertEqual(wait_for_action(client, 'a')['status'], status)
        self.assertEqual(sleep.call_count, 4)

    def test_finished_world_and_bad_parameters(self):
        with self.assertRaises(LookupError):
            wait_for_action(Client([observation(None, True)]), 'a')
        for value in (0, -1, float('inf'), True):
            with self.assertRaises(ValueError):
                wait_for_action(Client([]), 'a', timeout=value)

    def test_world_step_failure_does_not_wait_until_timeout(self):
        state = {**observation('accepted'), 'simulationError': 'world_step_failed'}
        with self.assertRaises(SandboxError) as result:
            wait_for_action(Client([state]), 'a')
        self.assertEqual((result.exception.status, result.exception.code), (503, 'world_step_failed'))
        state['actions'][0]['status'] = 'completed'
        self.assertEqual(wait_for_action(Client([state]), 'a')['status'], 'completed')
        state = {**observation('accepted'), 'sessionError': 'journal_write_failed'}
        with self.assertRaises(SandboxError) as result:
            wait_for_action(Client([state]), 'a')
        self.assertEqual((result.exception.status, result.exception.code), (503, 'journal_write_failed'))

    @patch('box_agent.watch.time.monotonic', side_effect=[0, 2])
    def test_wall_timeout(self, _clock):
        with self.assertRaises(TimeoutError):
            wait_for_action(Client([observation('accepted')]), 'a', timeout=1)


if __name__ == '__main__':
    unittest.main()
