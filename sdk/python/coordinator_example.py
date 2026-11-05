"""External battery-priority dispatcher; server time is controlled separately by an admin."""
import os
import time
from box_agent import CoordinatorClient

client = CoordinatorClient(os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'], os.environ.get('BOX_URL', 'http://127.0.0.1:8787'))
sequence = 0
while True:
    obs = client.observe()
    if obs['done']:
        print('实验结束', '失败' if obs['failed'] else '完成')
        break
    for task in obs['tasks']:
        if task['candidates']:
            candidate = max(task['candidates'], key=lambda item: (item['battery'], item['id']))
            sequence += 1
            result = client.assign(f'python-{sequence}', task['id'], candidate['id'], obs['tick'])
            print(task['id'], result['decision']['status'], flush=True)
    time.sleep(0.1)
