"""Centralized minimum-cost matching policy over the authorized ready-task observation.

Maximize the number of assignments, then maximize their total priority, then
minimize straight-line travel. Only the highest-priority matched task is returned; the next call
optimizes the new observation again. This is not a distributed auction.
"""
import heapq
import json
import math
import sys


def choose(observation):
    tasks = observation['tasks']
    agents = sorted({a['id'] for t in tasks for a in t['candidates']})
    if not agents:
        return None
    # Total distance across at most 50 assignments is below 7.1 million.
    # One priority point must therefore dominate the entire distance objective.
    priority_weight = 8_000_000
    n_tasks, n_agents = len(tasks), len(agents)
    source, task0, agent0 = 0, 1, 1 + n_tasks
    sink = agent0 + n_agents
    graph = [[] for _ in range(sink + 1)]
    agent_nodes = {agent: agent0 + i for i, agent in enumerate(agents)}

    def add(u, v, capacity, cost):
        graph[u].append([v, len(graph[v]), capacity, cost])
        graph[v].append([u, len(graph[u]) - 1, 0, -cost])

    for i, task in enumerate(tasks):
        add(source, task0 + i, 1, 0)
        x, y = task['target']
        for a in sorted(task['candidates'], key=lambda item: item['id']):
            distance = round(math.hypot(a['x'] - x, a['y'] - y) * 1000)
            add(task0 + i, agent_nodes[a['id']], 1,
                (100 - task.get('priority', 0)) * priority_weight + distance)
    for agent in agents:
        add(agent_nodes[agent], sink, 1, 0)

    # Successive shortest augmenting paths with reduced costs. Reverse edges
    # allow earlier allocations to be revised when a scarce candidate is needed.
    potential = [0] * len(graph)
    while True:
        dist = [math.inf] * len(graph)
        parent = [None] * len(graph)
        dist[source] = 0
        queue = [(0, source)]
        while queue:
            d, u = heapq.heappop(queue)
            if d != dist[u]:
                continue
            for index, (v, _, cap, cost) in enumerate(graph[u]):
                if not cap:
                    continue
                nd = d + cost + potential[u] - potential[v]
                if nd < dist[v]:
                    dist[v], parent[v] = nd, (u, index)
                    heapq.heappush(queue, (nd, v))
        if parent[sink] is None:
            break
        for node, d in enumerate(dist):
            if d != math.inf:
                potential[node] += d
        v = sink
        while v != source:
            u, index = parent[v]
            edge = graph[u][index]
            edge[2] -= 1
            graph[v][edge[1]][2] += 1
            v = u
    selected = []
    for i, task in enumerate(tasks):
        for v, _, cap, _ in graph[task0 + i]:
            if agent0 <= v < sink and cap == 0:
                selected.append((-task.get('priority', 0), i, v - agent0))
    if not selected:
        return None
    _, task_index, agent_index = min(selected)
    return {'taskId': tasks[task_index]['id'], 'agentId': agents[agent_index]}


if __name__ == '__main__':
    json.dump(choose(json.load(sys.stdin)), sys.stdout)
