"""Run controlled link comparisons in separate local world-service sessions."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import Request, urlopen

from box_agent import AgentClient
from planner_demo import SCENES
from system_compare import stats


def request(base,path,method='GET',data=None,token=None):
    headers={'content-type':'application/json'}
    if token: headers['authorization']='Bearer '+token
    payload=None if data is None else json.dumps(data).encode()
    with urlopen(Request(base+path,data=payload,method=method,headers=headers),timeout=30) as response:
        return json.load(response)


def runtime(base):
    health=request(base,'/health');info=health.get('runtime')
    if not health.get('ok') or not isinstance(info,dict) or not isinstance(info.get('instanceId'),str):
        raise RuntimeError('world service lacks runtime metadata')
    return info


def fetch_scene(base,scene_id):
    created=request(base,'/sessions','POST',{'sceneId':scene_id})
    try:
        return created['scene']
    finally:
        request(base,'/sessions/'+created['sessionId'],'DELETE',token=created['adminToken'])


def run_one(base,seed,policy,scene_id,scene,physics,max_ticks,capture):
    data={'seed':seed,'policy':policy,'sceneId':scene_id,'physicsMode':physics,'dispatchMode':'networked'}
    if scene is not None: data['scene']=scene
    created=request(base,'/sessions','POST',data);root='/sessions/'+created['sessionId'];token=created['adminToken'];state=created
    try:
        if scene is not None and created['scene']!=scene: raise RuntimeError('world service changed requested scene')
        while not state['world']['done'] and state['world']['tick']<max_ticks:
            state=request(base,root+'/step','POST',{'count':min(25,max_ticks-state['world']['tick'])},token)
        world=state['world'];result={'seed':seed,'policy':policy,'scene':created['scene'],'physicsMode':physics,'dispatchMode':'networked',
            'status':'failed' if world['failed'] else 'completed' if world['done'] else 'timeout',
            'metrics':state['metrics'],'events':world['events']}
        if capture:
            history=request(base,root+'/history?after=-1',token=token);frames=history['frames'];first,last=frames[0]['revision'],frames[-1]['revision']
            if [x['revision'] for x in frames]!=list(range(first,last+1)) or frames[-1]['world']!=world: raise RuntimeError('inconsistent retained history')
            result['historyTruncated']=history['truncated'];result['archive']={'format':'3dbox-prototype-v1','source':'server',
                'coverage':{'start':'partial' if history['truncated'] else 'complete','end':'finished' if world['done'] else 'unfinished','revisionRange':[first,last]},
                'config':{'seed':seed,'policy':policy,'sceneId':scene_id,'scene':created['scene']},'frames':[x['world'] for x in frames]}
        return result
    finally:
        request(base,root,'DELETE',token=token)


def summarize(pairs):
    groups=[]
    for condition in ('base','delay','loss'):
        runs=[p[condition] for p in pairs];done=[r for r in runs if r['status']=='completed']
        failures=lambda r,reason:sum(e.get('kind')=='dispatch_failed' and e.get('reason')==reason for e in r['events'])
        groups.append({'condition':condition,'runs':len(runs),'completed':len(done),'failed':sum(r['status']=='failed' for r in runs),
            'timedOut':sum(r['status']=='timeout' for r in runs),'completionTicks':stats([r['metrics']['ticks'] for r in done]),
            'dispatchSent':stats([r['metrics']['dispatchSent'] for r in runs]),'dispatchFailed':stats([r['metrics']['dispatchFailed'] for r in runs]),
            'dropped':stats([failures(r,'dropped') for r in runs]),'expired':stats([failures(r,'expired') for r in runs]),'stale':stats([failures(r,'stale_observation') for r in runs])})
    paired={}
    for condition in ('delay','loss'):
        done=[p for p in pairs if p['base']['status']=='completed' and p[condition]['status']=='completed']
        paired[condition]={'bothCompleted':len(done),'completionTickDifference':stats([p[condition]['metrics']['ticks']-p['base']['metrics']['ticks'] for p in done]),
            'dispatchFailureDifference':stats([p[condition]['metrics']['dispatchFailed']-p['base']['metrics']['dispatchFailed'] for p in pairs])}
    return groups,paired


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--url',default='http://127.0.0.1:8787');p.add_argument('--scene',choices=SCENES,default='industrial-park-parallel-v1');p.add_argument('--policy',choices=('nearest','battery'),default='nearest');p.add_argument('--physics',choices=('rapier','kinematic'),default='rapier');p.add_argument('--count',type=int,default=2);p.add_argument('--start-seed',type=int,default=42);p.add_argument('--delay',type=int,default=12);p.add_argument('--loss',type=float,default=.3);p.add_argument('--max-ticks',type=int,default=1000);p.add_argument('--ttl',type=int,help='instruction TTL for all conditions');p.add_argument('--decision-max-age',type=int,help='decision observation age limit for all conditions');p.add_argument('--archive-seed',type=int);p.add_argument('--archive-condition',choices=('base','delay','loss'),default='base');a=p.parse_args()
    if not 1<=a.count<=50 or not 0<=a.start_seed<=0xffffffff or a.start_seed+a.count-1>0xffffffff or not 1<=a.delay<=10000 or not 0<=a.loss<=1 or not 1<=a.max_ticks<=10000 or any(v is not None and not 1<=v<=10000 for v in (a.ttl,a.decision_max_age)) or a.archive_seed is not None and not a.start_seed<=a.archive_seed<a.start_seed+a.count: p.error('invalid experiment parameters')
    AgentClient('_','_','_',a.url);base=a.url.rstrip('/');identity=runtime(base);scene=fetch_scene(base,a.scene);pairs=[]
    if a.ttl is not None: scene['communication']['ttl']=a.ttl
    if a.decision_max_age is not None: scene['communication']['decisionMaxAge']=a.decision_max_age
    if runtime(base)!=identity: raise RuntimeError('world service changed while loading scene')
    for seed in range(a.start_seed,a.start_seed+a.count):
        pair={'seed':seed}
        for condition in ('base','delay','loss'):
            print(f'seed {seed}: {condition}',file=sys.stderr,flush=True)
            variant=copy.deepcopy(scene)
            if variant is not None and condition=='delay': variant['communication']['delay']=a.delay
            if variant is not None and condition=='loss': variant['communication']['lossRate']=a.loss
            result=run_one(base,seed,a.policy,a.scene,variant,a.physics,a.max_ticks,seed==a.archive_seed and condition==a.archive_condition)
            if runtime(base)!=identity: raise RuntimeError('world service changed during comparison')
            pair[condition]=result
        pairs.append(pair)
    summary,paired=summarize(pairs);root=Path(__file__).resolve().parents[3]
    files=('src/engine.js','src/navigation.js','src/sensors.js','server/physics.js','server/world-server.js','sdk/python/link_compare.py','sdk/python/system_compare.py')
    print(json.dumps({'format':'3dbox-server-link-comparison-v1','config':{'sceneId':a.scene,'scene':scene,'policy':a.policy,'physicsMode':a.physics,'dispatchMode':'networked','startSeed':a.start_seed,'count':a.count,'delay':a.delay,'lossRate':a.loss,'maxTicks':a.max_ticks,'ttlOverride':a.ttl,'decisionMaxAgeOverride':a.decision_max_age,'archiveSeed':a.archive_seed,'archiveCondition':a.archive_condition if a.archive_seed is not None else None},'serverRuntime':identity,'localSourceSha256':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},'summary':summary,'paired':paired,'pairs':pairs},ensure_ascii=False,separators=(',',':')))

if __name__=='__main__': main()
