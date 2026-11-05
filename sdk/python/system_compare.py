"""Compare rule policies in separate fixed-step world-service sessions."""
import argparse
import hashlib
import json
from pathlib import Path
from math import sqrt
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from box_agent import AgentClient
from planner_demo import SCENES


def stats(values):
    if not values: return {'n':0,'mean':None,'sd':None}
    average=sum(values)/len(values)
    return {'n':len(values),'mean':average,
            'sd':sqrt(sum((v-average)**2 for v in values)/(len(values)-1)) if len(values)>1 else 0}


def availability(run):
    activity=run['metrics'].get('activity')
    if activity is None: return None
    total=activity['available']+activity['unavailable']
    return activity['available']/total if total else None


def summarize(pairs):
    groups=[]
    for policy in ('nearest','battery'):
        runs=[p[policy] for p in pairs]
        completed=[r for r in runs if r['status']=='completed']
        measured=[r['metrics']['faultRecovery'] for r in runs if r['metrics'].get('faultRecovery') is not None]
        recovery=[record for item in measured for record in item['records']]
        boundaries=[r['metrics']['boundaryInterventions'] for r in runs if r.get('boundaryMonitoringVersion')==1 and type(r['metrics'].get('boundaryInterventions')) is int]
        depletions=[r['metrics']['energyDepletions'] for r in runs if type(r['metrics'].get('energyDepletions')) is int]
        risk=lambda version: [r['metrics']['riskZoneEntries'] for r in runs if r.get('riskMonitoringVersion')==version and r['metrics'].get('riskZoneEntries') is not None]
        unknown=[r['metrics']['riskZoneEntries'] for r in runs if r.get('riskMonitoringVersion') is None and r['metrics'].get('riskZoneEntries') is not None]
        groups.append({'policy':policy,'availability':stats([v for r in runs if (v:=availability(r)) is not None]),'risk':{'sampled':stats(risk(1)),'segments':stats(risk(2)),'unknown':stats(unknown),'unmeasured':sum(r['metrics'].get('riskZoneEntries') is None for r in runs)},'boundary':{'measuredRuns':len(boundaries),'interventionRuns':sum(v>0 for v in boundaries),'interventions':stats(boundaries)},'depletion':{'measuredRuns':len(depletions),'affectedRuns':sum(v>0 for v in depletions),'events':stats(depletions)},'runs':len(runs),'completed':len(completed),
                       'failed':sum(r['status']=='failed' for r in runs),
                       'timedOut':sum(r['status']=='timeout' for r in runs),
                       'faultsAttempted':sum(r['faultAttempted'] for r in runs),
                       'faultsInjected':sum(r['faultInjected'] for r in runs),
                       'recovery':{'measuredRuns':len(measured),'faults':len(recovery),
                                   'reassigned':sum(x['assignedTick'] is not None for x in recovery),
                                   'started':sum(x['startedTick'] is not None for x in recovery),
                                   'assignmentDelay':stats([x['assignmentDelay'] for x in recovery if x['assignmentDelay'] is not None]),
                                   'startDelay':stats([x['startDelay'] for x in recovery if x['startDelay'] is not None])},
                       'completionTicks':stats([r['metrics']['ticks'] for r in completed]),
                       'energy':stats([r['metrics']['energyUsed'] for r in completed]),
                       'contacts':stats([r['metrics']['collisionContacts'] for r in runs]) if runs[0]['config']['physicsMode']=='rapier' else None})
    both=[p for p in pairs if p['nearest']['status']=='completed' and p['battery']['status']=='completed']
    return groups,{'bothCompleted':len(both),
                   'tickDifference':stats([p['battery']['metrics']['ticks']-p['nearest']['metrics']['ticks'] for p in both]),
                   'energyDifference':stats([p['battery']['metrics']['energyUsed']-p['nearest']['metrics']['energyUsed'] for p in both]),
                   'availabilityDifference':stats([availability(p['battery'])-availability(p['nearest']) for p in pairs if availability(p['battery']) is not None and availability(p['nearest']) is not None]),
                   'boundaryDifference':stats([p['battery']['metrics']['boundaryInterventions']-p['nearest']['metrics']['boundaryInterventions'] for p in pairs if all(p[k].get('boundaryMonitoringVersion')==1 and type(p[k]['metrics'].get('boundaryInterventions')) is int for k in ('nearest','battery'))]),
                   'depletionDifference':stats([p['battery']['metrics']['energyDepletions']-p['nearest']['metrics']['energyDepletions'] for p in pairs if all(type(p[k]['metrics'].get('energyDepletions')) is int for k in ('nearest','battery'))]),
                   'riskDifferences':{name:stats([p['battery']['metrics']['riskZoneEntries']-p['nearest']['metrics']['riskZoneEntries'] for p in pairs if p['battery'].get('riskMonitoringVersion')==version and p['nearest'].get('riskMonitoringVersion')==version and p['battery']['metrics'].get('riskZoneEntries') is not None and p['nearest']['metrics'].get('riskZoneEntries') is not None]) for name,version in (('sampled',1),('segments',2))}}


