"""Coordinate assignments and guarded recovery from delivered blocked reports."""
import argparse
import os
import time
import uuid

from blocked_coordinator import blocked_assignment
from box_agent import CoordinatorClient, SandboxError
from box_agent.planner import plan


def eligible_observation(observation, cooldown):
    """Temporarily avoid a task/device pair after guarded withdrawal or dispatch failure."""
    tick=observation['tick'];avoid=set()
    for revocation in observation.get('revocations',[]):
        applied=revocation.get('appliedTick')
        if revocation.get('status')=='accepted' and revocation.get('requireBlockedSince') is not None and type(applied) is int and 0<=tick-applied<cooldown:
            avoid.add((revocation['taskId'],revocation['agentId']))
    for decision in observation.get('decisions',[]):
        applied=decision.get('appliedTick');status=decision.get('status');reason=decision.get('reason')
        if type(applied) is int and 0<=tick-applied<cooldown and ((status=='rejected' and reason in ('not_available','stale_observation')) or (status=='failed' and reason in ('interrupted','dropped','unavailable','expired'))):
            avoid.add((decision['taskId'],decision['agentId']))
    return {**observation,'tasks':[{**task,'candidates':[agent for agent in task['candidates'] if (task['id'],agent['id']) not in avoid]} for task in observation['tasks']]}


def eligible_blocked_assignment(observation, minimum):
    # A rejected condition proves that this particular wait episode has ended.
    disproved={(r['taskId'],r['agentId'],r['assignmentId'],r['requireBlockedSince'])
               for r in observation.get('revocations',[])
               if r.get('status')=='rejected' and r.get('reason')=='route_condition_changed'
               and r.get('requireBlockedSince') is not None}
    active=[]
    for task in observation.get('active',[]):
        report=task.get('statusReport') or {}
        if (task['id'],task['assignee'],task['assignmentId'],report.get('routeBlockedSince')) not in disproved:
            active.append(task)
    return blocked_assignment({**observation,'active':active},minimum)


def choose(observation, minimum, cooldown):
    task=eligible_blocked_assignment(observation,minimum)
    if task:
        return {'type':'revoke','taskId':task['id'],'agentId':task['assignee'],
                'assignmentId':task['assignmentId'],'requireBlockedSince':task['statusReport']['routeBlockedSince']}
    choices=plan(eligible_observation(observation,cooldown))
    if choices:
        return {'type':'assign','taskId':choices[0]['taskId'],'agentId':choices[0]['agentId']}
    return None


def submit(client,observation,choice,request_id):
    if choice['type']=='revoke':
        return client.revoke(request_id,choice['taskId'],choice['agentId'],choice['assignmentId'],observation['tick'],require_blocked_since=choice['requireBlockedSince'])['revocation']
    return client.assign(request_id,choice['taskId'],choice['agentId'],observation['tick'])['decision']


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--poll',type=float,default=.1)
    parser.add_argument('--min-blocked-ticks',type=int,default=5)
    parser.add_argument('--cooldown-ticks',type=int,default=30)
    parser.add_argument('--once',action='store_true',help='make at most one decision')
    args=parser.parse_args()
    if not .01<=args.poll<=60 or not 0<=args.min_blocked_ticks<=10000 or not 1<=args.cooldown_ticks<=10000:
        parser.error('invalid poll, blocked duration or cooldown')
    client=CoordinatorClient(os.environ['BOX_SESSION'],os.environ['BOX_COORDINATOR_TOKEN'],os.environ.get('BOX_URL','http://127.0.0.1:8787'))
    prefix='adaptive-'+uuid.uuid4().hex;sequence=0
    while True:
        observation=client.observe()
        session_error = observation.get('sessionError') or observation.get('simulationError')
        if session_error in ('world_step_failed', 'journal_write_failed'):
            raise SandboxError(503, session_error)
        if observation['done']:
            print('实验结束：'+('失败' if observation['failed'] else '完成'),flush=True)
            return 1 if observation['failed'] else 0
        choice=choose(observation,args.min_blocked_ticks,args.cooldown_ticks)
        try:
            if choice:
                sequence+=1;result=submit(client,observation,choice,f'{prefix}-{sequence}')
                label='条件撤回' if choice['type']=='revoke' else '→ '+choice['agentId']
                print(f"T+{observation['tick']} {choice['taskId']} {label}：{result['status']} {result.get('reason','')}",flush=True)
            elif args.once:
                print('暂无可执行决策。',flush=True)
        except SandboxError as error:
            if error.status!=409 or error.code not in ('task_in_transit','queue_full','world_finished'):
                raise
            print(f'决策未提交：{error.code}',flush=True)
            if args.once:return 1
            time.sleep(args.poll);continue
        if args.once:return 0
        time.sleep(args.poll)

if __name__=='__main__':
    try:raise SystemExit(main())
    except (KeyError,ValueError,SandboxError) as error:raise SystemExit(f'自适应协调器停止：{error}')
