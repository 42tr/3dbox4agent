"""Compare waiting and adaptive handoff in staged, paired server sessions."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys

from adaptive_coordinator import choose, submit
from box_agent import AgentClient, CoordinatorClient
from link_compare import fetch_scene, request, runtime
from system_compare import stats


def make_scene(base):
    scene=copy.deepcopy(base);scene['name']='道路封闭接力对照';scene['obstacles']=[];scene.pop('terrain',None);scene.pop('navigation',None)
    scene['agents']=[{'role':'vehicle','label':'勘察车','count':2,'capabilities':['inspect'],'speed':2}]
    scene['tasks']=[{'id':'survey','name':'区域勘察','role':'vehicle','capability':'inspect','behavior':'survey','target':[80,88],'duration':8,'dependsOn':[]}]
    scene['communication'].update({'delay':2,'ttl':10,'lossRate':0,'statusInterval':2,'statusMaxAge':20,'decisionMaxAge':20})
    return scene


def run_one(base,scene,seed,condition,physics,duration,max_ticks,minimum,cooldown,capture):
    created=request(base,'/sessions','POST',{'seed':seed,'sceneId':scene['id'],'scene':scene,'dispatchMode':'networked_reported','physicsMode':physics})
    root='/sessions/'+created['sessionId'];admin=created['adminToken'];state=created
    try:
        if created['scene']!=scene:raise RuntimeError('world service changed the requested scene')
        # Stage the second device on the far side before starting the paired trial.
        request(base,root+'/agents/vehicle-2/actions','POST',{'requestId':'stage-position','type':'move','target':{'x':78,'y':84},'targetTick':1,'expiresTick':50},admin)
        while state['world']['tick']<250:
            state=request(base,root+'/step','POST',{'count':3},admin)
            action=next(x for x in state['world']['actions'] if x['requestId']=='stage-position')
            if action['status']=='completed':break
            if action['status'] in ('failed','rejected','cancelled') or state['world']['done']:raise RuntimeError('staging movement failed')
        else:raise RuntimeError('staging movement timed out')
        request(base,root+'/assign','POST',{'taskId':'survey','agentId':'vehicle-1'},admin)
        state=request(base,root+'/roadblock','POST',{'rect':{'x':50,'y':0,'w':8,'h':100},'duration':duration},admin)
        if state['waiting']!=1:raise RuntimeError('staged roadblock did not block the assigned device')
        world=state['world'];start=world['tick'];reporting=world['communication']['reporting'];setup={'tick':start,'agents':[{'id':a['id'],'x':a['x'],'y':a['y'],'battery':a['battery'],'status':a['status']} for a in world['agents']], 'roadblock':state['roadblock'],'reporting':{k:reporting[k] for k in ('sent','delivered','failed')}}
        issued=request(base,root+'/coordinator/credentials','POST',{},admin);client=CoordinatorClient(created['sessionId'],issued['coordinatorToken'],base);trace=[];seq=0
        while not state['world']['done'] and state['world']['tick']-start<max_ticks:
            if condition=='adaptive':
                obs=client.observe();choice=choose(obs,minimum,cooldown)
                if choice:
                    seq+=1;result=submit(client,obs,choice,f'compare-{seq}')
                    trace.append({'tick':obs['tick'],'choice':choice,'result':result,'active':obs.get('active',[]),'tasks':obs['tasks']})
            state=request(base,root+'/step','POST',{'count':1},admin)
        world=state['world'];status='failed' if world['failed'] else 'completed' if world['done'] else 'timeout'
        result={'seed':seed,'condition':condition,'status':status,'setup':setup,'metrics':state['metrics'],'events':world['events'],'decisions':world['decisions'],'revocations':world.get('revocations',[]),'trace':trace,
                'completionDuration':world['tick']-start if status=='completed' else None,
                'takeoverCompleted':any(e.get('kind')=='task_completed' and e.get('taskId')=='survey' and e.get('agentId')=='vehicle-2' for e in world['events'])}
        if capture:
            history=request(base,root+'/history?after=-1',token=admin);frames=history['frames'];first,last=frames[0]['revision'],frames[-1]['revision']
            if [f['revision'] for f in frames]!=list(range(first,last+1)) or frames[-1]['world']!=world:raise RuntimeError('inconsistent retained history')
            result['historyTruncated']=history['truncated'];result['archive']={'format':'3dbox-prototype-v1','source':'server','coverage':{'start':'partial' if history['truncated'] else 'complete','end':'finished' if world['done'] else 'unfinished','revisionRange':[first,last]},'config':{'seed':seed,'policy':'nearest','sceneId':scene['id'],'scene':scene},'frames':[f['world'] for f in frames]}
        return result
    finally:request(base,root,'DELETE',token=admin)


def summarize(pairs):
    groups=[]
    for condition in ('wait','adaptive'):
        runs=[p[condition] for p in pairs];completed=[r for r in runs if r['status']=='completed']
        groups.append({'condition':condition,'runs':len(runs),'completed':len(completed),'failed':sum(r['status']=='failed' for r in runs),'timedOut':sum(r['status']=='timeout' for r in runs),
                       'completionDuration':stats([r['completionDuration'] for r in completed]),'waitingTicks':stats([r['metrics']['roadblockWaitTicks'] for r in runs]),
                       'acceptedRevocations':sum(sum(v['status']=='accepted' for v in r['revocations']) for r in runs),'takeovers':sum(r['takeoverCompleted'] for r in runs),
                       'reportingRuns':len(runs),'statusDelivered':stats([r['metrics']['reportDelivered']-r['setup']['reporting']['delivered'] for r in runs]),
                       'statusFailed':stats([r['metrics']['reportFailed']-r['setup']['reporting']['failed'] for r in runs]),'dispatchFailed':stats([r['metrics']['dispatchFailed'] for r in runs])})
    both=[p for p in pairs if p['wait']['status']=='completed' and p['adaptive']['status']=='completed']
    return groups,{'bothCompleted':len(both),'durationDifference':stats([p['adaptive']['completionDuration']-p['wait']['completionDuration'] for p in both]),
                   'waitingDifference':stats([p['adaptive']['metrics']['roadblockWaitTicks']-p['wait']['metrics']['roadblockWaitTicks'] for p in pairs])}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--url',default='http://127.0.0.1:8787');p.add_argument('--count',type=int,default=2);p.add_argument('--start-seed',type=int,default=42);p.add_argument('--physics',choices=('rapier','kinematic'),default='rapier');p.add_argument('--duration',type=int,default=80);p.add_argument('--max-ticks',type=int,default=500);p.add_argument('--link-delay',type=int,default=2);p.add_argument('--link-ttl',type=int,default=10);p.add_argument('--loss',type=float,default=0);p.add_argument('--status-interval',type=int,default=2);p.add_argument('--status-max-age',type=int,default=20);p.add_argument('--decision-max-age',type=int,default=20);p.add_argument('--min-blocked-ticks',type=int,default=5);p.add_argument('--cooldown-ticks',type=int,default=30);p.add_argument('--archive-seed',type=int);p.add_argument('--archive-condition',choices=('wait','adaptive'),default='adaptive');a=p.parse_args()
    if not 1<=a.count<=50 or not 0<=a.start_seed<=0xffffffff or a.start_seed+a.count-1>0xffffffff or not 1<=a.duration<=1000 or not 1<=a.max_ticks<=5000 or not 0<=a.min_blocked_ticks<=10000 or not 1<=a.cooldown_ticks<=10000 or not 0<=a.loss<=1 or any(not 1<=v<=10000 for v in (a.link_delay,a.link_ttl,a.status_interval,a.status_max_age,a.decision_max_age)) or a.archive_seed is not None and not a.start_seed<=a.archive_seed<a.start_seed+a.count:p.error('invalid experiment parameters')
    AgentClient('_','_','_',a.url);base=a.url.rstrip('/');identity=runtime(base);scene=make_scene(fetch_scene(base,'industrial-park-v1'));scene['communication'].update({'delay':a.link_delay,'ttl':a.link_ttl,'lossRate':a.loss,'statusInterval':a.status_interval,'statusMaxAge':a.status_max_age,'decisionMaxAge':a.decision_max_age});pairs=[]
    for seed in range(a.start_seed,a.start_seed+a.count):
        pair={'seed':seed}
        for condition in ('wait','adaptive'):
            print(f'seed {seed}: {condition}',file=sys.stderr,flush=True)
            pair[condition]=run_one(base,scene,seed,condition,a.physics,a.duration,a.max_ticks,a.min_blocked_ticks,a.cooldown_ticks,seed==a.archive_seed and condition==a.archive_condition)
            if runtime(base)!=identity:raise RuntimeError('world service changed during comparison')
        if pair['wait']['setup']!=pair['adaptive']['setup']:raise RuntimeError('paired staging diverged')
        pairs.append(pair)
    summary,paired=summarize(pairs);root=Path(__file__).resolve().parents[3];files=('src/engine.js','src/navigation.js','src/sensors.js','server/physics.js','server/world-server.js','sdk/python/roadblock_compare.py','sdk/python/adaptive_coordinator.py','sdk/python/blocked_coordinator.py','sdk/python/link_compare.py','sdk/python/system_compare.py','sdk/python/planner_demo.py','sdk/python/box_agent/__init__.py','sdk/python/box_agent/client.py','sdk/python/box_agent/planner.py','package-lock.json')
    print(json.dumps({'format':'3dbox-roadblock-coordination-v1','config':{'scene':scene,'physicsMode':a.physics,'dispatchMode':'networked_reported','startSeed':a.start_seed,'count':a.count,'duration':a.duration,'maxTicks':a.max_ticks,'minBlockedTicks':a.min_blocked_ticks,'cooldownTicks':a.cooldown_ticks,'archiveSeed':a.archive_seed,'archiveCondition':a.archive_condition if a.archive_seed is not None else None},'serverRuntime':identity,'localSourceSha256':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},'summary':summary,'paired':paired,'pairs':pairs},ensure_ascii=False,separators=(',',':')))

if __name__=='__main__':main()
