"""Run a real coordinator and scoped agent processes against one local world."""
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

from box_agent import AgentClient, CoordinatorClient
from box_agent.client import CONTROL_HTTP_ORIGIN
from planner_demo import SCENES
from scene_input import load_scene_file
from box_agent.recording import capture_recording_context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='World origin for orchestration and WebSocket; also used for scoped HTTP unless --control-url is set')
    parser.add_argument('--control-url', help='Control origin for scoped Agent and Coordinator HTTP')
    scene_choice = parser.add_mutually_exclusive_group()
    scene_choice.add_argument('--scene', choices=SCENES, default=SCENES[1])
    scene_choice.add_argument('--scene-file', type=Path, help='local scene JSON or YAML, at most 60 KB')
    parser.add_argument('--schedule-plan', type=Path, help='JSON disturbance plan for synchronized stepping')
    parser.add_argument('--coordinator-policy', type=Path, help='replace planner with a local Python policy (single coordinator)')
    parser.add_argument('--auction', action='store_true', help='collect agent bids over the simulated peer network')
    parser.add_argument('--policy-protocol', type=int, choices=(1,2), default=1)
    parser.add_argument('--policy-timeout', type=float, default=5)
    parser.add_argument('--max-policy-calls', type=int, default=1000)
    parser.add_argument('--max-policy-errors', type=int, default=3)
    parser.add_argument('--trace-decisions', action='store_true', help='record scoped policy observations and decisions')
    parser.add_argument('--trace-model-output', action='store_true', help='record bounded response excerpts for the built-in OpenAI policy')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--physics', choices=('kinematic','rapier'), default='kinematic')
    parser.add_argument('--sensor-mode', choices=('geometry','rapier'), default='geometry')
    parser.add_argument('--fault', choices=('transport','recoverable','resident','none'), default='transport')
    parser.add_argument('--dispatch', choices=('external','networked_external','networked_reported'), default='external')
    parser.add_argument('--link-profile', choices=('default','long'), default='default')
    parser.add_argument('--outage', choices=('none','first-command'), default='none')
    parser.add_argument('--outage-duration', type=int, default=10)
    parser.add_argument('--max-ticks', type=int, default=1000)
    parser.add_argument('--timeout', type=float, default=45)
    parser.add_argument('--coordinator-grpc-target', help='route coordinator process requests through a local gRPC adapter host:port')
    parser.add_argument('--agent-grpc-target', help='route agent requests through a local gRPC adapter host:port')
    parser.add_argument('--grpc-observe-stream', action='store_true', help='use gRPC observation streams for all workers')
    parser.add_argument('--observe-stream', action='store_true', help='use scoped WebSocket observations for agents and coordinators')
    parser.add_argument('--auto-charge', action='store_true', help='allow devices to request charging from their own return estimate')
    parser.add_argument('--preempt-for-charge', action='store_true', help='with auto-charge, pause own task actions when return energy is low')
    parser.add_argument('--auto-rescue', action='store_true', help='allow configured devices to rescue faults from their own local observations')
    parser.add_argument('--rescue-search', action='store_true', help='with auto-rescue, let idle rescuers search using their own sensors')
    parser.add_argument('--auto-report-samples', action='store_true', help='let each agent report own samples, with up to three attempts')
    parser.add_argument('--sample-followup', action='store_true', help='require a delivered sample report and completed evidence-bound survey (one coordinator)')
    parser.add_argument('--archive', action='store_true', help='include retained world snapshots for browser replay')
    parser.add_argument('--coordinators', type=int, default=1, help='number of independent coordinator processes (1–4)')
    parser.add_argument('--coordinator-fault-tick', type=int, help='kill the first coordinator at this tick and reassign its shard')
    parser.add_argument('--clock', choices=('step','realtime'), default='step', help='synchronized stepping or continuously running world')
    parser.add_argument('--speed', type=int, choices=(1,2,5), default=1, help='realtime world speed')
    parser.add_argument('--reconfigure-delay-ms', type=int, default=0, help='simulate orchestration delay during coordinator recovery')
    args = parser.parse_args()
    if args.preempt_for_charge and not args.auto_charge:
        parser.error('--preempt-for-charge requires --auto-charge')
    if args.rescue_search and not args.auto_rescue:
        parser.error('--rescue-search requires --auto-rescue')
    schedule_plan = None
    schedule_source = None
    schedule_hash = None
    if args.schedule_plan:
        options = {arg.split('=',1)[0] for arg in sys.argv[1:] if arg.startswith('--')}
        if options.intersection({'--scene','--scene-file','--seed','--physics','--max-ticks'}):
            parser.error('--schedule-plan supplies scene, seed, physics and max-ticks; do not override them')
        if args.clock != 'step' or args.outage != 'none' or args.fault != 'none' and '--fault' in options:
            parser.error('--schedule-plan requires step clock, no legacy outage, and --fault none')
        try:
            with args.schedule_plan.open('rb') as source: raw = source.read(60001)
            if len(raw) > 60000: raise ValueError('plan exceeds 60 KB')
            bridge = Path(__file__).resolve().parents[3]/'packages/world/scripts/validate-scheduled-plan-stdin.js'
            parsed = subprocess.run(['node',str(bridge)],input=raw,capture_output=True,timeout=10,check=False)
            if parsed.returncode: raise ValueError(parsed.stderr.decode('utf-8','replace').strip()[:300])
            schedule_plan = json.loads(parsed.stdout)
            schedule_source = json.loads(raw)
            schedule_hash = hashlib.sha256(raw).hexdigest()
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            parser.error(f'invalid schedule plan: {error}')
        args.seed, args.physics, args.max_ticks = schedule_plan['seed'], schedule_plan['physicsMode'], schedule_plan['maxTicks']
        args.fault = 'none'
    policy = None
    policy_hash = None
    if args.coordinator_policy:
        if args.coordinators != 1 or args.sample_followup:
            parser.error('--coordinator-policy requires one coordinator and cannot be combined with --sample-followup')
        if not args.coordinator_policy.is_file() or not .05 <= args.policy_timeout <= 120 or not 1 <= args.max_policy_calls <= 1000 or not 1 <= args.max_policy_errors <= 100:
            parser.error('invalid coordinator policy or policy limits')
        try:
            policy = args.coordinator_policy.resolve()
            policy_hash = hashlib.sha256(policy.read_bytes()).hexdigest()
        except OSError as error:
            parser.error(f'cannot read policy: {error}')
        if args.trace_model_output and (not args.trace_decisions or args.policy_protocol != 2 or policy != (Path(__file__).resolve().parent/'openai_policy.py').resolve()):
            parser.error('--trace-model-output requires --trace-decisions, protocol 2 and the built-in OpenAI policy')
    elif args.trace_decisions:
        parser.error('--trace-decisions requires --coordinator-policy')
    elif args.trace_model_output:
        parser.error('--trace-model-output requires --coordinator-policy')
    if args.auction and (args.coordinators != 1 or args.clock != 'realtime' or args.speed != 1 or args.scene not in ('industrial-park-v1','industrial-park-parallel-v1') or args.scene_file or args.schedule_plan or args.coordinator_policy or args.sample_followup or args.observe_stream or args.grpc_observe_stream or args.agent_grpc_target or args.coordinator_grpc_target):
        parser.error('--auction requires one coordinator, realtime 1x, a built-in park scene and HTTP workers')
    if args.grpc_observe_stream and (not args.agent_grpc_target or not args.coordinator_grpc_target or args.observe_stream):
        parser.error('--grpc-observe-stream requires both gRPC targets and cannot be combined with --observe-stream')
    if args.sensor_mode == 'rapier' and args.physics != 'rapier':
        parser.error('--sensor-mode rapier requires --physics rapier')
    if not 0 <= args.seed <= 0xffffffff or not 1 <= args.max_ticks <= 10000 or not 2 <= args.timeout <= 300 or not 1 <= args.coordinators <= 4:
        parser.error('invalid seed, max-ticks, or timeout')
    if not 0 <= args.reconfigure_delay_ms <= 5000 or (args.reconfigure_delay_ms and args.coordinators < 2):
        parser.error('reconfigure delay must be 0–5000 ms and requires at least two coordinators')
    if args.coordinator_fault_tick is not None and (args.coordinators < 2 or not 1 <= args.coordinator_fault_tick <= args.max_ticks):
        parser.error('--coordinator-fault-tick requires at least two coordinators and must fit within max-ticks')
    if not 1 <= args.outage_duration <= 1000 or (args.outage != 'none' and args.dispatch not in ('networked_external','networked_reported')):
        parser.error('outage requires a simulated link and duration 1–1000')
    if args.observe_stream:
        try:
            import box_agent.observation_reader
        except ImportError as error:
            parser.error(f'--observe-stream requires box-agent-sdk[stream]: {error}')
    if args.agent_grpc_target:
        try:
            from box_agent.grpc_client import GrpcAgentClient
            check = GrpcAgentClient('_', '_', '_', args.agent_grpc_target)
            check.close()
        except (ImportError, ValueError) as error:
            parser.error(f'invalid gRPC setup: {error}')
    if args.coordinator_grpc_target:
        try:
            from box_agent.grpc_client import GrpcCoordinatorClient
            check = GrpcCoordinatorClient('_', '_', args.coordinator_grpc_target)
            check.close()
        except (ImportError, ValueError) as error:
            parser.error(f'invalid coordinator gRPC setup: {error}')
    scene_input = schedule_plan['scene'] if schedule_plan else None
    scene_file_hash = None
    if args.scene_file is not None:
        try:
            scene_input, scene_file_hash = load_scene_file(args.scene_file)
        except (OSError, ValueError, UnicodeDecodeError) as error:
            parser.error(f'invalid scene file: {error}')
    if args.sample_followup:
        if args.coordinators != 1 or args.coordinator_fault_tick is not None:
            parser.error('--sample-followup requires one coordinator')
        if (scene_input is None and args.scene not in ('lunar-sampling-v1', 'lunar-outpost-v1')) or (scene_input is not None and (not isinstance(scene_input.get('tasks'), list) or sum(t.get('behavior') == 'sample' for t in scene_input['tasks'] if isinstance(t, dict)) != 1)):
            parser.error('--sample-followup requires a scene with one sample task')
        args.auto_report_samples = True
    world_url = args.url or os.environ.get('BOX_WORLD_URL') or 'http://127.0.0.1:8787'
    control_url = args.control_url or os.environ.get('BOX_CONTROL_URL') or args.url or CONTROL_HTTP_ORIGIN
    AgentClient('_','_','_',world_url)
    AgentClient('_','_','_',control_url)
    base = world_url.rstrip('/')
    def request(path, method='GET', data=None, token=None):
        payload = None if data is None else json.dumps(data,ensure_ascii=False,separators=(',',':')).encode('utf-8')
        req = Request(base+path,data=payload,method=method,headers={'content-type':'application/json'})
        if token:
            req.add_unredirected_header('Authorization', 'Bearer ' + token)
        with urlopen(req,timeout=10) as response:
            return json.load(response)

    runtime = request('/health')['runtime']
    session = request('/sessions','POST',{'seed':args.seed,**({'scene':scene_input} if scene_input is not None else {'sceneId':args.scene}),'physicsMode':args.physics,'sensorMode':args.sensor_mode,
                                          'dispatchMode':args.dispatch,'executionMode':'primitive','linkProfile':args.link_profile, 'policy':schedule_plan['policy'] if schedule_plan else 'nearest'})
    args.scene = session['scene']['id']
    started = time.monotonic()
    root = '/sessions/'+session['sessionId']
    admin = session['adminToken']
    directory = Path(__file__).resolve().parent
    children = []
    live_workers = set()
    live_coordinators = {}
    control_events = []
    coordinator_fault_injected = False
    coordinator_starts = 0
    faulted = False
    fault_target = None
    outage_injected = False
    outage_target = None
    schedule_index = 0
    schedule_outcomes = []
    reason = None
    state = session
    history = None
    result = None
    try:
        recording = capture_recording_context(session, runtime)
        if args.coordinators == 1:
            coord_tokens = [('coordinator', request(root+'/coordinator/credentials','POST',{},admin)['coordinatorToken'])]
        else:
            coord_tokens = [(f'node-{i+1}', request(root+f'/coordinators/node-{i+1}/credentials','POST',{},admin)['coordinatorToken']) for i in range(args.coordinators)]
        coordinator = CoordinatorClient(session['sessionId'],coord_tokens[0][1],control_url)
        # Never inherit another 3DBOX role's token into a worker.
        base_env = {k:v for k,v in os.environ.items() if k not in ('BOX_SESSION','BOX_TOKEN','BOX_COORDINATOR_TOKEN','BOX_AGENT','BOX_URL','BOX_WORLD_URL')}
        def launch(name, script, env, arguments):
            log = tempfile.TemporaryFile(mode='w+t',encoding='utf-8')
            proc = subprocess.Popen([sys.executable,str(directory/script),*arguments],
                                    env={**base_env,'BOX_URL':control_url,'BOX_WORLD_URL':world_url,**env},stdout=log,stderr=subprocess.STDOUT)
            children.append((name,proc,log))
            live_workers.add(proc)
            return proc
        agent_credentials = {a['id']:request(root+'/agents/'+a['id']+'/credentials','POST',{},admin)['agentToken'] for a in session['world']['agents']} if args.auction else {}
        auctioneer = session['world']['agents'][0]['id'] if args.auction else None
        def start_coordinators(tokens):
            nonlocal coordinator_starts
            live_coordinators.clear()
            for index, (name, coord_token) in enumerate(tokens):
                if args.auction:
                    proc = launch(name,'auction_coordinator.py',{'BOX_SESSION':session['sessionId'],'BOX_COORDINATOR_TOKEN':coord_token,'BOX_AGENT':auctioneer,'BOX_TOKEN':agent_credentials[auctioneer]},['--poll','0.03','--wait-ticks',str(max(20,2*session['scene']['communication']['delay']+8))])
                elif policy:
                    proc = launch(name,'policy_coordinator.py',{'BOX_SESSION':session['sessionId'],
                                                                 'BOX_COORDINATOR_TOKEN':coord_token},['--poll','0.03','--protocol',str(args.policy_protocol),'--policy',str(policy),'--timeout',str(args.policy_timeout),'--max-calls',str(args.max_policy_calls),'--max-errors',str(args.max_policy_errors)]+(['--trace'] if args.trace_decisions else [])+(['--trace-model-output'] if args.trace_model_output else [])+(['--observe-stream'] if args.observe_stream else [])+(['--grpc-observe-stream'] if args.grpc_observe_stream else [])+(['--grpc-target',args.coordinator_grpc_target] if args.coordinator_grpc_target else []))
                elif args.sample_followup:
                    proc = launch(name,'policy_coordinator.py',{'BOX_SESSION':session['sessionId'],
                                                                 'BOX_COORDINATOR_TOKEN':coord_token},['--poll','0.03','--protocol','2','--max-calls','1000','--policy',str(directory/'evidence_policy.py')]+(['--observe-stream'] if args.observe_stream else [])+(['--grpc-observe-stream'] if args.grpc_observe_stream else [])+(['--grpc-target',args.coordinator_grpc_target] if args.coordinator_grpc_target else []))
                else:
                    proc = launch(name,'planner_coordinator.py',{'BOX_SESSION':session['sessionId'],
                                                                  'BOX_COORDINATOR_TOKEN':coord_token},['--poll','0.03','--shard-count',str(len(tokens)),'--shard-index',str(index)]+(['--observe-stream'] if args.observe_stream else [])+(['--grpc-observe-stream'] if args.grpc_observe_stream else [])+(['--grpc-target',args.coordinator_grpc_target] if args.coordinator_grpc_target else []))
                live_coordinators[name] = proc
                coordinator_starts += 1
        start_coordinators(coord_tokens)
        for agent in session['world']['agents']:
            token = agent_credentials[agent['id']] if args.auction else request(root+'/agents/'+agent['id']+'/credentials','POST',{},admin)['agentToken']
            launch(agent['id'],'task_agent.py',{'BOX_SESSION':session['sessionId'],
                                               'BOX_AGENT':agent['id'],'BOX_TOKEN':token},['--poll','0.03','--lead-ticks',('10' if args.clock=='realtime' and args.sample_followup else '1')] + (['--auto-charge'] if args.auto_charge else []) + (['--preempt-for-charge'] if args.preempt_for_charge else []) + (['--auto-rescue'] if args.auto_rescue else []) + (['--rescue-search'] if args.rescue_search else []) + (['--auto-report-samples'] if args.auto_report_samples else []) + (['--observe-stream'] if args.observe_stream else [])+(['--grpc-observe-stream'] if args.grpc_observe_stream else []) + (['--grpc-target',args.agent_grpc_target] if args.agent_grpc_target else []))

        if args.auction:
            for agent in session['world']['agents']:
                if agent['id'] != auctioneer:
                    launch('bidder-'+agent['id'],'auction_bidder.py',{'BOX_SESSION':session['sessionId'],'BOX_AGENT':agent['id'],'BOX_TOKEN':agent_credentials[agent['id']]},['--auctioneer',auctioneer,'--poll','0.03'])

        if args.clock == 'realtime':
            request(root+'/run','POST',{'speed':args.speed},admin)
        deadline = time.monotonic()+args.timeout
        while True:
            state = request(root,token=admin)
            world = state['world']
            if world['done']:
                break
            if schedule_plan and schedule_index < len(schedule_plan['interventions']) and schedule_plan['interventions'][schedule_index]['tick'] == world['tick']:
                item = schedule_plan['interventions'][schedule_index]
                schedule_index += 1
                kind = item['type']
                if kind == 'fault': endpoint, payload = 'fault', {}
                elif kind == 'outage': endpoint, payload = 'communication-outage', {'agentId':item['agentId'],'duration':item['duration']}
                elif kind == 'low_energy': endpoint, payload = 'low-energy', {'agentId':item['agentId'],'level':item['level']}
                elif kind == 'roadblock': endpoint, payload = 'roadblock', {'rect':item['rect'],'duration':item['duration']}
                else: endpoint, payload = 'terrain-effect', {key:item[key] for key in ('zoneId','duration','speedFactor','energyFactor')}
                try:
                    updated = request(root+'/'+endpoint,'POST',payload,admin)
                    schedule_outcomes.append({'id':item['id'],'tick':item['tick'],'type':kind,'status':'applied','revision':updated['revision']})
                except HTTPError as error:
                    if error.code != 409: raise
                    try: details = json.load(error).get('error','invalid_request')
                    except (ValueError,AttributeError): details = 'invalid_request'
                    schedule_outcomes.append({'id':item['id'],'tick':item['tick'],'type':kind,'status':'rejected','reason':details,'httpStatus':error.code})
                continue
            if world['tick'] >= args.max_ticks:
                reason = 'tick_limit'
                break
            if time.monotonic() >= deadline:
                reason = 'wall_timeout'
                break
            if (args.coordinator_fault_tick is not None and not coordinator_fault_injected
                    and world['tick'] >= args.coordinator_fault_tick):
                name, proc = next(iter(live_coordinators.items()))
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=2)
                    coordinator_fault_injected = True
                    observed = request(root,token=admin)
                    control_events.append({'kind':'coordinator_failure_injected','tick':observed['world']['tick'],'observedRevision':observed['revision'],'coordinatorId':name})
            failed_nodes = [name for name,proc in live_coordinators.items() if proc.poll() is not None]
            if failed_nodes:
                current = request(root,token=admin)
                if args.clock == 'realtime' and current['world']['done']:
                    state = current
                    break
                world = current['world']
                recovery_start = time.monotonic()
                survivors = [name for name in live_coordinators if name not in failed_nodes]
                control_events.append({'kind':'coordinator_failure_detected','tick':world['tick'],'observedRevision':current['revision'],'coordinatorIds':failed_nodes})
                if not survivors or args.coordinators == 1:
                    reason = 'worker_exited:'+failed_nodes[0]+':'+str(live_coordinators[failed_nodes[0]].returncode)
                    break
                # Revoke all old generations before restarting survivors: no retired process can submit new commands.
                for name, _ in coord_tokens:
                    try:
                        request(root+f'/coordinators/{name}/credentials','DELETE',token=admin)
                    except HTTPError as error:
                        if error.code != 404:  # Already revoked is also fenced.
                            raise
                for proc in live_coordinators.values():
                    if proc.poll() is None:
                        proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                    live_workers.discard(proc)
                if args.reconfigure_delay_ms:
                    time.sleep(args.reconfigure_delay_ms/1000)
                coord_tokens = [(name, request(root+f'/coordinators/{name}/credentials','POST',{},admin)['coordinatorToken']) for name in survivors]
                coordinator = CoordinatorClient(session['sessionId'],coord_tokens[0][1],control_url)
                start_coordinators(coord_tokens)
                observed = request(root,token=admin)
                control_events.append({'kind':'coordinator_shards_reassigned','tick':observed['world']['tick'],'coordinatorIds':survivors,'elapsedMs':round((time.monotonic()-recovery_start)*1000,3),
                                       'observedRevision':observed['revision'],'priorDecisionIds':[d['requestId'] for d in observed['world']['decisions']]})
                continue
            stopped = next(((name,proc.returncode) for name,proc,_ in children if proc in live_workers and proc.poll() is not None),None)
            if stopped:
                if args.clock == 'realtime':
                    current = request(root,token=admin)
                    if current['world']['done']:
                        state = current
                        break
                reason = f'worker_exited:{stopped[0]}:{stopped[1]}'
                break
            if args.outage=='first-command' and not outage_injected:
                packet = next((p for p in world['communication']['dispatchQueue'] if p.get('actor')=='external'),None)
                if packet:
                    outage_target = packet['agentId']
                    try:
                        request(root+'/communication-outage','POST',{'agentId':outage_target,'duration':args.outage_duration},admin)
                    except HTTPError as error:
                        if args.clock == 'realtime' and error.code == 409:
                            continue
                        raise
                    outage_injected = True
                    continue
            active = [t for t in world['tasks'] if t['status']=='active']
            carrier = world['part']['carrierId']
            if args.fault == 'resident' and not faulted:
                resident = next((a for a in world['agents'] if a.get('relayState', {}).get('deployed') and not a['disabled']), None)
                if resident:
                    condition = {'agentId': resident['id']}
                    if resident.get('recoverableFault'):
                        condition['expectedFaultGeneration'] = resident['faultGeneration']
                    try:
                        changed = request(root+'/fault', 'POST', condition, admin)
                    except HTTPError as error:
                        if args.clock == 'realtime' and error.code == 409:
                            continue
                        raise
                    incident = next(e for e in reversed(changed['world']['events']) if e.get('kind') == 'device_fault' and e.get('agentId') == resident['id'])
                    fault_target = {'agentId': resident['id'], 'faultSeq': incident['seq'], 'faultTick': incident['tick'],
                                    'before': {'battery': resident['battery'], 'position': [resident['x'], resident['y']], 'relayState': resident['relayState']},
                                    **({'expectedFaultGeneration': condition['expectedFaultGeneration']} if 'expectedFaultGeneration' in condition else {})}
                    faulted = True
                    continue
            if args.fault=='recoverable' and not faulted and active and any(a['id']==active[0]['assignee'] and a.get('recoverableFault') for a in world['agents']):
                request(root+'/fault','POST',{},admin)
                faulted = True
                continue
            if args.fault=='transport' and not faulted and carrier and len(active)==1 and active[0]['assignee']==carrier:
                agent = next(a for a in world['agents'] if a['id']==carrier)
                if agent['status']=='manual':
                    try:
                        request(root+'/fault','POST',{},admin)
                    except HTTPError as error:
                        if args.clock == 'realtime' and error.code == 409:
                            continue
                        raise
                    faulted = True
                    continue
            waiting_sample_followup = False
            if args.sample_followup:
                sample = next((e for e in world['events'] if e.get('kind') == 'sample_collected'), None)
                if sample:
                    reports = [r for r in world.get('sampleReports', []) if r['agentId'] == sample['agentId'] and r['taskId'] == sample['taskId']]
                    delivered = next((r for r in reports if r['status'] == 'delivered'), None)
                    source = next(a for a in world['agents'] if a['id'] == sample['agentId'])
                    if not delivered and not any(r['status'] == 'pending' for r in reports) and (len(reports) >= 3 or source['disabled']):
                        reason = 'sample_report_not_delivered'
                        break
                    if delivered:
                        linked = any(p.get('sampleReportId') == delivered['id'] and p['status'] == 'accepted' for p in world.get('proposals', []))
                        if not linked and world['tick'] - sample['tick'] > 60:
                            reason = 'sample_evidence_stale'
                            break
                        if not linked and not any('inspect' in a['capabilities'] for a in world['agents']):
                            reason = 'sample_survey_unavailable'
                            break
                        waiting_sample_followup = not linked
            if args.clock == 'realtime':
                time.sleep(.01)
                continue
            # Keep the authoritative clock paused while a scoped process is making a needed decision.
            ready = coordinator.observe()['tasks']
            # Assignment and action submissions change revision without advancing the tick.
            if request(root,token=admin)['revision'] != state['revision']:
                continue
            waiting_dispatch = any(t['candidates'] for t in ready)
            waiting_action = any(a['status']=='assigned' and not any(x['agentId']==a['id'] and x['status'] in ('pending','accepted') for x in world['actions']) for a in world['agents'])
            # In step mode let the sampled agent submit before advancing again; in realtime no such pause occurs.
            waiting_sample_report = False
            if args.auto_report_samples:
                for event in (e for e in world['events'] if e.get('kind') == 'sample_collected'):
                    reports = [r for r in world.get('sampleReports', []) if r['agentId'] == event['agentId'] and r['taskId'] == event['taskId']]
                    agent = next(a for a in world['agents'] if a['id'] == event['agentId'])
                    if not agent['disabled'] and len(reports) < 3 and not any(r['status'] in ('pending', 'delivered') for r in reports):
                        waiting_sample_report = True
                        break
            if waiting_dispatch or waiting_action or waiting_sample_report or waiting_sample_followup:
                time.sleep(.01)
                continue
            state = request(root+'/step','POST',{'count':1},admin)
        if args.clock == 'realtime':
            state = request(root+'/pause','POST',{},admin)
        # Freeze processes before the final state/history read so the report and archive share one revision.
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
        if schedule_plan:
            for item in schedule_plan['interventions'][schedule_index:]:
                schedule_outcomes.append({'id':item['id'],'tick':item['tick'],'type':item['type'],'status':'skipped','reason':'world_finished' if state['world']['done'] else 'run_stopped'})
            if any(item['status'] != 'applied' for item in schedule_outcomes) and reason is None:
                reason = 'scheduled_intervention_failed'
        if args.coordinator_fault_tick is not None and not coordinator_fault_injected and reason is None:
            reason = 'coordinator_fault_not_injected'
        if reason is None and state['world']['done']:
            if args.fault != 'none' and not faulted:
                reason = 'resident_fault_not_injected' if args.fault == 'resident' else 'transport_fault_not_injected'
            elif args.outage != 'none' and not outage_injected:
                reason = 'outage_not_injected'
        if args.fault == 'resident' and fault_target and reason is None:
            reset = next((e for e in state['world']['events'] if e.get('kind') == 'rescue_completed' and e.get('targetAgentId') == fault_target['agentId'] and e.get('faultSeq') == fault_target['faultSeq']), None)
            if reset is None:
                reason = 'resident_fault_not_recovered'
        if args.sample_followup and reason is None:
            reports = state['world'].get('sampleReports', [])
            delivered_ids = {r['id'] for r in reports if r['status'] == 'delivered'}
            linked = [p for p in state['world'].get('proposals', []) if p.get('sampleReportId') in delivered_ids and p['status'] == 'accepted']
            if not delivered_ids:
                reason = 'sample_report_not_delivered'
            elif not any(any(t['id'] == p['task']['id'] and t['status'] == 'done' for t in state['world']['tasks']) for p in linked):
                reason = 'sample_followup_not_completed'
        if args.archive:
            history = request(root+'/history?after=-1',token=admin)
        world = state['world']
        observation_transport_metrics = request(root+'/observation-transport',token=admin)
        if request('/health')['runtime']['instanceId'] != runtime['instanceId']:
            raise RuntimeError('world server instance changed during experiment')
        workspace = directory.parents[2]
        files = (('src/scheduled-plan.js','scripts/validate-scheduled-plan-stdin.js') if schedule_plan else ()) + ('src/scene-format.js','scripts/parse-scene-stdin.js','sdk/python/scene_input.py','package-lock.json','examples/scenes/shore-surface.json','examples/scenes/shore-sea-state.json','examples/scenes/shore-echelons.json','examples/scenes/shore-rescue.json','src/echelons.js','src/engine.js','src/surface-domain.js','src/navigation.js','src/sensors.js','server/world-server.js','sdk/python/multi_agent_demo.py','sdk/python/planner_coordinator.py','sdk/python/task_agent.py','sdk/python/policy_coordinator.py','sdk/python/evidence_policy.py','sdk/python/box_agent/client.py','sdk/python/box_agent/recording.py','sdk/python/box_agent/planner.py','sdk/python/box_agent/stream.py','sdk/python/box_agent/stream.desc','sdk/python/box_agent/observation_reader.py')
        if args.auto_rescue:
            files += ('sdk/python/box_agent/rescue_policy.py','src/rescue.js')
        if args.auction:
            files += ('sdk/python/auction_coordinator.py','sdk/python/auction_bidder.py')
        if args.agent_grpc_target or args.coordinator_grpc_target:
            files += ('proto/agent.proto','sdk/python/box_agent/agent.desc','sdk/python/box_agent/grpc_protocol.py','sdk/python/box_agent/grpc_client.py','sdk/python/box_agent/grpc_stream.py','sdk/python/box_agent/grpc_observation_reader.py','sdk/python/box_agent/typed_observation.py','sdk/python/grpc_gateway.py')
        versions = {name:hashlib.sha256((workspace/name).read_bytes()).hexdigest() for name in files}
        if policy:
            try: current_policy_hash = hashlib.sha256(policy.read_bytes()).hexdigest()
            except OSError: raise RuntimeError('policy file unavailable at experiment end') from None
            if current_policy_hash != policy_hash: raise RuntimeError('policy file changed during experiment')
        sample_followup = None
        if args.sample_followup:
            sample = next((e for e in world['events'] if e.get('kind') == 'sample_collected'), None)
            reports = [r for r in world.get('sampleReports', []) if sample and r['taskId'] == sample['taskId'] and r['agentId'] == sample['agentId']]
            delivered = next((r for r in reports if r['status'] == 'delivered'), None)
            proposal = next((p for p in world.get('proposals', []) if delivered and p.get('sampleReportId') == delivered['id'] and p['status'] == 'accepted'), None)
            completed = next((e for e in world['events'] if proposal and e.get('kind') == 'task_completed' and e.get('taskId') == proposal['task']['id']), None)
            sample_followup = {'collectedTick':sample['tick'] if sample else None,
                               'reportAttempts':len(reports),
                               'reportSubmittedTick':delivered['submittedTick'] if delivered else None,
                               'reportDeliveredTick':delivered['appliedTick'] if delivered else None,
                               'proposalTick':proposal['appliedTick'] if proposal else None,
                               'followupCompletedTick':completed['tick'] if completed else None,
                               'samplingToFollowupTicks':completed['tick']-sample['tick'] if completed else None}
        result = {'format':'3dbox-multiprocess-v1','worldRuntime':runtime,'sourceSha256':versions,'pythonVersion':sys.version.split()[0],
                  'scene':session['scene'], 'config':{'seed':args.seed,'sceneId':args.scene,'sceneFileSha256':scene_file_hash,'physicsMode':args.physics,'sensorMode':args.sensor_mode,
                            'dispatchMode':args.dispatch,'executionMode':'primitive',**({'autoCharge':True} if args.auto_charge else {}),**({'preemptForCharge':True} if args.preempt_for_charge else {}),**({'autoRescue':True} if args.auto_rescue else {}),**({'rescueSearch':True} if args.rescue_search else {}),'linkProfile':args.link_profile,'auction':args.auction,'clock':args.clock,'speed':args.speed,'reconfigureDelayMs':args.reconfigure_delay_ms,'coordinators':args.coordinators,'coordinatorFaultTick':args.coordinator_fault_tick,'fault':args.fault,'observationTransport':'grpc-stream' if args.grpc_observe_stream else 'stream' if args.observe_stream else 'http','agentRequestTransport':'grpc' if args.agent_grpc_target else 'http','coordinatorRequestTransport':'grpc' if args.coordinator_grpc_target else 'http','autoReportSamples':args.auto_report_samples,'sampleFollowup':args.sample_followup,'outage':args.outage,'outageDuration':args.outage_duration,'maxTicks':args.max_ticks},
                  'status':'failed' if world['failed'] or reason in ('coordinator_fault_not_injected','transport_fault_not_injected','resident_fault_not_injected','resident_fault_not_recovered','outage_not_injected','sample_report_not_delivered','sample_followup_not_completed','sample_evidence_stale','sample_survey_unavailable','scheduled_intervention_failed') or (reason and reason.startswith('worker_exited:')) else 'completed' if world['done'] else 'timeout',
                  'reason':reason,'finalRevision':state['revision'],'elapsedSeconds':round(time.monotonic()-started,3),'faultInjected':faulted,'outageInjected':outage_injected,'outageTarget':outage_target,'agentProcesses':len(session['world']['agents']),'coordinatorProcesses':args.coordinators,'coordinatorStarts':coordinator_starts,'coordinatorFaultInjected':coordinator_fault_injected,'controlEvents':control_events,
                  'observationTransportMetrics':observation_transport_metrics,'sampleFollowup':sample_followup,'sampleReports':world.get('sampleReports',[]),'proposals':world.get('proposals',[]),'metrics':state['metrics'],'decisions':world['decisions'],'actions':world['actions'],'events':world['events']}
        if fault_target:
            reset = next((e for e in world['events'] if e.get('kind') == 'rescue_completed' and e.get('targetAgentId') == fault_target['agentId'] and e.get('faultSeq') == fault_target['faultSeq']), None)
            result['faultTarget'] = {**fault_target, 'restoredTick': reset['tick'] if reset else None, 'restoredBy': reset['agentId'] if reset else None}
        if policy:
            result['experiment'] = 'multi-agent-policy-v1'
            result['policySha256'] = policy_hash
            result['config'].update({'coordinatorPolicy':policy.name,'policyProtocol':args.policy_protocol,'policyTimeoutSeconds':args.policy_timeout,'maxPolicyCalls':args.max_policy_calls,'maxPolicyErrors':args.max_policy_errors,'traceDecisions':args.trace_decisions,'traceModelOutput':args.trace_model_output})
            if policy == (directory/'openai_policy.py').resolve():
                result['model'] = os.environ.get('OPENAI_MODEL') or None
                if args.trace_decisions:
                    from openai_policy import INSTRUCTIONS, SCHEMA
                    result['modelPrompt'] = {'instructions':INSTRUCTIONS,'outputSchema':SCHEMA}
        if schedule_plan:
            result['scheduledPlanSha256'] = schedule_hash
            result['scheduledPlan'] = schedule_source
            result['scheduledInterventions'] = schedule_outcomes
        result['sourceSessionId'] = session['sessionId']
        if recording is not None:
            result['recordingContext'] = recording
        if history is not None:
            result['historyTruncated'] = history['truncated']
            entries = history['frames']
            first, last = entries[0]['revision'], entries[-1]['revision']
            if last != state['revision'] or [entry['revision'] for entry in entries] != list(range(first,last+1)):
                raise RuntimeError('non-contiguous or changed history from world server')
            coverage = {'start':'complete' if first==0 else 'partial','end':'finished' if entries[-1]['world']['done'] else 'unfinished','revisionRange':[first,last]}
            result['archive'] = {'format':'3dbox-prototype-v1','source':'server',**({'recordingContext':recording} if recording is not None else {}),'coverage':coverage,
                                 'config':{'seed':args.seed,'policy':world['policy'],'sceneId':args.scene,'scene':session['scene']},
                                 'frames':[entry['world'] for entry in entries]}
    finally:
        for _,proc,_ in children:
            if proc.poll() is None:
                proc.terminate()
        for _,proc,_ in children:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        logs = []
        for name,proc,log in children:
            log.seek(0)
            text = log.read(2*1024*1024+1 if (policy or args.auction) and name == 'coordinator' else 16385)
            if policy and name == 'coordinator':
                lines = text.splitlines()
                if len(text) > 2*1024*1024 and lines: lines.pop()
                if args.trace_decisions and result is not None:
                    trace, malformed = [], False
                    for line in lines:
                        if line.startswith('TRACE '):
                            try: trace.append(json.loads(line[6:]))
                            except ValueError: malformed = True
                    result['policyTrace'] = [entry for entry in trace if entry.get('kind') != 'truncated']
                    result['policyTraceTruncated'] = malformed or len(text) > 2*1024*1024 or any(entry.get('kind') == 'truncated' for entry in trace)
                    starts = {entry['call'] for entry in trace if entry.get('kind') == 'start'}
                    ends = {entry['call'] for entry in trace if entry.get('kind') == 'result'}
                    result['policyTraceIncompleteCalls'] = sorted(starts-ends)
                text = '\n'.join(line for line in lines if not line.startswith('TRACE '))
            if args.auction and name == 'coordinator':
                lines = text.splitlines()
                if len(text) > 2*1024*1024 and lines: lines.pop()
                trace, malformed = [], False
                for line in lines:
                    if line.startswith('AUCTION_TRACE '):
                        try:
                            event=json.loads(line[14:])
                            if not isinstance(event,dict): raise ValueError('invalid trace')
                            trace.append(event)
                        except ValueError: malformed=True
                if result is not None:
                    result['auctionTrace'] = [e for e in trace if e.get('kind')!='truncated']
                    result['auctionTraceTruncated'] = malformed or len(text)>2*1024*1024 or any(e.get('kind')=='truncated' for e in trace)
                    started={e.get('auctionId') for e in trace if e.get('kind')=='open' and isinstance(e.get('auctionId'),str)}
                    ended={e.get('auctionId') for e in trace if e.get('kind')=='close' and isinstance(e.get('auctionId'),str)}
                    result['auctionTraceIncomplete'] = sorted(started-ended)
                text='\n'.join(line for line in lines if not line.startswith('AUCTION_TRACE '))
            logs.append({'role':name,'exitCode':proc.returncode,'output':text[:16384],'truncated':len(text)>16384})
            log.close()
        request(root,'DELETE',token=admin)
    result['processLogs'] = logs
    print(json.dumps(result,ensure_ascii=False,indent=None if args.archive else 2,separators=(',',':') if args.archive else None))
    return 0 if result['status']=='completed' and (args.fault=='none' or faulted) and (args.outage=='none' or outage_injected) and (args.coordinator_fault_tick is None or coordinator_fault_injected) else 1


if __name__ == '__main__':
    raise SystemExit(main())
