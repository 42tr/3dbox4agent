"""One coordinator solicits bids over a designated agent's simulated peer link."""
import argparse, json, math, os, sys, time, uuid
from box_agent import AgentClient, CoordinatorClient, SandboxError
from auction_bidder import bid


_trace_count=0

def trace(kind, **data):
    global _trace_count
    if _trace_count < 3000:
        print('AUCTION_TRACE '+json.dumps({'kind':kind,**data},ensure_ascii=True,separators=(',',':')),flush=True)
    elif _trace_count == 3000:
        print('AUCTION_TRACE '+json.dumps({'kind':'truncated'}),flush=True)
    _trace_count+=1


def valid_bid(message, current):
    try:
        value=json.loads(message['text'])
        source=message['from'];sent=message['sentTick'];received=message['receivedTick']
    except (ValueError,TypeError,KeyError):return None
    if not isinstance(value,dict) or value.get('v')!=1 or value.get('kind')!='auction_bid' or value.get('auction')!=current['id'] or value.get('task')!=current['task'] or source not in current['candidates'] or type(sent) is not int or sent<current['opened'] or type(received) is not int or (current['until'] is not None and received>current['until']):return None
    score=value.get('score')
    if isinstance(score,bool) or not isinstance(score,(int,float)) or not math.isfinite(score) or not 0<=score<=1000:return None
    return source,score


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--poll',type=float,default=.03);p.add_argument('--wait-ticks',type=int,default=20);args=p.parse_args()
    if not .01<=args.poll<=1 or not 6<=args.wait_ticks<=200:p.error('invalid polling or auction window')
    url=os.environ.get('BOX_URL','http://127.0.0.1:8787');session=os.environ['BOX_SESSION'];agent_id=os.environ['BOX_AGENT']
    agent=AgentClient(session,agent_id,os.environ['BOX_TOKEN'],url);coordinator=CoordinatorClient(session,os.environ['BOX_COORDINATOR_TOKEN'],url)
    prefix=uuid.uuid4().hex[:8];number=0;current=None;seen=set()
    while True:
        obs=coordinator.observe();self_obs=agent.observe();error=obs.get('sessionError') or obs.get('simulationError')
        if error: raise SandboxError(503,error)
        if obs['done']:
            if current: trace('close',auctionId=current['id'],status='run_ended',observedTick=obs['tick'],worldRevision=obs['worldRevision'])
            return 1 if obs['failed'] else 0
        if self_obs['self']['status']=='fault': raise SandboxError(409,'auctioneer_unavailable')
        ready={t['id']:t for t in obs['tasks'] if t['candidates']}
        if current and current['task'] not in ready:
            trace('close',auctionId=current['id'],status='task_unavailable',observedTick=obs['tick'],worldRevision=obs['worldRevision']);current=None
        if current is None and ready:
            task=next(iter(ready.values()));number+=1;auction=f'{prefix}-{number}';call={'v':1,'kind':'auction_call','auction':auction,'task':task['id'],'capability':task['capability'],'target':task['target']}
            candidates=[a['id'] for a in task['candidates']];own=bid(self_obs,call) if agent_id in candidates else None
            current={'id':auction,'task':task['id'],'call':call,'candidates':set(candidates),'unsent':[a for a in candidates if a!=agent_id],'bids':{agent_id:own['score']} if own else {},'until':None,'opened':obs['tick']}
            trace('open',auctionId=auction,taskId=task['id'],broker=agent_id,candidates=candidates,observedTick=obs['tick'],worldRevision=obs['worldRevision'])
            if own: trace('bid',auctionId=auction,agentId=agent_id,score=own['score'],source='self')
            print('auction_open '+auction+' '+task['id'],flush=True)
        if current:
            while current['unsent']:
                recipient=current['unsent'][0]
                try:
                    sent=agent.send_message(recipient,json.dumps(current['call'],separators=(',',':')),request_id='call-'+current['id']+'-'+recipient)
                    trace('call',auctionId=current['id'],agentId=recipient,messageId=sent['messageId'])
                except SandboxError as error:
                    if error.code in ('rate_limit','queue_full'):break
                    if error.code in ('recipient_unavailable','world_finished'):current['unsent'].pop(0);continue
                    raise
                current['unsent'].pop(0)
            if not current['unsent'] and current['until'] is None:
                current['until']=agent.observe()['tick']+args.wait_ticks;trace('window',auctionId=current['id'],deadlineTick=current['until'])
            for message in self_obs['inbox']:
                if message['id'] in seen:continue
                seen.add(message['id'])
                offer=valid_bid(message,current)
                if offer is not None and offer[0] not in current['bids']:
                    current['bids'][offer[0]]=offer[1];trace('bid',auctionId=current['id'],agentId=offer[0],score=offer[1],source='message',messageId=message['id'],receivedTick=message['receivedTick'])
            seen.intersection_update({m['id'] for m in self_obs['inbox']})
            if current['until'] is not None and obs['tick']>=current['until']:
                task=ready.get(current['task']);eligible={a['id'] for a in task['candidates']} if task else set();valid=[(score,agent_id_) for agent_id_,score in current['bids'].items() if agent_id_ in eligible]
                if valid:
                    score,winner=min(valid)
                    try:
                        result=coordinator.assign('auction-'+current['id'],current['task'],winner,obs['tick'])
                        trace('close',auctionId=current['id'],status=result['decision']['status'],winner=winner,score=score,requestId='auction-'+current['id'],observedTick=obs['tick'],worldRevision=obs['worldRevision'])
                        print('auction_result '+current['id']+' '+winner+' '+result['decision']['status'],flush=True)
                    except SandboxError as error:
                        if error.code not in ('task_in_transit','queue_full','world_finished'):raise
                        trace('close',auctionId=current['id'],status='request_failed',winner=winner,score=score,reason=error.code,observedTick=obs['tick'],worldRevision=obs['worldRevision'])
                        print('auction_rejected '+current['id']+' '+error.code,flush=True)
                else:
                    trace('close',auctionId=current['id'],status='no_bids',observedTick=obs['tick'],worldRevision=obs['worldRevision'])
                    print('auction_no_bids '+current['id'],flush=True)
                current=None
        time.sleep(args.poll)

if __name__=='__main__':
    try:sys.exit(main())
    except (KeyError,ValueError,SandboxError) as error:raise SystemExit('竞价协调者停止：'+str(error))
