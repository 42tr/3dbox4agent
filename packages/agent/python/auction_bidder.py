"""Bid on coordinator calls using only this agent's scoped observation and peer link."""
import argparse, json, math, os, re, sys, time
from box_agent import AgentClient, SandboxError
from box_agent.client import CONTROL_HTTP_ORIGIN


def bid(observation, call):
    if not isinstance(call, dict) or call.get('v') != 1 or call.get('kind') != 'auction_call': return None
    auction, task, capability, target = (call.get(k) for k in ('auction','task','capability','target'))
    if not isinstance(auction,str) or not re.fullmatch(r'[a-f0-9]{8}-[0-9]{1,8}',auction) or not isinstance(task,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',task) or not isinstance(capability,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',capability): return None
    if not isinstance(target,list) or len(target)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=100 for v in target): return None
    me=observation['self']
    if me['status']!='idle' or me['battery']<=5 or capability not in me['capabilities']: return None
    score=round(math.hypot(me['x']-target[0],me['y']-target[1])+(100-me['battery'])*.05,3)
    return {'v':1,'kind':'auction_bid','auction':auction,'task':task,'score':score}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--auctioneer',required=True);p.add_argument('--poll',type=float,default=.03);args=p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',args.auctioneer) or not .01<=args.poll<=1: p.error('invalid auctioneer or poll interval')
    client=AgentClient(os.environ['BOX_SESSION'],os.environ['BOX_AGENT'],os.environ['BOX_TOKEN'],os.environ.get('BOX_URL',CONTROL_HTTP_ORIGIN))
    processed=set()
    while True:
        observation=client.observe();error=observation.get('sessionError') or observation.get('simulationError')
        if error: raise SandboxError(503,error)
        if observation['done']: return 0
        for msg in observation['inbox']:
            if msg['id'] in processed or msg['from']!=args.auctioneer: continue
            try: call=json.loads(msg['text'])
            except (ValueError,TypeError,KeyError): processed.add(msg['id']);continue
            offer=bid(observation,call)
            if offer is None: processed.add(msg['id']);continue
            try:
                client.send_message(args.auctioneer,json.dumps(offer,separators=(',',':')),request_id='bid-'+str(msg['id']))
            except SandboxError as error:
                if error.code in ('rate_limit','queue_full'): break
                if error.code in ('recipient_unavailable','sender_unavailable','world_finished'): processed.add(msg['id']);continue
                raise
            processed.add(msg['id']);print('bid '+offer['auction']+' '+offer['task'],flush=True)
        # Inbox holds only 20 messages; retaining more IDs is unnecessary.
        visible={m['id'] for m in observation['inbox']};processed.intersection_update(visible)
        time.sleep(args.poll)

if __name__=='__main__':
    try:sys.exit(main())
    except (KeyError,ValueError,SandboxError) as error:raise SystemExit('竞价设备停止：'+str(error))
