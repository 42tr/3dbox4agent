"""Example one-shot policy: choose the highest-battery candidate for the first ready task."""
import json
import sys

observation = json.load(sys.stdin)
choice = None
for task in observation['tasks']:
    if task['candidates']:
        agent = sorted(task['candidates'], key=lambda a: (-a['battery'], a['id']))[0]
        choice = {'taskId': task['id'], 'agentId': agent['id']}
        break
json.dump(choice, sys.stdout, ensure_ascii=False)
