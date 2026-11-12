"""Run a replaceable local policy process against scoped coordinator observations."""
import argparse
from contextlib import ExitStack
import json
import math
import re
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from box_agent import CoordinatorClient, SandboxError
from box_agent.client import CONTROL_HTTP_ORIGIN


class PolicyError(Exception):
    pass


def policy_input(observation, protocol):
    data = {'version': protocol, 'tick': observation['tick'], 'tasks': observation['tasks']}
    if protocol == 2:
        data.update({'evidence': observation.get('evidence', []), 'knownTasks': observation.get('knownTasks', [])})
        if observation.get('fixedSensorReports'):
            data['fixedSensorReports'] = observation['fixedSensorReports']
        if observation.get('sampleReports'):
            data['sampleReports'] = observation['sampleReports']
    return data


class DecisionTrace:
    """Bounded opt-in trace of scoped inputs and validated outputs."""
    def __init__(self, enabled):
        self.enabled, self.bytes, self.truncated = enabled, 0, False

    def emit(self, event):
        if not self.enabled or self.truncated:
            return
        encoded = json.dumps(event, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        length = len(encoded.encode('utf-8')) + len('TRACE ') + 1
        if self.bytes + length > 1024 * 1024:
            print('TRACE {"kind":"truncated"}', flush=True)
            self.truncated = True
            return
        self.bytes += length
        print('TRACE ' + encoded, flush=True)


def choose(policy, observation, timeout, protocol=1, model_record=None):
    """Pass scoped task summaries and, in protocol 2, delivered evidence."""
    payload = json.dumps(policy_input(observation, protocol), ensure_ascii=False).encode()
    env = {key: value for key, value in os.environ.items() if not key.startswith('BOX_')}
    env.pop('SANDBOX_MODEL_TRACE_PATH', None)
    with tempfile.TemporaryDirectory(prefix='3dbox-model-trace-') as trace_dir, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        trace_file = Path(trace_dir)/'response.json'
        if model_record is not None and policy.resolve() == (Path(__file__).resolve().parent/'openai_policy.py').resolve():
            env['SANDBOX_MODEL_TRACE_PATH'] = str(trace_file)
        try:
            child = subprocess.run([sys.executable, str(policy)], input=payload, stdout=output, stderr=errors, env=env, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise PolicyError('policy_timeout') from None
        finally:
            if model_record is not None:
                try:
                    if trace_file.stat().st_size <= 150000:
                        record = json.loads(trace_file.read_text(encoding='utf-8'))
                        if (isinstance(record, dict) and isinstance(record.get('responseExcerpt'), str)
                                and len(record['responseExcerpt'].encode('utf-8')) <= 32768
                                and type(record.get('truncated')) is bool and type(record.get('apiKeyRedacted')) is bool
                                and (record.get('returnedModel') is None or isinstance(record['returnedModel'], str) and len(record['returnedModel']) <= 200)):
                            model_record.update(record)
                except (OSError, ValueError, UnicodeError):
                    pass
        if child.returncode != 0:
            reason = 'policy_failed'
            if policy.resolve() == (Path(__file__).resolve().parent/'openai_policy.py').resolve():
                errors.seek(0)
                raw_error = errors.read(4097)
                allowed = {'api_http_401','api_http_403','api_http_404','api_http_429','api_http_500','api_http_502','api_http_503','api_http_504','api_unavailable','api_refusal','api_incomplete','api_response_too_large','api_invalid_response','api_missing_output','choice_not_authorized','OPENAI_API_KEY_and_OPENAI_MODEL_required','invalid_api_key_format','unsupported_base_url','invalid_base_url','invalid_timeout'}
                text = raw_error.decode('utf-8',errors='replace').strip()
                prefix = '模型策略停止：'
                if len(raw_error)<=4096 and text.startswith(prefix) and text[len(prefix):] in allowed:
                    reason = 'model_' + text[len(prefix):]
            raise PolicyError(reason)
        output.seek(0)
        raw = output.read(65537)
        if len(raw) > 65536:
            raise PolicyError('policy_output_too_large')
    try:
        choice = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise PolicyError('policy_invalid_json') from None
    if choice is None:
        return None
    if protocol == 2 and isinstance(choice, dict) and {'type', 'task'} <= set(choice) <= {'type', 'task', 'evidenceId', 'sensorEvidenceId', 'sampleReportId'} and choice['type'] == 'propose_survey':
        task = choice['task']
        evidence_id = choice.get('evidenceId')
        if 'evidenceId' in choice and (type(evidence_id) is not int or not 1 <= evidence_id <= 1000 or not any(e['id'] == evidence_id for e in observation.get('evidence', []))):
            raise PolicyError('policy_evidence_not_in_observation')
        sensor_id = choice.get('sensorEvidenceId')
        if 'sensorEvidenceId' in choice and (type(sensor_id) is not int or sensor_id < 1 or not any(r.get('reportId') == sensor_id for r in observation.get('fixedSensorReports', [])) or 'evidenceId' in choice):
            raise PolicyError('policy_evidence_not_in_observation')
        sample_id = choice.get('sampleReportId')
        if 'sampleReportId' in choice and (type(sample_id) is not int or sample_id < 1 or not any(r.get('id') == sample_id for r in observation.get('sampleReports', []))):
            raise PolicyError('policy_evidence_not_in_observation')
        if sum(key in choice for key in ('evidenceId', 'sensorEvidenceId', 'sampleReportId')) > 1:
            raise PolicyError('policy_evidence_not_in_observation')
        required = {'id', 'name', 'role', 'target', 'duration'}
        optional = {'dependsOn', 'priority', 'deadline'}
        identifier = lambda value, length: isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,' + str(length) + r'}', value) is not None
        integer = lambda value, low, high: type(value) is int and low <= value <= high
        if not isinstance(task, dict) or not required <= set(task) or set(task) - required - optional:
            raise PolicyError('policy_invalid_proposal')
        deps = task.get('dependsOn', [])
        target = task['target']
        if (not identifier(task['id'], 64) or task['id'] in ('__proto__', 'constructor', 'prototype') or not isinstance(task['name'], str) or not task['name'].strip() or len(task['name']) > 100 or not identifier(task['role'], 48)
                or not isinstance(target, list) or len(target) != 2 or any(type(n) not in (int, float) or not 0 <= n <= 100 or not math.isfinite(n) for n in target)
                or not integer(task['duration'], 1, 1000) or not isinstance(deps, list) or len(deps) > 100 or any(not identifier(d, 64) for d in deps) or len(set(deps)) != len(deps)
                or 'priority' in task and not integer(task['priority'], 0, 100) or 'deadline' in task and not integer(task['deadline'], 1, 10000000)):
            raise PolicyError('policy_invalid_proposal')
        return choice
    if not isinstance(choice, dict) or set(choice) != {'taskId', 'agentId'} or not all(isinstance(choice[x], str) for x in ('taskId', 'agentId')):
        raise PolicyError('policy_invalid_choice')
    if not any(task['id'] == choice['taskId'] and any(agent['id'] == choice['agentId'] for agent in task['candidates']) for task in observation['tasks']):
        raise PolicyError('policy_choice_not_in_observation')
    return choice


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', type=Path, required=True, help='local Python policy script')
    parser.add_argument('--timeout', type=float, default=5)
    parser.add_argument('--grpc-target', help='use a local gRPC adapter host:port for coordinator requests')
    parser.add_argument('--grpc-observe-stream', action='store_true', help='use scoped gRPC observation stream')
    parser.add_argument('--observe-stream', action='store_true', help='use scoped coordinator WebSocket observations')
    parser.add_argument('--poll', type=float, default=.1)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--trace', action='store_true', help='emit bounded scoped observations and validated decisions')
    parser.add_argument('--trace-model-output', action='store_true', help='include bounded model response excerpt in decision trace')
    parser.add_argument('--protocol', choices=(1, 2), type=int, default=1)
    parser.add_argument('--reserve-agent', help='exclude this agent until it delivers evidence')
    parser.add_argument('--max-calls', type=int, default=100)
    parser.add_argument('--max-errors', type=int, default=3, help='stop after consecutive policy failures')
    parser.add_argument('--wait-seconds', type=float, default=1, help='minimum wait after the policy chooses no action')
    args = parser.parse_args()
    if args.grpc_observe_stream and (not args.grpc_target or args.observe_stream):
        parser.error('--grpc-observe-stream requires --grpc-target and cannot be combined with --observe-stream')
    if not args.policy.is_file() or not .05 <= args.timeout <= 120 or not .01 <= args.poll <= 60 or not 1 <= args.max_calls <= 1000 or not 1 <= args.max_errors <= 100 or not .1 <= args.wait_seconds <= 60:
        parser.error('invalid policy, timing, call limit or error limit')
    if args.trace_model_output and (not args.trace or args.protocol != 2 or args.policy.resolve() != (Path(__file__).resolve().parent/'openai_policy.py').resolve()):
        parser.error('--trace-model-output requires --trace, protocol 2 and the built-in OpenAI policy')
    if args.grpc_target:
        from box_agent.grpc_client import GrpcCoordinatorClient
        client = GrpcCoordinatorClient(os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'], args.grpc_target)
    else:
        client = CoordinatorClient(os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'], os.environ.get('BOX_URL', CONTROL_HTTP_ORIGIN))
    prefix = 'policy-' + uuid.uuid4().hex
    seq = 0
    calls = 0
    consecutive_errors = 0
    trace = DecisionTrace(args.trace)
    with ExitStack() as stack:
        if args.grpc_target:
            stack.callback(client.close)
        if args.grpc_observe_stream:
            from box_agent.grpc_observation_reader import GrpcObservationReader
            reader = stack.enter_context(GrpcObservationReader(client, os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'], None, args.grpc_target, args.poll, role='coordinator'))
        elif args.observe_stream:
            from box_agent.observation_reader import ObservationReader
            reader = stack.enter_context(ObservationReader(client, os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'], None, os.environ.get('BOX_WORLD_URL', os.environ.get('BOX_URL', 'http://127.0.0.1:8787')), args.poll, role='coordinator'))
        else:
            reader = client
        while True:
            obs = reader.observe()
            session_error = obs.get('sessionError') or obs.get('simulationError')
            if session_error in ('world_step_failed', 'journal_write_failed'):
                raise SandboxError(503, session_error)
            if obs['done']:
                print('实验已结束。', flush=True)
                return 1 if obs['failed'] else 0
            if args.reserve_agent and not any(e['agentId'] == args.reserve_agent for e in obs.get('evidence', [])):
                obs = {**obs, 'tasks': [{**task, 'candidates': [a for a in task['candidates'] if a['id'] != args.reserve_agent]} for task in obs['tasks']]}
            if not any(task['candidates'] for task in obs['tasks']) and not (args.protocol == 2 and (obs.get('evidence') or obs.get('fixedSensorReports') or obs.get('sampleReports'))):
                if args.once:
                    print('没有可分配任务。', flush=True)
                    return 0
                time.sleep(args.poll)
                continue
            if calls >= args.max_calls:
                print('策略调用达到上限。', flush=True)
                return 2
            calls += 1
            print(f'策略调用 {calls}', flush=True)
            trace.emit({'kind':'start','call':calls,'observation':policy_input(obs,args.protocol),**({'worldRevision':obs['worldRevision']} if type(obs.get('worldRevision')) is int and obs['worldRevision']>=0 else {})})
            started = time.monotonic()
            model_record = {} if args.trace_model_output else None
            try:
                choice = choose(args.policy, obs, args.timeout, args.protocol, model_record)
            except PolicyError as error:
                trace.emit({'kind':'result','call':calls,'elapsedMs':round((time.monotonic()-started)*1000,3),'error':str(error), **({'modelResponse':model_record} if model_record else {})})
                consecutive_errors += 1
                print(f'策略未产生有效决策：{error}', flush=True)
                if args.once:
                    return 1
                if consecutive_errors >= args.max_errors:
                    print('连续策略失败达到上限。', flush=True)
                    return 3
                time.sleep(max(args.poll, 1))
                continue
            trace.emit({'kind':'result','call':calls,'elapsedMs':round((time.monotonic()-started)*1000,3),'choice':choice, **({'modelResponse':model_record} if model_record else {})})
            consecutive_errors = 0
            if choice:
                seq += 1
                try:
                    if choice.get('type') == 'propose_survey':
                        task = choice['task']
                        result = client.propose_survey(f'{prefix}-{seq}', task['id'], task['name'], task['role'], task['target'], task['duration'], obs['tick'], task.get('dependsOn', []), task.get('priority'), task.get('deadline'), choice.get('evidenceId'), choice.get('sensorEvidenceId'), choice.get('sampleReportId'))['proposal']
                        kind = '提案'
                    else:
                        result = client.assign(f'{prefix}-{seq}', choice['taskId'], choice['agentId'], obs['tick'])['decision']
                        kind = '分配'
                except SandboxError as error:
                    if error.status != 409:
                        raise
                    trace.emit({'kind':'submission','call':calls,'status':'request_failed','reason':error.code})
                    print(f'策略提交失败：{error.code}', flush=True)
                    if args.once:
                        return 1
                    time.sleep(args.poll)
                    continue
                trace.emit({'kind':'submission','call':calls,'requestId':f'{prefix}-{seq}','status':result['status'],**({'reason':result['reason']} if result.get('reason') else {})})
                print(f"观察 T+{obs['tick']} {kind}：{result['status']} {result.get('reason', '')}", flush=True)
                if args.once:
                    return 0 if result['status'] in ('accepted', 'pending') else 1
            else:
                print('策略选择暂不分配。', flush=True)
                if args.once:
                    return 0
                time.sleep(max(args.poll, args.wait_seconds))
                continue
            time.sleep(args.poll)


def stop_on_signal(signum, frame):
    # Interrupt subprocess.run so it kills and waits for the direct policy child.
    raise SystemExit(128 + signum)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop_on_signal)
    try:
        raise SystemExit(main())
    except (KeyError, ValueError, SandboxError) as error:
        raise SystemExit(f'策略协调器停止：{error}')
