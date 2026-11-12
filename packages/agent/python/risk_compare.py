"""Compare ground risk routing in paired fixed-step world-service sessions."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from box_agent import AgentClient
from link_compare import request, runtime, fetch_scene
from system_compare import stats


def initial(world):
    return {'tick':world['tick'],'agents':[{k:a[k] for k in ('id','x','y','battery','status','disabled')} for a in world['agents']],
            'tasks':[{k:t[k] for k in ('id','status','assignee')} for t in world['tasks']]}


def run_one(base,seed,policy,scene,physics,max_ticks,fault_tick,capture):
    data={'seed':seed,'policy':policy,'sceneId':scene['id'],'scene':scene,'physicsMode':physics,'dispatchMode':'rule'}
    created=request(base,'/sessions','POST',data);root='/sessions/'+created['sessionId'];token=created['adminToken'];state=created
    try:
        if created['scene']!=scene: raise RuntimeError('world service changed requested scene')
        start=initial(created['world']);attempted=injected=False
        while not state['world']['done'] and state['world']['tick']<max_ticks:
            tick=state['world']['tick'];count=min(25,max_ticks-tick)
            if fault_tick and tick<fault_tick: count=min(count,fault_tick-tick)
            state=request(base,root+'/step','POST',{'count':count},token)
            if fault_tick and state['world']['tick']==fault_tick and not attempted:
                attempted=True
                try: state=request(base,root+'/fault','POST',{},token);injected=True
                except HTTPError as error:
                    if error.code!=409: raise
        world=state['world'];result={'seed':seed,'policy':policy,'scene':created['scene'],'physicsMode':physics,'dispatchMode':'rule','initial':start,
            'status':'failed' if world['failed'] else 'completed' if world['done'] else 'timeout',
            'faultAttempted':attempted,'faultInjected':injected,'riskMonitoringVersion':world.get('riskMonitoringVersion'),'metrics':state['metrics'],'events':world['events'],'decisions':world['decisions']}
        if world.get('riskMonitoringVersion')!=2: raise RuntimeError('world service lacks segment-based risk tracking')
        if capture:
            history=request(base,root+'/history?after=-1',token=token);frames=history['frames'];first,last=frames[0]['revision'],frames[-1]['revision']
            if [x['revision'] for x in frames]!=list(range(first,last+1)) or frames[-1]['world']!=world: raise RuntimeError('inconsistent retained history')
            result['historyTruncated']=history['truncated'];result['archive']={'format':'3dbox-prototype-v1','source':'server',
                'coverage':{'start':'partial' if history['truncated'] else 'complete','end':'finished' if world['done'] else 'unfinished','revisionRange':[first,last]},
                'config':{'seed':seed,'policy':policy,'sceneId':scene['id'],'scene':scene},'frames':[x['world'] for x in frames]}
        return result
    finally: request(base,root,'DELETE',token=token)


def summarize(pairs,scene,physics):
    groups=[];ids={'air':set(),'ground':set()}
    for a in scene['agents']:
        mobility=a.get('mobility','air' if a['role']=='drone' else 'ground')
        ids[mobility].update(a['role']+'-'+str(i) for i in range(1,a['count']+1))
    def entries(run,kind): return sum(e.get('kind')=='risk_zone_entered' and e.get('agentId') in ids[kind] for e in run['events'])
    for condition in ('monitor','avoid'):
        runs=[p[condition] for p in pairs];done=[r for r in runs if r['status']=='completed']
        groups.append({'condition':condition,'runs':len(runs),'completed':len(done),'failed':sum(r['status']=='failed' for r in runs),
            'timedOut':sum(r['status']=='timeout' for r in runs),'faultsInjected':sum(r['faultInjected'] for r in runs),
            'groundEntries':stats([entries(r,'ground') for r in runs]),'airEntries':stats([entries(r,'air') for r in runs]),
            'completionTicks':stats([r['metrics']['ticks'] for r in done]),'distance':stats([r['metrics']['distance'] for r in runs]),
            'energyUsed':stats([r['metrics']['energyUsed'] for r in runs])})
    both=[p for p in pairs if p['monitor']['status']=='completed' and p['avoid']['status']=='completed']
    paired={'bothCompleted':len(both),'tickDifference':stats([p['avoid']['metrics']['ticks']-p['monitor']['metrics']['ticks'] for p in both]),
        'groundEntryDifference':stats([entries(p['avoid'],'ground')-entries(p['monitor'],'ground') for p in pairs]),
        'airEntryDifference':stats([entries(p['avoid'],'air')-entries(p['monitor'],'air') for p in pairs]),
        'distanceDifference':stats([p['avoid']['metrics']['distance']-p['monitor']['metrics']['distance'] for p in pairs]),
        'energyDifference':stats([p['avoid']['metrics']['energyUsed']-p['monitor']['metrics']['energyUsed'] for p in pairs])}
    contacts=[stats([p[k]['metrics']['collisionContacts'] for p in pairs]) if physics=='rapier' else None for k in ('monitor','avoid')]
    return groups,paired,contacts


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--url',default='http://127.0.0.1:8787');p.add_argument('--policy',choices=('nearest','battery'),default='nearest');p.add_argument('--physics',choices=('rapier','kinematic'),default='rapier');p.add_argument('--count',type=int,default=2);p.add_argument('--start-seed',type=int,default=42);p.add_argument('--max-ticks',type=int,default=1000);p.add_argument('--fault-tick',type=int,default=0);p.add_argument('--archive-seed',type=int);a=p.parse_args()
    if not 1<=a.count<=50 or not 0<=a.start_seed<=0xffffffff or a.start_seed+a.count-1>0xffffffff or not 1<=a.max_ticks<=10000 or not 0<=a.fault_tick<=a.max_ticks or a.archive_seed is not None and not a.start_seed<=a.archive_seed<a.start_seed+a.count: p.error('invalid experiment parameters')
    AgentClient('_','_','_',a.url);base=a.url.rstrip('/');identity=runtime(base);scene=fetch_scene(base,'industrial-park-risk-detour-v1');pairs=[]
    if not scene.get('riskZones'): raise RuntimeError('risk scenario has no zones')
    for seed in range(a.start_seed,a.start_seed+a.count):
        pair={'seed':seed}
        for condition in ('monitor','avoid'):
            print(f'seed {seed}: {condition}',file=sys.stderr,flush=True);variant=copy.deepcopy(scene);variant['riskNavigation']=condition
            pair[condition]=run_one(base,seed,a.policy,variant,a.physics,a.max_ticks,a.fault_tick,seed==a.archive_seed)
            if runtime(base)!=identity: raise RuntimeError('world service changed during comparison')
        if pair['monitor']['initial']!=pair['avoid']['initial']: raise RuntimeError('paired initial states differ')
        pairs.append(pair)
    summary,paired,contacts=summarize(pairs,scene,a.physics);root=Path(__file__).resolve().parents[3]
    files=('src/engine.js','src/navigation.js','src/sensors.js','server/physics.js','server/world-server.js','sdk/python/risk_compare.py','sdk/python/link_compare.py','sdk/python/system_compare.py')
    print(json.dumps({'format':'3dbox-server-risk-comparison-v1','config':{'sceneId':scene['id'],'scene':scene,'policy':a.policy,'physicsMode':a.physics,'dispatchMode':'rule','startSeed':a.start_seed,'count':a.count,'maxTicks':a.max_ticks,'faultTick':a.fault_tick or None,'archiveSeed':a.archive_seed},'serverRuntime':identity,'localSourceSha256':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},'summary':summary,'paired':paired,'contacts':contacts,'pairs':pairs},ensure_ascii=False,separators=(',',':')))

if __name__=='__main__': main()
