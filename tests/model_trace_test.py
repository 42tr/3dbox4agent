"""Bounded opt-in capture of model response payloads."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from openai_policy import save_response_trace


class ModelTraceTest(unittest.TestCase):
    def test_capture_redacts_and_truncates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'trace.json')
            body = json.dumps({'model':'snapshot-1', 'output':'密' * 20000, 'echo':'fake-secret'}, ensure_ascii=False).encode()
            with patch.dict(os.environ, {'SANDBOX_MODEL_TRACE_PATH':path}):
                save_response_trace(body, 'fake-secret')
            with open(path, encoding='utf-8') as stream:
                trace = json.load(stream)
            self.assertEqual(trace['returnedModel'], 'snapshot-1')
            self.assertTrue(trace['truncated'])
            self.assertTrue(trace['apiKeyRedacted'])
            self.assertLessEqual(len(trace['responseExcerpt'].encode()), 32768)
            self.assertNotIn('fake-secret', trace['responseExcerpt'])

    def test_capture_requires_explicit_trace_and_builtin_policy(self):
        command = [sys.executable, 'sdk/python/policy_experiment.py', '--policy',
                   'sdk/python/openai_policy.py', '--policy-protocol', '2', '--trace-model-output']
        run = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn('requires --trace-decisions', run.stderr)
        command = [sys.executable, 'sdk/python/policy_coordinator.py', '--policy',
                   'sdk/python/example_policy.py', '--protocol', '2', '--trace', '--trace-model-output']
        run = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn('built-in OpenAI policy', run.stderr)

    def test_pair_capture_requires_tracing_and_builtin_model(self):
        base = [sys.executable, 'sdk/python/policy_compare.py', '--candidate', 'sdk/python/openai_policy.py',
                '--protocol', '2', '--trace-archive-model-output']
        result = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('requires archived decision tracing', result.stderr)
        base = [sys.executable, 'sdk/python/policy_compare.py', '--candidate', 'sdk/python/example_policy.py',
                '--protocol', '2', '--archive-seed', '42', '--trace-archive-decisions', '--trace-archive-model-output']
        result = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('built-in OpenAI policy', result.stderr)

    def test_absent_or_invalid_destination_does_not_break_policy(self):
        with patch.dict(os.environ, {}, clear=True):
            save_response_trace(b'bad json', 'fake-secret')
        with patch.dict(os.environ, {'SANDBOX_MODEL_TRACE_PATH':'/nonexistent-dir/trace'}):
            save_response_trace(b'bad json', 'fake-secret')


if __name__ == '__main__':
    unittest.main()
