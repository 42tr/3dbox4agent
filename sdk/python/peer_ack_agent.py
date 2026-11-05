"""Minimal peer sender/receiver using only scoped observations and simulated messages."""
import argparse
import json
import os
import re
import sys
import time
from box_agent import AgentClient, SandboxError


def emit(kind, **values):
    print(json.dumps({'kind': kind, **values}, ensure_ascii=False, separators=(',', ':')), flush=True)


def decode(message, expected_from):
    if message.get('from') != expected_from:
        return None
    try:
        obj = json.loads(message['text'])
    except (KeyError, TypeError, ValueError):
        return None
    return obj if isinstance(obj, dict) and obj.get('v') == 1 else None


def accept_in_memory(client, peer, logical_id, body):
    """Commit this demo's acceptance marker using the agent's session memory CAS."""
    for _ in range(8):
        current = client.read_memory()
        value = current['value']
        records = value.get('peerAckV1', [])
        if not isinstance(records, list) or len(records) > 50 or any(not isinstance(r, dict) or set(r) != {'peer', 'id', 'body'} or not all(isinstance(r[k], str) for k in ('peer', 'id', 'body')) for r in records):
            raise ValueError('invalid peer acknowledgement memory')
        matches = [r for r in records if r['peer'] == peer and r['id'] == logical_id]
        if matches:
            if len(matches) != 1 or matches[0]['body'] != body:
                raise ValueError('conflicting peer acknowledgement memory')
            return False
        if len(records) >= 50:
            raise ValueError('peer acknowledgement memory full')
        updated = {**value, 'peerAckV1': [*records, {'peer': peer, 'id': logical_id, 'body': body}]}
        try:
            client.write_memory(updated, current['revision'])
            return True
        except SandboxError as error:
            if error.code != 'memory_revision_conflict':
                raise
    raise SandboxError(409, 'memory_revision_conflict')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('role', choices=('sender', 'receiver'))
    p.add_argument('--peer', required=True)
    p.add_argument('--logical-id', default='demo-1')
    p.add_argument('--retry-ticks', type=int, default=15)
    p.add_argument('--max-attempts', type=int, default=4)
    p.add_argument('--timeout', type=float, default=15)
    p.add_argument('--poll', type=float, default=.03)
    a = p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', a.logical_id) or not 1 <= a.retry_ticks <= 1000 or not 1 <= a.max_attempts <= 20 or not .01 <= a.poll <= 1 or not 1 <= a.timeout <= 120:
        p.error('invalid protocol parameters')
    client = AgentClient(os.environ['BOX_SESSION'], os.environ['BOX_AGENT'], os.environ['BOX_TOKEN'], os.environ.get('BOX_URL', 'http://127.0.0.1:8787'))
    deadline = time.monotonic() + a.timeout
    attempts, next_tick, last_incoming = 0, 0, set()
    data = json.dumps({'v': 1, 'kind': 'data', 'id': a.logical_id, 'body': '状态确认'}, ensure_ascii=False, separators=(',', ':'))
    ack = json.dumps({'v': 1, 'kind': 'ack', 'id': a.logical_id}, separators=(',', ':'))
    while time.monotonic() < deadline:
        try:
            obs = client.observe()
            session_error = obs.get('sessionError') or obs.get('simulationError')
            if session_error in ('world_step_failed', 'journal_write_failed'):
                emit('stopped', reason=session_error, tick=obs['tick']); return 1
            if obs['done']:
                emit('stopped', reason='world_finished', tick=obs['tick']); return 1
            for message in obs['inbox']:
                if message['id'] in last_incoming:
                    continue
                value = decode(message, a.peer)
                if not value or value.get('id') != a.logical_id:
                    last_incoming.add(message['id']); continue
                if a.role == 'sender' and value.get('kind') == 'ack':
                    emit('acknowledged', tick=obs['tick'], attempts=attempts, messageId=message['id']); return 0
                if a.role == 'receiver' and value.get('kind') == 'data' and value.get('body') == '状态确认':
                    accepted = accept_in_memory(client, a.peer, a.logical_id, value['body'])
                    emit('accepted' if accepted else 'duplicate_data', tick=obs['tick'], messageId=message['id'])
                    result = client.send_message(a.peer, ack, request_id='ack-' + str(message['id']))
                    emit('ack_submitted', tick=obs['tick'], messageId=result['messageId'], duplicate=result['duplicate'])
                last_incoming.add(message['id'])
            if a.role == 'sender' and obs['tick'] >= next_tick:
                if attempts >= a.max_attempts:
                    emit('stopped', reason='attempt_limit', tick=obs['tick'], attempts=attempts); return 1
                number = attempts + 1
                result = client.send_message(a.peer, data, request_id='data-' + a.logical_id + '-' + str(number))
                attempts = number; next_tick = obs['tick'] + a.retry_ticks
                emit('data_submitted', tick=obs['tick'], attempt=attempts, messageId=result['messageId'], duplicate=result['duplicate'])
        except SandboxError as error:
            if error.status != 0 and error.code not in ('rate_limit', 'queue_full'):
                emit('stopped', reason=error.code); return 1
            # Transport failure retries the same request ID; rate-limited sends were not accepted.
        time.sleep(a.poll)
    emit('stopped', reason='wall_timeout', attempts=attempts)
    return 1


if __name__ == '__main__':
    sys.exit(main())
