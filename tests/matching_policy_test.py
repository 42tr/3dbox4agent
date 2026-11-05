import sys
import itertools
import math
import random
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'sdk/python'))
from matching_policy import choose


def task(identifier, candidates, priority=0):
    return {'id':identifier,'target':[0,0],'priority':priority,'candidates':[
        {'id':name,'x':x,'y':0,'battery':80} for name,x in candidates]}


class MatchingTests(unittest.TestCase):
    def test_scarce_device_reserved_for_other_task(self):
        observation={'tasks':[task('flexible',[('a',1),('b',10)]),task('restricted',[('a',1)])]}
        self.assertEqual(choose(observation),{'taskId':'flexible','agentId':'b'})

    def test_priority_matters_when_not_all_tasks_can_be_matched(self):
        observation={'tasks':[task('low',[('a',0)]),task('high',[('a',50)],9)]}
        self.assertEqual(choose(observation),{'taskId':'high','agentId':'a'})

    def test_highest_priority_is_submitted_first(self):
        obs={'tasks':[task('low',[('a',0)]),task('high',[('b',0)],9)]}
        self.assertEqual(choose(obs),{'taskId':'high','agentId':'b'})

    def test_equal_priority_minimizes_total_distance(self):
        observation={'tasks':[task('first',[('a',1),('b',2)]),task('second',[('a',1),('b',99)])]}
        self.assertEqual(choose(observation),{'taskId':'first','agentId':'b'})

    def test_matches_exhaustive_objective_on_small_graphs(self):
        rng = random.Random(123)
        for _ in range(100):
            names = ['a', 'b', 'c', 'd']
            tasks = [task(str(i), [(a, rng.randrange(10)) for a in names if rng.randrange(2)],
                          rng.randrange(4)) for i in range(4)]
            options = [[None] + t['candidates'] for t in tasks]
            best = None
            winners = []
            for allocation in itertools.product(*options):
                assigned = [a for a in allocation if a is not None]
                if len({a['id'] for a in assigned}) != len(assigned):
                    continue
                score = (len(assigned), sum(t['priority'] for t, a in zip(tasks, allocation) if a),
                         -sum(round(math.hypot(a['x']-t['target'][0], a['y']-t['target'][1])*1000)
                              for t, a in zip(tasks, allocation) if a))
                if best is None or score > best:
                    best, winners = score, [allocation]
                elif score == best:
                    winners.append(allocation)
            choice = choose({'tasks':tasks})
            if not choice:
                self.assertEqual(best[0], 0)
            else:
                index = int(choice['taskId'])
                self.assertTrue(any(a[index] is not None and a[index]['id'] == choice['agentId'] for a in winners))

    def test_empty_and_stable_ties(self):
        self.assertIsNone(choose({'tasks':[task('empty',[])]}))
        obs={'tasks':[task('first',[('b',1),('a',1)])]}
        self.assertEqual(choose(obs),{'taskId':'first','agentId':'a'})
        self.assertEqual(choose(obs),choose(obs))

if __name__=='__main__':
    unittest.main()
