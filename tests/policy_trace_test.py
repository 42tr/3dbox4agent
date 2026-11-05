import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk/python'))
from policy_coordinator import DecisionTrace

class TraceTest(unittest.TestCase):
    def test_opt_in_and_limit(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            off = DecisionTrace(False)
            off.emit({'kind':'start','call':1,'observation':{'sensitive':'example'}})
            on = DecisionTrace(True)
            on.emit({'kind':'start','call':1,'observation':{'data':'a' * 100}})
            on.emit({'kind':'result','call':1,'data':'b' * (1024 * 1024)})
            on.emit({'kind':'start','call':2})
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0][6:])['kind'], 'start')
        self.assertEqual(json.loads(lines[1][6:]), {'kind':'truncated'})
        self.assertTrue(on.truncated)
        self.assertNotIn('sensitive', out.getvalue())

if __name__ == '__main__':
    unittest.main()
