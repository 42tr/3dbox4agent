import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk/python'))
from box_agent.recording import capture_recording_context, backend_profile
from policy_compare import execution_order


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.sid = '11111111-1111-4111-8111-111111111111'
        self.runtime = {'instanceId':'22222222-2222-4222-8222-222222222222', 'physicsBackend':'rust',
                        'taskBackend':'js', 'communicationBackend':'js', 'navigationBackend':'rust', 'worldLedgerBackend':'rust', 'worldMotionBackend':'rust', 'worldTasksBackend':'rust', 'worldExecutionBackend':'rust', 'worldActionsBackend':'rust', 'worldPeerBackend':'rust', 'worldReportsBackend':'rust', 'worldDispatchBackend':'rust', 'worldResourcesBackend':'rust', 'worldPerceptionsBackend':'rust', 'worldEnvironmentBackend':'rust', 'worldRequestsBackend':'rust', 'worldControlBackend':'rust', 'worldRollbackVersion':1, 'worldRouteVersion':1, 'worldStationaryVersion':1, 'worldWorkVersion':1, 'worldActivationVersion':1, 'worldLifecycleVersion':1, 'worldAssignmentVersion':1, 'worldInterruptionVersion':1, 'worldRevocationVersion':1, 'worldProposalVersion':1, 'worldTimeVersion':1, 'worldEndingVersion':1, 'worldFinalizationVersion':1, 'worldTaskEventsVersion':1, 'worldRouteEventsVersion':1, 'worldStationaryEventsVersion':1, 'worldLifecycleEventsVersion':1, 'worldActivationEventsVersion':1, 'worldPeerEventsVersion':1, 'worldReportEventsVersion':1, 'worldDispatchEventsVersion':1, 'worldAutomaticDispatchVersion':1, 'worldCollisionReplanVersion':1, 'worldActivationPlanningVersion':1, 'worldAssignmentPlanningVersion':1, 'worldAgentObservationVersion':1, 'worldCoordinatorObservationVersion':1, 'worldTaskAdvanceVersion':1, 'worldActionAdvanceVersion':1, 'worldAdvanceVersion':1, 'worldInitializationVersion':1, 'worldEnvironmentPlanningVersion':1,
                        'node':'v22.0.0', 'sourceSha256':{'src/engine.js':'a'*64},
                        'environment':{'KEY':'private'}, 'adminToken':'secret'}
        self.session = {'sessionId':self.sid, 'adminToken':'private-root',
                        'recordingContext':{'version':1,'sessionId':self.sid,'runtime':self.runtime,'adminToken':'private-context'}}

    def test_copy_whitelist_and_bind_world_instance(self):
        service = {**self.runtime, 'instanceId':'33333333-3333-4333-8333-333333333333'}
        result = capture_recording_context(self.session, service)
        self.assertEqual(result['runtime']['instanceId'], self.runtime['instanceId'])
        self.assertEqual(result['runtime']['worldAssignmentPlanningVersion'], 1)
        self.assertEqual(result['runtime']['worldEnvironmentPlanningVersion'], 1)
        self.assertEqual(result['runtime']['worldAgentObservationVersion'], 1)
        self.assertEqual(result['runtime']['worldActivationPlanningVersion'], 1)
        self.assertEqual(result['runtime']['worldLedgerBackend'], 'rust')
        self.assertEqual(result['runtime']['worldMotionBackend'], 'rust')
        self.assertEqual(result['runtime']['worldTasksBackend'], 'rust')
        self.assertEqual(result['runtime']['worldExecutionBackend'], 'rust')
        self.assertEqual(result['runtime']['worldActionsBackend'], 'rust')
        self.assertEqual(result['runtime']['worldPeerBackend'], 'rust')
        self.assertEqual(result['runtime']['worldReportsBackend'], 'rust')
        self.assertEqual(result['runtime']['worldDispatchBackend'], 'rust')
        self.assertEqual(result['runtime']['worldResourcesBackend'], 'rust')
        self.assertEqual(result['runtime']['worldPerceptionsBackend'], 'rust')
        self.assertEqual(result['runtime']['worldEnvironmentBackend'], 'rust')
        self.assertEqual(result['runtime']['worldRequestsBackend'], 'rust')
        self.assertEqual(result['runtime']['worldControlBackend'], 'rust')
        self.assertEqual(result['runtime']['worldRollbackVersion'], 1)
        self.assertEqual(result['runtime']['worldRouteVersion'], 1)
        self.assertEqual(result['runtime']['worldStationaryVersion'], 1)
        self.assertEqual(result['runtime']['worldWorkVersion'], 1)
        self.assertEqual(result['runtime']['worldActivationVersion'], 1)
        self.assertEqual(result['runtime']['worldLifecycleVersion'], 1)
        self.assertEqual(result['runtime']['worldAssignmentVersion'], 1)
        self.assertEqual(result['runtime']['worldInterruptionVersion'], 1)
        self.assertEqual(result['runtime']['worldRevocationVersion'], 1)
        self.assertEqual(result['runtime']['worldProposalVersion'], 1)
        self.assertEqual(result['runtime']['worldTimeVersion'], 1)
        self.assertEqual(result['runtime']['worldEndingVersion'], 1)
        self.assertEqual(result['runtime']['worldFinalizationVersion'], 1)
        self.assertEqual(result['runtime']['worldTaskEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldRouteEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldStationaryEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldLifecycleEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldActivationEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldPeerEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldReportEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldDispatchEventsVersion'], 1)
        self.assertEqual(result['runtime']['worldAutomaticDispatchVersion'], 1)
        self.assertEqual(result['runtime']['worldCollisionReplanVersion'], 1)
        self.assertNotIn('adminToken', result)
        self.assertNotIn('adminToken', result['runtime'])
        self.assertNotIn('environment', result['runtime'])
        result['runtime']['sourceSha256']['src/engine.js'] = 'b'*64
        self.assertEqual(self.runtime['sourceSha256']['src/engine.js'], 'a'*64)
        self.assertEqual(backend_profile(self.runtime), backend_profile(service))

    def test_foreign_session_and_changed_world_configuration_rejected(self):
        wrong = copy.deepcopy(self.session)
        wrong['sessionId'] = '44444444-4444-4444-8444-444444444444'
        with self.assertRaises(ValueError): capture_recording_context(wrong)
        with self.assertRaises(ValueError): capture_recording_context(self.session, {**self.runtime,'taskBackend':'rust'})
        with self.assertRaises(ValueError): capture_recording_context(self.session, {**self.runtime,'sourceSha256':{'src/engine.js':'b'*64}})

    def test_invalid_metadata_and_legacy(self):
        self.assertIsNone(capture_recording_context({'sessionId':self.sid}))
        for mutation in (lambda v:v.update(version=True), lambda v:v.update(runtime=None),
                         lambda v:v['runtime'].update(worldMotionBackend='gpu'),
                         lambda v:v['runtime'].update(worldTasksBackend='gpu'),
                         lambda v:v['runtime'].update(worldExecutionBackend='gpu'),
                         lambda v:v['runtime'].update(worldActionsBackend='gpu'),
                         lambda v:v['runtime'].update(worldRollbackVersion=True),
                         lambda v:v['runtime'].update(worldRollbackVersion=2),
                         lambda v:v['runtime'].update(worldRouteVersion=True),
                         lambda v:v['runtime'].update(worldRouteVersion=2),
                         lambda v:v['runtime'].update(worldStationaryVersion=True),
                         lambda v:v['runtime'].update(worldStationaryVersion=2),
                         lambda v:v['runtime'].update(worldWorkVersion=True),
                         lambda v:v['runtime'].update(worldWorkVersion=2),
                         lambda v:v['runtime'].update(worldActivationVersion=True),
                         lambda v:v['runtime'].update(worldActivationVersion=2),
                         lambda v:v['runtime'].update(worldLifecycleVersion=True),
                         lambda v:v['runtime'].update(worldLifecycleVersion=2),
                         lambda v:v['runtime'].update(worldAssignmentVersion=True),
                         lambda v:v['runtime'].update(worldAssignmentVersion=2),
                         lambda v:v['runtime'].update(worldInterruptionVersion=True),
                         lambda v:v['runtime'].update(worldInterruptionVersion=2),
                         lambda v:v['runtime'].update(worldRevocationVersion=True),
                         lambda v:v['runtime'].update(worldRevocationVersion=2),
                         lambda v:v['runtime'].update(worldProposalVersion=True),
                         lambda v:v['runtime'].update(worldProposalVersion=2),
                         lambda v:v['runtime'].update(worldTimeVersion=True),
                         lambda v:v['runtime'].update(worldTimeVersion=2),
                         lambda v:v['runtime'].update(worldEndingVersion=True),
                         lambda v:v['runtime'].update(worldEndingVersion=2),
                         lambda v:v['runtime'].update(worldFinalizationVersion=True),
                         lambda v:v['runtime'].update(worldFinalizationVersion=2),
                         lambda v:v['runtime'].update(worldTaskEventsVersion=True),
                         lambda v:v['runtime'].update(worldTaskEventsVersion=2),
                         lambda v:v['runtime'].update(worldRouteEventsVersion=True),
                         lambda v:v['runtime'].update(worldRouteEventsVersion=2),
                         lambda v:v['runtime'].update(worldStationaryEventsVersion=True),
                         lambda v:v['runtime'].update(worldStationaryEventsVersion=2),
                         lambda v:v['runtime'].update(worldLifecycleEventsVersion=True),
                         lambda v:v['runtime'].update(worldLifecycleEventsVersion=2),
                         lambda v:v['runtime'].update(worldActivationEventsVersion=True),
                         lambda v:v['runtime'].update(worldActivationEventsVersion=2),
                         lambda v:v['runtime'].update(worldPeerEventsVersion=True),
                         lambda v:v['runtime'].update(worldPeerEventsVersion=2),
                         lambda v:v['runtime'].update(worldReportEventsVersion=True),
                         lambda v:v['runtime'].update(worldReportEventsVersion=2),
                         lambda v:v['runtime'].update(worldDispatchEventsVersion=True),
                         lambda v:v['runtime'].update(worldDispatchEventsVersion=2),
                         lambda v:v['runtime'].update(worldAutomaticDispatchVersion=True),
                         lambda v:v['runtime'].update(worldAutomaticDispatchVersion=2),
                         lambda v:v['runtime'].update(worldAssignmentPlanningVersion=True),
                         lambda v:v['runtime'].update(worldAssignmentPlanningVersion=2),
                         lambda v:v['runtime'].update(worldEnvironmentPlanningVersion=True),
                         lambda v:v['runtime'].update(worldEnvironmentPlanningVersion=2),
                         lambda v:v['runtime'].update(worldActivationPlanningVersion=True),
                         lambda v:v['runtime'].update(worldActivationPlanningVersion=2),
                         lambda v:v['runtime'].update(worldCollisionReplanVersion=True),
                         lambda v:v['runtime'].update(worldCollisionReplanVersion=2),
                         lambda v:v['runtime'].update(sourceSha256={'../secret':'a'*64}),
                         lambda v:v.update(forkedFrom={'sessionId':self.sid,'revision':0})):
            value = copy.deepcopy(self.session)
            mutation(value['recordingContext'])
            with self.assertRaises(ValueError): capture_recording_context(value)

    def test_twenty_seed_order_and_explicit_overrides(self):
        rows = [execution_order('alternating', i) for i in range(20)]
        self.assertEqual(rows[:4], [['baseline','candidate'],['candidate','baseline']]*2)
        self.assertEqual(sum(row[0]=='baseline' for row in rows), 10)
        self.assertEqual(sum(row[0]=='candidate' for row in rows), 10)
        self.assertEqual(execution_order('baseline-first', 19), ['baseline','candidate'])
        self.assertEqual(execution_order('candidate-first', 0), ['candidate','baseline'])
        for mode,index in [('unknown',0),('alternating',-1),('alternating',True)]:
            with self.assertRaises(ValueError): execution_order(mode,index)


    def test_agent_observation_optional_version(self):
        for value in (True, False, 0, 2, "1", None):
            bad = copy.deepcopy(self.session)
            bad['recordingContext']['runtime']['worldAgentObservationVersion'] = value
            with self.assertRaises(ValueError): capture_recording_context(bad)
        old = copy.deepcopy(self.session)
        del old['recordingContext']['runtime']['worldAgentObservationVersion']
        self.assertNotIn('worldAgentObservationVersion', capture_recording_context(old)['runtime'])


