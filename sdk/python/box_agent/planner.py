"""Deterministic, scoped, minimum-cost maximum matching for ready tasks."""
import heapq
import math


def plan(observation):
    """Return task/agent assignments using only coordinator observation data.

    Maximize the number of assignments first, then total priority; then minimize straight-line
    distance plus a half-unit penalty per missing battery unit. This is a
    one-step assignment plan, not a route or future-task planner.
    """
    tasks = sorted(observation['tasks'], key=lambda task: task['id'])
    if len(tasks) > 100 or len({task['id'] for task in tasks}) != len(tasks):
        raise ValueError('too many tasks or duplicate task IDs')
    agent_ids = sorted({candidate['id'] for task in tasks for candidate in task['candidates']})
    if len(agent_ids) > 300:
        raise ValueError('too many candidate agents')
    n_tasks, n_agents = len(tasks), len(agent_ids)
    source, task_base, agent_base = 0, 1, 1 + n_tasks
    sink = agent_base + n_agents
    graph = [[] for _ in range(sink + 1)]

    def edge(start, end, cost):
        forward = [end, len(graph[end]), 1, cost]
        reverse = [start, len(graph[start]), 0, -cost]
        graph[start].append(forward)
        graph[end].append(reverse)
        return forward

    agent_index = {agent_id: i for i, agent_id in enumerate(agent_ids)}
    assignment_edges = []
    for i, task in enumerate(tasks):
        priority = task.get('priority', 0)
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 100:
            raise ValueError('invalid priority')
        # Maximum aggregate geometric/battery cost is below this penalty.
        edge(source, task_base + i, (100 - priority) * 2_000_001)
        tx, ty = task['target']
        seen = set()
        for candidate in sorted(task['candidates'], key=lambda item: item['id']):
            agent_id = candidate['id']
            if agent_id in seen:
                raise ValueError('duplicate candidate')
            seen.add(agent_id)
            x, y, battery = candidate['x'], candidate['y'], candidate['battery']
            if not all(math.isfinite(v) for v in (tx, ty, x, y, battery)) or not all(0 <= v <= 100 for v in (tx, ty, x, y, battery)):
                raise ValueError('invalid candidate data')
            cost = round(100 * math.hypot(x - tx, y - ty) + 50 * (100 - battery))
            arc = edge(task_base + i, agent_base + agent_index[agent_id], cost)
            assignment_edges.append((task['id'], agent_id, cost, arc))
    for i in range(n_agents):
        edge(agent_base + i, sink, 0)

    # Successive shortest augmenting paths; potentials keep residual edge costs nonnegative.
    potentials = [0] * len(graph)
    while True:
        distances = [math.inf] * len(graph)
        previous = [None] * len(graph)
        distances[source] = 0
        queue = [(0, source)]
        while queue:
            distance, node = heapq.heappop(queue)
            if distance != distances[node]:
                continue
            for i, arc in enumerate(graph[node]):
                end, _, capacity, cost = arc
                candidate_distance = distance + cost + potentials[node] - potentials[end]
                if capacity and candidate_distance < distances[end]:
                    distances[end] = candidate_distance
                    previous[end] = (node, i)
                    heapq.heappush(queue, (candidate_distance, end))
        if previous[sink] is None:
            break
        for i, distance in enumerate(distances):
            if distance < math.inf:
                potentials[i] += distance
        node = sink
        while node != source:
            prior, index = previous[node]
            arc = graph[prior][index]
            arc[2] -= 1
            graph[node][arc[1]][2] += 1
            node = prior

    return [{'taskId': task_id, 'agentId': agent_id, 'cost': cost / 100}
            for task_id, agent_id, cost, arc in assignment_edges if arc[2] == 0]
