"""Run a scoped scout, evidence coordinator and planner as separate processes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
from box_agent import AgentClient, CoordinatorClient
from planner_demo import SCENES


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8787')
    parser.add_argument('--scene', choices=SCENES, default='lunar-terrain-v1')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--dispatch', choices=('external','networked_external','networked_reported'), default='networked_reported')
    parser.add_argument('--outage', choices=('none','first-report'), default='none')
    parser.add_argument('--max-ticks', type=int, default=1000)
    parser.add_argument('--timeout', type=float, default=45)
    parser.add_argument('--waypoint', type=float, nargs=2, action='append', metavar=('X','Y'), help='override the default patrol route; repeat for each waypoint')
    parser.add_argument('--archive', action='store_true')
    args = parser.parse_args()
    if not 0 <= args.seed <= 0xffffffff or not 1 <= args.max_ticks <= 10000 or not 2 <= args.timeout <= 300:
        parser.error('invalid seed, tick limit or timeout')
    if args.waypoint and (len(args.waypoint)>20 or any(not 0 <= n <= 100 for p in args.waypoint for n in p)):
        parser.error('provide at most 20 waypoints within 0–100')
    AgentClient('_','_','_',args.url)
    def request(path, method='GET', data=None, token=None):
        headers = {'content-type':'application/json'}
        if token:
            headers['authorization'] = 'Bearer ' + token
        payload = None if data is None else json.dumps(data).encode()
        with urlopen(Request(args.url.rstrip('/')+path, data=payload, method=method, headers=headers), timeout=10) as response:
            return json.load(response)
    session = request('/sessions','POST',{'seed':args.seed,'sceneId':args.scene,'dispatchMode':args.dispatch,'executionMode':'auto'})
    root, admin = '/sessions/'+session['sessionId'], session['adminToken']
    directory = Path(__file__).resolve().parent
    children, state, reason, outage = [], session, None, False
    deadline = time.monotonic()+args.timeout
    env = {k:v for k,v in os.environ.items() if k not in ('BOX_SESSION','BOX_TOKEN','BOX_COORDINATOR_TOKEN','BOX_AGENT','BOX_URL')}
    def launch(name, script, credentials, arguments):
        log = tempfile.TemporaryFile(mode='w+t', encoding='utf-8')
        proc = subprocess.Popen([sys.executable,str(directory/script),*arguments], env={**env,**credentials}, stdout=log, stderr=subprocess.STDOUT)
        children.append((name,proc,log))
        return proc
    def expired(world):
        return 'tick_limit' if world['tick'] >= args.max_ticks else 'wall_timeout' if time.monotonic() >= deadline else None
    try:
        token = request(root+'/coordinator/credentials','POST',{},admin)['coordinatorToken']
        coord = CoordinatorClient(session['sessionId'], token, args.url)
        scout = next(a for a in session['world']['agents'] if 'inspect' in a['capabilities'])
        scout_token = request(root+'/agents/'+scout['id']+'/credentials','POST',{},admin)['agentToken']
        common = {'BOX_URL':args.url, 'BOX_SESSION':session['sessionId']}
        # Route is supplied in advance, independently of the hidden asset position.
        waypoints = args.waypoint or [[35,50],[55,50],[75,50]]
        patrol_args = [item for x,y in waypoints for item in ('--waypoint',str(x),str(y))]
        proc = launch('scout','evidence_scout.py',{**common,'BOX_AGENT':scout['id'],'BOX_TOKEN':scout_token},patrol_args)
        while True:
            state = request(root,token=admin); world = state['world']
            if proc.poll() is not None:
                if proc.returncode != 0: reason = f'scout_exited:{proc.returncode}'
                break
            reason = expired(world)
            if reason or world['done']:
                reason = reason or 'world_ended_before_report'; break
            pending = [r for r in world.get('evidenceReports',[]) if r['status']=='pending']
            if args.outage=='first-report' and pending and not outage:
                request(root+'/communication-outage','POST',{'agentId':scout['id'],'duration':world['communication']['config']['delay']},admin)
                outage = True; continue
            actions = [a for a in world['actions'] if a['agentId']==scout['id'] and a['status'] in ('pending','accepted')]
            if actions or pending:
                request(root+'/step','POST',{'count':1},admin)
            else:
                time.sleep(.01)
        if not reason:
            proc = launch('evidence-coordinator','evidence_coordinator.py',{**common,'BOX_COORDINATOR_TOKEN':token},['--once'])
            while proc.poll() is None and time.monotonic()<deadline:
                time.sleep(.01)
            if proc.poll() is None: reason = 'wall_timeout'
            elif proc.returncode: reason = f'evidence_coordinator_exited:{proc.returncode}'
            state = request(root,token=admin)
            proposals = state['world'].get('proposals',[])
            if not reason and not any(p['status']=='accepted' for p in proposals): reason = 'no_evidence_proposal'
        if not reason:
            proc = launch('planner','planner_coordinator.py',{**common,'BOX_COORDINATOR_TOKEN':token},['--poll','0.03'])
            while True:
                state = request(root,token=admin); world = state['world']
                if world['done']: break
                reason = expired(world)
                if reason: break
                if proc.poll() is not None:
                    reason = f'planner_exited:{proc.returncode}'; break
                ready = coord.observe()['tasks']
                if request(root,token=admin)['revision'] != state['revision']: continue
                if any(t['candidates'] for t in ready): time.sleep(.01); continue
                request(root+'/step','POST',{'count':1},admin)
        state = request(root,token=admin); world = state['world']
        history = request(root+'/history?after=-1',token=admin) if args.archive else None
        files = ('src/engine.js','src/navigation.js','src/sensors.js','server/world-server.js','sdk/python/evidence_mission.py','sdk/python/evidence_scout.py','sdk/python/evidence_coordinator.py','sdk/python/planner_coordinator.py','sdk/python/box_agent/client.py','sdk/python/box_agent/planner.py')
        workspace = directory.parents[1]
        result = {'format':'3dbox-multiprocess-v1','sourceSha256':{f:hashlib.sha256((workspace/f).read_bytes()).hexdigest() for f in files},'pythonVersion':sys.version.split()[0],
                  'config':{'seed':args.seed,'sceneId':args.scene,'dispatchMode':args.dispatch,'executionMode':'auto','outage':args.outage,'patrolWaypoints':waypoints},
                  'status':'completed' if world['done'] and not world['failed'] and not reason else 'failed', 'reason':reason,
                  'outageInjected':outage,'agentProcesses':1,'coordinatorProcesses':2,'metrics':state['metrics'],
                  'evidenceReports':world.get('evidenceReports',[]),'proposals':world.get('proposals',[]),'decisions':world['decisions'],'actions':world['actions'],'events':world['events']}
        if history is not None:
            result['historyTruncated'] = history['truncated']
            result['archive'] = {'format':'3dbox-prototype-v1','source':'server','config':{'seed':args.seed,'policy':world['policy'],'sceneId':args.scene,'scene':session['scene']},'frames':[entry['world'] for entry in history['frames']]}
    finally:
        for _,proc,_ in children:
            if proc.poll() is None: proc.terminate()
        logs = []
        for name,proc,log in children:
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
            log.seek(0); logs.append({'role':name,'exitCode':proc.returncode,'output':log.read(16384)}); log.close()
        request(root,'DELETE',token=admin)
    result['processLogs'] = logs
    print(json.dumps(result,ensure_ascii=False,separators=(',',':') if args.archive else None,indent=None if args.archive else 2))
    return 0 if result['status']=='completed' and (args.outage=='none' or outage) else 1


if __name__ == '__main__':
    raise SystemExit(main())