class CoordinatorObservationMetadataTest(unittest.TestCase):
    def test_native_coordinator_observation_version(self):
        from box_agent.recording import normalize_runtime
        runtime = {'instanceId': '33333333-3333-4333-8333-333333333333',
                   'sourceSha256': {'src/engine.js': 'a' * 64},
                   'worldCoordinatorObservationVersion': 1}
        self.assertEqual(normalize_runtime(runtime)['worldCoordinatorObservationVersion'], 1)
        for value in (True, False, 0, 2, '1', None):
            with self.assertRaises(ValueError):
                normalize_runtime({**runtime, 'worldCoordinatorObservationVersion': value})
        del runtime['worldCoordinatorObservationVersion']
        self.assertNotIn('worldCoordinatorObservationVersion', normalize_runtime(runtime))


class TaskAdvanceMetadataTest(unittest.TestCase):
    def test_native_task_frame_version(self):
        from box_agent.recording import normalize_runtime
        runtime = {'instanceId': '33333333-3333-4333-8333-333333333333',
                   'sourceSha256': {'src/engine.js': 'a' * 64},
                   'worldTaskAdvanceVersion': 1}
        self.assertEqual(normalize_runtime(runtime)['worldTaskAdvanceVersion'], 1)
        for value in (True, False, 0, 2, '1', None):
            with self.assertRaises(ValueError):
                normalize_runtime({**runtime, 'worldTaskAdvanceVersion': value})
        del runtime['worldTaskAdvanceVersion']
        self.assertNotIn('worldTaskAdvanceVersion', normalize_runtime(runtime))


