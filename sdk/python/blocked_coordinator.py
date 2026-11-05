"""Withdraw long-blocked assignments based only on delivered coordinator reports."""
import argparse
import os
import time
import uuid

from box_agent import CoordinatorClient, SandboxError


def blocked_assignment(observation, minimum):
    candidates=[]
    for task in observation.get('active', []):
        report=task.get('statusReport')
        if not isinstance(report,dict) or report.get('fresh') is not True:
            continue
        since=report.get('routeBlockedSince');captured=report.get('capturedTick')
        if type(since) is not int or type(captured) is not int or captured-since<minimum:
            continue
        candidates.append((since,task['id'],task))
    return min(candidates,default=(None,None,None))[2]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--poll',type=float,default=.2)
    parser.add_argument('--min-blocked-ticks',type=int,default=5)
    parser.add_argument('--once',action='store_true')
    args=parser.parse_args()
    if not .01<=args.poll<=60 or not 0<=args.min_blocked_ticks<=10000:
        parser.error('invalid polling interval or blocked duration')
    client=CoordinatorClient(os.environ['BOX_SESSION'],os.environ['BOX_COORDINATOR_TOKEN'],os.environ.get('BOX_URL','http://127.0.0.1:8787'))
    prefix='blocked-'+uuid.uuid4().hex;sequence=0
    while True:
        observation=client.observe()
        session_error = observation.get('sessionError') or observation.get('simulationError')
        if session_error in ('world_step_failed', 'journal_write_failed'):
            raise SandboxError(503, session_error)
        if observation['done']:
            print('实验结束。',flush=True);return 0
        task=blocked_assignment(observation,args.min_blocked_ticks)
        if task is None:
            if args.once:
                print('没有符合条件的已送达受阻报告。',flush=True);return 0
            time.sleep(args.poll);continue
        sequence+=1;report=task['statusReport']
        result=client.revoke(f'{prefix}-{sequence}',task['id'],task['assignee'],task['assignmentId'],observation['tick'],require_blocked_since=report['routeBlockedSince'])['revocation']
        print(f"T+{observation['tick']} 任务 {task['id']} 条件撤回：{result['status']} {result.get('reason','')}",flush=True)
        if args.once: return 0 if result['status']=='accepted' else 1
        time.sleep(args.poll)

if __name__=='__main__':
    try:
        raise SystemExit(main())
    except (KeyError,ValueError,SandboxError) as error:
        raise SystemExit(f'受阻协调器停止：{error}')