def run_one(base, seed, policy, scene, mode, fault_tick, max_ticks, capture=False):
    def request(path,method='GET',data=None,token=None):
        headers={'content-type':'application/json'}
        if token: headers['authorization']='Bearer '+token
        payload=None if data is None else json.dumps(data).encode()
        with urlopen(Request(base+path,data=payload,method=method,headers=headers),timeout=30) as response:
            return json.load(response)
    created=request('/sessions','POST',{'seed':seed,'policy':policy,'sceneId':scene,'physicsMode':mode,'dispatchMode':'rule'})
    root='/sessions/'+created['sessionId'];admin=created['adminToken'];state=created
    attempted=injected=False;reason=None
    try:
        while not state['world']['done'] and state['world']['tick']<max_ticks:
            tick=state['world']['tick'];count=min(25,max_ticks-tick)
            if fault_tick and tick<fault_tick: count=min(count,fault_tick-tick)
            state=request(root+'/step','POST',{'count':count},admin)
            if fault_tick and state['world']['tick']==fault_tick and not attempted:
                attempted=True
                try:
                    state=request(root+'/fault','POST',{},admin);injected=True
                except HTTPError as error:
                    if error.code!=409: raise
                    reason='no_active_task'
        world=state['world']
        result={'seed':seed,'policy':policy,'config':{'sceneId':scene,'physicsMode':mode,'dispatchMode':'rule','faultTick':fault_tick,'maxTicks':max_ticks},
                'status':'failed' if world['failed'] else 'completed' if world['done'] else 'timeout',
                'faultAttempted':attempted,'faultInjected':injected,'faultReason':reason,
                'metrics':state['metrics'],'events':world['events'],'decisions':world['decisions']}
        if world.get('boundaryMonitoringVersion') is not None: result['boundaryMonitoringVersion']=world['boundaryMonitoringVersion']
        if world.get('riskMonitoringVersion') is not None: result['riskMonitoringVersion']=world['riskMonitoringVersion']
        if capture:
            history=request(root+'/history?after=-1',token=admin);saved=history['frames']
            first,last=saved[0]['revision'],saved[-1]['revision']
            if [f['revision'] for f in saved]!=list(range(first,last+1)) or saved[-1]['world']!=world:
                raise RuntimeError('incomplete or inconsistent retained history')
            result['historyTruncated']=history['truncated']
            result['archive']={'format':'3dbox-prototype-v1','source':'server',
                'coverage':{'start':'complete' if first==0 else 'partial','end':'finished' if world['done'] else 'unfinished','revisionRange':[first,last]},
                'config':{'seed':seed,'policy':policy,'sceneId':scene,'scene':created['scene']},'frames':[f['world'] for f in saved]}
        return result,created['scene']
    finally:
        request(root,'DELETE',token=admin)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8787')
    parser.add_argument('--count',type=int,default=2)
    parser.add_argument('--start-seed',type=int,default=42)
    parser.add_argument('--scene',choices=SCENES+('industrial-park-risk-v1',),default='industrial-park-parallel-v1')
    parser.add_argument('--physics',choices=('rapier','kinematic'),default='rapier')
    parser.add_argument('--fault-tick',type=int,default=3,help='0 disables fault injection')
    parser.add_argument('--max-ticks',type=int,default=1000)
    parser.add_argument('--archive-seed',type=int,help='retain available snapshots for one seed')
    parser.add_argument('--archive-policy',choices=('nearest','battery'),default='nearest')
    args=parser.parse_args()
    if not 1<=args.count<=50 or not 0<=args.start_seed<=0xffffffff or args.start_seed+args.count-1>0xffffffff or not 1<=args.max_ticks<=10000 or not 0<=args.fault_tick<=args.max_ticks:
        parser.error('invalid count, seed or tick limits')
    if args.archive_seed is not None and not args.start_seed<=args.archive_seed<args.start_seed+args.count:
        parser.error('archive seed must belong to the comparison')
    AgentClient('_','_','_',args.url)
    base=args.url.rstrip('/')
    def runtime():
        with urlopen(base+'/health',timeout=5) as response:
            health=json.load(response)
        info=health.get('runtime')
        if not health.get('ok') or not isinstance(info,dict) or not isinstance(info.get('instanceId'),str):
            raise SystemExit('world service lacks runtime metadata; restart the current service')
        return info
    server_runtime=runtime()
    pairs=[];actual_scene=None
    for seed in range(args.start_seed,args.start_seed+args.count):
        pair={'seed':seed}
        for policy in ('nearest','battery'):
            print(f'seed {seed}: {policy}',file=sys.stderr,flush=True)
            capture=seed==args.archive_seed and policy==args.archive_policy
            pair[policy],scene=run_one(base,seed,policy,args.scene,args.physics,args.fault_tick,args.max_ticks,capture)
            if runtime()!=server_runtime: raise SystemExit('world service changed during comparison')
            if actual_scene is not None and actual_scene!=scene: raise SystemExit('world service scene changed during comparison')
            actual_scene=scene
        pairs.append(pair)
    summary,paired=summarize(pairs)
    root=Path(__file__).resolve().parents[2]
    files=('examples/scenes/shore-surface.json','examples/scenes/shore-sea-state.json','examples/scenes/shore-echelons.json','examples/scenes/shore-rescue.json','src/echelons.js','src/engine.js','src/surface-domain.js','src/navigation.js','src/sensors.js','server/physics.js','server/world-server.js','sdk/python/system_compare.py')
    hashes={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files}
    print(json.dumps({'format':'3dbox-system-comparison-v1','config':{'count':args.count,'startSeed':args.start_seed,'sceneId':args.scene,'scene':actual_scene,'physicsMode':args.physics,'dispatchMode':'rule','faultTick':args.fault_tick,'maxTicks':args.max_ticks,'archiveSeed':args.archive_seed,'archivePolicy':args.archive_policy if args.archive_seed is not None else None},'serverRuntime':server_runtime,'localSourceSha256':hashes,'summary':summary,'paired':paired,'pairs':pairs},ensure_ascii=False,indent=None if args.archive_seed is not None else 2,separators=(',',':') if args.archive_seed is not None else None))


if __name__=='__main__':
    main()
