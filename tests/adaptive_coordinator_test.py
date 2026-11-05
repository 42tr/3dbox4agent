import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'sdk/python'))
from adaptive_coordinator import eligible_observation, eligible_blocked_assignment
from blocked_coordinator import blocked_assignment

class AdaptiveTests(unittest.TestCase):
    def test_cooldowns_and_input_unchanged(self):
        source={'tick':20,'tasks':[{'id':'a','candidates':[{'id':'x'},{'id':'y'}]}],
                'revocations':[{'status':'accepted','taskId':'a','agentId':'x','appliedTick':15,'requireBlockedSince':3}],
                'decisions':[{'status':'rejected','reason':'not_available','taskId':'a','agentId':'y','appliedTick':19}]}
        self.assertEqual(eligible_observation(source,10)['tasks'][0]['candidates'],[])
        self.assertEqual(len(source['tasks'][0]['candidates']),2)
        self.assertEqual([a['id'] for a in eligible_observation({**source,'tick':25},10)['tasks'][0]['candidates']],['x'])
        self.assertEqual(len(eligible_observation({**source,'tick':29},10)['tasks'][0]['candidates']),2)
    def test_disproved_wait_is_not_retried(self):
        task={'id':'a','assignee':'x','assignmentId':7,'statusReport':{'fresh':True,'capturedTick':10,'routeBlockedSince':3}}
        rejected={'status':'rejected','reason':'route_condition_changed','taskId':'a','agentId':'x','assignmentId':7,'requireBlockedSince':3}
        obs={'active':[task],'revocations':[rejected]}
        self.assertIsNone(eligible_blocked_assignment(obs,2))
        later={**task,'statusReport':{**task['statusReport'],'routeBlockedSince':8,'capturedTick':11}}
        self.assertEqual(eligible_blocked_assignment({**obs,'active':[later]},2),later)

    def test_only_fresh_observed_duration_counts(self):
        task={'id':'a','statusReport':{'fresh':True,'capturedTick':10,'routeBlockedSince':7}}
        self.assertIsNone(blocked_assignment({'tick':100,'active':[task]},4))
        self.assertEqual(blocked_assignment({'tick':100,'active':[task]},3),task)
        self.assertIsNone(blocked_assignment({'active':[{**task,'statusReport':{**task['statusReport'],'fresh':False}}]},0))

if __name__=='__main__':unittest.main()
