import itertools
import math
import random
import unittest

from box_agent.planner import plan


class PlannerTest(unittest.TestCase):
    def test_global_assignment_avoids_greedy_dead_end(self):
        obs = {'tasks': [
            {'id':'a', 'target':[0, 0], 'candidates':[{'id':'x','x':0,'y':0,'battery':100}, {'id':'y','x':1,'y':0,'battery':100}]},
            {'id':'b', 'target':[0, 0], 'candidates':[{'id':'x','x':0,'y':0,'battery':100}]},
        ]}
        result = plan(obs)
        self.assertEqual({(x['taskId'], x['agentId']) for x in result}, {('a','y'),('b','x')})
        self.assertEqual(result, plan({'tasks':list(reversed(obs['tasks']))}))

    def test_matches_brute_force_oracle(self):
        randomizer = random.Random(872)
        for _ in range(100):
            tasks = []
            for t in range(4):
                candidates = [{'id':f'a{a}', 'x':randomizer.randrange(8), 'y':randomizer.randrange(8), 'battery':randomizer.randrange(50,101)}
                              for a in range(4) if randomizer.random() < .7]
                tasks.append({'id':f't{t}', 'target':[randomizer.randrange(8),randomizer.randrange(8)], 'candidates':candidates})
            result = plan({'tasks':tasks})
            actual = (-len(result), round(sum(r['cost'] for r in result)*100))
            possibilities = []
            for choice in itertools.product(*[[None]+t['candidates'] for t in tasks]):
                chosen = [c for c in choice if c is not None]
                if len({c['id'] for c in chosen}) != len(chosen):
                    continue
                cost = sum(round(100*math.hypot(c['x']-task['target'][0], c['y']-task['target'][1])+50*(100-c['battery']))
                           for task,c in zip(tasks,choice) if c is not None)
                possibilities.append((-len(chosen),cost))
            self.assertEqual(actual,min(possibilities))

    def test_empty_and_invalid(self):
        self.assertEqual(plan({'tasks':[]}), [])
        candidate = {'id':'x','x':0,'y':0,'battery':101}
        with self.assertRaises(ValueError):
            plan({'tasks':[{'id':'a','target':[0,0],'candidates':[candidate]}]})

    def test_plans_in_the_expanded_world(self):
        task = {'id': 'repair', 'target': [164, 120], 'candidates': [
            {'id': 'east', 'x': 160, 'y': 128, 'battery': 100},
            {'id': 'west', 'x': 62, 'y': 101, 'battery': 100},
        ]}
        self.assertEqual(plan({'worldSize': 224, 'tasks': [task]})[0]['agentId'], 'east')
        with self.assertRaises(ValueError):
            plan({'tasks': [task]})


class PriorityTests(unittest.TestCase):
    def test_priority_breaks_resource_contention_after_cardinality(self):
        tasks = [
            {'id':'low','priority':1,'target':[0,0],'candidates':[{'id':'a','x':0,'y':0,'battery':100}]},
            {'id':'high','priority':10,'target':[100,100],'candidates':[{'id':'a','x':0,'y':0,'battery':100}]},
        ]
        self.assertEqual(plan({'tasks':tasks})[0]['taskId'],'high')
        tasks[0]['candidates'].append({'id':'b','x':100,'y':100,'battery':100})
        self.assertEqual(len(plan({'tasks':tasks})),2)

if __name__ == '__main__':
    unittest.main()
