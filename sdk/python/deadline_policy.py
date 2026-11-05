"""Select the earliest-deadline ready task from an authorized coordinator observation.

Within an equal deadline, prefer higher priority, then observation order. Choose the
nearest authorized candidate, breaking equal distances by agent ID. Missing deadlines
sort after dated tasks. The policy does not estimate travel or task completion time.
"""
import json
import math
import sys


def choose(observation):
    available = [(i, task) for i, task in enumerate(observation['tasks']) if task['candidates']]
    if not available:
        return None
    _, task = min(available, key=lambda item: (item[1].get('deadline', math.inf), -item[1].get('priority', 0), item[0]))
    x, y = task['target']
    agent = min(task['candidates'], key=lambda a: (math.hypot(a['x'] - x, a['y'] - y), a['id']))
    return {'taskId': task['id'], 'agentId': agent['id']}


if __name__ == '__main__':
    json.dump(choose(json.load(sys.stdin)), sys.stdout)
