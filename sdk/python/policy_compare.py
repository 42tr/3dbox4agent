"""Compare two scoped asynchronous policies under paired seeds and equal settings."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from statistics import mean, stdev
from urllib.request import urlopen

from box_agent import AgentClient
from box_agent.recording import capture_recording_context

from planner_demo import SCENES
from scene_input import load_scene_file

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime(base_url):
    with urlopen(base_url.rstrip('/') + '/health', timeout=10) as response:
        try:
            health = json.load(response)
            info = health.get('runtime')
            if not health.get('ok') or not isinstance(info, dict) or not isinstance(info.get('instanceId'), str) or not info['instanceId']:
                raise ValueError()
            return info
        except (ValueError, AttributeError, TypeError):
            raise RuntimeError('world service lacks runtime metadata') from None


def execution_order(mode, index):
    if mode not in ('alternating', 'baseline-first', 'candidate-first') or type(index) is not int or index < 0:
        raise ValueError('invalid execution order')
    first = 'candidate' if mode == 'candidate-first' or mode == 'alternating' and index % 2 else 'baseline'
    return [first, 'baseline' if first == 'candidate' else 'candidate']


def stats(values):
    return {'n': len(values), 'mean': mean(values) if values else None,
            'sd': stdev(values) if len(values) > 1 else 0 if values else None}


def summarize(pairs, fault_tick=0, command_outage_duration=0):
    groups = []
    for name in ('baseline', 'candidate'):
        runs = [p[name] for p in pairs]
        done = [r for r in runs if r['status'] == 'completed']
        groups.append({'policy': name, 'runs': len(runs), 'completed': len(done),
                       'failed': sum(r['status'] == 'failed' for r in runs),
                       'timedOut': sum(r['status'] == 'timeout' for r in runs),
                       'faultsAttempted':sum(r.get('faultAttempted', False) for r in runs),
                       'faultsInjected':sum(r.get('faultInjected', False) for r in runs),
                       'outageAttempts':sum(r.get('commandOutage', {}).get('attempted', False) for r in runs),
                       'outagesInjected':sum(r.get('commandOutage', {}).get('injected', False) for r in runs),
                       'outagesObserved':sum(r.get('commandOutage', {}).get('observed', False) for r in runs),
                       'completionTicks': stats([r['metrics']['ticks'] for r in done]),
                       'energy': stats([r['metrics']['energyUsed'] for r in done])})
    done = [p for p in pairs if all(p[name]['status'] == 'completed' and (not fault_tick or p[name].get('faultInjected')) and (not command_outage_duration or p[name].get('commandOutage', {}).get('observed')) for name in ('baseline', 'candidate'))]
    return groups, {'bothCompleted': len(done),
                    'tickDifference': stats([p['candidate']['metrics']['ticks'] - p['baseline']['metrics']['ticks'] for p in done]),
                    'energyDifference': stats([p['candidate']['metrics']['energyUsed'] - p['baseline']['metrics']['energyUsed'] for p in done])}


def delivery_summary(pairs):
    result = []
    for policy in ('baseline', 'candidate'):
        values = [p[policy]['metrics'].get('deliveryTravel') for p in pairs]
        values = [v for v in values if v is not None]
        row = {'policy':policy, 'measuredRuns':len(values)}
        for key in ('emptyDistance','loadedDistance','emptyTicks','loadedTicks'):
            row[key] = stats([v[key] for v in values])
        result.append(row)
    return result


def activity_summary(pairs, scene):
    result = []
    for policy in ('baseline', 'candidate'):
        values = [p[policy]['metrics'].get('activity') for p in pairs]
        values = [a for a in values if a is not None]
        row = {'policy':policy, 'measuredRuns':len(values),
               'availabilityRatio':stats([a['availabilityRatio'] for a in values if a['availabilityRatio'] is not None]),
               'activeRatio':stats([a['activeRatio'] for a in values if a['activeRatio'] is not None]),
               'waitingTicks':stats([a['taskWaiting']+a['chargeWaiting'] for a in values]),
               'unavailableTicks':stats([a['unavailable'] for a in values]), 'roles':[]}
        for spec in scene['agents']:
            entries = [role for a in values for role in a['byRole'] if role['role']==spec['role']]
            row['roles'].append({'role':spec['role'], 'agents':spec['count'],
                                 'spreadTicks':stats([r['maxActiveTicks']-r['minActiveTicks'] for r in entries])})
        result.append(row)
    return result


def outcome_summary(pairs):
    result = []
    for policy in ('baseline', 'candidate'):
        metrics = [p[policy]['metrics'] for p in pairs]
        measured = [m for m in metrics if all(type(m.get(k)) is int for k in ('completed','total','deadlineTasks','deadlineMissed')) and m['total'] > 0]
        result.append({'policy':policy, 'measuredRuns':len(measured),
                       'taskCompletionRatio':stats([m['completed']/m['total'] for m in measured]),
                       'deadlineTasks':sum(m['deadlineTasks'] for m in measured),
                       'deadlineMissed':sum(m['deadlineMissed'] for m in measured),
                       'runsWithMissedDeadline':sum(m['deadlineMissed']>0 for m in measured)})
    return result


def communication_summary(pairs):
    result = []
    for policy in ('baseline', 'candidate'):
        runs = [pair[policy] for pair in pairs if pair[policy]['config']['dispatchMode'] in ('networked_external', 'networked_reported')]
        measured = [r for r in runs if all(isinstance(r['metrics'].get(k), int) for k in ('dispatchSent', 'dispatchDelivered', 'dispatchFailed'))]
        samples = []
        for r in measured:
            m = r['metrics']
            samples.append({'sent':m['dispatchSent'], 'delivered':m['dispatchDelivered'],
                            'failed':m['dispatchFailed'], 'pending':m['dispatchSent']-m['dispatchDelivered']-m['dispatchFailed'],
                            'interrupted':sum(e.get('kind')=='dispatch_failed' and e.get('reason')=='interrupted' for e in r['events'])})
        row = {'policy':policy, 'measuredRuns':len(samples)}
        for key in ('sent','delivered','failed','pending','interrupted'):
            values = [sample[key] for sample in samples]
            row[key] = {'total':sum(values),'perRun':stats(values)}
        result.append(row)
    return result


def recovery_summary(pairs):
    result = []
    for policy in ('baseline', 'candidate'):
        runs = [pair[policy] for pair in pairs]
        records = [record for run in runs if run.get('recoveryEventsVersion') == 1
                   for record in (run['metrics'].get('faultRecovery') or {}).get('records', [])]
        row = {'policy': policy, 'measuredRuns': sum(r.get('recoveryEventsVersion') == 1 for r in runs),
               'faults': len(records), 'reassigned': sum(r['assignedTick'] is not None for r in records),
               'started': sum(r['startedTick'] is not None for r in records),
               'completed': sum(r['completedTick'] is not None for r in records)}
        for key in ('assignmentDelay', 'startDelay', 'completionDelay'):
            row[key] = stats([r[key] for r in records if r[key] is not None])
        result.append(row)
    return result


def safety_summary(pairs):
    definitions = {
        'collisionContacts': ('collisionContacts', 'physicsMode', 'rapier'),
        'energyDepletions': ('energyDepletions', None, None),
        'boundaryInterventions': ('boundaryInterventions', 'boundaryMonitoringVersion', 1),
        'footprintBoundaryExits': ('footprintBoundaryExits', 'footprintMonitoringVersion', 1),
        'riskZoneEntriesV1': ('riskZoneEntries', 'riskMonitoringVersion', 1),
        'riskZoneEntriesV2': ('riskZoneEntries', 'riskMonitoringVersion', 2),
    }
    result = []
    for policy in ('baseline', 'candidate'):
        runs = [pair[policy] for pair in pairs]
        row = {'policy': policy}
        for name, (metric, version, expected) in definitions.items():
            values = [r['metrics'][metric] for r in runs
                      if (version is None or (r['config'].get(version) if version == 'physicsMode' else r.get(version)) == expected)
                      and r['metrics'].get(metric) is not None]
            row[name] = {'runs': len(values), 'runsWithEvents': sum(x > 0 for x in values),
                         'events': sum(values), 'perRun': stats(values)}
        result.append(row)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, default=HERE/'nearest_policy.py')
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--url', default='http://127.0.0.1:8787')
    parser.add_argument('--count', type=int, default=2)
    parser.add_argument('--order', choices=('alternating','baseline-first','candidate-first'), default='alternating')
    parser.add_argument('--require-recording-context', action='store_true', help='require session-bound world runtime metadata in every run')
    parser.add_argument('--start-seed', type=int, default=42)
    scene_choice = parser.add_mutually_exclusive_group()
    scene_choice.add_argument('--scene', choices=SCENES, default='industrial-park-parallel-v1')
    scene_choice.add_argument('--scene-file', type=Path, help='local scene JSON or YAML, at most 60 KB')
    parser.add_argument('--speed', type=int, choices=(1, 2, 5), default=2)
    parser.add_argument('--physics', choices=('kinematic','rapier'), default='kinematic')
    parser.add_argument('--dispatch', choices=('external', 'networked_external', 'networked_reported'), default='external')
    parser.add_argument('--link-profile', choices=('default', 'long'), default='default')
    parser.add_argument('--protocol', type=int, choices=(1, 2), default=1)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--policy-timeout', type=float, default=5)
    parser.add_argument('--max-ticks', type=int, default=1000)
    parser.add_argument('--fault-tick', type=int, default=0, help='inject a device failure when an active task is observed after this tick')
    parser.add_argument('--command-outage-duration', type=int, default=0, help='interrupt first observed in-flight external command')
    parser.add_argument('--max-policy-calls', type=int, default=30)
    parser.add_argument('--max-policy-errors', type=int, default=3)
    parser.add_argument('--archive-seed', type=int, help='save both run histories for this seed')
    parser.add_argument('--archive-dir', type=Path, help='new private directory for every full run, never overwritten')
    parser.add_argument('--trace-all-decisions', action='store_true', help='record scoped decisions for every external run file; requires --archive-dir')
    parser.add_argument('--trace-archive-decisions', action='store_true', help='also record scoped policy decisions for the archived runs')
    parser.add_argument('--trace-archive-model-output', action='store_true', help='include bounded OpenAI response excerpts for archived built-in model policies')
    args = parser.parse_args()
    if not all(p.is_file() for p in (args.baseline, args.candidate)) or not 1 <= args.count <= 20 or not 0 <= args.start_seed <= 0xffffffff or args.start_seed + args.count - 1 > 0xffffffff or not 1 <= args.timeout <= 300 or not .05 <= args.policy_timeout <= 120 or not 1 <= args.max_ticks <= 10000 or not 1 <= args.max_policy_calls <= 1000 or not 1 <= args.max_policy_errors <= 100 or not 0 <= args.fault_tick <= args.max_ticks or (args.archive_seed is not None and not args.start_seed <= args.archive_seed < args.start_seed + args.count) or (args.trace_archive_decisions and args.archive_seed is None):
        parser.error('invalid policy, seed, count or experiment limits')
    if not 0 <= args.command_outage_duration <= 1000 or (args.command_outage_duration and args.dispatch not in ('networked_external','networked_reported')):
        parser.error('--command-outage-duration requires simulated network dispatch')
    if args.archive_dir is not None and args.archive_dir.exists():
        parser.error('--archive-dir already exists')
    if args.trace_all_decisions and args.archive_dir is None:
        parser.error('--trace-all-decisions requires --archive-dir')
    builtin_model = (HERE/'openai_policy.py').resolve()
    model_conditions = [name for name,path in (('baseline',args.baseline),('candidate',args.candidate)) if path.resolve()==builtin_model]
    if args.trace_archive_model_output and (not args.trace_archive_decisions or args.protocol != 2 or not model_conditions):
        parser.error('--trace-archive-model-output requires archived decision tracing, protocol 2 and a built-in OpenAI policy')
    if not args.trace_archive_model_output:
        model_conditions = []
    scene_hash = None
    if args.scene_file is not None:
        try:
            _, scene_hash = load_scene_file(args.scene_file)
        except (OSError, ValueError, UnicodeDecodeError) as error:
            parser.error(f'invalid scene file: {error}')
    AgentClient('_', '_', '_', args.url)
    server_runtime = runtime(args.url)
    policies = {'baseline': args.baseline.resolve(), 'candidate': args.candidate.resolve()}
    hashes = {name: digest(path) for name, path in policies.items()}
    comparison_hash = digest(Path(__file__))
    if args.archive_dir is not None:
        args.archive_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    pairs, source_hashes, experiment_scene = [], None, None
    for seed in range(args.start_seed, args.start_seed + args.count):
        order = execution_order(args.order, seed - args.start_seed)
        pair = {'seed': seed, 'executionOrder': order}
        for name in order:
            policy = policies[name]
            print(f'seed {seed}: {name}', file=sys.stderr, flush=True)
            if digest(Path(__file__)) != comparison_hash:
                raise RuntimeError('comparison source changed during experiment')
            if runtime(args.url) != server_runtime:
                raise RuntimeError('world service changed during comparison')
            if args.scene_file is not None and digest(args.scene_file) != scene_hash:
                raise RuntimeError('scene file changed during comparison')
            if digest(policy) != hashes[name]:
                raise RuntimeError('policy file changed during comparison')
            cmd = [sys.executable, str(HERE/'policy_experiment.py'), '--url', args.url, '--policy', str(policy),
                   *(['--scene-file', str(args.scene_file)] if args.scene_file is not None else ['--scene', args.scene]), '--seed', str(seed), '--speed', str(args.speed), '--physics', args.physics, '--dispatch', args.dispatch,
                   '--link-profile', args.link_profile, '--policy-protocol', str(args.protocol), '--timeout', str(args.timeout),
                   '--policy-timeout', str(args.policy_timeout), '--max-ticks', str(args.max_ticks),
                   '--max-policy-calls', str(args.max_policy_calls), '--max-policy-errors', str(args.max_policy_errors), '--fault-tick', str(args.fault_tick), '--command-outage-duration', str(args.command_outage_duration)]
            if seed == args.archive_seed or args.archive_dir is not None:
                cmd.append('--archive')
                if args.trace_all_decisions or seed == args.archive_seed and args.trace_archive_decisions:
                    cmd.append('--trace-decisions')
                if seed == args.archive_seed and name in model_conditions:
                    cmd.append('--trace-model-output')
            child = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                run = json.loads(child.stdout)
                if child.returncode not in (0, 1) or run['format'] != '3dbox-multiprocess-v1' or run['policySha256'] != hashes[name] or (child.returncode == 0) != (run['status'] == 'completed'):
                    raise ValueError()
                if args.scene_file is not None and run.get('config', {}).get('sceneFileSha256') != scene_hash:
                    raise RuntimeError('scene file changed during comparison')
                if source_hashes is not None and source_hashes != run['sourceSha256']:
                    raise RuntimeError('experiment sources changed during comparison')
                context = capture_recording_context({'sessionId':run.get('sourceSessionId'), **({'recordingContext':run['recordingContext']} if 'recordingContext' in run else {})}, server_runtime)
                if args.require_recording_context and context is None:
                    raise RuntimeError('experiment lacks session-bound recording context')
                if context is not None:
                    run['recordingContext'] = context
                    if 'archive' in run and run['archive'].get('recordingContext') != context:
                        raise RuntimeError('archive recording context differs from run')
                source_hashes = run['sourceSha256']
                if experiment_scene is not None and run['scene'] != experiment_scene:
                    raise RuntimeError('scene changed during comparison')
                experiment_scene = run['scene']
            except (ValueError, KeyError, TypeError):
                raise RuntimeError('experiment process failed without a valid report') from None
            if runtime(args.url) != server_runtime:
                raise RuntimeError('world service changed during comparison')
            if args.scene_file is not None and digest(args.scene_file) != scene_hash:
                raise RuntimeError('scene file changed during comparison')
            if args.archive_dir is not None:
                payload = json.dumps(run, ensure_ascii=False, separators=(',',':'), allow_nan=False).encode('utf-8')
                if len(payload) > 50*1024*1024:
                    raise RuntimeError('external run exceeds replay file limit')
                filename = f'seed-{seed}-{name}.json'
                with os.fdopen(os.open(args.archive_dir/filename, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'wb') as saved:
                    saved.write(payload)
                run['externalRun'] = {'file':filename, 'sha256':hashlib.sha256(payload).hexdigest(), 'bytes':len(payload)}
                if seed != args.archive_seed:
                    for key in ('archive','policyTrace'):
                        run.pop(key, None)
            pair[name] = run
        pairs.append(pair)
    if digest(Path(__file__)) != comparison_hash:
        raise RuntimeError('comparison source changed during experiment')
    summary, paired = summarize(pairs, args.fault_tick, args.command_outage_duration)
    print(json.dumps({'format': '3dbox-policy-comparison-v1',
        'config': {'count': args.count, 'startSeed': args.start_seed, 'executionOrder':args.order, 'requireRecordingContext':args.require_recording_context, 'externalArchives':args.archive_dir is not None, 'traceAllDecisions':args.trace_all_decisions, 'sceneId': experiment_scene['id'], 'scene':experiment_scene, 'sceneFileSha256':scene_hash,
                   'speed': args.speed, 'dispatchMode': args.dispatch, 'linkProfile': args.link_profile,
                   'policyProtocol': args.protocol, 'maxTicks': args.max_ticks, 'wallTimeoutSeconds': args.timeout,
                   'policyTimeoutSeconds': args.policy_timeout, 'maxPolicyCalls': args.max_policy_calls,
                   'maxPolicyErrors': args.max_policy_errors, 'physicsMode': args.physics,
                   'archiveSeed': args.archive_seed, 'traceArchiveDecisions': args.trace_archive_decisions, 'traceArchiveModelOutput': args.trace_archive_model_output, 'modelTraceConditions':model_conditions, 'faultTick': args.fault_tick, 'commandOutageDuration':args.command_outage_duration},
        'serverRuntime': server_runtime, 'comparisonSha256': comparison_hash, 'policySha256': hashes, 'sourceSha256': source_hashes, 'safetySummary': safety_summary(pairs), 'outcomeSummary': outcome_summary(pairs), 'activitySummary': activity_summary(pairs, experiment_scene), 'deliverySummary':delivery_summary(pairs), 'communicationSummary': communication_summary(pairs), 'recoverySummary': recovery_summary(pairs), 'summary': summary, 'paired': paired, 'pairs': pairs}, ensure_ascii=False, indent=None if args.archive_seed is not None else 2, separators=(',',':') if args.archive_seed is not None else None))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f'comparison failed: {error}', file=sys.stderr)
        raise SystemExit(1)
