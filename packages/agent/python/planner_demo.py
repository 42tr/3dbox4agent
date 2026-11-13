"""Run local coordinator experiments with separate admin and coordinator credentials."""
import argparse
import json
import math
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from box_agent import CoordinatorClient
from box_agent.client import AgentClient
from box_agent.planner import plan

SCENES = ('industrial-park-v1', 'industrial-park-parallel-v1', 'lunar-base-v1', 'lunar-terrain-v1', 'lunar-sampling-v1', 'lunar-outpost-v1', 'shore-coordination-v1', 'shore-surface-v1','shore-sea-state-v1','shore-echelons-v1','shore-rescue-v1', 'industrial-park-fixed-sensor-v1', 'industrial-park-v2')


def nearest(observation):
    """Select one candidate from the first ready task, using only its authorized summary."""
    for task in sorted(observation['tasks'], key=lambda item: item['id']):
        if task['candidates']:
            tx, ty = task['target']
            candidate = min(task['candidates'], key=lambda a: (math.hypot(a['x']-tx, a['y']-ty), a['id']))
            return [{'taskId':task['id'], 'agentId':candidate['id']}]
    return []


def run_experiment(url, seed, scene, fault_tick, max_ticks, algorithm='planner'):
    if algorithm not in ('planner', 'nearest') or scene not in SCENES:
        raise ValueError('unknown algorithm or scene')
    if not 0 <= seed <= 0xffffffff or not 0 <= fault_tick <= max_ticks or not 1 <= max_ticks <= 10000:
        raise ValueError('invalid seed, fault tick or maximum ticks')
    AgentClient('_', '_', '_', url)  # Validate loopback origin before using an admin credential.
    base = url.rstrip('/')

    def request(path, method='GET', data=None, token=None):
        headers = {'content-type':'application/json'}
        if token:
            headers['authorization'] = 'Bearer ' + token
        payload = None if data is None else json.dumps(data).encode('utf-8')
        with urlopen(Request(base + path, data=payload, method=method, headers=headers), timeout=5) as response:
            return json.load(response)

    session = request('/sessions', 'POST', {'seed':seed, 'sceneId':scene, 'dispatchMode':'external'})
    root = '/sessions/' + session['sessionId']
    admin = session['adminToken']
    try:
        token = request(root + '/coordinator/credentials', 'POST', {}, admin)['coordinatorToken']
        coordinator = CoordinatorClient(session['sessionId'], token, url)
        sequence = 0
        fault_attempted = fault_injected = False
        fault_reason = None
        while True:
            observation = coordinator.observe()
            if observation['done'] or observation['tick'] >= max_ticks:
                break
            # Re-observe after every decision: both algorithms have the same interface and timing.
            choices = plan(observation) if algorithm == 'planner' else nearest(observation)
            if choices:
                sequence += 1
                selected = choices[0]
                coordinator.assign(f'demo-{sequence}', selected['taskId'], selected['agentId'], observation['tick'])
                continue
            state = request(root + '/step', 'POST', {'count':1}, admin)
            if fault_tick and state['world']['tick'] == fault_tick:
                fault_attempted = True
                try:
                    request(root + '/fault', 'POST', {}, admin)
                    fault_injected = True
                except HTTPError as error:
                    if error.code != 409:
                        raise
                    fault_reason = json.load(error).get('error', 'fault_rejected')
        state = request(root, token=admin)
        world = state['world']
        return {'config':{'seed':seed, 'sceneId':scene, 'faultTick':fault_tick, 'maxTicks':max_ticks,
                          'dispatchMode':'external', 'algorithm':algorithm}, 'seed':seed,
                'status':'failed' if world['failed'] else 'completed' if world['done'] else 'timeout',
                'faultAttempted':fault_attempted, 'faultInjected':fault_injected, 'faultReason':fault_reason,
                'metrics':state['metrics'], 'decisions':world['decisions'], 'events':world['events']}
    finally:
        request(root, 'DELETE', token=admin)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8787')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--scene', choices=SCENES, default=SCENES[0])
    parser.add_argument('--fault-tick', type=int, default=3, help='0 disables device fault injection')
    parser.add_argument('--max-ticks', type=int, default=1000)
    args = parser.parse_args()
    try:
        report = run_experiment(args.url, args.seed, args.scene, args.fault_tick, args.max_ticks)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'completed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
