"""Local patrol is a bounded low-priority action source, never fault evidence."""
import subprocess
import unittest
from box_agent.rescue_policy import RescuePolicy


class Client:
    def __init__(self):
        self.calls = []

    def move_to(self, *args):
        self.calls.append(('move', args))

    def cancel_action(self, *args):
        self.calls.append(('cancel', args))

    def rescue(self, *args):
        self.calls.append(('rescue', args))


def observation():
    return {'tick': 20, 'done': False, 'self': {'id': 'helper', 'x': 9, 'y': 16, 'battery': 90, 'status': 'idle', 'rescue': {'workTicks': 6}, 'returnEnergyEstimate': 3}, 'assignedTasks': [], 'actions': [], 'memory': []}


class PolicyTest(unittest.TestCase):
    def test_opt_in_profile_and_energy_fences(self):
        c = Client(); self.assertFalse(RescuePolicy(10).step(c, observation())); self.assertEqual(c.calls, [])
        for change in [lambda o: o.update(done=True), lambda o: o['self'].update(status='fault'), lambda o: o['self'].pop('rescue'), lambda o: o['self'].update(battery=20), lambda o: o['assignedTasks'].append({'status': 'active'})]:
            o = observation(); change(o); c = Client()
            self.assertFalse(RescuePolicy(10, search=True).step(c, o)); self.assertEqual(c.calls, [])

    def test_real_schedule_bounds_and_finite_moves(self):
        o = observation(); c = Client(); p = RescuePolicy(10, search=True)
        for _ in range(60):
            p.step(c, o); o['tick'] += 10
        self.assertGreater(len(c.calls), 0); self.assertLessEqual(len(c.calls), 32)
        for kind, args in c.calls:
            self.assertEqual(kind, 'move'); self.assertTrue(0 <= args[1] <= 100 and 0 <= args[2] <= 100)
            self.assertEqual(args[-1] - args[-2], 90)  # due=tick+10, expiry<=tick+100
        self.assertFalse(p.step(c, o))

    def test_search_yields_to_task_fault_observation_or_low_energy(self):
        for trigger in ['task', 'contact', 'energy']:
            o = observation(); c = Client(); p = RescuePolicy(10, search=True); self.assertTrue(p.step(c, o)); request = c.calls[0][1][0]
            o['actions'] = [{'requestId': request, 'type': 'move', 'status': 'accepted'}]
            if trigger == 'task': o['assignedTasks'] = [{'status': 'active'}]; o['self']['status'] = 'assigned'
            if trigger == 'contact': o['memory'] = [{'kind': 'agent', 'id': 'target', 'x': 20, 'y': 16, 'status': 'fault', 'observedTick': 20, 'faultGeneration': 2}]
            if trigger == 'energy': o['self']['battery'] = 19
            self.assertTrue(p.step(c, o)); self.assertEqual(c.calls[-1], ('cancel', (request,)))
            if trigger != 'contact':
                o['actions'][0]['status'] = 'cancelled'; before = len(c.calls); self.assertFalse(p.step(c, o)); self.assertEqual(len(c.calls), before)

    def test_own_contact_is_required_and_bound(self):
        o = observation(); c = Client(); p = RescuePolicy(10, search=True); p.step(c, o)
        self.assertFalse(any(k == 'rescue' for k, _ in c.calls))
        o['actions'] = []; o['self'].update(x=12, y=12); o['memory'] = [{'kind': 'agent', 'id': 'target', 'x': 15, 'y': 12, 'status': 'fault', 'observedTick': 19, 'faultGeneration': 3}]
        p.step(c, o); self.assertEqual(c.calls[-1][0], 'rescue'); self.assertEqual(c.calls[-1][1][1:], ('target', 19, 30, 70, 3))

    def test_existing_actions_are_not_cancelled(self):
        o = observation(); o['actions'] = [{'requestId': 'operator-move', 'type': 'move', 'status': 'accepted'}]; c = Client(); self.assertFalse(RescuePolicy(10, search=True).step(c, o)); self.assertEqual(c.calls, [])

    def test_operating_load_reserves_the_command_lead(self):
        plain = observation(); plain['self']['battery'] = 40
        self.assertTrue(RescuePolicy(10, search=True).step(Client(), plain))
        powered = observation(); powered['self']['operatingEnergyPerTick'] = 5
        client = Client(); policy = RescuePolicy(10, search=True)
        self.assertTrue(policy.step(client, powered)); request = client.calls[0][1][0]
        powered['actions'] = [{'requestId': request, 'type': 'move', 'status': 'accepted'}]
        powered['self']['battery'] = 40; powered['tick'] += 1
        self.assertTrue(policy.step(client, powered))
        self.assertEqual(client.calls[-1], ('cancel', (request,)))
        powered['actions'] = []; other = Client()
        self.assertFalse(RescuePolicy(10, search=True).step(other, powered))
        self.assertEqual(other.calls, [])

    def test_cli_dependency_rejects_before_connection(self):
        for script in ['sdk/python/task_agent.py', 'sdk/python/multi_agent_demo.py']:
            r = subprocess.run(['python3', script, '--rescue-search'], capture_output=True, text=True)
            self.assertEqual(r.returncode, 2); self.assertIn('requires --auto-rescue', r.stderr)


if __name__ == '__main__':
    unittest.main()
