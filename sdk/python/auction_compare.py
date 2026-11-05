"""Paired real-time runs of the planner and the peer-message auction."""
import argparse, hashlib, json, math, os, signal, subprocess, sys
from pathlib import Path
from statistics import mean, stdev
from urllib.request import urlopen
from box_agent import AgentClient

HERE=Path(__file__).resolve().parent

def stats(values):
    return {'n':len(values),'mean':mean(values) if values else None,'sd':stdev(values) if len(values)>1 else 0 if values else None}

def summarize(pairs):
    groups=[]
    for condition in ('planner','auction'):
        runs=[p[condition] for p in pairs];done=[r for r in runs if r['status']=='completed']
        groups.append({'condition':condition,'runs':len(runs),'completed':len(done),'failed':sum(r['status']=='failed' for r in runs),'timedOut':sum(r['status']=='timeout' for r in runs),
            'completionTicks':stats([r['metrics']['ticks'] for r in done]),'elapsedSeconds':stats([r['elapsedSeconds'] for r in done]),
            'messagesSubmitted':stats([r['metrics']['peerMessages']['submitted'] for r in runs]),'messagesDelivered':stats([r['metrics']['peerMessages']['delivered'] for r in runs]),'messagesFailed':stats([r['metrics']['peerMessages']['failed'] for r in runs])})
    both=[p for p in pairs if all(p[k]['status']=='completed' for k in ('planner','auction'))]
    paired={'bothCompleted':len(both),'tickDifference':stats([p['auction']['metrics']['ticks']-p['planner']['metrics']['ticks'] for p in both]),'elapsedDifference':stats([p['auction']['elapsedSeconds']-p['planner']['elapsedSeconds'] for p in both])}
    return groups,paired

def execution_order(mode, index):
    """Deterministic counterbalancing; index is relative to the first seed."""
    if mode not in ('alternating','planner-first','auction-first') or type(index) is not int or index < 0:
        raise ValueError('invalid execution order')
    first = 'auction' if mode == 'auction-first' or mode == 'alternating' and index % 2 else 'planner'
    return [first, 'planner' if first == 'auction' else 'auction']

def run_worker(cmd, timeout):
    # Own a process group so an interrupted comparison cannot leave bidder workers behind.
    child=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=(os.name=='posix'))
    try:
        stdout,stderr=child.communicate(timeout=timeout)
        return child.returncode,stdout,stderr
    except BaseException:
        if os.name=='posix':
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass
        else:child.terminate()
        try:child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            if os.name=='posix':
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
            else:child.kill()
            child.communicate()
        raise

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--url',default='http://127.0.0.1:8787');p.add_argument('--scene',choices=('industrial-park-v1','industrial-park-parallel-v1'),default='industrial-park-parallel-v1');p.add_argument('--physics',choices=('kinematic','rapier'),default='kinematic');p.add_argument('--dispatch',choices=('external','networked_external','networked_reported'),default='external');p.add_argument('--link-profile',choices=('default','long'),default='default');p.add_argument('--count',type=int,default=2);p.add_argument('--start-seed',type=int,default=42);p.add_argument('--max-ticks',type=int,default=1000);p.add_argument('--timeout',type=float,default=60);p.add_argument('--archive-seed',type=int);p.add_argument('--order',choices=('alternating','planner-first','auction-first'),default='alternating',help='execution order within each seed (default: alternating)');args=p.parse_args()
    if not 1<=args.count<=10 or not 0<=args.start_seed<=0xffffffff or args.start_seed+args.count-1>0xffffffff or not 1<=args.max_ticks<=10000 or not math.isfinite(args.timeout) or not 2<=args.timeout<=300 or args.archive_seed is not None and args.archive_seed not in range(args.start_seed,args.start_seed+args.count):p.error('invalid seed, count, timing or archive selection')
    AgentClient('_','_','_',args.url)
    def health():
        with urlopen(args.url.rstrip('/')+'/health',timeout=10) as r:return json.load(r)['runtime']
    workspace=HERE.parents[1];files=('sdk/python/multi_agent_demo.py','sdk/python/planner_coordinator.py','sdk/python/task_agent.py','sdk/python/auction_coordinator.py','sdk/python/auction_bidder.py','sdk/python/auction_compare.py','sdk/python/box_agent/client.py');hashes={name:hashlib.sha256((workspace/name).read_bytes()).hexdigest() for name in files};runtime=health();pairs=[];scene=None
    for seed in range(args.start_seed,args.start_seed+args.count):
        order=execution_order(args.order,seed-args.start_seed);pair={'seed':seed,'executionOrder':order}
        for condition in order:
            print(f'seed {seed}: {condition}',file=sys.stderr,flush=True)
            if health()!=runtime or any(hashlib.sha256((workspace/name).read_bytes()).hexdigest()!=digest for name,digest in hashes.items()):raise RuntimeError('service or source changed during comparison')
            cmd=[sys.executable,str(HERE/'multi_agent_demo.py'),'--url',args.url,'--scene',args.scene,'--physics',args.physics,'--seed',str(seed),'--fault','none','--clock','realtime','--speed','1','--dispatch',args.dispatch,'--link-profile',args.link_profile,'--max-ticks',str(args.max_ticks),'--timeout',str(args.timeout)]
            if condition=='auction':cmd.append('--auction')
            if seed==args.archive_seed:cmd.append('--archive')
            returncode,stdout,stderr=run_worker(cmd,args.timeout+30)
            try:run=json.loads(stdout)
            except (ValueError,UnicodeDecodeError):raise RuntimeError(f'{condition} worker did not produce a report: {stderr.decode("utf-8","replace")[-500:]}') from None
            if run.get('format')!='3dbox-multiprocess-v1' or run.get('worldRuntime')!=runtime or run.get('status') not in ('completed','failed','timeout') or (returncode==0)!=(run['status']=='completed'):raise RuntimeError('worker report inconsistent')
            if scene is None:scene=run['scene']
            elif run['scene']!=scene:raise RuntimeError('scene changed during comparison')
            pair[condition]=run
        pairs.append(pair)
    if health()!=runtime or any(hashlib.sha256((workspace/name).read_bytes()).hexdigest()!=digest for name,digest in hashes.items()):raise RuntimeError('service or source changed during comparison')
    summary,paired=summarize(pairs);report={'format':'3dbox-auction-comparison-v1','config':{'sceneId':args.scene,'scene':scene,'physicsMode':args.physics,'dispatchMode':args.dispatch,'linkProfile':args.link_profile,'count':args.count,'startSeed':args.start_seed,'maxTicks':args.max_ticks,'wallTimeoutSeconds':args.timeout,'archiveSeed':args.archive_seed,'executionOrder':args.order},'worldRuntime':runtime,'sourceSha256':hashes,'summary':summary,'paired':paired,'pairs':pairs}
    print(json.dumps(report,ensure_ascii=False,separators=(',',':')))
    return 0
if __name__=='__main__':sys.exit(main())
