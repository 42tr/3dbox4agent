"""Compare HTTP polling and scoped observation streams in separate paired runs."""
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


def log_evidence(run):
    logs=run.get('processLogs',[])
    return {'processes':len(logs),
            'connectedObserved':sum('观察流已连接' in x['output'] for x in logs),
            'fallbackObserved':sum('观察流已断开，改用 HTTP 观察' in x['output'] for x in logs),
            'truncatedLogs':sum(bool(x.get('truncated')) for x in logs)}


def summarize(pairs):
    groups=[]
    for mode in ('http','stream'):
        runs=[p[mode] for p in pairs];done=[r for r in runs if r['status']=='completed']
        measured=[r['observationTransportMetrics'] for r in runs if r.get('observationTransportMetrics') is not None]
        transport={'measuredRuns':len(measured)}
        for key in ('httpResponses','httpBodyBytes','streamMessages','streamPayloadBytes'):
            transport[key]=sum(t[role][key] for t in measured for role in ('agent','coordinator'))
        groups.append({'mode':mode,'runs':len(runs),'completed':len(done),
                       'failed':sum(r['status']=='failed' for r in runs),
                       'timedOut':sum(r['status']=='timeout' for r in runs),
                       'ticks':stats([r['metrics']['ticks'] for r in done]),
                       'elapsedSeconds':stats([r['elapsedSeconds'] for r in done]),
                       'transport':transport})
    complete=[p for p in pairs if p['http']['status']=='completed' and p['stream']['status']=='completed']
    return groups,{'bothCompleted':len(complete),
                   'tickDifference':stats([p['stream']['metrics']['ticks']-p['http']['metrics']['ticks'] for p in complete]),
                   'elapsedDifference':stats([p['stream']['elapsedSeconds']-p['http']['elapsedSeconds'] for p in complete])}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8787')
    scenes=parser.add_mutually_exclusive_group()
    scenes.add_argument('--scene',choices=SCENES,default='industrial-park-parallel-v1')
    scenes.add_argument('--scene-file',type=Path)
    parser.add_argument('--physics',choices=('kinematic','rapier'),default='kinematic')
    parser.add_argument('--clock',choices=('step','realtime'),default='step')
    parser.add_argument('--speed',type=int,choices=(1,2,5),default=1)
    parser.add_argument('--dispatch',choices=('external','networked_external','networked_reported'),default='external')
    parser.add_argument('--link-profile',choices=('default','long'),default='default')
    parser.add_argument('--count',type=int,default=2)
    parser.add_argument('--start-seed',type=int,default=42)
    parser.add_argument('--max-ticks',type=int,default=1000)
    parser.add_argument('--timeout',type=float,default=60)
    parser.add_argument('--archive-seed',type=int)
    args=parser.parse_args()
    if not 1<=args.count<=10 or not 0<=args.start_seed<=0xffffffff or args.start_seed+args.count-1>0xffffffff or not 1<=args.max_ticks<=10000 or not math.isfinite(args.timeout) or not 2<=args.timeout<=300 or (args.archive_seed is not None and args.archive_seed not in range(args.start_seed,args.start_seed+args.count)):
        parser.error('invalid seeds, count or limits')
    try:
        import box_agent.observation_reader  # noqa: F401
    except ImportError as error:
        parser.error(f'stream dependencies required: {error}')
    scene_hash=None
    if args.scene_file is not None:
        try:
            _,scene_hash=load_scene_file(args.scene_file)
        except (OSError,ValueError,UnicodeDecodeError) as error:
            parser.error(f'invalid scene file: {error}')
    AgentClient('_','_','_',args.url)
    def health():
        with urlopen(args.url.rstrip('/')+'/health',timeout=10) as response:
            return json.load(response)['runtime']
    runtime=health();pairs=[];sources=None;scene=None
    for seed in range(args.start_seed,args.start_seed+args.count):
        pair={'seed':seed}
        for mode in ('http','stream'):
            print(f'seed {seed}: {mode}',file=sys.stderr,flush=True)
            if health()!=runtime:
                raise RuntimeError('world service changed during comparison')
            if args.scene_file is not None and hashlib.sha256(args.scene_file.read_bytes()).hexdigest()!=scene_hash:
                raise RuntimeError('scene file changed during comparison')
            cmd=[sys.executable,str(HERE/'multi_agent_demo.py'),'--url',args.url,
                 *(['--scene-file',str(args.scene_file)] if args.scene_file is not None else ['--scene',args.scene]),
                 '--seed',str(seed),'--physics',args.physics,'--clock',args.clock,'--speed',str(args.speed),
                 '--dispatch',args.dispatch,'--link-profile',args.link_profile,'--max-ticks',str(args.max_ticks),
                 '--timeout',str(args.timeout),'--fault','none',*(['--observe-stream'] if mode=='stream' else []),
                 *(['--archive'] if seed==args.archive_seed else [])]
            child=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=args.timeout+30)
            try:
                run=json.loads(child.stdout)
                if child.returncode not in (0,1) or run['format']!='3dbox-multiprocess-v1' or (child.returncode==0)!=(run['status']=='completed') or run['config']['seed']!=seed or run['config']['observationTransport']!=mode:
                    raise ValueError()
                if args.scene_file is not None and run['config'].get('sceneFileSha256')!=scene_hash:
                    raise RuntimeError('scene file changed during comparison')
                if sources is not None and sources!=run['sourceSha256']:
                    raise RuntimeError('experiment sources changed during comparison')
                sources=run['sourceSha256']
                if scene is not None and scene!=run['scene']:
                    raise RuntimeError('scene changed during comparison')
                scene=run['scene']
            except (ValueError,KeyError,TypeError):
                raise RuntimeError('experiment process failed without a valid report') from None
            if health()!=runtime:
                raise RuntimeError('world service changed during comparison')
            if args.scene_file is not None and hashlib.sha256(args.scene_file.read_bytes()).hexdigest()!=scene_hash:
                raise RuntimeError('scene file changed during comparison')
            run['streamEvidence']=log_evidence(run)
            run.pop('processLogs',None)
            pair[mode]=run
        pairs.append(pair)
    groups,paired=summarize(pairs)
    print(json.dumps({'format':'3dbox-observation-comparison-v1',
          'config':{'count':args.count,'startSeed':args.start_seed,'sceneId':scene['id'],'scene':scene,'sceneFileSha256':scene_hash,
                    'physicsMode':args.physics,'clock':args.clock,'speed':args.speed,'dispatchMode':args.dispatch,
                    'linkProfile':args.link_profile,'maxTicks':args.max_ticks,'wallTimeoutSeconds':args.timeout,'archiveSeed':args.archive_seed},
          'serverRuntime':runtime,'sourceSha256':sources,'summary':groups,'paired':paired,'pairs':pairs},ensure_ascii=False,separators=(',',':') if args.archive_seed is not None else None,indent=None if args.archive_seed is not None else 2))


if __name__=='__main__':
    main()
