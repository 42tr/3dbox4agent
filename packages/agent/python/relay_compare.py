"""Compare direct and relayed peer messages in independent world-service sessions."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from box_agent import AgentClient
from scene_input import load_scene_file
from link_compare import fetch_scene, request, runtime
from planner_demo import SCENES


def run_one(base, scene, seed, policy, physics, sender, recipient, relay, side, max_ticks, capture):
    created = request(base, '/sessions', 'POST', {'scene': scene, 'sceneId': scene['id'], 'seed': seed,
                      'policy': policy, 'physicsMode': physics, 'dispatchMode': 'rule', 'executionMode': 'auto'})
    root, token = '/sessions/' + created['sessionId'], created['adminToken']
    try:
        if created['scene'] != scene:
            raise RuntimeError('world service changed requested scene')
        initial = created['world']
        initial_hash = hashlib.sha256(json.dumps(initial, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        ids = {a['id'] for a in initial['agents']}
        if len({sender, recipient, relay}) != 3 or not {sender, recipient, relay} <= ids:
            raise ValueError('select three different devices in the scene')
        state = request(base, root + '/message', 'POST', {'from': sender, 'to': recipient,
                        'text': 'relay-test', 'via': [relay] if side == 'relay' else []}, token)
        message_id = state['messageId']
        while True:
            world = state['world']
            relevant = [e for e in world['events'] if e.get('messageId') == message_id]
            terminal = next((e for e in relevant if e['kind'] in ('message_delivered', 'message_failed')), None)
            if terminal or world['done'] or world['tick'] >= max_ticks:
                break
            state = request(base, root + '/step', 'POST', {'count': 1}, token)
        outcome = {'status': ('delivered' if terminal['kind'] == 'message_delivered' else 'failed') if terminal else 'pending',
                   'reason': terminal.get('reason') if terminal else None,
                   'elapsedTicks': terminal['tick'] if terminal else world['tick'],
                   'successfulHops': sum(e['kind'] == 'message_relayed' for e in relevant) + int(bool(terminal and terminal['kind'] == 'message_delivered'))}
        result = {'initialStateSha256': initial_hash, 'outcome': outcome, 'messageEvents': relevant}
        archive = None
        if capture:
            history = request(base, root + '/history?after=-1', token=token)
            frames = history['frames']
            first, last = frames[0]['revision'], frames[-1]['revision']
            if [x['revision'] for x in frames] != list(range(first, last + 1)) or frames[-1]['world'] != world:
                raise RuntimeError('inconsistent retained history')
            archive = {'format': '3dbox-prototype-v1', 'source': 'server',
                       'coverage': {'start': 'partial' if history['truncated'] else 'complete',
                                    'end': 'finished' if world['done'] else 'unfinished', 'revisionRange': [first, last]},
                       'config': {'seed': seed, 'policy': policy, 'sceneId': scene['id'], 'scene': scene},
                       'frames': [x['world'] for x in frames]}
        return result, archive
    finally:
        request(base, root, 'DELETE', token=token)


def summarize(pairs):
    summary = {'count': len(pairs), 'bothDelivered': 0, 'directOnly': 0, 'relayOnly': 0, 'neitherDelivered': 0}
    for pair in pairs:
        direct = pair['direct']['outcome']['status'] == 'delivered'
        relay = pair['relay']['outcome']['status'] == 'delivered'
        summary['bothDelivered' if direct and relay else 'directOnly' if direct else 'relayOnly' if relay else 'neitherDelivered'] += 1
    summary['deliveryDifference'] = (summary['relayOnly'] - summary['directOnly']) / len(pairs)
    return summary


def load_scene(base, path):
    scene, scene_hash = load_scene_file(path, max_bytes=60 * 1024)
    created = request(base, '/sessions', 'POST', {'scene': scene})
    try:
        return created['scene'], scene_hash
    finally:
        request(base, '/sessions/' + created['sessionId'], 'DELETE', token=created['adminToken'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8787')
    scene_choice = parser.add_mutually_exclusive_group()
    scene_choice.add_argument('--scene', choices=SCENES)
    scene_choice.add_argument('--scene-file', type=Path, help='local scene JSON (60 KiB) or YAML (60 KB)')
    parser.add_argument('--policy', choices=('nearest', 'battery'), default='nearest')
    parser.add_argument('--physics', choices=('rapier', 'kinematic'), default='rapier')
    parser.add_argument('--from-agent', default='drone-1')
    parser.add_argument('--to-agent', default='drone-2')
    parser.add_argument('--relay-agent', default='drone-3')
    parser.add_argument('--count', type=int, default=2)
    parser.add_argument('--start-seed', type=int, default=42)
    parser.add_argument('--max-ticks', type=int, default=1000)
    parser.add_argument('--archive-seed', type=int)
    parser.add_argument('--archive-side', choices=('direct', 'relay'), default='relay')
    parser.add_argument('--archive-file', help='write a selected server replay; must not already exist')
    parser.add_argument('--report-file', help='also write the report to a new file; must not already exist')
    a = parser.parse_args()
    if not 1 <= a.count <= 50 or not 0 <= a.start_seed <= 0xffffffff or a.start_seed + a.count - 1 > 0xffffffff or not 1 <= a.max_ticks <= 1000 or ((a.archive_seed is None) != (a.archive_file is None)) or a.archive_seed is not None and not a.start_seed <= a.archive_seed < a.start_seed + a.count:
        parser.error('invalid experiment parameters or archive selection')
    AgentClient('_', '_', '_', a.url)
    base = a.url.rstrip('/')
    identity = runtime(base)
    if a.scene_file is not None:
        scene, scene_hash = load_scene(base, a.scene_file)
    else:
        scene, scene_hash = fetch_scene(base, a.scene or 'industrial-park-v1'), None
    if runtime(base) != identity:
        raise RuntimeError('world service changed while loading scene')
    pairs, selected_archive = [], None
    for seed in range(a.start_seed, a.start_seed + a.count):
        pair = {'seed': seed}
        for side in ('direct', 'relay'):
            print(f'seed {seed}: {side}', file=sys.stderr, flush=True)
            pair[side], archive = run_one(base, scene, seed, a.policy, a.physics, a.from_agent, a.to_agent, a.relay_agent, side, a.max_ticks, seed == a.archive_seed and side == a.archive_side)
            if archive is not None:
                selected_archive = archive
            if runtime(base) != identity:
                raise RuntimeError('world service changed during comparison')
        if pair['direct']['initialStateSha256'] != pair['relay']['initialStateSha256']:
            raise RuntimeError('paired initial worlds differ')
        pairs.append(pair)
    if selected_archive is not None:
        with open(a.archive_file, 'x', encoding='utf-8') as output:
            json.dump(selected_archive, output, ensure_ascii=False, separators=(',', ':'))
    root = Path(__file__).resolve().parents[3]
    files = ('src/scene-format.js','scripts/parse-scene-stdin.js','sdk/python/scene_input.py','package-lock.json','src/engine.js', 'src/navigation.js', 'src/sensors.js', 'server/physics.js', 'server/world-server.js', 'sdk/python/relay_compare.py')
    report = json.dumps({'format': '3dbox-server-relay-comparison-v1',
                      'config': {'scene': scene, 'sceneFileSha256': scene_hash, 'policy': a.policy, 'physicsMode': a.physics, 'dispatchMode': 'rule',
                                 'executionMode': 'auto', 'from': a.from_agent, 'to': a.to_agent, 'relay': a.relay_agent,
                                 'startSeed': a.start_seed, 'count': a.count, 'maxTicks': a.max_ticks,
                                 'archiveSeed': a.archive_seed, 'archiveSide': a.archive_side if a.archive_seed is not None else None},
                      'serverRuntime': identity, 'localSourceSha256': {f: hashlib.sha256((root / f).read_bytes()).hexdigest() for f in files},
                      'summary': summarize(pairs), 'pairs': pairs}, ensure_ascii=False, separators=(',', ':'))
    if a.report_file is not None:
        with open(a.report_file, 'x', encoding='utf-8') as output:
            output.write(report)
    print(report)


if __name__ == '__main__':
    main()
