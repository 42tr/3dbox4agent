"""Compare a temporary road closure with a control from one saved world version."""
import argparse
import json
import math
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError

from box_agent import AgentClient
from link_compare import request, runtime

ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
TOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$')


def access_file(path):
    with path.open('rb') as source:
        raw = source.read(2049)
    if len(raw) > 2048:
        raise ValueError('access file too large')
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('format') != '3dbox-journal-access-v1' or not isinstance(value.get('sessionId'), str) or not ID.fullmatch(value['sessionId']) or not isinstance(value.get('adminToken'), str) or not TOKEN.fullmatch(value['adminToken']):
        raise ValueError('invalid access file')
    return value


def run(base, access, revision, rect, duration, max_ticks, archive):
    identity = runtime(base)
    if not identity.get('eventJournalEnabled'):
        raise RuntimeError('event journal is not enabled')
    sessions = []
    source_root = '/event-journals/' + access['sessionId']
    try:
        for condition in ('control', 'roadblock'):
            created = request(base, source_root + '/fork', 'POST', {'revision': revision}, access['adminToken'])
            if not isinstance(created.get('sessionId'), str) or not isinstance(created.get('adminToken'), str):
                raise RuntimeError('invalid fork response')
            sessions.append((condition, created))
        first, second = (x[1] for x in sessions)
        if first['world'] != second['world'] or first['scene'] != second['scene'] or first['metrics'] != second['metrics']:
            raise RuntimeError('fork starting states differ')
        start, start_metrics = first['world'], first['metrics']
        if start.get('done') or not isinstance(start.get('tick'), int):
            raise RuntimeError('invalid fork starting state')
        runs = {}
        for condition, created in sessions:
            if runtime(base) != identity:
                raise RuntimeError('world service changed during comparison')
            root, token = '/sessions/' + created['sessionId'], created['adminToken']
            state = created
            if condition == 'roadblock':
                state = request(base, root + '/roadblock', 'POST', {'rect': rect, 'duration': duration}, token)
            while not state['world']['done'] and state['world']['tick'] - start['tick'] < max_ticks:
                count = min(25, max_ticks - (state['world']['tick'] - start['tick']))
                state = request(base, root + '/step', 'POST', {'count': count}, token)
            world = state['world']
            if world['events'][:len(start['events'])] != start['events']:
                raise RuntimeError('fork event history changed')
            result = {'status': 'failed' if world['failed'] else 'completed' if world['done'] else 'timeout',
                      'finalWorld': world, 'metrics': state['metrics'],
                      'sourceState': {'closed': created['forkedFrom']['sourceClosed'], 'partialTail': created['forkedFrom']['sourcePartialTail']}}
            if archive:
                history = request(base, root + '/history?after=-1', token=token)
                frames = history['frames']
                if not frames or frames[-1]['world'] != world or [f['revision'] for f in frames] != list(range(frames[0]['revision'], frames[-1]['revision'] + 1)):
                    raise RuntimeError('inconsistent retained history')
                result['archive'] = {'format': '3dbox-prototype-v1', 'source': 'server',
                    'config': {'seed': start['seed'], 'policy': start['policy'], 'sceneId': start['sceneId'], 'scene': created['scene']},
                    'coverage': {'start': 'partial', 'end': 'finished' if world['done'] else 'unfinished',
                                 'revisionRange': [frames[0]['revision'], frames[-1]['revision']]},
                    'frames': [f['world'] for f in frames]}
            runs[condition] = result
        if runtime(base) != identity:
            raise RuntimeError('world service changed during comparison')
        return {'format': '3dbox-fork-roadblock-v1',
                'source': {'sessionId': access['sessionId'], 'revision': revision},
                'config': {'scene': first['scene'], 'rect': rect, 'duration': duration, 'maxTicks': max_ticks},
                'worldRuntime': identity, 'initialWorld': start, 'initialMetrics': start_metrics, 'runs': runs}
    finally:
        for _, session in sessions:
            try:
                request(base, '/sessions/' + session['sessionId'], 'DELETE', token=session['adminToken'])
            except (HTTPError, URLError, OSError, TimeoutError):
                print('warning: failed to close one comparison session', file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', default='http://127.0.0.1:8787')
    p.add_argument('--access', type=Path, required=True, help='saved journal access JSON')
    p.add_argument('--revision', type=int, required=True)
    for key in ('x', 'y', 'w', 'h'):
        p.add_argument('--' + key, type=float, required=True)
    p.add_argument('--duration', type=int, default=30)
    p.add_argument('--max-ticks', type=int, default=300)
    p.add_argument('--archive', action='store_true', help='include both retained replay histories')
    a = p.parse_args()
    rect = {k: getattr(a, k) for k in ('x', 'y', 'w', 'h')}
    if not 0 <= a.revision <= 9007199254740991 or not 1 <= a.duration <= 1000 or not 1 <= a.max_ticks <= 5000 or not all(math.isfinite(v) for v in rect.values()) or rect['x'] < 0 or rect['y'] < 0 or rect['w'] < 2 or rect['h'] < 2 or rect['x'] + rect['w'] > 100 or rect['y'] + rect['h'] > 100:
        p.error('invalid revision, rectangle, duration or tick limit')
    try:
        AgentClient('_', '_', '_', a.url)
        report = run(a.url.rstrip('/'), access_file(a.access), a.revision, rect, a.duration, a.max_ticks, a.archive)
        print(json.dumps(report, ensure_ascii=False, separators=(',', ':'), allow_nan=False))
    except (HTTPError, URLError, OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        if isinstance(error, HTTPError):
            try:
                detail = json.load(error).get('error', 'http_error')
            except (ValueError, AttributeError):
                detail = 'http_error'
            print('comparison failed: ' + str(detail), file=sys.stderr)
        else:
            print('comparison failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
