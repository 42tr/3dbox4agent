import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk/python'))
import policy_compare


class RuntimeTests(unittest.TestCase):
    def test_service_change_after_first_run_rejects_comparison(self):
        run = {'format':'3dbox-multiprocess-v1','status':'completed','policySha256':'hash', 'sourceSha256':{}, 'scene':{'id':'test'}}
        argv = ['policy_compare.py', '--candidate', 'sdk/python/matching_policy.py', '--count', '1']
        states = [{'instanceId':'one'}, {'instanceId':'one'}, {'instanceId':'two'}]
        with patch.object(sys, 'argv', argv), patch.object(policy_compare, 'runtime', side_effect=states), \
             patch.object(policy_compare, 'digest', return_value='hash'), \
             patch.object(policy_compare.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps(run).encode(), returncode=0)) as child, \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'world service changed'):
                policy_compare.main()
            self.assertEqual(child.call_count, 1)
            self.assertEqual(out.getvalue(), '')

    def test_pair_differences_require_both_faults_when_requested(self):
        def run(injected, ticks):
            return {'status':'completed', 'faultAttempted':injected, 'faultInjected':injected,
                    'metrics':{'ticks':ticks, 'energyUsed':ticks}}
        pairs = [{'baseline':run(True,10), 'candidate':run(False,20)},
                 {'baseline':run(True,12), 'candidate':run(True,18)}]
        groups, paired = policy_compare.summarize(pairs, fault_tick=3)
        self.assertEqual(paired['bothCompleted'], 1)
        self.assertEqual(paired['tickDifference']['mean'], 6)
        self.assertEqual(groups[1]['completed'], 2)
        self.assertEqual(groups[1]['faultsInjected'], 1)
        self.assertEqual(policy_compare.summarize(pairs, fault_tick=0)[1]['bothCompleted'], 2)

    def test_pair_differences_require_observed_command_interruption(self):
        def run(observed, ticks):
            return {'status':'completed', 'commandOutage':{'attempted':True,'injected':True,'observed':observed},
                    'metrics':{'ticks':ticks,'energyUsed':ticks}}
        pairs = [{'baseline':run(True,10),'candidate':run(False,20)},
                 {'baseline':run(True,12),'candidate':run(True,18)}]
        groups, paired = policy_compare.summarize(pairs, command_outage_duration=50)
        self.assertEqual(paired['bothCompleted'], 1)
        self.assertEqual(paired['tickDifference']['mean'], 6)
        self.assertEqual(groups[1]['outagesInjected'], 2)
        self.assertEqual(groups[1]['outagesObserved'], 1)

    def test_changed_scene_file_rejects_comparison(self):
        with tempfile.TemporaryDirectory() as folder:
            scene = Path(folder) / 'scene.json'
            scene.write_text('{"id":"original"}', encoding='utf-8')
            policy = Path('sdk/python/matching_policy.py')
            run = {'format':'3dbox-multiprocess-v1','status':'completed',
                   'policySha256':policy_compare.digest(policy),'sourceSha256':{},'scene':{'id':'original'}}
            def alter_scene(*_args, **_kwargs):
                scene.write_text('{"id":"changed"}', encoding='utf-8')
                return SimpleNamespace(stdout=json.dumps(run).encode(), returncode=0)
            argv = ['policy_compare.py','--baseline',str(policy),'--candidate',str(policy),'--count','1','--scene-file',str(scene)]
            with patch.object(sys, 'argv', argv), patch.object(policy_compare, 'runtime', return_value={'instanceId':'one'}), \
                 patch.object(policy_compare.subprocess, 'run', side_effect=alter_scene), \
                 contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'scene file changed'):
                    policy_compare.main()
                self.assertEqual(output.getvalue(), '')

    def test_child_scene_hash_must_match_even_if_path_is_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            scene = Path(folder) / 'scene.json'
            scene.write_text('{"id":"original"}', encoding='utf-8')
            policy = Path('sdk/python/matching_policy.py')
            run = {'format':'3dbox-multiprocess-v1','status':'completed',
                   'policySha256':policy_compare.digest(policy),'sourceSha256':{},
                   'config':{'sceneFileSha256':'0'*64},'scene':{'id':'original'}}
            argv = ['policy_compare.py','--baseline',str(policy),'--candidate',str(policy),'--count','1','--scene-file',str(scene)]
            with patch.object(sys,'argv',argv), patch.object(policy_compare,'runtime',return_value={'instanceId':'one'}), \
                 patch.object(policy_compare.subprocess,'run',return_value=SimpleNamespace(stdout=json.dumps(run).encode(),returncode=0)), \
                 contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'scene file changed'):
                    policy_compare.main()
                self.assertEqual(output.getvalue(), '')

    def test_outcomes_include_partial_and_failed_runs(self):
        def run(completed, total, deadline_tasks, missed, status):
            return {'status':status, 'metrics':{'completed':completed,'total':total,
                    'deadlineTasks':deadline_tasks,'deadlineMissed':missed}}
        pairs = [{'baseline':run(1,4,2,1,'timeout'), 'candidate':run(4,4,2,0,'completed')},
                 {'baseline':run(0,4,2,2,'failed'), 'candidate':run(4,4,2,1,'completed')}]
        baseline, candidate = policy_compare.outcome_summary(pairs)
        self.assertEqual(baseline['measuredRuns'], 2)
        self.assertEqual(baseline['taskCompletionRatio']['mean'], .125)
        self.assertEqual(baseline['deadlineMissed'], 3)
        self.assertEqual(baseline['runsWithMissedDeadline'], 2)
        self.assertEqual(candidate['deadlineTasks'], 4)

    def test_delivery_summary_includes_failed_runs_and_ignores_missing(self):
        def run(status, delivery):
            return {'status':status, 'metrics':{'deliveryTravel':delivery}}
        values = {'emptyDistance':8, 'loadedDistance':12, 'emptyTicks':4, 'loadedTicks':6}
        pairs = [{'baseline':run('failed', values), 'candidate':run('completed', None)},
                 {'baseline':run('timeout', None), 'candidate':run('completed', values)}]
        baseline, candidate = policy_compare.delivery_summary(pairs)
        self.assertEqual(baseline['measuredRuns'], 1)
        self.assertEqual(baseline['emptyDistance']['mean'], 8)
        self.assertEqual(candidate['loadedTicks']['mean'], 6)

    def test_non_loopback_rejected_before_health_request(self):
        argv = ['policy_compare.py', '--candidate', 'sdk/python/matching_policy.py', '--url', 'http://example.com']
        with patch.object(sys, 'argv', argv), patch.object(policy_compare, 'runtime') as health:
            with self.assertRaisesRegex(ValueError, 'loopback'):
                policy_compare.main()
            health.assert_not_called()


if __name__ == '__main__':
    unittest.main()
