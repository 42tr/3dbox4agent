"""Select the nearest authorized candidate for the first ready task."""
import json
import math
import sys

observation = json.load(sys.stdin)
choice = None
for task in observation['tasks']:
    if task['candidates']:
        x, y = task['target']
        agent = min(task['candidates'], key=lambda a: (math.hypot(a['x']-x, a['y']-y), a['id']))
        choice = {'taskId': task['id'], 'agentId': agent['id']}
        break
json.dump(choice, sys.stdout)
