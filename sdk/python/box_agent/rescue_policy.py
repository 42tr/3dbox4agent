"""Optional local rescue policy using only one device's scoped observation."""
import math
import uuid

from .client import SandboxError


class RescuePolicy:
    def __init__(self, lead_ticks=1, search=False):
        self.lead = lead_ticks
        self.prefix = 'rescue-' + uuid.uuid4().hex
        self.sequence = 0
        self.blocked = set()
        self.cooldown = {}
        self.approach = {}
        self.handled = set()
        self.targets = {}
        self._moving_target = None
        self.search = search
        self.search_prefix = self.prefix + '-search-'
        self.search_points = None
        self.search_moves = 0
        self.search_after = 0

    @staticmethod
    def _cancel(client, request):
        try:
            client.cancel_action(request)
        except SandboxError as error:
            if error.status != 409 or error.code not in ('action_not_cancellable', 'action_not_found', 'world_finished'):
                raise

    def _search(self, client, observation):
        own, tick = observation['self'], observation['tick']
        # Known protocol map bounds are 0..100. These are search waypoints,
        # never target locations or evidence of an unseen device.
        reserve = min(79, max(20, (own.get('returnEnergyEstimate') or 0) + 5 + own.get('operatingEnergyPerTick', 0) * self.lead))
        if not self.search or self.search_moves >= 32 or tick < self.search_after or own['battery'] <= reserve:
            return False
        if self.search_points is None:
            self.search_points = sorted([(x, y) for x in (12.5, 37.5, 62.5, 87.5) for y in (12.5, 37.5, 62.5, 87.5)],
                                        key=lambda p: (math.hypot(own['x'] - p[0], own['y'] - p[1]), p))
        point = self.search_points[self.search_moves % len(self.search_points)]
        self.search_moves += 1
        if math.hypot(own['x'] - point[0], own['y'] - point[1]) <= 2:
            return True
        due = tick + self.lead
        try:
            client.move_to(f'{self.search_prefix}{self.search_moves}', point[0], point[1], due, tick + 100)
        except SandboxError as error:
            if error.status != 409 or error.code not in ('invalid_schedule', 'world_finished', 'agent_unavailable'):
                raise
        self.search_after = tick + 3
        return True

    def step(self, client, observation):
        own = observation['self']
        if not own.get('rescue') or observation['done'] or own['status'] == 'fault':
            return False
        tick = observation['tick']
        assigned = any(t['status'] == 'active' for t in observation.get('assignedTasks', []))
        contacts = {c['id']: c for c in observation.get('memory', []) if c['kind'] == 'agent'}
        for ident, contact in contacts.items():
            if contact.get('status') != 'fault':
                self.blocked.discard(ident)
                self.cooldown.pop(ident, None)
        actions = observation.get('actions', [])
        for action in actions:
            ident = action.get('targetAgentId') or self.targets.get(action['requestId'])
            if not action['requestId'].startswith(self.prefix) or action['requestId'] in self.handled or action['status'] in ('pending', 'accepted'):
                continue
            self.handled.add(action['requestId'])
            if action['requestId'].startswith(self.search_prefix):
                if action['status'] in ('failed', 'rejected'):
                    self.search_after = tick + 8
                continue
            if action['status'] in ('failed', 'rejected'):
                if action.get('reason') in ('not_recoverable', 'target_low_battery', 'fault_not_observed'):
                    self.blocked.add(ident)
                else:
                    self.cooldown[ident] = tick + 8
                    self.approach[ident] = self.approach.get(ident, 0) + 1
        active = [a for a in actions if a['status'] in ('pending', 'accepted')]
        targets = [c for c in contacts.values() if c.get('status') == 'fault' and c.get('faultGeneration', 0) > 0 and c['id'] not in self.blocked and self.cooldown.get(c['id'], -1) <= tick]
        if active:
            action = active[0]
            if action['requestId'].startswith(self.search_prefix):
                reserve = min(79, max(20, (own.get('returnEnergyEstimate') or 0) + 5 + own.get('operatingEnergyPerTick', 0) * self.lead))
                if assigned or targets or own['battery'] <= reserve:
                    self._cancel(client, action['requestId'])
                return True
            if action['requestId'].startswith(self.prefix) and action['type'] == 'move':
                target = contacts.get(self._moving_target)
                if target and math.hypot(own['x'] - target['x'], own['y'] - target['y']) <= 3.8:
                    self._cancel(client, action['requestId'])
            return action['requestId'].startswith(self.prefix)
        if assigned or own['status'] != 'idle' or own['battery'] <= 5:
            return False
        if not targets:
            return self._search(client, observation)
        target = min(targets, key=lambda c: (math.hypot(own['x'] - c['x'], own['y'] - c['y']), c['id']))
        self.sequence += 1
        request = f'{self.prefix}-{self.sequence}'
        self.targets[request] = target['id']
        due = tick + self.lead
        try:
            distance = math.hypot(own['x'] - target['x'], own['y'] - target['y'])
            if distance <= 3.8 and not self.approach.get(target['id'], 0):
                client.rescue(request, target['id'], target['observedTick'], due, due + 40, target['faultGeneration'])
            else:
                angle = math.atan2(own['y'] - target['y'], own['x'] - target['x']) + self.approach.get(target['id'], 0) * math.pi / 4
                x = max(0, min(100, target['x'] + 3.2 * math.cos(angle)))
                y = max(0, min(100, target['y'] + 3.2 * math.sin(angle)))
                self._moving_target = target['id']
                client.move_to(request, x, y, due, due + 40)
                self.approach[target['id']] = 0
        except SandboxError as error:
            if error.status == 409 and error.code in ('invalid_schedule', 'world_finished', 'action_not_cancellable', 'action_not_found'):
                return True
            if error.status == 409 and error.code in ('fault_not_observed', 'agent_unavailable'):
                self.cooldown[target['id']] = tick + 8
                return True
            raise
        return True
