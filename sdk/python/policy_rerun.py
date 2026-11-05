"""Rerun a local policy on recorded coordinator observations without advancing a world."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import time

from policy_coordinator import choose, PolicyError

MAX_REPORT_BYTES = 50 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def recorded_calls(report):
    if (not isinstance(report, dict) or report.get('format') != '3dbox-multiprocess-v1'
            or report.get('experiment') != 'asynchronous-policy-v1'
            or not isinstance(report.get('policyTrace'), list) or len(report['policyTrace']) > 3000
            or type(report.get('policyTraceTruncated')) is not bool):
        raise ValueError('report has no valid policy trace')
    calls = []
    for event in report['policyTrace']:
        if not isinstance(event, dict) or event.get('kind') not in ('start', 'result', 'submission') or type(event.get('call')) is not int:
            raise ValueError('invalid trace event')
        number = event['call']
        if event['kind'] == 'start':
            if number != len(calls) + 1 or number > 1000:
                raise ValueError('invalid call order')
            obs = event.get('observation')
            if (not isinstance(obs, dict) or type(obs.get('version')) is not int or obs['version'] not in (1, 2)
                    or type(obs.get('tick')) is not int or not 0 <= obs['tick'] <= 10000000
                    or not isinstance(obs.get('tasks'), list) or len(obs['tasks']) > 100):
                raise ValueError('invalid observation')
            for task in obs['tasks']:
                if (not isinstance(task, dict) or not isinstance(task.get('id'), str)
                        or not isinstance(task.get('candidates'), list) or len(task['candidates']) > 50
                        or any(not isinstance(a, dict) or not isinstance(a.get('id'), str) for a in task['candidates'])):
                    raise ValueError('invalid task candidates')
            if obs['version'] == 2 and (not isinstance(obs.get('evidence'), list) or len(obs['evidence']) > 1000
                    or any(not isinstance(e, dict) or type(e.get('id')) is not int for e in obs['evidence'])
                    or not isinstance(obs.get('knownTasks'), list) or len(obs['knownTasks']) > 1000):
                raise ValueError('invalid evidence or known tasks')
            revision = event.get('worldRevision')
            if revision is not None and (type(revision) is not int or revision < 0):
                raise ValueError('invalid world revision')
            calls.append({'call':number, 'observation':obs, 'worldRevision':revision, 'original':None, 'submitted':False})
        else:
            if number < 1 or number > len(calls):
                raise ValueError('trace event has no start')
            call = calls[number-1]
            if event['kind'] == 'result':
                if call['original'] is not None or call['submitted'] or ('choice' in event) == ('error' in event):
                    raise ValueError('invalid recorded result')
                if 'error' in event:
                    if not isinstance(event['error'], str) or len(event['error']) > 200:
                        raise ValueError('invalid recorded error')
                    call['original'] = {'kind':'error','error':event['error']}
                else:
                    choice = event['choice']
                    if choice is not None and not isinstance(choice, dict):
                        raise ValueError('invalid recorded choice')
                    call['original'] = {'kind':'choice','choice':choice}
            else:
                if call['original'] is None or call['submitted']:
                    raise ValueError('invalid recorded submission')
                call['submitted'] = True
    return calls


def selected_run(report, seed, condition):
    if not isinstance(report, dict):
        raise ValueError('invalid source report')
    if report.get('format') != '3dbox-policy-comparison-v1':
        if seed is not None or condition is not None:
            raise ValueError('pair selection requires a policy comparison report')
        return report, None
    config, pairs = report.get('config'), report.get('pairs')
    if seed is None or condition not in ('baseline','candidate'):
        raise ValueError('comparison report requires --pair-seed and --condition')
    if (not isinstance(config,dict) or type(config.get('startSeed')) is not int or type(config.get('count')) is not int
            or not 1 <= config['count'] <= 20 or not 0 <= config['startSeed'] <= 0xffffffff
            or config['startSeed'] + config['count'] - 1 > 0xffffffff or not isinstance(pairs,list)
            or len(pairs) != config['count'] or not config['startSeed'] <= seed < config['startSeed']+config['count']):
        raise ValueError('invalid comparison seed range')
    for index, pair in enumerate(pairs):
        if not isinstance(pair,dict) or type(pair.get('seed')) is not int or pair['seed'] != config['startSeed'] + index:
            raise ValueError('invalid comparison pairs')
    run = pairs[seed-config['startSeed']].get(condition)
    hashes = report.get('policySha256')
    if (not isinstance(run,dict) or not isinstance(run.get('config'),dict) or run['config'].get('seed') != seed
            or type(run['config'].get('seed')) is not int or not isinstance(config.get('sceneId'),str)
            or run['config'].get('sceneId') != config['sceneId'] or not isinstance(hashes,dict)
            or not isinstance(run.get('policySha256'),str) or len(run['policySha256']) != 64
            or any(ch not in '0123456789abcdef' for ch in run['policySha256'])
            or run['policySha256'] != hashes.get(condition)):
        raise ValueError('selected run does not match comparison')
    return run, {'seed':seed,'condition':condition}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='asynchronous policy report with --trace-decisions')
    parser.add_argument('--policy', type=Path, required=True, help='policy to run on each captured observation')
    parser.add_argument('--pair-seed', type=int, help='seed to select from a comparison report')
    parser.add_argument('--condition', choices=('baseline','candidate'), help='run to select from a comparison report')
    parser.add_argument('--max-calls', type=int, default=20, help='limit repeated policy process launches (1–100)')
    parser.add_argument('--timeout', type=float, default=5, help='per-call timeout in seconds')
    args = parser.parse_args()
    if not args.report.is_file() or args.report.stat().st_size > MAX_REPORT_BYTES or not args.policy.is_file() or not 1 <= args.max_calls <= 100 or not math.isfinite(args.timeout) or not .05 <= args.timeout <= 120:
        parser.error('invalid report, policy, call limit or timeout')
    raw = args.report.read_bytes()
    if len(raw) > MAX_REPORT_BYTES:
        parser.error('report too large')
    try:
        report = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('invalid numeric constant')))
        report, source_pair = selected_run(report, args.pair_seed, args.condition)
        calls = recorded_calls(report)
    except (ValueError, UnicodeDecodeError) as error:
        raise SystemExit(f'invalid report: {error}') from None
    if not calls:
        raise SystemExit('invalid report: no recorded observations')
    policy = args.policy.resolve()
    policy_hash = digest(policy.read_bytes())
    results = []
    for call in calls[:args.max_calls]:
        if digest(policy.read_bytes()) != policy_hash:
            raise SystemExit('policy file changed during rerun')
        started = time.monotonic()
        try:
            choice = choose(policy, call['observation'], args.timeout, call['observation']['version'])
            rerun = {'kind':'choice','choice':choice}
        except PolicyError as error:
            rerun = {'kind':'error','error':str(error)}
        except (KeyError, TypeError, ValueError):
            raise SystemExit('invalid report: malformed observation') from None
        elapsed = round((time.monotonic()-started)*1000, 3)
        original = call['original']
        comparison = ('rerun_error' if rerun['kind']=='error'
                      else 'original_unavailable' if original is None or original['kind']=='error'
                      else 'match' if original['choice']==rerun['choice'] else 'different')
        results.append({'call':call['call'],'tick':call['observation']['tick'],
                        'worldRevision':call['worldRevision'],'original':original,'rerun':rerun,
                        'elapsedMs':elapsed,'comparison':comparison})
        print(f"call {call['call']}: {comparison}", file=sys.stderr, flush=True)
    summary = {name:sum(r['comparison']==name for r in results) for name in ('match','different','original_unavailable','rerun_error')}
    print(json.dumps({'format':'3dbox-policy-rerun-v1','sourceReportSha256':digest(raw),
                      'sourcePair':source_pair, 'recordedPolicySha256':report.get('policySha256'), 'rerunPolicySha256':policy_hash,
                      'recordedModel':report.get('model'), 'rerunModel':(os_model() if policy.name=='openai_policy.py' and policy.parent==Path(__file__).resolve().parent else None),
                      'sourceTraceTruncated':report['policyTraceTruncated'], 'recordedCalls':len(calls),
                      'maxCalls':args.max_calls,'timeoutSeconds':args.timeout,'results':results,'summary':summary}, ensure_ascii=False, allow_nan=False, indent=2))


def os_model():
    import os
    return os.environ.get('OPENAI_MODEL') or None


if __name__ == '__main__':
    main()