class ActionAdvanceMetadataTest(unittest.TestCase):
    def test_native_action_frame_version(self):
        from box_agent.recording import normalize_runtime
        runtime = {'instanceId': '33333333-3333-4333-8333-333333333333',
                   'sourceSha256': {'src/engine.js': 'a' * 64},
                   'worldActionAdvanceVersion': 1}
        self.assertEqual(normalize_runtime(runtime)['worldActionAdvanceVersion'], 1)
        for value in (True, False, 0, 2, '1', None):
            with self.assertRaises(ValueError):
                normalize_runtime({**runtime, 'worldActionAdvanceVersion': value})
        del runtime['worldActionAdvanceVersion']
        self.assertNotIn('worldActionAdvanceVersion', normalize_runtime(runtime))



class WorldAdvanceMetadataTest(unittest.TestCase):
    def test_native_world_frame_version(self):
        from box_agent.recording import normalize_runtime
        runtime = {'instanceId': '33333333-3333-4333-8333-333333333333',
                   'sourceSha256': {'src/engine.js': 'a' * 64},
                   'worldAdvanceVersion': 1}
        self.assertEqual(normalize_runtime(runtime)['worldAdvanceVersion'], 1)
        for value in (True, False, 0, 2, '1', None):
            with self.assertRaises(ValueError):
                normalize_runtime({**runtime, 'worldAdvanceVersion': value})
        del runtime['worldAdvanceVersion']
        self.assertNotIn('worldAdvanceVersion', normalize_runtime(runtime))



class WorldInitializationMetadataTest(unittest.TestCase):
    def test_native_initialization_version(self):
        from box_agent.recording import normalize_runtime
        runtime = {'instanceId': '33333333-3333-4333-8333-333333333333',
                   'sourceSha256': {'src/engine.js': 'a' * 64},
                   'worldInitializationVersion': 1}
        self.assertEqual(normalize_runtime(runtime)['worldInitializationVersion'], 1)
        for value in (True, False, 0, 2, '1', None):
            with self.assertRaises(ValueError):
                normalize_runtime({**runtime, 'worldInitializationVersion': value})
        del runtime['worldInitializationVersion']
        self.assertNotIn('worldInitializationVersion', normalize_runtime(runtime))


if __name__ == '__main__': unittest.main()
