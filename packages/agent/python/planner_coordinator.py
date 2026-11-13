"""Run a planning coordinator using only its scoped sandbox credential."""
import argparse
from contextlib import ExitStack
import hashlib
import os
import time
import uuid

from box_agent import CoordinatorClient, SandboxError
from box_agent.client import CONTROL_HTTP_ORIGIN
from box_agent.planner import plan


def avoid_recent_transport_failure(observation):
    """Prefer another eligible device after the last link failure for a task."""
    recent = {}
    for decision in observation.get('decisions', []):
        recent[decision['taskId']] = decision
    tasks = []
    for task in observation['tasks']:
        previous = recent.get(task['id'], {})
        if (previous.get('status') == 'failed' and previous.get('reason') in ('interrupted', 'dropped', 'unavailable')) or (previous.get('status') == 'rejected' and previous.get('reason') == 'not_available'):
            alternatives = [a for a in task['candidates'] if a['id'] != previous.get('agentId')]
            tasks.append({**task, 'candidates':alternatives or task['candidates']})
        else:
            tasks.append(task)
    return {**observation, 'tasks':tasks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--grpc-target', help='use a local gRPC adapter host:port for coordinator requests')
    parser.add_argument('--grpc-observe-stream', action='store_true', help='use scoped gRPC observation stream')
    parser.add_argument('--observe-stream', action='store_true', help='use scoped coordinator WebSocket observations')
    parser.add_argument('--poll', type=float, default=0.1, help='seconds between idle or rejected observations')
    parser.add_argument('--once', action='store_true', help='perform at most one decision')
    parser.add_argument('--shard-count', type=int, default=1, help='partition tasks deterministically across coordinators')
    parser.add_argument('--shard-index', type=int, default=0)
    args = parser.parse_args()
    if args.grpc_observe_stream and (not args.grpc_target or args.observe_stream):
        parser.error('--grpc-observe-stream requires --grpc-target and cannot be combined with --observe-stream')
    if not 0.01 <= args.poll <= 60 or not 1 <= args.shard_count <= 16 or not 0 <= args.shard_index < args.shard_count:
        parser.error('invalid poll or coordinator shard')
    if args.grpc_target:
        from box_agent.grpc_client import GrpcCoordinatorClient
        client = GrpcCoordinatorClient(os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'], args.grpc_target)
    else:
        client = CoordinatorClient(os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'], os.environ.get('BOX_URL', CONTROL_HTTP_ORIGIN), run_id=os.environ.get('BOX_CONTROL_RUN_ID'))
    prefix = 'planner-' + uuid.uuid4().hex
    sequence = 0
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
            observation = reader.observe()
            session_error = observation.get('sessionError') or observation.get('simulationError')
            if session_error in ('world_step_failed', 'journal_write_failed'):
                raise SandboxError(503, session_error)
            if observation['done']:
                print('实验结束：' + ('失败' if observation['failed'] else '完成'), flush=True)
                return 1 if observation['failed'] else 0
            observation = {**observation, 'tasks':[t for t in observation['tasks'] if int.from_bytes(hashlib.sha256(t['id'].encode('utf-8')).digest()[:4], 'big') % args.shard_count == args.shard_index]}
            choices = plan(avoid_recent_transport_failure(observation))
            accepted = False
            if choices:
                choice = choices[0]
                sequence += 1
                try:
                    result = client.assign(f'{prefix}-{sequence}', choice['taskId'], choice['agentId'], observation['tick'])
                except SandboxError as error:
                    if error.status == 409 and error.code in ('task_in_transit', 'world_finished'):
                        if args.once:
                            return 0
                        time.sleep(args.poll)
                        continue
                    raise
                decision = result['decision']
                accepted = decision['status'] == 'accepted'
                print(f"T+{observation['tick']} {choice['taskId']} → {choice['agentId']}：{decision['status']} {decision.get('reason', '')}", flush=True)
            if args.once:
                return 0
            if not accepted:
                time.sleep(args.poll)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (KeyError, ValueError, SandboxError) as error:
        raise SystemExit(f'规划器停止：{error}')
