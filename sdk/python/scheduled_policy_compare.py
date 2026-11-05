"""Run paired multi-agent policies under the same versioned disturbance plan."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from statistics import mean, stdev
from box_agent import AgentClient
from policy_compare import runtime

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

def digest(data): return hashlib.sha256(data).hexdigest()
def stats(values): return {'n':len(values),'mean':mean(values) if values else None,'sd':stdev(values) if len(values)>1 else 0 if values else None}

def summarize(pairs):
    groups=[]
    for side in ('baseline','candidate'):
        runs=[p[side] for p in pairs]
        complete=[r for r in runs if r['status']=='completed']
        groups.append({'policy':side,'runs':len(runs),'completed':len(complete),'failed':sum(r['status']=='failed' for r in runs),
                       'timedOut':sum(r['status']=='timeout' for r in runs),
                       'allInterventionsApplied':sum(all(x['status']=='applied' for x in r['scheduledInterventions']) for r in runs),
                       'completionTicks':stats([r['metrics']['ticks'] for r in complete]),
                       'energy':stats([r['metrics']['energyUsed'] for r in complete])})
    done=[p for p in pairs if all(p[side]['status']=='completed' and all(x['status']=='applied' for x in p[side]['scheduledInterventions']) for side in ('baseline','candidate'))]
    return {'groups':groups,'bothCompleted':len(done),
            'tickDifference':stats([p['candidate']['metrics']['ticks']-p['baseline']['metrics']['ticks'] for p in done]),
            'energyDifference':stats([p['candidate']['metrics']['energyUsed']-p['baseline']['metrics']['energyUsed'] for p in done])}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',type=Path,required=True)
    parser.add_argument('--baseline',type=Path,default=HERE/'nearest_policy.py')
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--url',default='http://127.0.0.1:8787')
    parser.add_argument('--count',type=int,default=2)
    parser.add_argument('--start-seed',type=int)
    parser.add_argument('--protocol',type=int,choices=(1,2),default=1)
    parser.add_argument('--timeout',type=float,default=60)
    parser.add_argument('--policy-timeout',type=float,default=5)
    parser.add_argument('--max-policy-calls',type=int,default=1000)
    parser.add_argument('--max-policy-errors',type=int,default=3)
    parser.add_argument('--archive-seed',type=int)
    parser.add_argument('--trace-archive-decisions',action='store_true')
    args=parser.parse_args()
    if not all(p.is_file() for p in (args.plan,args.baseline,args.candidate)) or not 1<=args.count<=10 or not 2<=args.timeout<=300 or not .05<=args.policy_timeout<=120 or not 1<=args.max_policy_calls<=1000 or not 1<=args.max_policy_errors<=100 or (args.trace_archive_decisions and args.archive_seed is None):
        parser.error('invalid files or experiment limits')
    with args.plan.open('rb') as f: raw=f.read(60001)
    if len(raw)>60000: parser.error('plan exceeds 60 KB')
    check=subprocess.run(['node',str(ROOT/'scripts/validate-scheduled-plan-stdin.js')],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    if check.returncode: parser.error('invalid plan: '+check.stderr.decode('utf-8','replace').strip()[:300])
    original=json.loads(raw)
    start=original['seed'] if args.start_seed is None else args.start_seed
    if not 0<=start<=0xffffffff or start+args.count-1>0xffffffff or args.archive_seed is not None and not start<=args.archive_seed<start+args.count:
        parser.error('invalid seed range')
    AgentClient('_','_','_',args.url)
    server_runtime=runtime(args.url)
    comparison_hash=digest(Path(__file__).read_bytes())
    policies={'baseline':args.baseline.resolve(),'candidate':args.candidate.resolve()}
    hashes={name:digest(file.read_bytes()) for name,file in policies.items()}
    pairs=[];source_hashes=None;scene=None
    with tempfile.TemporaryDirectory(prefix='3dbox-paired-schedule-') as directory:
        for seed in range(start,start+args.count):
            data={**original,'seed':seed}
            plan_bytes=(json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf-8')
            plan_path=Path(directory)/f'plan-{seed}.json';plan_path.write_bytes(plan_bytes)
            pair={'seed':seed}
            for side,policy in policies.items():
                print(f'seed {seed}: {side}',file=sys.stderr,flush=True)
                if runtime(args.url)!=server_runtime or digest(policy.read_bytes())!=hashes[side]: raise RuntimeError('service or policy changed during comparison')
                command=[sys.executable,str(HERE/'multi_agent_demo.py'),'--url',args.url,'--schedule-plan',str(plan_path),
                         '--coordinator-policy',str(policy),'--policy-protocol',str(args.protocol),'--policy-timeout',str(args.policy_timeout),
                         '--max-policy-calls',str(args.max_policy_calls),'--max-policy-errors',str(args.max_policy_errors),'--timeout',str(args.timeout)]
                if seed==args.archive_seed:
                    command.append('--archive')
                    if args.trace_archive_decisions: command.append('--trace-decisions')
                child=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                try:
                    run=json.loads(child.stdout)
                    if child.returncode not in (0,1) or run['format']!='3dbox-multiprocess-v1' or run['experiment']!='multi-agent-policy-v1' or run['policySha256']!=hashes[side] or run['scheduledPlanSha256']!=digest(plan_bytes) or run['scheduledPlan']!=data or (child.returncode==0)!=(run['status']=='completed'):
                        raise ValueError()
                    if source_hashes is not None and run['sourceSha256']!=source_hashes: raise RuntimeError('experiment sources changed during comparison')
                    if scene is not None and run['scene']!=scene: raise RuntimeError('scene changed during comparison')
                    source_hashes,scene=run['sourceSha256'],run['scene']
                except (ValueError,KeyError,TypeError): raise RuntimeError('experiment process failed without a valid report') from None
                if runtime(args.url)!=server_runtime or digest(policy.read_bytes())!=hashes[side]: raise RuntimeError('service or policy changed during comparison')
                pair[side]=run
            pairs.append(pair)
    if digest(Path(__file__).read_bytes())!=comparison_hash: raise RuntimeError('comparison script changed during experiment')
    report={'format':'3dbox-scheduled-policy-comparison-v1','plan':original,'planSourceSha256':digest(raw),'comparisonSourceSha256':comparison_hash,
            'config':{'count':args.count,'startSeed':start,'sceneId':scene['id'],'scene':scene,'physicsMode':original['physicsMode'],
                      'policyProtocol':args.protocol,'maxTicks':original['maxTicks'],'wallTimeoutSeconds':args.timeout,
                      'policyTimeoutSeconds':args.policy_timeout,'maxPolicyCalls':args.max_policy_calls,'maxPolicyErrors':args.max_policy_errors,
                      'archiveSeed':args.archive_seed,'traceArchiveDecisions':args.trace_archive_decisions},
            'policySha256':hashes,'worldRuntime':server_runtime,'sourceSha256':source_hashes,'pairs':pairs,'summary':summarize(pairs)}
    print(json.dumps(report,ensure_ascii=False,separators=(',',':')))

if __name__=='__main__': main()
