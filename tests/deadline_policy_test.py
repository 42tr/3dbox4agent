import unittest
from deadline_policy import choose


def task(name, deadline=None, priority=0, candidates=None):
    result = {'id': name, 'target': [0, 0], 'priority': priority, 'candidates': candidates or []}
    if deadline is not None:
        result['deadline'] = deadline
    return result


def agent(name, x):
    return {'id': name, 'x': x, 'y': 0, 'battery': 80}


class DeadlinePolicyTest(unittest.TestCase):
    def test_deadline_precedes_priority_and_distance(self):
        tasks = [task('priority', 60, 10, [agent('a', 1)]), task('urgent', 40, 1, [agent('a', 4), agent('b', 2)])]
        self.assertEqual(choose({'tick': 5, 'tasks': tasks}), {'taskId': 'urgent', 'agentId': 'b'})

    def test_empty_earlier_task_skipped_and_undated_last(self):
        tasks = [task('blocked', 1), task('undated', priority=100, candidates=[agent('x', 0)]), task('dated', 10, 0, [agent('y', 1)])]
        self.assertEqual(choose({'tick': 20, 'tasks': tasks})['taskId'], 'dated')
        self.assertIsNone(choose({'tick': 0, 'tasks': [task('empty')]}))

    def test_priority_observation_order_and_agent_ties(self):
        tasks = [task('low', 40, 1, [agent('z', 0)]), task('high', 40, 2, [agent('b', 1), agent('a', 1)]), task('last', 40, 2, [agent('z', 0)])]
        self.assertEqual(choose({'tick': 0, 'tasks': tasks}), {'taskId': 'high', 'agentId': 'a'})


if __name__ == '__main__':
    unittest.main()
