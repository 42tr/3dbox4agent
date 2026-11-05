"""Presence and extension fidelity for typed observation messages."""
import unittest
from box_agent.typed_observation import encode, decode

class TypedObservationTest(unittest.TestCase):
    def test_presence_and_extensions(self):
        source={'version':2,'tick':0,'done':False,'executionMode':'primitive',
          'self':{'id':'a','role':'rover','x':0,'y':2,'battery':100,'status':'idle','sensorRange':22,'communicationRange':60,'moveEnergyPerUnit':.045,'workEnergyPerTick':.08,'capabilities':['inspect'],'communicationInterrupted':False,'communicationBytesPerTick':None,'routeBlockedSince':0,'returnEnergyEstimate':None,'newSelfField':{'字':1}},
          'nearby':[{'kind':'agent','id':'b','role':'rover','x':4,'y':5,'status':'idle','observedTick':0,'source':'sensor'}],
          'visibleTargets':[], 'assignedTasks':[{'id':'t','name':'任务','target':[1,2],'status':'active','phase':None,'waypoint':None,'withinReach':False}],
          'memory':[{'kind':'agent','id':'b','role':'rover','x':4,'y':5,'status':'idle','observedTick':0,'source':'sensor','current':False,'age':0}],
          'actions':[{'agentId':'a','requestId':'m','type':'move','status':'pending','target':{'x':1,'y':2},'targetTick':0,'expiresTick':4,'progress':0}],
          'inbox':[{'id':1,'from':'b','to':'a','text':'测试\ud800','sentTick':0,'receivedTick':1,'via':['c']}],
          'evidenceReports':[{'id':9}],'simulationError':'world_step_failed','sessionError':'world_step_failed','futureField':{'nested':[False,None,1]}}
        typed=encode('AgentObservation',source)
        self.assertTrue(typed.self.HasField('route_blocked_since'))
        self.assertFalse(typed.self.HasField('return_energy_estimate'))
        self.assertTrue(typed.assigned_tasks[0].HasField('within_reach'))
        self.assertEqual(decode('AgentObservation',typed),source)
        self.assertEqual(decode('AgentObservation',typed.__class__.FromString(typed.SerializeToString())),source)

    def test_coordinator_optional_zero(self):
        source={'version':1,'tick':0,'done':False,'failed':False,'worldRevision':0,
                'tasks':[{'id':'t','capability':'inspect','target':[5,9],'name':'观察','behavior':'survey','duration':5,'priority':0,'deadline':1,'candidates':[{'id':'a','x':0,'y':1,'battery':5,'reportedTick':0}]}],
                'active':[{'id':'v','name':'活动','assignee':'a','assignmentId':2,'statusReport':None}],
                'decisions':[],'evidence':[],'future':1}
        typed=encode('CoordinatorObservation',source)
        self.assertTrue(typed.HasField('world_revision'))
        self.assertEqual(decode('CoordinatorObservation',typed),source)

if __name__=='__main__':unittest.main()
