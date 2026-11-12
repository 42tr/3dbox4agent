"""Run an asynchronous policy against an independently ticking local world."""
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
from urllib.error import HTTPError

from box_agent import AgentClient
from planner_demo import SCENES
from scene_input import load_scene_file
from box_agent.recording import capture_recording_context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', type=Path, required=True)
    parser.add_argument('--url', default='http://127.0.0.1:8787')
    scene_choice = parser.add_mutually_exclusive_group()
    scene_choice.add_argument('--scene', choices=SCENES, default='industrial-park-parallel-v1')
    scene_choice.add_argument('--scene-file', type=Path, help='local scene JSON or YAML, at most 60 KB')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--speed', type=int, choices=(1,2,5), default=2)
    parser.add_argument('--physics', choices=('kinematic','rapier'), default='kinematic')
    parser.add_argument('--dispatch', choices=('external','networked_external','networked_reported'), default='external')
    parser.add_argument('--link-profile', choices=('default','long'), default='default')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--policy-timeout', type=float, default=5)
    parser.add_argument('--policy-protocol', type=int, choices=(1, 2), default=1)
    parser.add_argument('--max-policy-calls', type=int, default=30)
    parser.add_argument('--max-policy-errors', type=int, default=3)
    parser.add_argument('--max-ticks', type=int, default=1000)
    parser.add_argument('--fault-tick', type=int, default=0, help='after this tick, fail the first active task device; 0 disables')
    parser.add_argument('--outage', choices=('none','first-report'), default='none')
    parser.add_argument('--command-outage-duration', type=int, default=0, help='interrupt the target of the first observed in-flight external command')
    parser.add_argument('--scout', action='store_true', help='run a scoped patrol agent and require an evidence-linked completed task')
    parser.add_argument('--archive', action='store_true')
    parser.add_argument('--trace-decisions', action='store_true', help='record scoped observations, validated outputs and latency')
    parser.add_argument('--trace-model-output', action='store_true', help='also record bounded OpenAI response excerpts')
    args = parser.parse_args()
    if not args.policy.is_file() or not 0 <= args.seed <= 0xffffffff or not 1 <= args.max_ticks <= 10000 or not 1 <= args.timeout <= 300 or not .05 <= args.policy_timeout <= 120 or not 1 <= args.max_policy_calls <= 1000 or not 1 <= args.max_policy_errors <= 100 or not 0 <= args.fault_tick <= args.max_ticks:
        parser.error('invalid policy, seed, tick limit or timeout')
    if args.trace_model_output and (not args.trace_decisions or args.policy_protocol != 2 or args.policy.resolve() != (Path(__file__).resolve().parent/'openai_policy.py').resolve()):
        parser.error('--trace-model-output requires --trace-decisions, protocol 2 and the built-in OpenAI policy')
    if not 0 <= args.command_outage_duration <= 1000 or (args.command_outage_duration and (args.dispatch not in ('networked_external','networked_reported') or args.scout)):
        parser.error('--command-outage-duration requires simulated network dispatch and no scout')
    if args.scout and args.policy_protocol != 2:
        parser.error('--scout requires --policy-protocol 2')
    if args.outage != 'none' and not args.scout:
        parser.error('--outage first-report requires --scout')
    scene_input = None
    scene_file_hash = None
    if args.scene_file is not None:
        try:
            scene_input, scene_file_hash = load_scene_file(args.scene_file)
        except (OSError, ValueError, UnicodeDecodeError) as error:
            parser.error(f'invalid scene file: {error}')
    AgentClient('_','_','_',args.url)
    def request(path, method='GET', data=None, token=None):
        headers = {'content-type':'application/json'}
        if token: headers['authorization'] = 'Bearer ' + token
        payload = None if data is None else json.dumps(data,ensure_ascii=False,separators=(',',':')).encode()
        with urlopen(Request(args.url.rstrip('/')+path, data=payload, method=method, headers=headers), timeout=10) as response:
            return json.load(response)
    directory = Path(__file__).resolve().parent
    policy = args.policy.resolve()
    policy_hash = hashlib.sha256(policy.read_bytes()).hexdigest()
    service_runtime = request('/health').get('runtime')
    session = request('/sessions','POST',{'seed':args.seed,**({'scene':scene_input} if scene_input is not None else {'sceneId':args.scene}),'dispatchMode':args.dispatch,'physicsMode':args.physics,'executionMode':'auto','linkProfile':args.link_profile})
    args.scene = session['scene']['id']
    root, admin = '/sessions/'+session['sessionId'], session['adminToken']
    children, worker, scout, reason, outage_tick, result = [], None, None, None, None, None
    command_outage = {'attempted':False,'injected':False,'dispatchId':None,'agentId':None,'tick':None,'observed':False}
    fault_attempted = False
    fault_injected = False
    started = time.monotonic()
    try:
        recording = capture_recording_context(session, service_runtime)
        coordinator = request(root+'/coordinator/credentials','POST',{},admin)['coordinatorToken']
        base_env = {k:v for k,v in os.environ.items() if not k.startswith('BOX_')}
        common = {'BOX_URL':args.url,'BOX_SESSION':session['sessionId']}
        def launch(name, script, credentials, arguments):
            log = tempfile.TemporaryFile(mode='w+t', encoding='utf-8')
            proc = subprocess.Popen([sys.executable,str(directory/script),*arguments], env={**base_env,**common,**credentials}, stdout=log, stderr=subprocess.STDOUT)
            children.append((name,proc,log))
            return proc
        if args.scout:
            agent = next(a for a in session['world']['agents'] if 'inspect' in a['capabilities'])
            token = request(root+'/agents/'+agent['id']+'/credentials','POST',{},admin)['agentToken']
            route = [[35,50],[55,50],[75,50]]
            patrol_args = [item for x,y in route for item in ('--waypoint',str(x),str(y))]
            scout = launch('scout','evidence_scout.py',{'BOX_AGENT':agent['id'],'BOX_TOKEN':token},[*patrol_args,'--lead-ticks','10'])
        request(root+'/run','POST',{'speed':args.speed},admin)
        # Let the scout's first action become active before other tasks are allocated.
        if scout:
            while True:
                state = request(root,token=admin);world = state['world']
                if any(a['agentId']==agent['id'] and a['type']=='move' and a['status'] in ('accepted','completed') for a in world['actions']): break
                if world['done']: reason='world_ended_before_scout'; break
                if world['tick'] >= args.max_ticks: reason='tick_limit'; break
                if time.monotonic()-started >= args.timeout: reason='wall_timeout'; break
                if scout.poll() is not None: reason=f'scout_exited:{scout.returncode}'; break
                time.sleep(.03)
        if not reason:
            worker = launch('policy-coordinator','policy_coordinator.py',{'BOX_COORDINATOR_TOKEN':coordinator},['--policy',str(policy),'--timeout',str(args.policy_timeout),'--poll','.03','--protocol',str(args.policy_protocol),'--max-calls',str(args.max_policy_calls),'--max-errors',str(args.max_policy_errors),*(['--reserve-agent',agent['id']] if args.scout else []),*(['--trace'] if args.trace_decisions else []),*(['--trace-model-output'] if args.trace_model_output else [])])
        while not reason:
            state = request(root,token=admin); world = state['world']
            if world['done']: break
            if world['tick'] >= args.max_ticks: reason='tick_limit'; break
            if time.monotonic()-started >= args.timeout: reason='wall_timeout'; break
            if worker.poll() is not None: reason=f'worker_exited:{worker.returncode}'; break
            if scout and scout.poll() is not None and scout.returncode != 0: reason=f'scout_exited:{scout.returncode}'; break
            if args.command_outage_duration and not command_outage['injected']:
                packet = next((p for p in world['communication']['dispatchQueue'] if p.get('actor')=='external'), None)
                if packet:
                    command_outage['attempted'] = True
                    try:
                        interrupted = request(root+'/communication-outage','POST',{'agentId':packet['agentId'],'duration':args.command_outage_duration},admin)
                        command_outage.update({'injected':True,'dispatchId':packet['id'],'agentId':packet['agentId'],'tick':interrupted['world']['tick']})
                    except HTTPError as error:
                        if error.code != 409:
                            raise
                    continue
            if args.fault_tick and not fault_injected and world['tick'] >= args.fault_tick and any(t['status']=='active' for t in world['tasks']):
                fault_attempted = True
                try:
                    fault_state = request(root+'/fault','POST',{},admin)
                    fault_injected = any(e.get('kind')=='device_fault' for e in fault_state['world']['events'])
                except HTTPError as error:
                    if error.code != 409:
                        raise
                continue
            if args.outage == 'first-report' and outage_tick is None:
                first = next((r for r in world.get('evidenceReports',[]) if r['agentId']==agent['id'] and r['requestId']=='patrol-report-1' and r['status']=='pending'), None)
                if first:
                    try:
                        result = request(root+'/communication-outage','POST',{'agentId':agent['id'],'duration':world['communication']['config']['delay']},admin)
                    except HTTPError:
                        reason = 'outage_injection_failed'; break
                    outage_tick = result['world']['tick']
                    continue
            time.sleep(.03)
        state = request(root+'/pause','POST',{},admin)
        # Stop all writers before reading the final state and retained history.
        for _,proc,_ in children:
            if proc.poll() is None:
                proc.terminate()
        for _,proc,_ in children:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        state = request(root,token=admin)
        world = state['world']
        if world['done'] and not world['failed'] and reason == 'worker_exited:0': reason = None
        command_outage['observed'] = bool(command_outage['injected'] and any(e.get('kind')=='dispatch_failed' and e.get('dispatchId')==command_outage['dispatchId'] and e.get('agentId')==command_outage['agentId'] and e.get('reason')=='interrupted' for e in world['events']))
        history = request(root+'/history?after=-1',token=admin) if args.archive else None
        decisions = [d for d in world['decisions'] if d.get('actor')=='external']
        proposals = world.get('proposals', [])
        reports = world.get('evidenceReports', [])
        delivered = [r for r in reports if r['status']=='delivered']
        first_report = next((r for r in reports if args.scout and r['agentId']==agent['id'] and r['requestId']=='patrol-report-1'), None)
        outage_observed = bool(first_report and first_report['status']=='failed' and first_report.get('reason')=='interrupted')
        scout_report_ids = {r['id'] for r in delivered if args.scout and r['agentId']==agent['id']}
        completed_links = [p for p in proposals if p['status']=='accepted' and p.get('evidenceId') in scout_report_ids and any(t['id']==p['task']['id'] and t['status']=='done' for t in world['tasks'])]
        if args.scout and world['done'] and not world['failed'] and not reason and not completed_links:
            reason = 'evidence_task_incomplete'
        if args.outage != 'none' and world['done'] and not world['failed'] and not reason and not outage_observed:
            reason = 'outage_not_observed'
        ages = [(d['submittedTick'] if 'submittedTick' in d else d['appliedTick'])-d['observedTick'] for d in decisions]
        workspace = directory.parents[2]
        files = ('src/scene-format.js','scripts/parse-scene-stdin.js','sdk/python/scene_input.py','package-lock.json','src/engine.js','src/navigation.js','src/sensors.js','server/world-server.js','sdk/python/policy_experiment.py','sdk/python/policy_coordinator.py','sdk/python/evidence_scout.py','sdk/python/box_agent/client.py','sdk/python/box_agent/recording.py')
        try:
            current_policy_hash = hashlib.sha256(policy.read_bytes()).hexdigest()
        except OSError:
            raise RuntimeError('policy file changed during experiment') from None
        if current_policy_hash != policy_hash:
            raise RuntimeError('policy file changed during experiment')
        result = {'format':'3dbox-multiprocess-v1','experiment':'asynchronous-policy-v1',
                  'scene':session['scene'], 'sourceSha256':{name:hashlib.sha256((workspace/name).read_bytes()).hexdigest() for name in files},
                  'policySha256':policy_hash, 'pythonVersion':sys.version.split()[0],
                  'config':{'sceneId':args.scene,'sceneFileSha256':scene_file_hash,'seed':args.seed,'speed':args.speed,'physicsMode':args.physics,'dispatchMode':args.dispatch,'executionMode':'auto','maxTicks':args.max_ticks,'wallTimeoutSeconds':args.timeout,'policyTimeoutSeconds':args.policy_timeout,'policyProtocol':args.policy_protocol,'maxPolicyCalls':args.max_policy_calls,'maxPolicyErrors':args.max_policy_errors,'traceDecisions':args.trace_decisions,'traceModelOutput':args.trace_model_output,'faultTick':args.fault_tick,'commandOutageDuration':args.command_outage_duration,'linkProfile':args.link_profile,'outage':args.outage,'scout':args.scout,**({'patrolWaypoints':route} if args.scout else {})},
                  'status':'completed' if world['done'] and not world['failed'] and not reason else 'failed' if world['failed'] or reason in ('evidence_task_incomplete','outage_not_observed','outage_injection_failed','policy_call_limit','policy_error_limit') or (reason and (reason.startswith('worker_exited:') or reason.startswith('scout_exited:') or reason=='world_ended_before_scout')) else 'timeout',
                  'reason':reason,'finalRevision':state['revision'],'commandOutage':command_outage,'faultAttempted':fault_attempted,'faultInjected':fault_injected,'outageInjected':outage_tick is not None,'outageObserved':outage_observed,'outageTick':outage_tick,'elapsedSeconds':round(time.monotonic()-started,3),'agentProcesses':1 if args.scout else 0,'coordinatorProcesses':1,
                  'evidenceSummary':{'delivered':len(delivered),'failed':sum(r['status']=='failed' for r in reports),'interrupted':sum(r.get('reason')=='interrupted' for r in reports),'linkedTasksCompleted':len(completed_links)},
                  'decisionSummary':{'submitted':len(decisions),'accepted':sum(d['status']=='accepted' for d in decisions),'rejected':sum(d['status']=='rejected' for d in decisions),'failed':sum(d['status']=='failed' for d in decisions),'pending':sum(d['status']=='pending' for d in decisions),'stale':sum(d.get('reason')=='stale_observation' for d in decisions),'meanSubmissionAgeTicks':sum(ages)/len(ages) if ages else None,'maxSubmissionAgeTicks':max(ages) if ages else None},
                  'proposalSummary':{'submitted':len(proposals),'accepted':sum(p['status']=='accepted' for p in proposals),'rejected':sum(p['status']=='rejected' for p in proposals),'stale':sum(p.get('reason')=='stale_observation' for p in proposals)},
                  'recoveryEventsVersion':world.get('recoveryEventsVersion'), 'boundaryMonitoringVersion':world.get('boundaryMonitoringVersion'), 'footprintMonitoringVersion':world.get('footprintMonitoringVersion'), 'riskMonitoringVersion':world.get('riskMonitoringVersion'),
                  'metrics':state['metrics'],'decisions':decisions,'proposals':proposals,'evidenceReports':reports,'actions':world['actions'],'events':world['events']}
        if policy == (directory/'openai_policy.py').resolve():
            result['model'] = os.environ.get('OPENAI_MODEL') or None
            if args.trace_decisions:
                from openai_policy import INSTRUCTIONS, SCHEMA
                result['modelPrompt'] = {'instructions':INSTRUCTIONS,'outputSchema':SCHEMA}
        result['sourceSessionId'] = session['sessionId']
        if recording is not None:
            result['recordingContext'] = recording
        if history is not None:
            result['historyTruncated'] = history['truncated']
            saved_frames = history['frames']
            first_revision, last_revision = saved_frames[0]['revision'], saved_frames[-1]['revision']
            if last_revision != state['revision'] or [f['revision'] for f in saved_frames] != list(range(first_revision,last_revision+1)):
                raise RuntimeError('non-contiguous history from world server')
            coverage = {'start':'complete' if first_revision==0 else 'partial',
                        'end':'finished' if saved_frames[-1]['world']['done'] else 'unfinished',
                        'revisionRange':[first_revision,last_revision]}
            result['archive'] = {'format':'3dbox-prototype-v1','source':'server',**({'recordingContext':recording} if recording is not None else {}),'coverage':coverage,'config':{'seed':args.seed,'policy':world['policy'],'sceneId':args.scene,'scene':session['scene']},'frames':[entry['world'] for entry in saved_frames]}
    finally:
        for _,proc,_ in children:
            if proc.poll() is None: proc.terminate()
        logs = []
        for name,proc,log in children:
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
            log.seek(0);output=log.read();log.close()
            lines=output.splitlines()
            public_output='\n'.join(line for line in lines if not line.startswith('TRACE '))
            logs.append({'role':name,'exitCode':proc.returncode,'output':public_output[:16384]})
            if name=='policy-coordinator' and result is not None:
                if args.trace_decisions:
                    trace=[json.loads(line[6:]) for line in lines if line.startswith('TRACE ')]
                    result['policyTrace']=[entry for entry in trace if entry.get('kind')!='truncated']
                    result['policyTraceTruncated']=any(entry.get('kind')=='truncated' for entry in trace)
                    starts={entry['call'] for entry in trace if entry.get('kind')=='start'}
                    ends={entry['call'] for entry in trace if entry.get('kind')=='result'}
                    result['policyTraceIncompleteCalls']=sorted(starts-ends)
                result['policySummary']={'calls':sum(line.startswith('策略调用 ') for line in lines),'errors':sum(line.startswith('策略未产生有效决策：') for line in lines),'waits':sum(line=='策略选择暂不分配。' for line in lines)}
                if result['reason']=='worker_exited:2' and '策略调用达到上限。' in lines: result['reason']='policy_call_limit'
                if result['reason']=='worker_exited:3' and '连续策略失败达到上限。' in lines: result['reason']='policy_error_limit'
        request(root,'DELETE',token=admin)
    if args.trace_decisions and 'policyTrace' not in result:
        result['policyTrace'],result['policyTraceTruncated'],result['policyTraceIncompleteCalls'] = [],False,[]
    result['processLogs'] = logs
    print(json.dumps(result,ensure_ascii=False,separators=(',',':') if args.archive else None,indent=None if args.archive else 2))
    return 0 if result['status']=='completed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
