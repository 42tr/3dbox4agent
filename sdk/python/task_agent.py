"""Execute assigned tasks through a single scoped agent credential."""
import argparse
from contextlib import ExitStack
import os
import time
import uuid

from box_agent import AgentClient, SandboxError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--grpc-target', help='use a local gRPC adapter host:port for observations and actions')
    parser.add_argument('--grpc-observe-stream', action='store_true', help='use scoped gRPC observation stream')
    parser.add_argument('--observe-stream', action='store_true', help='use optional scoped WebSocket observations')
    parser.add_argument('--poll', type=float, default=.1)
    parser.add_argument('--lead-ticks', type=int, default=10)
    parser.add_argument('--auto-rescue', action='store_true', help='approach locally observed faulted devices and perform configured mechanical resets')
    parser.add_argument('--rescue-search', action='store_true', help='with auto-rescue, search while idle using bounded own-sensor patrol moves')
    parser.add_argument('--auto-charge', action='store_true', help='request charging when idle at or below the threshold')
    parser.add_argument('--preempt-for-charge', action='store_true', help='pause own task action before charging when return energy is low')
    parser.add_argument('--auto-report-samples', action='store_true', help='report own collected samples and retry failed reports')
    parser.add_argument('--sample-report-attempts', type=int, default=3, help='maximum total attempts per sample (1–10)')
    parser.add_argument('--charge-threshold', type=float, default=5)
    parser.add_argument('--charge-reserve', type=float, default=3, help='extra energy above estimated return cost')
    args = parser.parse_args()
    if args.rescue_search and not args.auto_rescue:
        parser.error('--rescue-search requires --auto-rescue')
    if args.grpc_observe_stream and (not args.grpc_target or args.observe_stream):
        parser.error('--grpc-observe-stream requires --grpc-target and cannot be combined with --observe-stream')
    if not .01 <= args.poll <= 60 or not 1 <= args.lead_ticks <= 50 or not 1 <= args.charge_threshold < 80 or not 0 <= args.charge_reserve <= 50 or not 1 <= args.sample_report_attempts <= 10:
        parser.error('poll must be 0.01–60 seconds, lead-ticks 1–50, charge-threshold 1–79, and charge-reserve 0–50, and sample-report-attempts 1–10')
    if args.preempt_for_charge and not args.auto_charge:
        parser.error('--preempt-for-charge requires --auto-charge')
    if args.grpc_target:
        from box_agent.grpc_client import GrpcAgentClient
        client = GrpcAgentClient(os.environ['BOX_SESSION'], os.environ['BOX_AGENT'], os.environ['BOX_TOKEN'], args.grpc_target)
    else:
        client = AgentClient(os.environ['BOX_SESSION'], os.environ['BOX_AGENT'], os.environ['BOX_TOKEN'], os.environ.get('BOX_URL','http://127.0.0.1:8787'))
    from box_agent.rescue_policy import RescuePolicy
    rescue_policy = RescuePolicy(max(10,args.lead_ticks), search=args.rescue_search) if args.auto_rescue else None
    prefix = 'task-' + uuid.uuid4().hex
    sequence = 0
    last_attempt = None
    last_charge_attempt = None
    with ExitStack() as stack:
        if args.grpc_target:
            stack.callback(client.close)
        if args.grpc_observe_stream:
            from box_agent.grpc_observation_reader import GrpcObservationReader
            reader = stack.enter_context(GrpcObservationReader(client, os.environ['BOX_SESSION'], os.environ['BOX_TOKEN'], os.environ['BOX_AGENT'], args.grpc_target, args.poll, role='agent'))
        elif args.observe_stream:
            from box_agent.observation_reader import ObservationReader
            reader = stack.enter_context(ObservationReader(client, os.environ['BOX_SESSION'], os.environ['BOX_TOKEN'], os.environ['BOX_AGENT'], os.environ.get('BOX_URL', 'http://127.0.0.1:8787'), args.poll))
        else:
            reader = client
        while True:
            observation = reader.observe()
            session_error = observation.get('sessionError') or observation.get('simulationError')
            if session_error in ('world_step_failed', 'journal_write_failed'):
                raise SandboxError(503, session_error)
            if observation['done']:
                print('实验结束', flush=True)
                return
            self_state = observation['self']
            if rescue_policy and rescue_policy.step(client, observation):
                time.sleep(args.poll)
                continue
            if args.auto_report_samples and self_state['status'] != 'fault':
                for sample in observation.get('samples', []):
                    reports = [r for r in observation.get('sampleReports', []) if r['taskId'] == sample['taskId']]
                    if len(reports) >= args.sample_report_attempts or any(r['status'] in ('pending', 'delivered') for r in reports):
                        continue
                    sequence += 1
                    try:
                        result = client.report_sample(f'{prefix}-{sequence}', sample['taskId'])
                    except SandboxError as error:
                        if error.status == 409 and error.code in ('sample_already_reported', 'world_finished', 'agent_unavailable'):
                            break
                        raise
                    print(f"T+{observation['tick']} 提交采样报告 {sample['taskId']}（第 {len(reports)+1} 次）：{result['report']['status']}", flush=True)
                    break
            live_actions = [a for a in observation['actions'] if a['status'] in ('pending','accepted')]
            pending = bool(live_actions)
            tasks = [task for task in observation['assignedTasks'] if task['status']=='active']
            estimate = self_state.get('returnEnergyEstimate')
            limit = min(79, max(args.charge_threshold, estimate + args.charge_reserve + self_state.get('operatingEnergyPerTick', 0) * args.lead_ticks if estimate is not None else 0))
            if self_state['battery'] > limit:
                last_charge_attempt = None
            attempt = (self_state['battery'], self_state['x'], self_state['y'])
            if args.auto_charge and args.preempt_for_charge and tasks and estimate is not None and estimate < self_state['battery'] <= limit and attempt != last_charge_attempt:
                task_ids = {task['id'] for task in tasks}
                action = next((a for a in live_actions if
                               (a['type'] in ('execute_task','work_task') and a.get('taskId') in task_ids) or
                               (a['type']=='move' and (a.get('resumeTaskId') in task_ids or
                                                       a['status']=='pending' and self_state['status']=='assigned'))), None)
                if action:
                    try:
                        client.cancel_action(action['requestId'])
                    except SandboxError as error:
                        if error.status == 409 and error.code in ('action_not_cancellable','action_not_found','world_finished','action_state_conflict'):
                            time.sleep(args.poll)
                            continue
                        raise
                    print(f"T+{observation['tick']} 暂停任务动作以补能", flush=True)
                    time.sleep(args.poll)
                    continue
            if args.auto_charge and self_state['status'] in ('idle','assigned') and 0 < self_state['battery'] <= limit and not pending:
                attempt = (self_state['battery'], self_state['x'], self_state['y'])
                if attempt != last_charge_attempt:
                    sequence += 1
                    tick = observation['tick'] + args.lead_ticks
                    try:
                        result = client.charge(f'{prefix}-{sequence}', tick, tick+40)
                    except SandboxError as error:
                        if error.status == 409 and error.code in ('invalid_schedule', 'world_finished'):
                            time.sleep(args.poll)
                            continue
                        raise
                    last_charge_attempt = attempt
                    print(f"T+{observation['tick']} 提交自主补能：{result['action']['status']}", flush=True)
                    time.sleep(args.poll)
                    continue
            if observation['self']['status'] == 'assigned' and tasks:
                task = tasks[0]
                pending = any(a['status'] in ('pending','accepted') for a in observation['actions'])
                attempt = (task['id'], observation['tick'], task.get('phase'))
                if not pending and attempt != last_attempt:
                    sequence += 1
                    last_attempt = attempt
                    tick = observation['tick'] + args.lead_ticks
                    request_id = f'{prefix}-{sequence}'
                    try:
                        if observation.get('executionMode') == 'primitive':
                            if task['withinReach']:
                                result = client.work_task(request_id,task['id'],tick,tick+40)
                                kind = '作业'
                            elif task.get('approachPoint', task.get('waypoint')):
                                x,y = task.get('approachPoint', task.get('waypoint'))
                                result = client.move_to(request_id,x,y,tick,tick+40)
                                kind = '移动'
                            else:
                                time.sleep(args.poll)
                                continue
                        else:
                            result = client.execute_task(request_id,task['id'],tick,tick+40)
                            kind = '任务'
                    except SandboxError as error:
                        if error.status == 409 and error.code in ('invalid_schedule', 'world_finished'):
                            time.sleep(args.poll)
                            continue
                        raise
                    print(f"T+{observation['tick']} 提交{kind} {task['id']}：{result['action']['status']}",flush=True)
            time.sleep(args.poll)


if __name__ == '__main__':
    try:
        main()
    except (KeyError, ValueError, SandboxError) as error:
        raise SystemExit(f'单体客户端停止：{error}')
