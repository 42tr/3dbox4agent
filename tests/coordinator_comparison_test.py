import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'sdk/python'))
import coordinator_failover_compare as compare


class CoordinatorComparisonTests(unittest.TestCase):
    def test_changed_scene_stops_report(self):
        with tempfile.TemporaryDirectory() as folder:
            scene=Path(folder)/'scene.json'
            scene.write_text('{"id":"original"}',encoding='utf-8')
            run={'format':'3dbox-multiprocess-v1','status':'completed','config':{'seed':42},
                 'sourceSha256':{},'scene':{'id':'original'}}
            def mutate(*args,**kwargs):
                scene.write_text('{"id":"changed"}',encoding='utf-8')
                return SimpleNamespace(stdout=json.dumps(run).encode(),returncode=0)
            argv=['coordinator_failover_compare.py','--count','1','--scene-file',str(scene)]
            with patch.object(sys,'argv',argv), patch.object(compare,'urlopen',side_effect=lambda *a,**k:io.BytesIO(b'{"runtime":{"instanceId":"one"}}')), \
                 patch.object(compare.subprocess,'run',side_effect=mutate), \
                 contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError,'scene file changed'):
                    compare.main()
                self.assertEqual(output.getvalue(),'')

    def test_child_scene_hash_must_match_even_if_path_is_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            scene=Path(folder)/'scene.json'
            scene.write_text('{"id":"original"}',encoding='utf-8')
            run={'format':'3dbox-multiprocess-v1','status':'completed','config':{'seed':42,'sceneFileSha256':'0'*64},
                 'sourceSha256':{},'scene':{'id':'original'}}
            argv=['coordinator_failover_compare.py','--count','1','--scene-file',str(scene)]
            with patch.object(sys,'argv',argv), patch.object(compare,'urlopen',side_effect=lambda *a,**k:io.BytesIO(b'{"runtime":{"instanceId":"one"}}')), \
                 patch.object(compare.subprocess,'run',return_value=SimpleNamespace(stdout=json.dumps(run).encode(),returncode=0)), \
                 contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError,'scene file changed'):
                    compare.main()
                self.assertEqual(output.getvalue(),'')

    def test_same_tick_old_decisions_do_not_count_after_snapshot(self):
        run={'controlEvents':[{'kind':'coordinator_failure_detected','tick':4,'coordinatorIds':['node-1']},
                              {'kind':'coordinator_shards_reassigned','tick':4,'coordinatorIds':['node-2'],
                               'elapsedMs':3,'observedRevision':12,'priorDecisionIds':['old']}],
             'decisions':[{'requestId':'old','status':'accepted','coordinatorId':'node-2','submittedTick':4,'appliedTick':4},
                          {'requestId':'new','status':'accepted','coordinatorId':'node-2','submittedTick':4,'appliedTick':6}]}
        result=compare.recovery(run)
        self.assertEqual(result['firstAssignmentTick'],6)
        self.assertEqual(result['assignmentBasis'],'post_snapshot')
        run['decisions'].pop()
        self.assertIsNone(compare.recovery(run)['firstAssignmentTick'])
        del run['controlEvents'][1]['priorDecisionIds']
        self.assertEqual(compare.recovery(run)['firstAssignmentTick'],4)
        self.assertEqual(compare.recovery(run)['assignmentBasis'],'tick_only')

    def test_scene_file_must_be_json_object(self):
        with tempfile.TemporaryDirectory() as folder:
            scene=Path(folder)/'scene.json'
            scene.write_text('[]',encoding='utf-8')
            with patch.object(sys,'argv',['coordinator_failover_compare.py','--scene-file',str(scene)]), \
                 patch.object(compare,'urlopen') as health, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    compare.main()
                health.assert_not_called()

if __name__=='__main__':
    unittest.main()
