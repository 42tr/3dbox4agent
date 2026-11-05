import unittest
from laxity_policy import choose


def task(name, deadline, duration, candidates):
    return {'id': name, 'target': [0, 0], 'deadline': deadline, 'duration': duration, 'candidates': candidates}


def agent(name, x, speed):
    return {'id': name, 'x': x, 'y': 0, 'speed': speed}


class LaxityTest(unittest.TestCase):
    def test_longer_task_has_less_slack_and_fastest_candidate_wins(self):
        tasks = [task('early', 60, 4, [agent('a', 20, 2)]), task('long', 65, 30, [agent('a', 10, 1), agent('b', 15, 3)])]
        self.assertEqual(choose({'tick': 0, 'tasks': tasks}), {'taskId': 'long', 'agentId': 'b'})

    def test_mixed_observations_use_consistent_fallback(self):
        tasks = [task('earlier', 50, 2, [{'id': 'a', 'x': 1, 'y': 0}]),
                 task('later', 60, 40, [agent('b', 1, 1)])]
        self.assertEqual(choose({'tick': 0, 'tasks': tasks})['taskId'], 'earlier')
        tasks[0]['candidates'][0]['speed'] = 1
        self.assertEqual(choose({'tick': 0, 'tasks': tasks})['taskId'], 'later')

    def test_older_observation_falls_back_and_empty_is_safe(self):
        tasks = [task('earlier', 10, 1, [{'id': 'b', 'x': 2, 'y': 0}, {'id': 'a', 'x': 2, 'y': 0}]), task('later', 20, 1, [{'id': 'c', 'x': 0, 'y': 0}])]
        self.assertEqual(choose({'tick': 0, 'tasks': tasks}), {'taskId': 'earlier', 'agentId': 'a'})
        self.assertIsNone(choose({'tick': 0, 'tasks': []}))


if __name__ == '__main__':
    unittest.main()
