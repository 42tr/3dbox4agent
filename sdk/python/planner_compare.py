"""Paired-seed comparison of scoped planning and nearest-first coordinators."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import mean, stdev

from planner_demo import SCENES, run_experiment


def stats(values):
    return {'n':len(values), 'mean':mean(values) if values else None,
            'sd':stdev(values) if len(values) > 1 else 0 if values else None}


def summarize(pairs):
    groups = []
    for name in ('nearest', 'planner'):
        runs = [pair[name] for pair in pairs]
        successful = [run for run in runs if run['status'] == 'completed']
        groups.append({'algorithm':name, 'runs':len(runs), 'completed':len(successful),
                       'failed':sum(r['status']=='failed' for r in runs),
                       'timedOut':sum(r['status']=='timeout' for r in runs),
                       'faultsInjected':sum(r['faultInjected'] for r in runs),
                       'completionTicks':stats([r['metrics']['ticks'] for r in successful]),
                       'distance':stats([r['metrics']['distance'] for r in runs]),
                       'energy':stats([r['metrics']['energyUsed'] for r in runs])})
    both = [p for p in pairs if p['nearest']['status']=='completed' and p['planner']['status']=='completed']
    return groups, {'bothCompleted':len(both),
                    'completionTickDifference':stats([p['planner']['metrics']['ticks']-p['nearest']['metrics']['ticks'] for p in both]),
                    'energyDifference':stats([p['planner']['metrics']['energyUsed']-p['nearest']['metrics']['energyUsed'] for p in pairs])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8787')
    parser.add_argument('--count', type=int, default=10)
    parser.add_argument('--start-seed', type=int, default=42)
    parser.add_argument('--scene', choices=SCENES, default=SCENES[1])
    parser.add_argument('--fault-tick', type=int, default=3, help='0 disables device fault injection')
    parser.add_argument('--max-ticks', type=int, default=1000)
    args = parser.parse_args()
    if not 1 <= args.count <= 50 or not 0 <= args.start_seed <= 0xffffffff or args.start_seed+args.count-1 > 0xffffffff:
        parser.error('count must be 1–50 within the seed range')
    if not 1 <= args.max_ticks <= 10000 or not 0 <= args.fault_tick <= args.max_ticks:
        parser.error('invalid fault tick or maximum ticks')
    pairs = []
    for seed in range(args.start_seed,args.start_seed+args.count):
        pair = {'seed':seed}
        for name in ('nearest','planner'):
            pair[name] = run_experiment(args.url,seed,args.scene,args.fault_tick,args.max_ticks,name)
        pairs.append(pair)
    summary, paired = summarize(pairs)
    root = Path(__file__).resolve().parents[2]
    files = ('src/engine.js','src/navigation.js','src/sensors.js','server/world-server.js',
             'sdk/python/planner_demo.py','sdk/python/planner_compare.py','sdk/python/box_agent/client.py','sdk/python/box_agent/planner.py')
    versions = {name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files}
    report = {'format':'3dbox-planner-comparison-v1',
              'config':{'count':args.count,'startSeed':args.start_seed,'sceneId':args.scene,
                        'faultTick':args.fault_tick,'maxTicks':args.max_ticks,'physicsMode':'kinematic',
                        'dispatchMode':'external'}, 'sourceSha256':versions,
              'summary':summary,'paired':paired,'pairs':pairs}
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
