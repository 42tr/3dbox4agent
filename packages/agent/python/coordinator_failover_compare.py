"""Compare supervised coordinator failure and control runs under paired seeds."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
from statistics import mean, stdev
from urllib.request import urlopen

from box_agent import AgentClient
from planner_demo import SCENES
from scene_input import load_scene_file

HERE = Path(__file__).resolve().parent


def stats(values):
    return {'n':len(values), 'mean':mean(values) if values else None,
            'sd':stdev(values) if len(values)>1 else 0 if values else None}


def recovery(run):
    events = run.get('controlEvents', [])
    detected = next((e for e in events if e.get('kind')=='coordinator_failure_detected'), None)
    reconfigured = next((e for e in events if e.get('kind')=='coordinator_shards_reassigned'), None)
    if not detected or not reconfigured:
        return {'detectedTick':detected['tick'] if detected else None, 'reconfiguredTick':None,
                'reconfigurationTicks':None, 'reconfigurationMs':None, 'firstAssignmentTick':None,
                'firstAssignmentDelayTicks':None, 'assignmentBasis':None}
    prior = set(reconfigured['priorDecisionIds']) if 'priorDecisionIds' in reconfigured else None
    candidates = [d for d in run['decisions'] if (prior is None or d.get('requestId') not in prior) and d.get('status')=='accepted'
                  and d.get('coordinatorId') in reconfigured['coordinatorIds']
                  and d.get('submittedTick',d.get('appliedTick',-1))>=reconfigured['tick']
                  and d.get('appliedTick',-1)>=reconfigured['tick']]
    first = min((d['appliedTick'] for d in candidates),default=None)
    return {'detectedTick':detected['tick'], 'reconfiguredTick':reconfigured['tick'],
            'reconfigurationTicks':reconfigured['tick']-detected['tick'],
            'reconfigurationMs':reconfigured.get('elapsedMs'), 'firstAssignmentTick':first,
            'firstAssignmentDelayTicks':first-detected['tick'] if first is not None else None,
            'assignmentBasis':'post_snapshot' if prior is not None else 'tick_only'}


def summarize(pairs):
    groups=[]
    for name in ('control','failure'):
        runs=[p[name] for p in pairs];done=[r for r in runs if r['status']=='completed']
        groups.append({'condition':name,'runs':len(runs),'completed':len(done),
                       'failed':sum(r['status']=='failed' for r in runs),
                       'timedOut':sum(r['status']=='timeout' for r in runs),
                       'completionTicks':stats([r['metrics']['ticks'] for r in done]),
                       'elapsedSeconds':stats([r['elapsedSeconds'] for r in done]),
                       'injected':sum(r['coordinatorFaultInjected'] for r in runs),
                       'reconfigured':sum(r['recovery']['reconfiguredTick'] is not None for r in runs),
                       'firstAssignmentObserved':sum(r['recovery']['firstAssignmentTick'] is not None for r in runs),
                       'postSnapshotMeasured':sum(r['recovery']['assignmentBasis']=='post_snapshot' for r in runs),
                       'reconfigurationTicks':stats([r['recovery']['reconfigurationTicks'] for r in runs if r['recovery']['reconfigurationTicks'] is not None]),
                       'reconfigurationMs':stats([r['recovery']['reconfigurationMs'] for r in runs if r['recovery']['reconfigurationMs'] is not None]),
                       'firstAssignmentDelayTicks':stats([r['recovery']['firstAssignmentDelayTicks'] for r in runs if r['recovery']['firstAssignmentDelayTicks'] is not None])})
    both=[p for p in pairs if p['control']['status']=='completed' and p['failure']['status']=='completed' and p['failure']['coordinatorFaultInjected']]
    return groups,{'bothCompletedAndInjected':len(both),
                   'tickDifference':stats([p['failure']['metrics']['ticks']-p['control']['metrics']['ticks'] for p in both]),
                   'elapsedDifference':stats([p['failure']['elapsedSeconds']-p['control']['elapsedSeconds'] for p in both])}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8787')
    scene_choice=parser.add_mutually_exclusive_group()
    scene_choice.add_argument('--scene',choices=SCENES,default='shore-coordination-v1')
    scene_choice.add_argument('--scene-file',type=Path,help='local scene JSON or YAML, at most 60 KB')
    parser.add_argument('--physics',choices=('kinematic','rapier'),default='kinematic')
    parser.add_argument('--count',type=int,default=2)
    parser.add_argument('--start-seed',type=int,default=42)
    parser.add_argument('--clock',choices=('step','realtime'),default='realtime')
    parser.add_argument('--speed',type=int,choices=(1,2,5),default=2)
    parser.add_argument('--dispatch',choices=('external','networked_external','networked_reported'),default='external')
    parser.add_argument('--link-profile',choices=('default','long'),default='default')
    parser.add_argument('--coordinator-fault-tick',type=int,default=15)
    parser.add_argument('--reconfigure-delay-ms',type=int,default=300)
    parser.add_argument('--max-ticks',type=int,default=1000)
    parser.add_argument('--timeout',type=float,default=60)
    parser.add_argument('--archive-seed',type=int,help='retain both runs for one selected seed')
    args=parser.parse_args()
    if not 1<=args.count<=10 or not 0<=args.start_seed<=0xffffffff or args.start_seed+args.count-1>0xffffffff or not 1<=args.max_ticks<=10000 or not 1<=args.coordinator_fault_tick<=args.max_ticks or not 0<=args.reconfigure_delay_ms<=5000 or not math.isfinite(args.timeout) or not 2<=args.timeout<=300 or (args.archive_seed is not None and args.archive_seed not in range(args.start_seed,args.start_seed+args.count)):
        parser.error('invalid seeds, timing, count or archive selection')
    scene_hash=None
    if args.scene_file is not None:
        try:
            _, scene_hash = load_scene_file(args.scene_file)
        except (OSError,ValueError,UnicodeDecodeError) as error:
            parser.error(f'invalid scene file: {error}')
    AgentClient('_','_','_',args.url)
    def health():
        with urlopen(args.url.rstrip('/')+'/health',timeout=10) as response:
            return json.load(response)['runtime']
    runtime=health();pairs=[];source=None;experiment_scene=None
    for seed in range(args.start_seed,args.start_seed+args.count):
        pair={'seed':seed}
        for condition in ('control','failure'):
            print(f'seed {seed}: {condition}',file=sys.stderr,flush=True)
            if health()!=runtime:
                raise RuntimeError('world service changed during comparison')
            if args.scene_file is not None and hashlib.sha256(args.scene_file.read_bytes()).hexdigest()!=scene_hash:
                raise RuntimeError('scene file changed during comparison')
            cmd=[sys.executable,str(HERE/'multi_agent_demo.py'),'--url',args.url,*(['--scene-file',str(args.scene_file)] if args.scene_file is not None else ['--scene',args.scene]),'--physics',args.physics,'--seed',str(seed),
                 '--coordinators','2','--fault','none','--clock',args.clock,'--speed',str(args.speed),
                 '--dispatch',args.dispatch,'--link-profile',args.link_profile,'--max-ticks',str(args.max_ticks),
                 '--timeout',str(args.timeout),'--reconfigure-delay-ms',str(args.reconfigure_delay_ms)]
            if condition=='failure':cmd+=['--coordinator-fault-tick',str(args.coordinator_fault_tick)]
            if seed==args.archive_seed:cmd+=['--archive']
            child=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=args.timeout+30)
            try:
                run=json.loads(child.stdout)
                if child.returncode not in (0,1) or run['format']!='3dbox-multiprocess-v1' or (child.returncode==0)!=(run['status']=='completed') or run['config']['seed']!=seed:
                    raise ValueError()
                if args.scene_file is not None and run['config'].get('sceneFileSha256') != scene_hash:
                    raise RuntimeError('scene file changed during comparison')
                if source is not None and source!=run['sourceSha256']:
                    raise RuntimeError('experiment sources changed during comparison')
                source=run['sourceSha256']
                if experiment_scene is not None and run['scene']!=experiment_scene:
                    raise RuntimeError('scene changed during comparison')
                experiment_scene=run['scene']
            except (ValueError,KeyError,TypeError):
                raise RuntimeError('experiment process failed without a valid report') from None
            if args.scene_file is not None and hashlib.sha256(args.scene_file.read_bytes()).hexdigest()!=scene_hash:
                raise RuntimeError('scene file changed during comparison')
            run.pop('processLogs',None)
            run['recovery']=recovery(run)
            pair[condition]=run
        pairs.append(pair)
    if health()!=runtime:raise RuntimeError('world service changed during comparison')
    summary,paired=summarize(pairs)
    print(json.dumps({'format':'3dbox-coordinator-recovery-comparison-v1','config':{'count':args.count,'startSeed':args.start_seed,'sceneId':experiment_scene['id'],'scene':experiment_scene,'sceneFileSha256':scene_hash,'physicsMode':args.physics,'clock':args.clock,'speed':args.speed,'dispatchMode':args.dispatch,'linkProfile':args.link_profile,'coordinatorFaultTick':args.coordinator_fault_tick,'reconfigureDelayMs':args.reconfigure_delay_ms,'maxTicks':args.max_ticks,'wallTimeoutSeconds':args.timeout,'archiveSeed':args.archive_seed},'serverRuntime':runtime,'sourceSha256':source,'summary':summary,'paired':paired,'pairs':pairs},ensure_ascii=False,indent=None if args.archive_seed is not None else 2,separators=(',',':') if args.archive_seed is not None else None))


if __name__=='__main__':
    try:main()
    except (OSError,RuntimeError,subprocess.TimeoutExpired) as error:
        print(f'comparison failed: {error}',file=sys.stderr)
        raise SystemExit(1)
