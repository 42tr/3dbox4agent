"""Run two independent agents exchanging a message and an in-band acknowledgement."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from box_agent import AgentClient
from link_compare import fetch_scene, request


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', default='http://127.0.0.1:8787')
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--loss', type=float, default=0)
    p.add_argument('--retry-ticks', type=int, default=15)
    p.add_argument('--max-attempts', type=int, default=4)
    p.add_argument('--timeout', type=float, default=12)
    p.add_argument('--restart-receiver', action='store_true', help='restart the receiver after its first acknowledgement submission')
    p.add_argument('--archive-file', help='write retained snapshots to a new file')
    a = p.parse_args()
    if not 0 <= a.seed <= 0xffffffff or not 0 <= a.loss <= 1 or not 1 <= a.retry_ticks <= 1000 or not 1 <= a.max_attempts <= 20 or not 2 <= a.timeout <= 60:
        p.error('invalid experiment parameters')
    AgentClient('_', '_', '_', a.url)
    base = a.url.rstrip('/')
    scene = fetch_scene(base, 'industrial-park-v1')
    scene['communication'].update(range=1000, delay=3, ttl=15, lossRate=a.loss)
    created = request(base, '/sessions', 'POST', {'scene': scene, 'seed': a.seed, 'dispatchMode': 'external'})
    root, admin = '/sessions/' + created['sessionId'], created['adminToken']
    children = []
    status, reason = 'failed', 'worker_failed'
    receiver_outputs, restart_event = [], None
    try:
        tokens = {agent: request(base, root + '/agents/' + agent + '/credentials', 'POST', {}, admin)['agentToken'] for agent in ('drone-1', 'drone-2')}
        # Do not pass administrative or other agent credentials into either process.
        clean_env = {k: v for k, v in os.environ.items() if k not in ('BOX_SESSION', 'BOX_TOKEN', 'BOX_COORDINATOR_TOKEN', 'BOX_AGENT', 'BOX_URL')}
        script = Path(__file__).with_name('peer_ack_agent.py')
        def launch(role, agent, peer):
            env = {**clean_env, 'BOX_URL': base, 'BOX_SESSION': created['sessionId'], 'BOX_AGENT': agent, 'BOX_TOKEN': tokens[agent]}
            child = subprocess.Popen([sys.executable, str(script), role, '--peer', peer, '--retry-ticks', str(a.retry_ticks), '--max-attempts', str(a.max_attempts), '--timeout', str(a.timeout)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            children.append((role, child))
            return child
        receiver = launch('receiver', 'drone-2', 'drone-1')
        sender = launch('sender', 'drone-1', 'drone-2')
        request(base, root + '/run', 'POST', {'speed': 1}, admin)
        deadline = time.monotonic() + a.timeout + 2
        while sender.poll() is None and time.monotonic() < deadline:
            if a.restart_receiver and restart_event is None:
                observed = request(base, root, token=admin)
                if any(e.get('kind') == 'message_sent' and e.get('from') == 'drone-2' and e.get('to') == 'drone-1' for e in observed['world']['events']):
                    restart_event = {'kind': 'receiver_restarted', 'tick': observed['world']['tick'], 'observedRevision': observed['revision']}
                    if receiver.poll() is None:
                        receiver.terminate()
                    old_out, _ = receiver.communicate(timeout=2)
                    receiver_outputs.append(old_out)
                    receiver = launch('receiver', 'drone-2', 'drone-1')
            time.sleep(.02)
        try:
            sender_out, sender_err = sender.communicate(timeout=max(.01, deadline - time.monotonic()))
            status = 'acknowledged' if sender.returncode == 0 else 'failed'
            reason = None if sender.returncode == 0 else 'sender_stopped'
        except subprocess.TimeoutExpired:
            sender.kill(); sender_out, sender_err = sender.communicate(); reason = 'wall_timeout'
        if receiver.poll() is None:
            receiver.terminate()
        receiver_out, receiver_err = receiver.communicate(timeout=2)
        receiver_outputs.append(receiver_out)
        state = request(base, root + '/pause', 'POST', {}, admin)
        def parse_lines(value):
            result = []
            for line in value.splitlines():
                try:
                    record = json.loads(line)
                    if isinstance(record, dict): result.append(record)
                except ValueError:
                    continue
            return result
        sender_events = parse_lines(sender_out)
        receiver_events = [{**event, 'generation': generation} for generation, output in enumerate(receiver_outputs, 1) for event in parse_lines(output)]
        if status == 'acknowledged' and not any(e.get('kind') == 'acknowledged' for e in sender_events):
            status, reason = 'failed', 'missing_ack_observation'
        if a.restart_receiver and restart_event is None:
            status, reason = 'failed', 'restart_not_observed'
        if a.archive_file:
            history = request(base, root + '/history?after=-1', token=admin)
            frames = history['frames']; first, last = frames[0]['revision'], frames[-1]['revision']
            if [f['revision'] for f in frames] != list(range(first, last + 1)) or frames[-1]['world'] != state['world']:
                raise RuntimeError('inconsistent retained history')
            archive = {'format': '3dbox-prototype-v1', 'source': 'server',
                       'coverage': {'start': 'partial' if history['truncated'] else 'complete', 'end': 'finished' if state['world']['done'] else 'unfinished', 'revisionRange': [first, last]},
                       'config': {'seed': a.seed, 'policy': 'nearest', 'sceneId': scene['id'], 'scene': created['scene']}, 'frames': [f['world'] for f in frames]}
            with open(a.archive_file, 'x', encoding='utf-8') as output:
                json.dump(archive, output, ensure_ascii=False, separators=(',', ':'))
        result = {'format': '3dbox-peer-ack-demo-v1', 'status': status, 'reason': reason, 'config': {'seed': a.seed, 'lossRate': a.loss, 'retryTicks': a.retry_ticks, 'maxAttempts': a.max_attempts, 'restartReceiver': a.restart_receiver}, 'tick': state['world']['tick'], 'sender': sender_events, 'receiver': receiver_events, 'controlEvents': [restart_event] if restart_event else [], 'messageEvents': [e for e in state['world']['events'] if e.get('kind', '').startswith('message_')]}
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
        return 0 if status == 'acknowledged' else 1
    finally:
        for _, child in children:
            if child.poll() is None:
                child.kill()
            child.wait()
        request(base, root, 'DELETE', token=admin)


if __name__ == '__main__':
    sys.exit(main())
