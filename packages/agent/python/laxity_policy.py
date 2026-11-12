"""Rank ready tasks by estimated slack using only coordinator observations.

Travel is straight-line distance divided by nominal speed, plus configured task
work. This is a heuristic: obstacles, terrain, communication, stale reports,
future contention and delivery's second leg are not included. Missing duration
or speed in older observations falls back to earliest deadline and nearest agent.
"""
import json
import math
import sys


def _nonnegative_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def choose(observation):
    available = [(i, task) for i, task in enumerate(observation['tasks']) if task['candidates']]
    if not available:
        return None
    # Never compare estimated slack against a missing estimate treated as zero.
    complete = all(_nonnegative_number(task.get('duration')) and all(
        _nonnegative_number(a.get('speed')) and a['speed'] > 0 for a in task['candidates']
    ) for _, task in available)
    choices = []
    for index, task in available:
        x, y = task['target']
        def distance(agent):
            return math.hypot(agent['x'] - x, agent['y'] - y)
        agent = min(task['candidates'], key=lambda a: (distance(a) / a['speed'] if complete else distance(a), a['id']))
        estimate = distance(agent) / agent['speed'] + task['duration'] if complete else 0
        slack = task.get('deadline', math.inf) - observation['tick'] - estimate
        choices.append((slack, -task.get('priority', 0), index, task['id'], agent['id']))
    _, _, _, task_id, agent_id = min(choices)
    return {'taskId': task_id, 'agentId': agent_id}


if __name__ == '__main__':
    json.dump(choose(json.load(sys.stdin)), sys.stdout)
